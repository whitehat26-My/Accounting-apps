import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { GeistSans } from 'geist/font/sans';
import './globals.css';
import { Providers } from './providers';
import { APP_NAME, BRAND_MARK, appNameParts } from '@/lib/brand';

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

  /**
   * iOS does not read the web app manifest for any of this.
   *
   * Android takes `display: standalone` from `manifest.ts` and is done.
   * Safari has its own, older mechanism and ignores the manifest's display
   * mode, so "Add to Home Screen" without these tags gives an icon that opens
   * a browser with an address bar — the exact thing the setup guide promises
   * it will not do. Both halves are needed, and only one of them is standard.
   *
   * `statusBarStyle: 'default'` and not `black-translucent`: translucent
   * hands the app the area behind the clock and battery, which is right for a
   * photo-led screen and wrong for this one — the rail would slide under the
   * status bar and the first nav item would sit beneath the time.
   */
  appleWebApp: {
    capable: true,
    title: appNameParts().primary,
    statusBarStyle: 'default',
  },

  /*
   * Safari uses `apple-touch-icon` rather than the manifest's icons, so the
   * operator's own mark has to be named twice. Same file both times — a
   * company replaces `public/brand/mark.png` and both follow.
   */
  icons: { apple: BRAND_MARK },

  /*
   * The legacy Apple tag, by hand, because Next no longer emits it.
   *
   * `appleWebApp.capable: true` above now produces only the standardised
   * `mobile-web-app-capable`, which Chrome reads and older Safari does not.
   * iOS 16.4 and later honour the manifest's `display: standalone` and are
   * fine without this; everything before that needs the old name or the app
   * opens with an address bar over it.
   *
   * That older group is exactly the hardware a shop has — the counter iPad
   * bought a few years ago, the spare phone behind the till. Two duplicated
   * tags are a trivial price for those devices behaving like the guide says
   * they will, and the tag is inert on any phone that no longer needs it.
   */
  other: { 'apple-mobile-web-app-capable': 'yes' },
};

/**
 * The colour behind the phone's status bar once installed.
 *
 * Two values, because the app has two themes and a single one is visibly
 * wrong in the other: a light bar over the night palette is a white stripe
 * above a near-black rail. Converted from the `--color-rail` oklch tokens in
 * `globals.css` rather than chosen by eye, so the seam does not show.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#11161f' },
    { media: '(prefers-color-scheme: dark)', color: '#05070d' },
  ],
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
