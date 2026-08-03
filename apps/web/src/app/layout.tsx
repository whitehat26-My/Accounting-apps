import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Shah G Tech — shop & books',
  description: 'Point of sale, workshop and accounts for Shah G Tech',
};

/**
 * Geist, self-hosted from the npm package: the font files ship in the bundle,
 * so the static demo and the real deployment load ZERO font CDNs — no
 * flash-of-wrong-font, no third-party request carrying the user's IP.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={GeistSans.className}>
      <body>
        {process.env['NEXT_PUBLIC_DEMO'] === '1' ? (
          <div className="bg-amber-100 px-4 py-2 text-center text-xs text-amber-900">
            Prototype demo — sample data, saved only in this browser. The real system runs an
            append-only ledger on PostgreSQL, which a static page cannot host.
          </div>
        ) : null}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
