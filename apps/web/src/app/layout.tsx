import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import './globals.css';
import { Providers } from './providers';
import { APP_NAME } from '@/lib/brand';

/**
 * The browser tab carries the INSTALLATION's name, not any one tenant's.
 *
 * It is the same for everybody who reaches this URL, because it is set before
 * anybody has signed in and so cannot know whose books are behind it: yours if
 * you host, theirs if they run their own copy, configurable either way. A
 * tenant's own name appears inside the app and on their documents, where the
 * app knows who is asking. `@/lib/brand` is the one place that decides this.
 */
export const metadata: Metadata = {
  title: APP_NAME,
  description: 'Point of sale, workshop and accounts for Malaysian businesses',
};

/**
 * Geist, self-hosted from the npm package: the font files ship in the bundle,
 * so the static demo and the real deployment load ZERO font CDNs — no
 * flash-of-wrong-font, no third-party request carrying the user's IP.
 */
/**
 * Decide the theme BEFORE the first paint.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A BLOCKING INLINE SCRIPT ON PURPOSE, AND IT IS THE ONLY ONE.
 *
 * Reading the stored choice from React would mean the page paints light,
 * hydrates, and then flips to dark — a white flash in a dark room, every single
 * navigation. The fix has to run before the browser paints anything, which
 * means synchronously in `<head>`, which means a string.
 *
 * It is deliberately tiny and touches nothing but `documentElement.classList`.
 * `try/catch` because `localStorage` throws outright in a browser with cookies
 * blocked, and a theme preference is not worth a blank page.
 * ---------------------------------------------------------------------------
 */
const THEME_BOOTSTRAP = `
try {
  var t = localStorage.getItem('emil.theme');
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.documentElement.classList.add('dark');
} catch (e) {}
`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning`: the script above adds a class to <html>
    // before React sees it, so the server and client markup differ by design.
    <html lang="en" className={GeistSans.className} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {process.env['NEXT_PUBLIC_DEMO'] === '1' ? (
          <div className="bg-caution-soft px-4 py-2 text-center text-xs text-caution">
            Prototype demo — sample data, saved only in this browser. The real system runs an
            append-only ledger on PostgreSQL, which a static page cannot host.
          </div>
        ) : null}
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
