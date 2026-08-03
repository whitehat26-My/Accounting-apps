import type { NextConfig } from 'next';

/**
 * Two builds from one app.
 *
 * REAL: the browser talks to /api/*, Next rewrites to the API server, CORS
 * never exists — the shape a production reverse proxy has.
 *
 * DEMO (NEXT_PUBLIC_DEMO=1): a fully static export for GitHub Pages, served
 * under the repository's base path, with the in-browser demo backend compiled
 * in instead of a network. Rewrites are meaningless in an export and omitted.
 */
const demo = process.env['NEXT_PUBLIC_DEMO'] === '1';

const config: NextConfig = demo
  ? {
      output: 'export',
      basePath: process.env['DEMO_BASE_PATH'] ?? '',
      images: { unoptimized: true },
      // login/index.html instead of login.html, so /login and /login/ BOTH
      // resolve on a dumb file server. Without it, the trailing-slash form
      // falls through to the 404 page — found the hard way on an iPad.
      trailingSlash: true,
    }
  : {
      async rewrites() {
        const api = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:3001';
        return [{ source: '/api/:path*', destination: `${api}/:path*` }];
      },
      /**
       * Security headers on the real server.
       *
       * Not on the demo (a static export cannot set headers; its host does).
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
