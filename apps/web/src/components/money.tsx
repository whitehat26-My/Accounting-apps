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
export function Money({ value, className = '' }: { value: string; className?: string }) {
  const [text, setText] = useState(() => (isDecimal(value) ? rm(value) : value));
  const previous = useRef(value);
  const frame = useRef(0);

  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    const settled = isDecimal(value) ? rm(value) : value;

    if (
      from === value ||
      !isDecimal(from) ||
      !isDecimal(value) ||
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

  return <span className={className}>{text}</span>;
}

function isDecimal(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value);
}
