'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearSession, loadSession, type Session } from '@/lib/api';
import { can, ROLE_LABELS, useMe, type Me } from '@/lib/me';
import { Icon } from '@/components/icons';
import { Assistant } from '@/components/assistant';
// Static import so the demo's GitHub Pages base path is baked in at build.
import mark from '@/brand/mark.png';

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
      <aside
        className="flex w-16 flex-col bg-slate-950 text-slate-300 ring-1 ring-white/5 md:w-60
                   supports-[backdrop-filter]:bg-slate-950/85 supports-[backdrop-filter]:backdrop-blur-xl"
      >
        <div className="flex items-center justify-center gap-3 px-2 pb-5 pt-6 md:justify-start md:px-5">
          {/* The shop's actual hexagon mark, on a white tile so the blue
              reads against the dark rail. */}
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white p-1 shadow-lg shadow-black/40">
            <img src={mark.src} alt="Shah G Tech" className="h-full w-full object-contain" />
          </div>
          <div className="hidden min-w-0 md:block">
            <div className="text-sm font-semibold text-white">Shah G Tech</div>
            <div className="truncate text-xs text-slate-400">{session.organisationName}</div>
          </div>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 pb-4">
          {visibleSections.map((section) => (
            <div key={section.label ?? 'root'}>
              {section.label ? (
                <div className="hidden px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 md:block">
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
                      className={`relative flex items-center justify-center gap-2.5 rounded-lg px-2.5 py-2.5 text-[13px] transition-colors md:justify-start ${
                        active
                          ? 'bg-emerald-500/10 font-medium text-emerald-300'
                          : 'text-slate-300 hover:bg-white/5 hover:text-white'
                      }`}
                    >
                      {active ? (
                        <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-emerald-400" />
                      ) : null}
                      <Icon name={item.icon} className={active ? 'text-emerald-400' : 'text-slate-500'} />
                      <span className="hidden md:inline">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="hidden border-t border-white/10 px-5 py-4 md:block">
          {me.data ? (
            <div className="mb-2 text-xs text-slate-400">
              Signed in as{' '}
              <span className="font-medium text-slate-200">
                {ROLE_LABELS[me.data.role] ?? me.data.role}
              </span>
            </div>
          ) : null}
          <button
            className="text-xs text-slate-500 transition-colors hover:text-white"
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
      <main className="min-w-0 flex-1 bg-slate-100/70 bg-gradient-to-br from-sky-50 via-slate-100/70 to-emerald-50/40 p-4 md:p-6 lg:p-8">
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
    <div className="mx-auto max-w-lg rounded-2xl bg-white p-8 text-center shadow-sm ring-1 ring-slate-900/5">
      <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-slate-100">
        <Icon name="settings" className="text-slate-400" />
      </div>
      <h1 className="mt-4 text-lg font-semibold text-slate-900">Not part of your work here</h1>
      {/*
        Names the role rather than the permission. "You need payroll.read" is
        a message written for whoever built the app; "signed in as Technician"
        is one the person can act on — they know who to ask.
      */}
      <p className="mt-2 text-sm text-slate-600">
        You are signed in as{' '}
        <span className="font-medium text-slate-900">
          {me ? (ROLE_LABELS[me.role] ?? me.role) : 'a member'}
        </span>
        , and this screen is not part of that role. If you need it, the shop owner can
        change your role under Team.
      </p>
      <Link
        href="/"
        className="mt-5 inline-flex rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-800"
      >
        Back to Today
      </Link>
    </div>
  );
}
