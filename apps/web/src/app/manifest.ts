import type { MetadataRoute } from 'next';

import { APP_NAME, BRAND_MARK, appNameParts } from '@/lib/brand';

/**
 * Emit a FILE, not a route handler.
 *
 * Next treats `manifest.ts` as a dynamic route by default, and the GitHub
 * Pages build (`output: 'export'`) refuses to build at all against one:
 * "export const dynamic = force-static not configured on route
 * /manifest.webmanifest". Everything this function returns is fixed at build
 * time anyway — the name is inlined by Next, the paths are constants — so
 * there is nothing dynamic to give up.
 */
export const dynamic = 'force-static';

/**
 * What makes this installable rather than bookmarkable.
 *
 * ---------------------------------------------------------------------------
 * THE HOME SCREEN IS THE DIFFERENCE BETWEEN A SITE AND A TILL.
 *
 * The setup guide tells staff to add this to their home screen so it "opens
 * like an app rather than a bookmark". Without a manifest that was a promise
 * the app did not keep: the icon appeared, and tapping it opened a browser
 * with an address bar over the top — which on a phone being used as a till,
 * one-handed, at a counter, costs a row of pixels and a lot of confidence.
 *
 * `display: standalone` removes the browser chrome. `start_url` and `scope`
 * keep every navigation inside the installed window instead of bouncing back
 * out into the browser halfway through ringing a sale.
 * ---------------------------------------------------------------------------
 */
export default function manifest(): MetadataRoute.Manifest {
  const { primary } = appNameParts();

  /*
   * `BRAND_MARK` already carries the base path, which the GitHub Pages demo
   * needs and the real deployment leaves empty. `start_url` and `scope` must
   * carry it too — a manifest that points at `/` from a site served under
   * `/Accounting-apps` installs an app whose first tap is a 404.
   */
  const base = BRAND_MARK.replace('/brand/mark.png', '');

  return {
    id: `${base}/`,
    name: APP_NAME,
    /*
     * Under the icon there is room for roughly a dozen characters, so the
     * part before the em-dash is used: "Delima Trading", not "Delima Trading
     * — kedai & akaun" with the useful half truncated away.
     */
    short_name: primary,
    description: 'Point of sale, workshop and accounts for Malaysian businesses',
    start_url: `${base}/`,
    scope: `${base}/`,
    display: 'standalone',
    /*
     * Not locked to portrait. The counter iPad lives in landscape and the
     * phones in portrait, and the layouts already handle both — forcing one
     * would break the device it was not chosen for.
     */
    orientation: 'any',
    /*
     * The chrome around the app, matched to the rail rather than to the page,
     * because the rail is what sits against the status bar. Converted from the
     * `--color-rail` / `--color-surface` oklch tokens in globals.css rather
     * than picked by eye, so the seam at the top of the screen is invisible.
     */
    theme_color: '#11161f',
    background_color: '#f3f6fa',
    categories: ['business', 'finance', 'productivity'],
    icons: [
      {
        /*
         * The OPERATOR's own mark, not a bundled default, and deliberately not
         * a generated set of sizes: a company that replaces this one file gets
         * a new app icon on every phone with no build step to remember. 500px
         * clears the 192px that installability needs.
         *
         * Supply nothing and the platform falls back to a letter tile from
         * `short_name`, which is the same answer the sign-in page gives — a
         * real mark rather than somebody else's logo.
         */
        src: BRAND_MARK,
        sizes: '500x500',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
