/**
 * The handful of primitives every screen shares.
 *
 * Hand-rolled rather than a component library: a few components cover this
 * app, and a registry of fifty would be dependency surface with no second
 * user. If the design system grows past what a file can hold, that is the
 * moment to adopt one — with this file as the shopping list.
 */

import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode, Ref } from 'react';

/*
 * `ref` IS A PROP HERE, AND THAT IS WHY THERE IS NO `forwardRef` IN THIS FILE.
 *
 * React 19 passes `ref` to a function component like any other prop, so the
 * `{...props}` spread each primitive already does carries it onto the DOM node
 * with nothing else required. What DOESN'T come for free is the type: the
 * `*HTMLAttributes` interfaces deliberately omit `ref`, so a caller passing one
 * is a compile error even though it would work perfectly at runtime — the worst
 * combination, because the fix looks like it needs a refactor and needs a word.
 *
 * The journals screen moves focus to "Post journal" when the pairing engine
 * completes an entry, which is what wanted this.
 */

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'ghost' | 'danger';
  ref?: Ref<HTMLButtonElement>;
}) {
  const styles = {
    primary:
      'bg-primary text-primary-ink shadow-sm shadow-primary/25 hover:brightness-110 active:brightness-95 disabled:bg-line disabled:text-ink-faint disabled:shadow-none',
    /*
     * The premium secondary: a crisp edge at rest, and it COMMITS on hover —
     * filling solid primary rather than nudging a grey a shade darker.
     *
     * Applied to the variant rather than to the three export buttons that
     * prompted it, because "Print", "CSV" and "Download proof pack" are not
     * special: they are what a secondary action is, and 51 of these exist. A
     * second lookalike variant for one screen is how two grammars of button
     * end up in one app.
     */
    ghost:
      'bg-surface-raised text-ink shadow-sm ring-1 ring-inset ring-line-strong transition-all '
      + 'hover:bg-primary hover:text-primary-ink hover:ring-primary hover:shadow-md hover:shadow-primary/25 '
      + 'disabled:text-ink-faint disabled:hover:bg-surface-raised disabled:hover:text-ink-faint '
      + 'disabled:hover:ring-line-strong disabled:hover:shadow-sm',
    danger: 'bg-negative text-surface-raised shadow-sm hover:brightness-110 disabled:bg-line disabled:text-ink-faint',
  }[variant];
  /*
   * `active:scale` gives a press somewhere to land — 0.98 is felt in the
   * finger without being seen from across the room. Guarded by
   * `motion-safe:` so a press stays perfectly still for people who asked
   * everything to. The focus ring is not optional the same way: it is how a
   * keyboard user knows where they are, and it was missing entirely.
   */
  return (
    <button
      className={`min-h-10 rounded-lg px-3.5 py-2 text-sm font-medium transition-[background-color,filter,transform,box-shadow] duration-150 motion-safe:active:scale-[0.98] disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

/** Loading placeholder: bars with a light sweep where the content will land. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="emil-shimmer h-4 rounded"
          style={{ width: `${[85, 60, 72, 48, 66][i % 5]}%` }}
        />
      ))}
    </div>
  );
}

export function Input(
  props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> },
) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border-0 bg-surface-raised px-3 py-2 text-sm text-ink shadow-sm ring-1 ring-inset ring-line-strong placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-brand ${props.className ?? ''}`}
    />
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  );
}

export function Card({
  title,
  action,
  children,
  className = '',
  style,
}: {
  title?: string;
  /** Optional right-aligned header content — a button, a badge, a date. */
  action?: ReactNode;
  children: ReactNode;
  /** Pages opt into entrance motion here — `emil-rise` plus a staggered
      `animationDelay` in `style`, the idiom charts.tsx established. */
  className?: string;
  style?: CSSProperties;
}) {
  return (
    /*
      `min-w-0` is not cosmetic — it is what lets the `overflow-x-auto` below
      ever run.

      Almost every card is a grid or flex child, and such a child's automatic
      minimum size is its CONTENT, not the track it sits in. So a card holding
      a table that wants 384px did not become 318px wide with a scrolling
      table inside it. It became 504px wide on a 390px phone, pushed past the
      screen edge, and took the whole page sideways with it — the one thing
      the scroll container exists to prevent. The container was never at fault;
      it simply had no shortfall to absorb, because its own box had grown to
      meet the content.

      `min-w-0` withdraws that permission. The card is then whatever the layout
      gives it, the overflow lands where it was always meant to, and the page
      itself holds still.
    */
    <div className={`min-w-0 rounded-2xl bg-surface-raised shadow-sm ring-1 ring-line ${className}`} style={style}>
      {/*
        `flex-wrap` on the header for the phone: several cards put date pickers
        or a filter in `action`, and on a 390px screen a title plus two date
        inputs cannot sit on one line — unwrapped they were clipped at the card
        edge and forced the whole page to render zoomed out. Wrapping drops the
        action onto its own line instead. `min-w-0` lets the title shrink rather
        than pushing the action out of the card.
      */}
      {title ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="min-w-0 text-sm font-semibold text-ink">{title}</h2>
          {action ?? null}
        </div>
      ) : null}
      {/*
        `overflow-x-auto` is what makes this usable on a phone, and it is HALF
        of the mechanism — the other half lives on the tables themselves.

        Every data table in the app sits in a Card, and all twenty-eight of them
        are `w-full`. That is a percentage, so on a 390px screen a table did not
        overflow this container and scroll: it SHRANK to fit it, and eight
        columns of figures shared 318px. Nothing was cut off, so nothing looked
        broken; the columns simply crushed until "RM 5,200.00" wrapped mid-figure
        and item names became "Sams 99…". A scroll container alone never fired,
        because there was never anything to scroll.

        So each table also carries a `min-w-[…]` sized by its column count —
        roughly 6rem a column past three, three columns being what fits a phone
        unaided. The minimum is below the width of any tablet or desktop card,
        so it changes nothing there; on a phone it is what turns squashing into
        scrolling, inside the card, with the page itself still.

        Safe on the body rather than around each table: no card contains an
        absolutely-positioned popover that this would clip.
      */}
      {/* `emil-scroll-cue` shows a soft edge on whichever side has more table
          out of view, and shows nothing at all when there is none. */}
      <div className="emil-scroll-cue overflow-x-auto p-5">{children}</div>
    </div>
  );
}

