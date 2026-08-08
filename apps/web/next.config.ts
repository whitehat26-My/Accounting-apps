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

const config: NextConfig = staticExport
  ? {
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
