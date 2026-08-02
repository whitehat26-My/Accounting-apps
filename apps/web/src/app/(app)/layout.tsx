'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { clearSession, loadSession, type Session } from '@/lib/api';

/**
 * The signed-in shell: nav on the left, screen on the right.
 *
 * The auth check is a client-side redirect, not security — every request the
 * screens make is authenticated by the API, and this only spares a signed-out
 * user a page of failed queries.
 */

const NAV = [
  { href: '/', label: 'Today' },
  { href: '/pos', label: 'Point of sale' },
  { href: '/repairs', label: 'Repairs' },
  { href: '/stock', label: 'Stock' },
  { href: '/items', label: 'Items' },
];

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [session, setSession] = useState<Session | null | undefined>(undefined);

  useEffect(() => {
    const current = loadSession();
    if (!current) {
      router.replace('/login');
      return;
    }
    setSession(current);
  }, [router]);

  if (session === undefined || session === null) return null;

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-52 flex-col border-r border-neutral-200 bg-white p-4">
        <div className="mb-6">
          <div className="text-lg font-bold text-emerald-800">Emil</div>
          <div className="truncate text-xs text-neutral-500">{session.organisationName}</div>
        </div>
        <nav className="space-y-1">
          {NAV.map((item) => (
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
