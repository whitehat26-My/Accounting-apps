/**
 * Who THIS INSTALLATION says it is.
 *
 * ---------------------------------------------------------------------------
 * INSTANCE BRANDING IS NOT TENANT BRANDING, AND THIS FILE IS THE FIRST ONE.
 *
 * Two different identities live in this app and confusing them is the defect
 * migration 0050 was written to fix:
 *
 *   - The TENANT's — their name and logo, on their invoices, in their rail,
 *     in the assistant's answers. Read from the `organisation` row, different
 *     for every company keeping books on the same server.
 *   - The INSTALLATION's — the sign-in page and the browser tab. The same for
 *     everybody who reaches this address, because it is on screen BEFORE
 *     anybody has signed in, when the app cannot know whose books are behind
 *     it. That is this file.
 *
 * The sign-in page used to hardcode one shop's name, wordmark and a photograph
 * of its actual shopfront, so a second company running their own copy would
 * have had their staff sign in to somebody else's front door every morning.
 * ---------------------------------------------------------------------------
 */

/**
 * `NEXT_PUBLIC_APP_NAME` is inlined by Next at BUILD time — `process.env` is
 * not read at runtime here, the string is compiled in. That is why the compose
 * file passes it as a build arg and why changing it needs `up -d --build`.
 *
 * The default is deliberately nobody's shop. A default that names one company
 * is how the old bug survived: it looked correct to the only people who could
 * have noticed it was wrong.
 */
export const APP_NAME = process.env['NEXT_PUBLIC_APP_NAME'] ?? 'Emil Books';

/**
 * Split a name on its em-dash into the two lines the sign-in panel and the
 * rail already lay out: the company above, what the system is below.
 *
 * `"Delima Trading — shop & books"` → `{ primary: 'Delima Trading',
 * secondary: 'shop & books' }`. One line with no dash keeps `secondary`
 * undefined and the layouts simply omit it, so an operator who types a bare
 * company name gets a sensible result rather than an empty second line.
 *
 * An en-dash and a plain hyphen are accepted too. Somebody typing this into a
 * `.env.prod` in Notepad will not reach for an em-dash, and refusing their
 * input over a character they cannot easily type would be a poor trade.
 */
export function appNameParts(name: string = APP_NAME): {
  primary: string;
  secondary: string | undefined;
} {
  const [primary, ...rest] = name.split(/\s+[—–-]\s+/);
  return { primary: (primary ?? name).trim(), secondary: rest.join(' — ').trim() || undefined };
}

/**
 * Up to two initials for a name, for the tile shown when there is no logo.
 *
 * Shared rather than duplicated: the rail derives the TENANT's initials the
 * same way (`app/(app)/layout.tsx`), and two copies of this would drift into
 * one company being "DT" in one place and "D" in another.
 *
 * Tolerates `undefined` because a session written by an older build of the
 * login screen stored `organisationName: undefined`, and a rail that throws is
 * a rail nobody can sign out of to fix.
 */
export function initialsOf(name: string | undefined): string {
  return (name ?? '')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/**
 * The operator's own image files, served from `public/` rather than imported.
 *
 * This is load-bearing, not a tidy-up. A static `import mark from
 * '@/brand/mark.png'` is resolved by the bundler, so a company that supplies
 * no logo could not BUILD the app at all — the deployment would fail on a
 * missing decoration. Served from `public/`, an absent file is a 404 that the
 * components below turn into the initials tile and the plain gradient.
 *
 * Supplying them is therefore optional, and the fallbacks are the real design
 * rather than a degraded one.
 */
/**
 * `basePath` is applied by Next to its own routes and to statically imported
 * assets, but NOT to a bare string in an `<img src>` — which is what these
 * now are. The GitHub Pages demo is served under `/Accounting-apps`, so
 * without this prefix it would lose every brand image to a 404. Empty for the
 * real deployment, which is served from the root.
 */
const BASE = process.env['NEXT_PUBLIC_BASE_PATH'] ?? '';

export const BRAND_MARK = `${BASE}/brand/mark.png`;
export const BRAND_WORDMARK = `${BASE}/brand/wordmark.png`;
export const BRAND_PHOTO = `${BASE}/brand/shop.jpg`;
