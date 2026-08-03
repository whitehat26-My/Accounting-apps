'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Button, Card, ErrorNote, Field, Input, Skeleton } from '@/components/ui';
import { can, ROLE_LABELS, useMe } from '@/lib/me';

/**
 * Team: who works here, and what each of them can see.
 *
 * Built for a five-person shop: the boss, a cashier, technicians, and the
 * accountant. Staff register their own account first; the boss adds them
 * here by email and picks the role. The server enforces the rank rule — you
 * can never grant a role above your own.
 */

interface Member {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
}

/** The roles a shop actually assigns, with what they mean at the counter. */
const ASSIGNABLE_ROLES = [
  { code: 'SALES', hint: 'The till: ring sales, take payments, handle repairs at the counter. No reports, no bank.' },
  { code: 'TECHNICIAN', hint: 'The bench: repair jobs, parts, stock levels. Never sees money.' },
  { code: 'ACCOUNTANT', hint: 'Full books: ledger, bank, reports, closing. Cannot manage the team.' },
  { code: 'ADMIN', hint: 'Everything except deleting the organisation.' },
  { code: 'READ_ONLY', hint: 'Sees everything, changes nothing.' },
];

export default function TeamPage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('SALES');

  const members = useQuery({
    queryKey: ['members'],
    queryFn: () => api<{ members: Member[] }>('/v1/auth/members'),
  });

  const add = useMutation({
    mutationFn: () => api('/v1/auth/members', { method: 'POST', body: { email, role } }),
    onSuccess: () => {
      setEmail('');
      void queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });

  const manages = can(me.data, 'user.manage');

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Team</h1>

      <Card title="Who has access">
        {members.data ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2">Name</th>
                <th className="pb-2">Email</th>
                <th className="pb-2">Role</th>
                <th className="pb-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {members.data.members.map((m) => (
                <tr key={m.membershipId} className="border-t border-slate-100">
                  <td className="py-2 font-medium">{m.fullName}</td>
                  <td className="py-2 text-slate-500">{m.email}</td>
                  <td className="py-2">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium">
                      {ROLE_LABELS[m.role] ?? m.role}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-slate-500">{m.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Skeleton />
        )}
      </Card>

      {manages ? (
        <Card title="Add someone">
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              They register their own account first (the normal sign-up page), then you add
              their email here and choose what they can see.
            </p>
            <Field label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="cashier@example.com"
              />
            </Field>
            <Field label="Role">
              <div className="space-y-2">
                {ASSIGNABLE_ROLES.map((r) => (
                  <label key={r.code} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="radio"
                      name="role"
                      checked={role === r.code}
                      onChange={() => setRole(r.code)}
                      className="mt-1"
                    />
                    <span>
                      <span className="text-sm font-medium">{ROLE_LABELS[r.code]}</span>
                      <span className="block text-xs text-slate-500">{r.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Field>
            <Button onClick={() => add.mutate()} disabled={email.length === 0 || add.isPending}>
              {add.isPending ? 'Adding…' : 'Add to team'}
            </Button>
            {add.isError ? <ErrorNote error={add.error} /> : null}
            {add.isSuccess ? (
              <p className="text-sm text-emerald-700">Added. They can sign in now.</p>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