/**
 * A status chip.
 *
 * ---------------------------------------------------------------------------
 * FIVE TONES, NOT TWENTY-FIVE COLOURS.
 *
 * This mapped each of ~25 statuses to its own literal palette
 * (`bg-caution-soft text-caution ring-caution/30` …), which meant twenty-five
 * places to get night mode wrong and no way to see that DECLINED and CANCELLED
 * were meant to read the same. Statuses do not have twenty-five meanings; they
 * have five:
 *
 *   neutral   nothing is being asked of anybody yet
 *   waiting   the ball is in someone else's court
 *   working   in hand, in this shop, right now
 *   done      finished well
 *   stopped   finished badly, or refused
 *
 * The tone carries the meaning and the token carries the theme, so a status
 * added later picks a tone rather than inventing a colour.
 * ---------------------------------------------------------------------------
 */
type Tone = 'neutral' | 'waiting' | 'working' | 'done' | 'stopped';

const TONE: Record<Tone, string> = {
  neutral: 'bg-surface-sunken text-ink-muted ring-line',
  waiting: 'bg-caution-soft text-caution ring-caution/30',
  working: 'bg-brand/10 text-brand ring-brand/30',
  done: 'bg-positive-soft text-positive ring-positive/30',
  stopped: 'bg-negative-soft text-negative ring-negative/30',
};

const STATUS_TONE: Record<string, Tone> = {
  // Repairs
  RECEIVED: 'neutral', QUOTED: 'waiting', APPROVED: 'working',
  IN_PROGRESS: 'working', READY: 'done', COLLECTED: 'done',
  DECLINED: 'stopped', CANCELLED: 'stopped',
  // Invoices
  ISSUED: 'waiting', PART_PAID: 'waiting', PAID: 'done',
  // Periods and books
  ACTIVE: 'done', OPEN: 'done', CLOSED: 'waiting', LOCKED: 'neutral',
  // Quotes. DRAFT is neutral because a draft commits nobody; SENT waits on
  // someone else; EXPIRED stopped without anybody deciding.
  DRAFT: 'neutral', SENT: 'waiting', ACCEPTED: 'done',
  EXPIRED: 'neutral', INVOICED: 'working',
  // Audit
  MANUAL: 'working', REVERSAL: 'stopped',
  CREATE: 'done', UPDATE: 'working', DELETE: 'stopped',
};

/**
 * A table's header cell.
 *
 * ---------------------------------------------------------------------------
 * ONE COMPONENT, NOT NINETEEN COPIES OF FOUR UTILITIES.
 *
 * Headers and data used to be the same size and weight, so a table read as one
 * undifferentiated block and the eye had to re-find the columns on every
 * glance. Smaller, uppercase, tracked wider and muted separates the LABELS
 * from the FIGURES — which is the whole job of a header row.
 *
 * It is a component rather than a copied class string because there are
 * nineteen of these across reports and audit alone. Copied, the twentieth is
 * written slightly differently and a column quietly stops matching its
 * neighbours; nobody notices, because each table looks fine on its own.
 * ---------------------------------------------------------------------------
 */
export function Th({
  children,
  align = 'left',
}: {
  children?: ReactNode;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      className={`pb-2 text-xs font-semibold uppercase tracking-wider text-ink-faint ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

export function Badge({ status }: { status: string }) {
  return (
    <span
      // `whitespace-nowrap`: a status is one word to the reader even when it is
      // two on the page. Without it "IN PROGRESS" breaks across two lines and
      // spills out of its own pill the moment the column is narrow.
      // Bolder and wider than a label: in a column of a hundred audit rows the
      // action is the thing being SCANNED for, so it has to be findable at
      // arm's length rather than merely readable up close.
      className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-bold tracking-wide ring-1 ring-inset ${
        TONE[STATUS_TONE[status] ?? 'neutral']
      }`}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <p className="rounded-lg bg-negative-soft px-3 py-2 text-sm text-negative ring-1 ring-inset ring-negative/30">
      {message}
    </p>
  );
}
