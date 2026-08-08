/**
 * A UUID that works over plain HTTP, not only HTTPS and localhost.
 *
 * ---------------------------------------------------------------------------
 * `crypto.randomUUID` IS ABSENT IN A SHOP ON ITS OWN LAN.
 *
 * The browser only exposes `crypto.randomUUID` (and most of Web Crypto) in a
 * "secure context" — HTTPS, or `localhost`. A shop PC reached at
 * `http://192.168.68.109:8080` over the shop WiFi is neither, so the call is
 * `undefined` and throws `crypto.randomUUID is not a function`.
 *
 * That is not a corner case here, it is the MAIN case: this app is designed to
 * be deployed exactly like that, and every financial write attaches an
 * Idempotency-Key generated this way. Registration threw it on the first real
 * deployment; had that been got past, the first sale would have thrown it too.
 *
 * Found only by deploying: the dev server runs on `localhost` (secure), the
 * production build is served from `localhost` in tests (secure), and the
 * Playwright journeys hit `127.0.0.1` (secure). Every place the code runs
 * before a shop opens it is a secure context. The one place it does not is the
 * shop.
 * ---------------------------------------------------------------------------
 *
 * The key is stored in a `TEXT` column and validated only as non-empty, so any
 * unique string is a valid Idempotency-Key — the format is not load-bearing,
 * uniqueness is. `getRandomValues` is available in far more contexts than
 * `randomUUID`; the last resort uses `Math.random`, which is weak for crypto
 * and entirely adequate for "tell two double-clicks apart".
 */
export function uuid(): string {
  const c = globalThis.crypto;

  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === 'function') {
    const b = c.getRandomValues(new Uint8Array(16));
    b[6] = (b[6]! & 0x0f) | 0x40; // version 4
    b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
    const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // No Web Crypto at all. Not a UUID, and does not need to be — a unique
  // string is all the Idempotency-Key contract asks for.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
