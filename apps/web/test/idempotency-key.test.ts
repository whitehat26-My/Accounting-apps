import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * THE CLIENT'S RULE AND THE SERVER'S LIST MUST NOT DRIFT APART.
 *
 * ---------------------------------------------------------------------------
 * `src/lib/api.ts` stamped the Idempotency-Key on POST, PATCH and DELETE. The
 * comment immediately above that line said the API "treats POST, PUT, PATCH
 * and DELETE alike and refuses any of them without a key" — which is true, and
 * PUT was missing from the code under it.
 *
 * The app has exactly one PUT route, the letterhead, so the whole cost of the
 * omission landed on one screen: Settings → Upload a logo was refused every
 * time it was ever pressed, and no tenant has printed on its own letterhead.
 * It survived because the GitHub Pages demo short-circuits before the
 * interceptor, and because a hand-written list of verbs looks complete.
 *
 * So this does not check that PUT is in a list. It checks there is no list:
 * the client keys off the METHOD, and every verb the interceptor calls
 * mutating is covered by construction.
 * ---------------------------------------------------------------------------
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const client = readFileSync(join(here, '../src/lib/api.ts'), 'utf8');
const interceptor = readFileSync(
  join(here, '../../api/src/interceptors/idempotency.interceptor.ts'),
  'utf8',
);

describe('the Idempotency-Key the browser sends', () => {
  it('is decided by the method, not by a list of verbs', () => {
    // The condition guarding the header. A list here is the bug returning.
    expect(client).toMatch(/if \(method !== 'GET'\) \{\s*\n\s*headers\['idempotency-key'\]/);
    expect(client).not.toMatch(/options\.method === 'POST' \|\|/);
  });

  it('covers every verb the API interceptor calls mutating', () => {
    const declared = interceptor.match(/MUTATING = new Set\(\[([^\]]*)\]\)/);
    expect(declared).not.toBeNull();

    const mutating = [...declared![1]!.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]!);
    expect(mutating.length).toBeGreaterThan(0);
    expect(mutating).not.toContain('GET');

    // Every one of them is a method the client can send, and none is GET —
    // so `method !== 'GET'` covers the whole set.
    const clientMethods = client.match(/readonly method\?: ([^;]+);/);
    expect(clientMethods).not.toBeNull();

    const sendable = [...clientMethods![1]!.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]!);
    for (const verb of mutating) {
      expect(sendable).toContain(verb);
    }
  });

  it('still leaves GET alone', () => {
    // A key on a read is noise in every access log the request passes through.
    expect(client).toMatch(/const method = options\.method \?\? 'GET';/);
  });
});
