import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE GUARD AGAINST A DEPLOYMENT THAT QUIETLY HAS NO SECURITY HEADERS.
 *
 * ---------------------------------------------------------------------------
 * `next.config.ts` declares CSP, X-Frame-Options, Referrer-Policy,
 * Permissions-Policy and HSTS in `headers()`. Next calls that function on a
 * SERVER. The Netlify deployment is `output: 'export'` — a directory of files
 * with no server anywhere — so the function is never called and every one of
 * those headers is simply absent.
 *
 * Nothing about the site looks wrong when that happens. It renders, it signs
 * in, it takes payments. It is also framable, which is the one that matters:
 * an accounting app whose approvals and sign-off screens can be put in an
 * invisible iframe is a clickjacking target.
 *
 * So `netlify.toml` restates them. A restatement is a second copy, and a
 * second copy drifts — somebody tightens the CSP in next.config.ts for the
 * Docker path, and the hosted site keeps the old one for a year. THE COPY IS
 * UNAVOIDABLE (Next compiles next.config.ts in isolation and leaves a relative
 * import unresolved, so the two cannot share a module — proven by trying it).
 * THE DRIFT IS NOT.
 *
 * This compares the two by VALUE: it calls the real `headers()` and parses the
 * real toml, rather than checking that some file mentions some string. A test
 * that greps for 'frame-ancestors' passes against a file where the directive
 * is commented out — that exact failure has already been made once in this
 * repository, on the Dockerfile guard, and it passed against a container that
 * was crash-looping at the time.
 * ---------------------------------------------------------------------------
 */

const TOML = fileURLToPath(new URL('../../../netlify.toml', import.meta.url));

/**
 * A deliberately narrow reader for the ONE toml shape netlify.toml uses:
 *
 *     [[headers]]
 *       for = "/*"
 *       [headers.values]
 *         Key = "value"
 *
 * Narrow on purpose. It is not a TOML implementation and must never be
 * mistaken for one — but a parser that silently returns `{}` when the file
 * changes shape is worse than no parser at all, because the assertions below
 * would then compare nothing and pass. Hence: it throws when it cannot find
 * the block, and the first test asserts it found actual headers.
 */
function netlifyHeaders(): Map<string, string> {
  const lines = readFileSync(TOML, 'utf8').split(/\r?\n/);
  const found = new Map<string, string>();
  let inValues = false;

  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('#') || text === '') continue;

    // Any new table header ends the values block we were reading.
    if (text.startsWith('[')) {
      inValues = text === '[headers.values]';
      continue;
    }
    if (!inValues) continue;

    const match = /^([A-Za-z0-9-]+)\s*=\s*"(.*)"$/.exec(text);
    if (!match) throw new Error(`netlify.toml: unparsed line in [headers.values]: ${text}`);
    found.set(match[1]!, match[2]!);
  }

  if (found.size === 0) {
    throw new Error('netlify.toml: found no [headers.values] entries at all');
  }
  return found;
}

/**
 * The headers `next.config.ts` sets on the server path.
 *
 * The env vars are cleared first because they are read at MODULE level: with
 * EMIL_STATIC=1 leaking in from a shell, the import would take the export
 * branch, `headers` would be undefined, and this whole file would have nothing
 * to compare against.
 */
async function nextHeaders(): Promise<Map<string, string>> {
  delete process.env['EMIL_STATIC'];
  delete process.env['NEXT_PUBLIC_DEMO'];

  const config = (await import('../next.config')).default;
  if (typeof config.headers !== 'function') {
    throw new Error('next.config.ts took the static branch — nothing to compare');
  }

  const rules = await config.headers();
  const all = new Map<string, string>();
  for (const rule of rules) {
    for (const header of rule.headers) all.set(header.key, header.value);
  }
  return all;
}

describe('netlify.toml carries the headers a static export cannot', () => {
  it('states every header next.config.ts sets, with the same value', async () => {
    const expected = await nextHeaders();
    const actual = netlifyHeaders();

    expect(expected.size).toBeGreaterThan(0);
    for (const [key, value] of expected) {
      // Named individually so a failure says WHICH header, not "maps differ".
      expect({ [key]: actual.get(key) }).toEqual({ [key]: value });
    }
  });

  it('states nothing extra, so the two files are one list and not two', async () => {
    const expected = await nextHeaders();
    const extra = [...netlifyHeaders().keys()].filter((key) => !expected.has(key));

    // A header only Netlify sets is not automatically wrong — but it means the
    // Docker deployment silently lacks it, which is the same drift in reverse.
    expect(extra).toEqual([]);
  });

  it('keeps the frame lock, which is the one that would not be noticed missing', async () => {
    const actual = netlifyHeaders();
    expect(actual.get('X-Frame-Options')).toBe('DENY');
    expect(actual.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  });
});
