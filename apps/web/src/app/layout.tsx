import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import './globals.css';
import { Providers } from './providers';

/**
 * The PRODUCT's name, not any one tenant's.
 *
 * The browser tab is the same for everybody who reaches this URL — it is set
 * before anybody has signed in, so it cannot know whose books are behind it.
 * That makes it instance branding: yours if you host, theirs if they run their
 * own copy, and configurable either way. A tenant's own name appears inside
 * the app and on their documents, where the app knows who is asking.
 */
const APP_NAME = process.env['NEXT_PUBLIC_APP_NAME'] ?? 'Shah G Tech — shop & books';

export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Point of sale, workshop and accounts for Malaysian businesses',
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
