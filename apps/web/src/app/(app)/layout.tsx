'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearSession, loadSession, type Session } from '@/lib/api';
import { can, ROLE_LABELS, useMe } from '@/lib/me';

/**
 * The signed-in shell: nav on the left, screen on the right.
 *
 * The nav is ROLE-AWARE: each entry names the permission that makes it
 * meaningful, and entries the signed-in user does not hold are simply not
 * rendered. The cashier sees Today and the till; the technician sees the
 * bench; the boss sees everything. This is courtesy, not security — the
 * client-side check only spares people doors they cannot open, and every
 * request behind those doors is authorised again by the API.
 */

const NAV: { href: string; label: string; needs: string | null }[] = [
  { href: '/', label: 'Today', needs: null },
  { href: '/pos', label: 'Point of sale', needs: 'pos.sale' },
  { href: '/repairs', label: 'Repairs', needs: 'repair.read' },
  { href: '/stock', label: 'Stock', needs: 'stock.read' },
  { href: '/items', label: 'Items', needs: 'item.read' },
  { href: '/banking', label: 'Banking', needs: 'bank.reconcile' },
  { href: '/insights', label: 'Insights', needs: 'report.read' },
  { href: '/team', label: 'Team', needs: 'user.read' },
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

  const visible = NAV.filter(
    (item) => item.needs === null || can(me.data, item.needs),
  );

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-52 flex-col border-r border-neutral-200 bg-white p-4">
        <div className="mb-6">
          <div className="text-lg font-bold text-emerald-800">Emil</div>
          <div className="truncate text-xs text-neutral-500">{session.organisationName}</div>
          {me.data ? (
            <div className="mt-1 inline-block rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600">
              {ROLE_LABELS[me.data.role] ?? me.data.role}
            </div>
          ) : null}
        </div>
        <nav className="space-y-1">
          {visible.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`block rounded-md px-3 py-2 text-sm ${
                pathname === item.href
                  ? 'bg-emerald-50 font-medium text-emerald-800'
                  : 'text-neutral-700 hover:bg-neutral-100'
              }`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <button
          className="mt-auto rounded-md px-3 py-2 text-left text-sm text-neutral-500 hover:bg-neutral-100"
          onClick={() => {
            clearSession();
            router.push('/login');
          }}
        >
          Sign out
        </button>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
