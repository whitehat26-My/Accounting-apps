import type { NextConfig } from 'next';

/**
 * Three builds from one app.
 *
 * SERVER (the default): the browser talks to /api/*, Next rewrites to the API
 * server, CORS never exists — the shape a production reverse proxy has. This
 * is what `docker-compose.prod.yml` runs.
 *
 * DEMO (NEXT_PUBLIC_DEMO=1): a fully static export for GitHub Pages, served
 * under the repository's base path, with the in-browser demo backend compiled
 * in instead of a network. Rewrites are meaningless in an export and omitted.
 *
 * STATIC (EMIL_STATIC=1): the same static export, but with the REAL API
 * transport and served from the root — for Netlify, which serves files and
 * proxies /api/* onward itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THE APP CAN BE STATIC AT ALL, WHICH IS NOT OBVIOUS FOR A NEXT APP.
 *
 * Every one of the 24 pages is `'use client'`; there are no route handlers and
 * no `'use server'`. Nothing renders on a server, so there is nothing for a
 * server to do — the whole app is a bundle the browser runs, and it talks to
 * the API over `fetch` with a RELATIVE `/api/...` path (`src/lib/api.ts`).
 *
 * That relative path is what makes the Netlify deployment same-origin: Netlify
 * proxies `/api/*` to the API host with a 200 rewrite, so the browser only ever
 * sees one origin and CORS is never introduced. It is the Next rewrite's job,
 * done one layer out.
 * ---------------------------------------------------------------------------
 */
const demo = process.env['NEXT_PUBLIC_DEMO'] === '1';
const staticExport = demo || process.env['EMIL_STATIC'] === '1';

/**
 * True of every mode, so it is written once rather than in both branches.
 *
 * ---------------------------------------------------------------------------
 * THE ONE WORKSPACE PACKAGE THIS APP IMPORTS, AND WHY IT EARNS THE EXCEPTION.
 *
 * `apps/web` deliberately depends on nothing from this repository: CLAUDE.md's
 * rule is that amounts are strings end to end and the moment a screen needs to
 * CALCULATE, the calculation belongs on the server.
 *
 * `/verify` is the one screen where that is impossible. It checks a signed QR
 * code against a public key so a customer can confirm a receipt is genuine
 * WITH NO SERVER REACHABLE — that is the entire feature. It therefore has to
 * decode the signed payload itself, and it must decode it byte-identically to
 * the code that produced it, or it will read the wrong amount and still report
 * GENUINE. A second implementation living here is the drift risk this
 * repository keeps writing guard tests to prevent, and this is the one place
 * where drifting would launder a forgery.
 *
 * The rule's purpose survives: the browser is not computing money, it is
 * READING a figure the server computed and signed. `Money.fromUnits().toString()`
 * is also how minor units become a decimal without float error — hand-rolling
 * that here is how you get `1250.0000000001` on a receipt.
 *
 * `@emil/domain/attestation` is a subpath export, not the package barrel: the
 * graph is `attestation.ts` plus `money.ts`, and `money.ts` imports nothing.
 * Importing from the root would pull all 49 domain modules into the bundle.
 * `transpilePackages` is required because the package ships raw TypeScript.
 * ---------------------------------------------------------------------------
 */
const shared = {
  transpilePackages: ['@emil/domain'],
  /**
   * Teach webpack that `./money.js` means `./money.ts`.
   *
   * `packages/domain` is written for Node's ESM resolution, where a relative
   * import must carry the extension it will have AFTER compilation — so its
   * source says `from './money.js'` while the file on disk is `money.ts`. `tsc`
   * and `vitest` both understand that convention; webpack does not, and reports
   * `Module not found: Can't resolve './money.js'`.
   *
   * TYPECHECKING PASSES EITHER WAY, which is what makes this worth a comment:
   * the failure appears only when the bundler runs, so it cannot be caught by
   * `pnpm typecheck` and will look mysterious to whoever meets it next.
   */
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
} satisfies Partial<NextConfig>;

const config: NextConfig = staticExport
  ? {
      ...shared,
      output: 'export',
      // Only the Pages demo lives under a sub-path; Netlify serves from the root.
      basePath: demo ? (process.env['DEMO_BASE_PATH'] ?? '') : '',
      /**
       * The base path, again, where CLIENT code can see it.
       *
       * Next prefixes `basePath` onto its own routes and onto statically
       * imported assets, but NOT onto a plain string in an `<img src>`. The
       * brand images moved to `public/` (so a company that supplies no logo
       * can still build), which makes them exactly that kind of plain string —
       * and on Pages, where this is `/Accounting-apps`, an unprefixed
       * `/brand/mark.png` is a 404 and the demo silently loses its logo.
       *
       * Empty for Netlify, which is served from the root.
       */
      env: { NEXT_PUBLIC_BASE_PATH: demo ? (process.env['DEMO_BASE_PATH'] ?? '') : '' },
      images: { unoptimized: true },
      // login/index.html instead of login.html, so /login and /login/ BOTH
      // resolve on a dumb file server. Without it, the trailing-slash form
      // falls through to the 404 page — found the hard way on an iPad.
      trailingSlash: true,
      /*
       * NO `headers()` here, and that is not an omission — a static export has
       * no server to set them, so Next ignores the function entirely. The host
       * carries them instead: `netlify.toml` for Netlify, GitHub Pages' own
       * defaults for the demo. `apps/web/test/netlify-headers.test.ts` asserts
       * netlify.toml still carries every header the server branch below sets —
       * they cannot be one shared module, because Next compiles this file on
       * its own and a relative import is left unresolved at build time.
       */
    }
  : {
      ...shared,
      async rewrites() {
        const api = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:3001';
        return [{ source: '/api/:path*', destination: `${api}/:path*` }];
      },
      /**
       * Security headers on the real server.
       *
       * The load-bearing one for an accounting app is `frame-ancestors 'none'`
       * / `X-Frame-Options: DENY` — without it the POS, approvals and sign-off
       * screens can be framed and clickjacked. HSTS only bites over HTTPS, so
       * it is harmless before Caddy and correct after.
       *
       * The CSP keeps `'unsafe-inline'` on script for Next's hydration bootstrap
       * (a nonce-based policy is a later tightening); the frontend has no HTML
       * injection sink today, so the real value here is the source allow-list
       * and the frame/object/base locks. `blob:` on img/connect is required —
       * "Print receipt" fetches the PDF and opens it as a blob URL.
       *
       * `netlify.toml` RESTATES all of this for the static deployment, which
       * has no server to run this function. The restatement is unavoidable;
       * the drift is not, and a test enforces that.
       */
      async headers() {
        const csp = [
          "default-src 'self'",
          "img-src 'self' data: blob:",
          "style-src 'self' 'unsafe-inline'",
          "script-src 'self' 'unsafe-inline'",
          "font-src 'self'",
          "connect-src 'self' blob:",
          "frame-ancestors 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "object-src 'none'",
        ].join('; ');
        return [
          {
            source: '/:path*',
            headers: [
              { key: 'Content-Security-Policy', value: csp },
              { key: 'X-Frame-Options', value: 'DENY' },
              { key: 'X-Content-Type-Options', value: 'nosniff' },
              { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
              { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
              {
                key: 'Strict-Transport-Security',
                value: 'max-age=63072000; includeSubDomains',
              },
            ],
          },
        ];
      },
    };

export default config;
