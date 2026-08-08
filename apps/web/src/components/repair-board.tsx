'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { displayDate } from '@/lib/display';
import { ErrorNote, Skeleton } from '@/components/ui';
import { useFlip } from '@/components/board';
import { useNotice } from '@/components/notice';

/**
 * The workshop, laid out the way the workshop is.
 *
 * ---------------------------------------------------------------------------
 * A BOARD YOU CANNOT DRAG, AND THAT IS THE DESIGN.
 *
 * Every kanban board invites dragging a card to the last column. Here the last
 * column would be "Collected", and dropping a card on it would hand a repaired
 * device back with the work unbilled — which the domain refuses outright
 * (`COLLECT_IS_NOT_A_STATUS_CHANGE`) because the INVOICE is the collection.
 * So the board does not pretend to offer it.
 *
 * What it does offer is the two transitions that genuinely are nothing but a
 * status: "start work" and "ready". Those need no quote, no reason, no
 * signature and no money, and they are the two a technician performs most
 * often — each currently costing a trip into the job screen and back. Every
 * other move stays where the evidence gates and the state machine live.
 *
 * That decision is also what makes the motion honest: a card travels because
 * somebody moved the work, not because a screen wanted to look busy.
 * ---------------------------------------------------------------------------
 */

interface Card {
  id: string;
  jobNo: string;
  deviceDescription: string;
  deviceSerial: string | null;
  reportedFault: string;
  status: string;
  receivedOn: string;
  customerName: string | null;
  ageDays: number;
  intakePhotoCount: number;
  intakeSignatureCount: number;
  warranty: { soldOn: string; expiresOn: string; status: string } | null;
}

/**
 * The five columns are the OPEN statuses, in the order work flows.
 *
 * DECLINED, COLLECTED and CANCELLED are deliberately absent: a board is for
 * what is still in the building. Finished jobs live in their own list below,
 * where they can be found without taking width from the work in hand.
 */
const COLUMNS = [
  { status: 'RECEIVED', label: 'Just in' },
  { status: 'QUOTED', label: 'Quoted' },
  { status: 'APPROVED', label: 'Approved' },
  { status: 'IN_PROGRESS', label: 'On the bench' },
  { status: 'READY', label: 'Ready' },
] as const;

/** The only two moves a card can make from here. See the note above. */
const ADVANCE: Record<string, { to: string; label: string } | undefined> = {
  APPROVED: { to: 'IN_PROGRESS', label: 'Start work' },
  IN_PROGRESS: { to: 'READY', label: 'Mark ready' },
};

export function RepairBoard() {
  const notice = useNotice();
  const queryClient = useQueryClient();
  const board = useQuery({
    queryKey: ['repair-board'],
    queryFn: () => api<{ cards: Card[] }>('/v1/repairs/board'),
  });

  const advance = useMutation({
    // `to`, not `status` — the field the route's schema actually validates.
    // Sending the wrong name cost a 422 that the board swallowed in silence,
    // which is why the error is now rendered rather than merely handled.
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api(`/v1/repairs/${id}/status`, { method: 'POST', body: { to } }),
    onSuccess: (_data, { to }) => {
      // The card visibly travels, so this is not the primary feedback — it is
      // the announced one, and the one that survives reduced motion, where
      // the card simply appears in its new column with nothing to notice.
      notice.ok(to === 'IN_PROGRESS' ? 'On the bench' : 'Ready for collection');
      void queryClient.invalidateQueries({ queryKey: ['repair-board'] });
      // The flat list and the bench-profit card read the same jobs.
      void queryClient.invalidateQueries({ queryKey: ['repairs'] });
    },
  });

  const cards = board.data?.cards ?? [];
  const open = cards.filter((c) => COLUMNS.some((col) => col.status === c.status));

  /*
   * The FLIP key is the ARRANGEMENT, not the array. Keying on `cards` would
   * re-measure on every refetch — including the ones that change nothing —
   * and any scroll or resize between them would then read as a movement.
   */
  const arrangement = open.map((c) => `${c.id}:${c.status}`).join('|');
  const container = useFlip(arrangement);

  /*
   * `hidden lg:block` on EVERY branch, not only the board itself.
   *
   * The phone has its own list below, so a board that showed its skeleton or
   * its empty state on a phone would be saying the same thing twice — once
   * emptily, once usefully.
   */
  if (board.isLoading) {
    return (
      <div className="hidden rounded-2xl bg-surface-raised p-4 shadow-sm ring-1 ring-line lg:block">
        <Skeleton rows={4} />
      </div>
    );
  }

  if (open.length === 0) {
    return (
      <div className="hidden rounded-2xl bg-surface-raised p-8 text-center shadow-sm ring-1 ring-line lg:block">
        <p className="text-sm text-ink-muted">
          Nothing in the workshop. Devices taken in appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="hidden lg:block">
      {/*
        A REFUSAL HAS TO BE VISIBLE.

        The server refuses transitions for real reasons — a closed period, a
        job somebody else already moved, an evidence gate. Without this the
        card simply does not move and the technician presses the button
        harder. Found exactly that way: a wrong field name made every press a
        silent 422.
      */}
      <ErrorNote error={advance.error} />
      {/*
       * Columns SHARE the width and only scroll when they genuinely cannot
       * fit. Fixed 16rem columns overflowed the shell's own max-width on every
       * desktop, so the board arrived permanently scrolled sideways with its
       * last column off-screen — a board you cannot see all of is a list.
       */}
      <div ref={container} className="flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map((column) => {
        const inColumn = open.filter((c) => c.status === column.status);
        return (
          <section
            key={column.status}
            aria-label={column.label}
            className="flex min-w-44 flex-1 basis-0 flex-col rounded-2xl bg-surface-sunken p-2"
          >
            <header className="flex items-baseline justify-between px-1.5 pb-2 pt-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {column.label}
              </h2>
              <span className="text-xs tabular-nums text-ink-faint">{inColumn.length}</span>
            </header>
            <div className="space-y-2">
              {inColumn.map((card) => (
                <JobCard
                  key={card.id}
                  card={card}
                  onAdvance={(to) => advance.mutate({ id: card.id, to })}
                  busy={advance.isPending && advance.variables?.id === card.id}
                />
              ))}
              {inColumn.length === 0 ? (
                <p className="px-1.5 py-3 text-xs text-ink-faint">Empty</p>
              ) : null}
            </div>
          </section>
        );
      })}
      </div>
    </div>
  );
}

