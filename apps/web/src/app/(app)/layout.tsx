'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearSession, loadSession, type Session } from '@/lib/api';
import { can, ROLE_LABELS, useMe } from '@/lib/me';
import { Icon } from '@/components/icons';
import { Assistant } from '@/components/assistant';

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
      { href: '/sales', label: 'Sales', icon: 'sales', needs: 'invoice.read' },
      { href: '/collections', label: 'Collections', icon: 'collections', needs: 'invoice.read' },
      { href: '/purchases', label: 'Purchases', icon: 'purchases', needs: 'bill.read' },
      { href: '/approvals', label: 'Approvals', icon: 'approvals', needs: 'bill.approve' },
      { href: '/banking', label: 'Banking', icon: 'banking', needs: 'bank.reconcile' },
      { href: '/insights', label: 'Insights', icon: 'insights', needs: 'report.read' },
      { href: '/reports', label: 'Reports', icon: 'reports', needs: 'report.read' },
    ],
  },
  {
    label: 'Manage',
    items: [
      { href: '/team', label: 'Team', icon: 'team', needs: 'user.read' },
      { href: '/settings', label: 'Settings', icon: 'settings', needs: 'tax.read' },
    ],
  },
];

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
      <aside className="flex w-16 flex-col bg-slate-950 text-slate-300 md:w-60">
        <div className="flex items-center justify-center gap-3 px-2 pb-5 pt-6 md:justify-start md:px-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-400 to-emerald-600 text-[13px] font-black tracking-tight text-slate-950 shadow-lg shadow-emerald-500/20">
            SG
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

      <main className="min-w-0 flex-1 bg-slate-100/70 p-4 md:p-6 lg:p-8">
        <div className="mx-auto max-w-5xl">{children}</div>
      </main>

      <Assistant />
    </div>
  );
}
