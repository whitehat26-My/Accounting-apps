'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { apiBlobUrl, clearSession, loadSession, type Session } from '@/lib/api';
import { can, ROLE_LABELS, useMe, type Me } from '@/lib/me';
import { Icon } from '@/components/icons';
import { Assistant } from '@/components/assistant';
import { ThemeToggle } from '@/components/theme';
// Static import so the demo's GitHub Pages base path is baked in at build.
import mark from '@/brand/mark.png';

/** The product's name — instance branding, same for everyone on this server. */
const APP_NAME = process.env['NEXT_PUBLIC_APP_NAME'] ?? 'Shah G Tech';

/**
 * The signed-in shell: dark rail on the left, work on the right.
 *
 * The nav is ROLE-AWARE: each entry names the permission that makes it
 * meaningful, and entries the signed-in user does not hold are simply not
 * rendered — the cashier sees the till, the technician sees the bench, the
 * boss sees everything. Courtesy, not security; the API authorises every
 * request behind these doors again.
 *
 * Sections mirror how the shop thinks about the work: the counter, the
 * money, the running of the place.
 */

interface NavItem {
  href: string;
  label: string;
  icon: string;
  needs: string | null;
}

const SECTIONS: { label: string | null; items: NavItem[] }[] = [
  {
    label: null,
    items: [{ href: '/', label: 'Today', icon: 'today', needs: null }],
  },
  {
    label: 'Shop',
    items: [
      { href: '/pos', label: 'Point of sale', icon: 'pos', needs: 'pos.sale' },
      { href: '/repairs', label: 'Repairs', icon: 'repairs', needs: 'repair.read' },
      { href: '/stock', label: 'Stock', icon: 'stock', needs: 'stock.read' },
      { href: '/items', label: 'Items', icon: 'items', needs: 'item.read' },
    ],
  },
  {
    label: 'Money',
    items: [
      { href: '/quotes', label: 'Quotes', icon: 'quotes', needs: 'quote.read' },
      { href: '/sales', label: 'Sales', icon: 'sales', needs: 'invoice.read' },
      { href: '/collections', label: 'Collections', icon: 'collections', needs: 'invoice.read' },
      { href: '/statements', label: 'Statements', icon: 'statements', needs: 'report.read' },
      { href: '/purchases', label: 'Purchases', icon: 'purchases', needs: 'bill.read' },
      { href: '/approvals', label: 'Approvals', icon: 'approvals', needs: 'bill.approve' },
      { href: '/banking', label: 'Banking', icon: 'banking', needs: 'bank.reconcile' },
      { href: '/insights', label: 'Insights', icon: 'insights', needs: 'report.read' },
      { href: '/reports', label: 'Reports', icon: 'reports', needs: 'report.read' },
      { href: '/journals', label: 'Journals', icon: 'journals', needs: 'journal.read' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { href: '/team', label: 'Team', icon: 'team', needs: 'user.read' },
      { href: '/payroll', label: 'Payroll', icon: 'payroll', needs: 'payroll.read' },
      { href: '/compliance', label: 'Compliance', icon: 'compliance', needs: 'compliance.read' },
      { href: '/audit', label: 'Audit', icon: 'audit', needs: 'audit.read' },
      { href: '/settings', label: 'Settings', icon: 'settings', needs: 'tax.read' },
    ],
  },
];

/**
 * What permission a path needs, from the nav map above.
 *
 * ---------------------------------------------------------------------------
 * ONE MAP, TWO JOBS — WHICH IS THE POINT.
 *
 * Hiding a nav entry and refusing the screen behind it are the same fact, and
 * keeping them in two lists is how they come apart: somebody adds a screen,
 * remembers the nav, forgets the guard, and a technician who types /payroll
 * gets the payroll console rendered around skeletons that load forever. The
 * API returns 403 to every request that screen makes — no figure ever
 * arrives — but a page that LOOKS like it is loading the boss's payroll is a
 * page that invites the next person to wonder what else they can reach.
 *
 * Longest prefix wins, so /repairs/job is covered by /repairs without needing
 * its own entry. '/' is deliberately excluded: it is a prefix of everything,
 * and it needs no permission anyway.
 * ---------------------------------------------------------------------------
 */
function permissionFor(pathname: string): string | null {
  let best: { href: string; needs: string | null } | null = null;
  for (const section of SECTIONS) {
    for (const item of section.items) {
      if (item.href === '/') continue;
      if (pathname !== item.href && !pathname.startsWith(`${item.href}/`)) continue;
      if (best === null || item.href.length > best.href.length) best = item;
    }
  }
  return best?.needs ?? null;
}

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const me = useMe();

  useEffect(() => {
    const current = loadSession();
    if (!current) {
      router.replace('/login');
      return;
    }
    setSession(current);
  }, [router]);

  if (session === undefined || session === null) return null;

  const visibleSections = SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => item.needs === null || can(me.data, item.needs)),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="flex min-h-screen">
      {/*
        The frosted rail.
        `supports-[backdrop-filter]` keeps the solid colour as the fallback: a
        browser without backdrop-filter would otherwise render a see-through
        rail with nothing blurring behind it, which is worse than no effect at
        all. The tint stays dark and heavy (85%) because the icons and labels on
        it are white — a lighter panel here would cost contrast, which is the
        one thing the glass is not allowed to do.
      */}
      {/*
        `ring-rail-line`, not `ring-line`: at night the page itself is dark and
        the rail can no longer separate from it by brightness, so the edge has
        to be a LIT one. `--line` is a hairline drawn on a pale surface and
        goes dark with the theme — exactly backwards for this one border.
      */}
      <aside
        className="flex w-16 flex-col bg-rail text-rail-ink ring-1 ring-rail-line md:w-60
                   supports-[backdrop-filter]:bg-rail/90 supports-[backdrop-filter]:backdrop-blur-xl"
      >
        {/*
          THE ORGANISATION LEADS, NOT THE PRODUCT.
          This used to read "Shah G Tech" in white with the signed-in
          organisation small underneath — which, for any company other than the
          first, said "you are inside somebody else's system". Whose books these
          are is the fact that belongs at the top of their own screen; the
          product's name has its place beside the sign-out button.
        */}
        <div className="flex items-center justify-center gap-3 px-2 pb-5 pt-6 md:justify-start md:px-5">
          <OrgMark name={session.organisationName} />
          <div className="hidden min-w-0 md:block">
            <div className="truncate text-sm font-semibold text-rail-ink-strong">
              {session.organisationName || 'Your organisation'}
            </div>
            <div className="text-xs text-rail-ink/70">
              {me.data ? (ROLE_LABELS[me.data.role] ?? me.data.role) : ' '}
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
          {visibleSections.map((section) => (
            <div key={section.label ?? 'root'}>
              {section.label ? (
                <div className="hidden px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-rail-ink/50 md:block">
                  {section.label}
                </div>
              ) : null}
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.href;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.label}
                      // `rail-accent`, NOT `positive`. The rail is dark in both
                      // themes, so its accent must be too — and `--positive` is
                      // a DARK green by day, which put the selected page in
                      // near-black on near-black. Caught by screenshotting the
                      // light theme, not by reading the diff: at night the very
                      // same class looked perfect.
                      className={`relative flex items-center justify-center gap-2.5 rounded-lg px-2.5 py-2.5 text-[13px] transition-colors md:justify-start ${
                        active
                          ? 'bg-rail-accent/15 font-medium text-rail-accent'
                          : 'text-rail-ink hover:bg-rail-ink/10 hover:text-rail-ink-strong'
                      }`}
                    >
                      {active ? (
                        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-rail-accent" />
                      ) : null}
                      <Icon name={item.icon} className={active ? 'text-rail-accent' : 'text-rail-ink/60'} />
                      <span className="hidden md:inline">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="hidden border-t border-rail-line px-5 py-4 md:block">
          {/* Brightness sits above the sign-out, not in Settings: the shop
              turns the lights down at dusk, and a setting you reach for daily
              does not belong three clicks away behind a tax-rate screen. */}
          <div className="mb-3">
            <ThemeToggle />
          </div>
          {/* The product's name, where it belongs on somebody else's screen:
              small, at the bottom, beside the way out. */}
          <div className="mb-2 flex items-center gap-2">
            <img src={mark.src} alt="" className="h-4 w-4 shrink-0 opacity-60" />
            <span className="truncate text-[11px] text-rail-ink/50">{APP_NAME}</span>
          </div>
          <button
            className="text-xs text-rail-ink/60 transition-colors hover:text-rail-ink-strong"
            onClick={() => {
              clearSession();
              router.push('/login');
            }}
          >
            Sign out
          </button>
        </div>
      </aside>

      {/*
        A soft tinted wash rather than flat grey. Glass only reads as glass when
        there is something behind it to pick up — with a uniform background the
        blur is invisible and the translucency just looks like a lighter colour.
        Kept very low contrast so it never competes with the cards on top.
      */}
      <main className="min-w-0 flex-1 bg-surface p-4 md:p-6 lg:p-8">
        {/*
          `key={pathname}` remounts the wrapper on navigation so each screen
          arrives with the same short rise the sign-in card uses. The nav rail
          sits outside and never moves — the page changes, the frame doesn't.
        */}
        <div key={pathname} className="emil-rise mx-auto max-w-5xl">
          <Guarded pathname={pathname} me={me.data} settled={!me.isLoading}>
            {children}
          </Guarded>
        </div>
      </main>

      <Assistant />
    </div>
  );
}

