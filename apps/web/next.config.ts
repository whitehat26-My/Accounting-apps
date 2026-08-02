import type { NextConfig } from 'next';

/**
 * The browser talks to /api/*; Next proxies to the API server. This is why
 * the API needs no CORS configuration and the browser never sees a second
 * origin — the same shape a production reverse proxy will have.
 */
const config: NextConfig = {
  async rewrites() {
    const api = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:3001';
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};

export default config;
