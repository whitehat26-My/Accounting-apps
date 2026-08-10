import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE NAV MUST SAY WHERE YOU ARE, ON THE BUILD THAT ACTUALLY SHIPS.
 *
 * ---------------------------------------------------------------------------
 * `next.config.ts` sets `trailingSlash: true` for the static export, so the
 * browser's `pathname` on the till screen is `/pos/`. The nav declares its
 * links as `/pos`. A strict `pathname === item.href` is therefore FALSE on
 * every screen except Today — whose href is `/` and happens to match — and the
 * sidebar quietly stops indicating the current page.
 *
 * It fails only in the export. The server build has no trailing slash, so a
 * developer running `next dev` sees it work perfectly. That combination — right
 * in development, wrong in production, silent in both — is the kind that lives
 * for a year, and it was found by looking at a screenshot of the POS and
 * noticing nothing was lit.
 * ---------------------------------------------------------------------------
 */

const LAYOUT = fileURLToPath(new URL('../src/app/(app)/layout.tsx', import.meta.url));
const CONFIG = fileURLToPath(new URL('../next.config.ts', import.meta.url));

/** The matcher the shell actually uses, lifted out so it can be exercised. */
function matcher(): (pathname: string, href: string) => boolean {
  const source = readFileSync(LAYOUT, 'utf8');
  if (!/const here = pathname\.replace\(/.test(source)) {
    throw new Error(
      'The active-nav check no longer normalises the pathname. With trailingSlash '
        + 'on, `pathname === item.href` lights nothing but Today.',
    );
  }
  return (pathname, href) => (pathname.replace(/\/+$/, '') || '/') === href;
}

describe('the sidebar knows which page you are on', () => {
  it('still matters — the export really does add trailing slashes', () => {
    expect(readFileSync(CONFIG, 'utf8')).toMatch(/trailingSlash:\s*true/);
  });

  it('lights the current page whether or not the path has a trailing slash', () => {
    const active = matcher();
    for (const href of ['/pos', '/repairs', '/stock', '/reports', '/settings']) {
      expect(active(`${href}/`, href), `${href}/ should light ${href}`).toBe(true);
      expect(active(href, href), `${href} should light ${href}`).toBe(true);
    }
  });

  it('still lights Today at the root, in both forms', () => {
    const active = matcher();
    expect(active('/', '/')).toBe(true);
    expect(active('', '/')).toBe(true);
  });

  it('does not light a different page', () => {
    const active = matcher();
    expect(active('/pos/', '/purchases')).toBe(false);
    expect(active('/', '/pos')).toBe(false);
    // A prefix is not a match: /stock must not light while on /stock-take.
    expect(active('/stock-take/', '/stock')).toBe(false);
  });
});