function JobCard({
  card, onAdvance, busy,
}: {
  card: Card;
  onAdvance: (to: string) => void;
  busy: boolean;
}) {
  const move = ADVANCE[card.status];
  // Quoting is refused without an intake photograph. Saying so on the board
  // saves the walk back to a device already put down.
  const needsPhoto = card.status === 'RECEIVED' && card.intakePhotoCount === 0;
  const covered = card.warranty !== null && card.warranty.status !== 'EXPIRED';

  return (
    <article
      data-flip-id={card.id}
      className="emil-rise rounded-xl bg-surface-raised p-3 shadow-sm ring-1 ring-line"
    >
      <Link href={`/repairs/job?id=${card.id}`} className="block">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs tabular-nums text-ink-faint">{card.jobNo}</span>
          <Age days={card.ageDays} />
        </div>
        <p className="mt-0.5 text-sm font-medium leading-snug text-ink">
          {card.deviceDescription}
        </p>
        {card.customerName ? (
          <p className="mt-0.5 truncate text-xs text-ink-muted">{card.customerName}</p>
        ) : null}
        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-ink-muted">
          {card.reportedFault}
        </p>

        {covered && card.warranty ? (
          <p className="mt-2 rounded-md bg-positive-soft px-2 py-1 text-[11px] font-medium text-positive">
            {/* The flash the technician needs BEFORE quoting: this is a device
                the shop sold and still owes something on. */}
            Ours — warranty to {displayDate(card.warranty.expiresOn)}
          </p>
        ) : null}

        {needsPhoto ? (
          <p className="mt-2 rounded-md bg-caution-soft px-2 py-1 text-[11px] font-medium text-caution">
            Photograph it before quoting
          </p>
        ) : null}
      </Link>

      {move ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAdvance(move.to)}
          className="mt-2.5 w-full rounded-lg bg-surface-sunken px-2 py-1.5 text-xs font-medium text-ink-muted transition-colors hover:bg-line hover:text-ink disabled:opacity-60"
        >
          {busy ? 'Moving…' : move.label}
        </button>
      ) : null}
    </article>
  );
}

/**
 * How long it has been here.
 *
 * Colour is earned, not decorative: a device sitting a fortnight is the thing
 * a workshop loses money and goodwill on, and the board is the only place
 * anybody would notice. The thresholds are deliberately generous — a repair
 * waiting on a part legitimately takes a week.
 */
function Age({ days }: { days: number }) {
  if (days <= 0) return <span className="text-[11px] text-ink-faint">today</span>;
  const tone =
    days >= 14 ? 'text-negative' : days >= 7 ? 'text-caution' : 'text-ink-faint';
  return (
    <span className={`text-[11px] tabular-nums ${tone}`}>
      {days}d
    </span>
  );
}