/**
 * The screen, or an honest refusal in its place.
 *
 * Renders NOTHING until `/v1/auth/me` has settled. Rendering the page first
 * and swapping it for a refusal a moment later would flash the boss's payroll
 * headings at a technician — briefly, but a screenshot is instant, and "it
 * showed for a second" is not a defence anybody enjoys making.
 *
 * When `me` fails outright — offline, or the token has just expired — the
 * children render. The API is the security boundary and answers 403 to every
 * request behind this door; refusing here on a failed permission FETCH would
 * lock the whole app out of the shop over a dropped WiFi packet.
 */
function Guarded({
  pathname, me, settled, children,
}: {
  pathname: string;
  me: Me | undefined;
  settled: boolean;
  children: ReactNode;
}) {
  const needs = permissionFor(pathname);
  if (needs === null) return <>{children}</>;
  if (!settled) return null;
  if (me === undefined || can(me, needs)) return <>{children}</>;

  return (
    <div className="mx-auto max-w-lg rounded-2xl bg-surface-raised p-8 text-center shadow-sm ring-1 ring-line">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-surface-sunken">
        <Icon name="settings" className="text-ink-faint" />
      </div>
      <h1 className="mt-4 text-lg font-semibold text-ink">Not part of your work here</h1>
      {/*
        Names the role rather than the permission. "You need payroll.read" is
        a message written for whoever built the app; "signed in as Technician"
        is one the person can act on — they know who to ask.
      */}
      <p className="mt-2 text-sm text-ink-muted">
        You are signed in as{' '}
        <span className="font-medium text-ink">
          {me ? (ROLE_LABELS[me.role] ?? me.role) : 'a member'}
        </span>
        , and this screen is not part of that role. If you need it, the shop owner can
        change your role under Team.
      </p>
      <Link
        href="/"
        className="mt-5 inline-flex rounded-xl bg-brand px-4 py-2 text-sm font-medium text-surface-raised transition-[filter] hover:brightness-110"
      >
        Back to Today
      </Link>
    </div>
  );
}

