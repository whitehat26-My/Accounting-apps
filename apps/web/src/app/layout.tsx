import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: 'Emil — shop & books',
  description: 'Point of sale, workshop and accounts for Malaysian SMEs',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
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
