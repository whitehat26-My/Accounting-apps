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
    };

export default config;
