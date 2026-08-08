/**
 * Browser APIs that a shop on its own LAN does not have.
 *
 * This exists because of a bug that reached a real till: `crypto.randomUUID`
 * is a SECURE-CONTEXT API, present on HTTPS and localhost and ABSENT over
 * `http://<lan-ip>:8080` — which is precisely how this app is meant to be
 * deployed. It threw `crypto.randomUUID is not a function` on the very first
 * registration, and generates the Idempotency-Key for every financial write,
 * so the first sale would have thrown it too.
 *
 * Nothing caught it before the shop did: the dev server, the test build and
 * the Playwright journeys all run on localhost or 127.0.0.1, every one a
 * secure context. The only insecure context in the whole lifecycle is the shop
 * itself. So this is a source-level guard rather than a runtime test — the
 * runtime that matters cannot be reached from CI.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

import { uuid } from '../src/lib/uuid';

const SRC = join(import.meta.dirname, '..', 'src');

/**
 * Secure-context-only APIs, and what to use instead. The value is a bare
 * property access; the point is the *call* to it succeeding, which it will not
 * off localhost. `crypto.subtle` would belong here too if the app used it.
 */
const FORBIDDEN: { pattern: RegExp; use: string }[] = [
  {
    pattern: /\bcrypto\.randomUUID\b/,
    use: "import { uuid } from '@/lib/uuid' — it falls back off HTTPS, where crypto.randomUUID is undefined.",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

describe('the app uses no secure-context-only browser API', () => {
  it('never calls crypto.randomUUID directly (it is absent on a LAN)', () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      // The wrapper is the ONE place allowed to name it, guarded by a typeof.
      if (relative(SRC, file).replace(/\\/g, '/') === 'lib/uuid.ts') continue;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const { pattern, use } of FORBIDDEN) {
          if (pattern.test(line)) {
            hits.push(`  ${relative(SRC, file)}:${i + 1}\n      ${line.trim()}\n      → ${use}`);
          }
        }
      });
    }
    expect(hits, hits.length ? `\nSecure-context API off localhost:\n${hits.join('\n')}` : '').toEqual([]);
  });
});

describe('the uuid fallback', () => {
  it('returns a distinct non-empty string on every call', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const v = uuid();
      expect(v.length).toBeGreaterThan(0);
      seen.add(v);
    }
    // A collision here would silently merge two writes under one
    // Idempotency-Key, dropping the second. 1000 distinct is the property.
    expect(seen.size).toBe(1000);
  });

  it('works with no crypto object at all — the deepest fallback', () => {
    const original = globalThis.crypto;
    try {
      // @ts-expect-error — deleting a global for the duration of one assertion.
      delete globalThis.crypto;
      expect(uuid()).toMatch(/^id-/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true });
    }
  });
});
