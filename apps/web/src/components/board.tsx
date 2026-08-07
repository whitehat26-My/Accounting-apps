'use client';

import { useLayoutEffect, useRef } from 'react';

/**
 * FLIP — the technique, in one hook.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A CSS TRANSITION.
 *
 * A card that changes column changes PARENT. There is no CSS transition
 * between two positions in two different subtrees: the browser unmounts the
 * node from one column and paints it in the other, and the eye is left to
 * work out that the thing which vanished on the left is the thing which
 * appeared on the right.
 *
 * FLIP does the only thing that works. Remember where every card was (First),
 * let React move them (Last), compute the delta and put each card visually
 * back where it started with a transform (Invert), then animate the transform
 * away (Play). The layout is already correct the whole time — only the paint
 * is lying, and only for 420ms.
 *
 * TWO PROPERTIES THIS DELIBERATELY KEEPS:
 *
 *  1. It animates `transform` ONLY. No width, no top, no margin — nothing that
 *     forces layout on every frame. The workshop runs this on a shop PC.
 *  2. Under `prefers-reduced-motion` it does nothing at all, and "nothing" is
 *     the CORRECT result rather than a degraded one: the board is already in
 *     its final state before the animation starts, so skipping it leaves the
 *     card exactly where it belongs. The Playwright journeys run with reduced
 *     motion forced, which is what proves that.
 * ---------------------------------------------------------------------------
 */

/** A moved card travels; a card that merely re-rendered must not twitch. */
const MOVED_ENOUGH_PX = 1;

export function useFlip(dependency: unknown) {
  const container = useRef<HTMLDivElement | null>(null);
  const previous = useRef(new Map<string, DOMRect>());

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;

    const cards = root.querySelectorAll<HTMLElement>('[data-flip-id]');
    const reduce =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const next = new Map<string, DOMRect>();
    for (const card of cards) {
      const id = card.dataset['flipId'];
      if (id === undefined) continue;

      const last = card.getBoundingClientRect();
      next.set(id, last);

      const first = previous.current.get(id);
      // No remembered position means the card is NEW — it fades in through
      // `emil-rise` instead. Travelling from nowhere is not a movement.
      if (!first || reduce) continue;

      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (Math.abs(dx) < MOVED_ENOUGH_PX && Math.abs(dy) < MOVED_ENOUGH_PX) continue;

      card.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
        {
          duration: 420,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          // The Web Animations API composites this off the main thread and
          // tears it down itself, so there is no inline style to clean up and
          // nothing left behind if the component unmounts mid-flight.
          composite: 'replace',
        },
      );
    }

    previous.current = next;
  }, [dependency]);

  return container;
}
