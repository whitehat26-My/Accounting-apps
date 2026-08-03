'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { rm } from '@/lib/display';
import { Button, Card, ErrorNote, Input, Skeleton } from '@/components/ui';

/**
 * Bill approvals: the queue of spends waiting for a yes.
 *
 * Two-person control, enforced server-side: the person who entered a bill
 * cannot approve it, and a REJECT ends the matter with a reason. This screen
 * only surfaces the queue — every rule lives in the domain.
 */

interface PendingBill {
  billId: string;
  internalRef: string;
  billNo: string;
  supplierName: string;
  amount: string;
  outstanding: { sequence: number; requiredRole: string }[];
}

export default function ApprovalsPage() {
  const queryClient = useQueryClient();

  const pending = useQuery({
    queryKey: ['approvals'],
    queryFn: () => api<{ pending: PendingBill[] }>('/v1/approvals'),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['approvals'] });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Approvals</h1>

      <Card title="Waiting for a decision">
        {pending.data ? (
          pending.data.pending.length > 0 ? (
            <div className="space-y-3">
              {pending.data.pending.map((bill) => (
                <ApprovalRow key={bill.billId} bill={bill} onDecided={refresh} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-500">
              Nothing waiting. Bills appear here when an approval rule catches them.
            </p>
          )
        ) : (
          <Skeleton />
        )}
      </Card>
    </div>
  );
}

function ApprovalRow({ bill, onDecided }: { bill: PendingBill; onDecided: () => void }) {
  const [comment, setComment] = useState('');
  const nextStep = bill.outstanding[0];

  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api(`/v1/bills/${bill.billId}/approval`, {
        method: 'POST',
        body: {
          sequence: nextStep!.sequence,
          decision,
          ...(comment.trim() !== '' ? { comment } : {}),
        },
      }),
    onSuccess: onDecided,
  });

  return (
    <div className="rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{bill.supplierName}</span>
          <span className="ml-2 text-sm text-slate-500">
            {bill.billNo} · {bill.internalRef}
          </span>
        </div>
        <span className="font-semibold">{rm(bill.amount)}</span>
      </div>
      {nextStep ? (
        <p className="mt-1 text-xs text-slate-500">
          Step {nextStep.sequence}: needs a {nextStep.requiredRole.toLowerCase().replace('_', ' ')}
          {bill.outstanding.length > 1 ? ` (then ${bill.outstanding.length - 1} more)` : ''}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Input
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Comment (kept with the decision)"
          className="w-64"
        />
        <Button onClick={() => decide.mutate('APPROVE')} disabled={decide.isPending}>
          Approve
        </Button>
        <Button onClick={() => decide.mutate('REJECT')} disabled={decide.isPending}>
          Reject
        </Button>
      </div>
      {decide.isError ? <ErrorNote error={decide.error} /> : null}
    </div>
  );
}