/**
 * The tenant's own mark on their own screen.
 *
 * Falls back to INITIALS, not to the product's logo. Putting one company's
 * hexagon on another company's rail is the same mistake the PDFs used to make,
 * and two letters on a coloured tile reads as "yours" in a way somebody else's
 * mark never can. A tenant that uploads a logo in Settings gets it here too.
 *
 * The bytes come through `apiBlobUrl` because the route is authenticated and
 * an <img src> cannot carry a bearer token; the object URL is revoked on
 * unmount so navigating around the app does not leak one per screen.
 */
function OrgMark({ name }: { name: string | undefined }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked: string | null = null;
    let cancelled = false;
    void apiBlobUrl('/v1/organisations/logo')
      .then((u) => {
        if (cancelled) { URL.revokeObjectURL(u); return; }
        revoked = u;
        setUrl(u);
      })
      // 204 (no logo) and 403 (a role without tax.read) both land here, and
      // both mean the same thing to this component: show the initials.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, []);

  /*
   * `?? ''` because a session saved by an OLDER build of the login screen
   * holds `organisationName: undefined` — that bug is fixed, but the sessions
   * it wrote are in people's browsers until they sign in again, and a rail
   * that throws is a rail nobody can sign out of to fix it.
   */
  const initials = (name ?? '')
    .split(/\s+/)
    .filter((w) => /^[A-Za-z0-9]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-plate shadow-lg shadow-black/40">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} className="h-full w-full object-contain p-1" />
      ) : (
        <span className="text-[11px] font-bold tracking-tight text-plate-ink">
          {initials || '·'}
        </span>
      )}
    </div>
  );
}
