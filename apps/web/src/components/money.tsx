'use client';

import { useEffect, useRef, useState } from 'react';
import { rm } from '@/lib/display';

/**
 * A ringgit figure that counts to its new value when it changes.
 *
 * ---------------------------------------------------------------------------
 * NUMBERS HERE ARE MOTION, NOT MONEY.
 *
 * This file `Number()`s a decimal string, which the house rule (CLAUDE.md
 * rule 2, and the header of lib/display.ts) forbids for anything that IS an
 * amount. The same carve-out charts.tsx claims for pixels applies here for
 * frames: the parsed value drives the INTERMEDIATE frames of the animation
 * only, and the final, resting frame always renders `rm(value)` from the
 * exact server string. An interpolated float is on screen for at most 500ms
 * and is never the number anybody reads, copies, or reconciles against.
 * ---------------------------------------------------------------------------
 *
 * Behavioural rules, each doing a job:
 *
 *   - Animates only on CHANGE, not on mount. A dashboard that counts every
 *     tile up from zero on arrival is a slot machine; one where the takings
 *     figure rolls upward the moment a sale lands is a shop keeping score.
 *     (This also makes the dashboard's 60s `refetchInterval` free: an
 *     unchanged value re-arriving does nothing.)
 *   - Under prefers-reduced-motion the new value simply appears.
 *   - A placeholder ('—') or non-numeric value renders as-is, untouched.
 */
export function Money({
  value,
  className = '',
  delta = false,
}: {
  value: string;
  className?: string;
  /**
   * Show the CHANGE alongside the new figure for a moment: `+RM 399.00`.
   *
   * Opt-in, because every animation in this app has to earn its place. On the
   * takings tile it is the whole point — a sale lands and the shop watches the
   * day grow by the amount of it. On a balance sheet line it would be noise
   * attached to a figure nobody is watching in real time.
   */
  delta?: boolean;
}) {
  const [text, setText] = useState(() => (isDecimal(value) ? rm(value) : value));
  const [moved, setMoved] = useState<string | null>(null);
  const previous = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    const settled = isDecimal(value) ? rm(value) : value;
    const changed = from !== value && isDecimal(from) && isDecimal(value);

    /*
     * The delta chip is raised HERE, in the same effect that consumes
     * `previous.current`, and not in one of its own.
     *
     * A second effect looked tidier and could never have worked: React runs
     * effects in declaration order, so this one has already overwritten
     * `previous.current` with `value` before any later effect reads it — the
     * chip would have compared a value against itself and never appeared.
     *
     * It renders a SUBTRACTION, which is where 0.1 + 0.2 lives, so it is
     * fixed to two places before it is ever shown. It is also deliberately
     * transient: a notification that something moved, never a figure anybody
     * reconciles against. The authoritative amount is the one beside it, and
     * that is always the server's own string.
     */
    if (delta && changed) {
      const difference = Number(value) - Number(from);
      if (Math.abs(difference) >= 0.005) {
        setMoved(`${difference > 0 ? '+' : '−'}${rm(Math.abs(difference).toFixed(2))}`);
      }
    }

    if (
      !changed ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      setText(settled);
      return;
    }

    const start = Number(from);
    const end = Number(value);
    const startedAt = performance.now();
    const DURATION = 500;

    const tick = (now: number) => {
      const t = Math.min((now - startedAt) / DURATION, 1);
      if (t >= 1) {
        // The resting frame is the server's string, exactly — never the float.
        setText(settled);
        return;
      }
      const eased = 1 - Math.pow(1 - t, 3);
      setText(rm((start + (end - start) * eased).toFixed(2)));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [value]);

  /* The chip is a glance, not a status line: it clears itself. */
  useEffect(() => {
    if (moved === null) return;
    const timer = setTimeout(() => setMoved(null), 2600);
    return () => clearTimeout(timer);
  }, [moved]);

  if (!delta) return <span className={className}>{text}</span>;

  /*
   * THE CHIP IS OUT OF FLOW, AND THAT IS NOT A DETAIL.
   *
   * Laid out inline it took real width, which wrapped "RM 3,262.55" onto two
   * lines and grew the tile — so a sale landing shoved the entire dashboard
   * down for 2.6 seconds and then snapped it back. An animation whose whole
   * job is to say "this figure moved" must not move everything else to say it.
   *
   * `absolute left-full` parks it in the gap beside the figure: zero width in
   * the layout, nothing to reflow, and `whitespace-nowrap` on the wrapper
   * keeps the amount itself on one line whether the chip is up or not.
   */
  return (
    <span className="relative inline-flex items-baseline whitespace-nowrap">
      <span className={className}>{text}</span>
      {moved ? (
        <span
          /*
           * Hidden below `sm`. Out of flow means out of the CARD too, and on a
           * 390px phone the tiles are ~170px wide — the chip would hang past
           * the viewport and give the counter phone a horizontal scrollbar.
           * A back-office dashboard is where anyone watches a figure land
           * anyway; the phone still gets the number, which is the part that
           * matters.
           */
          className={`emil-rise absolute left-full top-1/2 ml-2 hidden -translate-y-1/2 rounded-full px-1.5 py-0.5 text-xs font-semibold sm:block ${
            moved.startsWith('+')
              ? 'bg-positive-soft text-positive'
              : 'bg-negative-soft text-negative'
          }`}
        >
          {moved}
        </span>
      ) : null}
    </span>
  );
}

function isDecimal(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}
