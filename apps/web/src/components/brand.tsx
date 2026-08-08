'use client';

import { useEffect, useRef, useState } from 'react';
import { APP_NAME, BRAND_MARK, initialsOf } from '@/lib/brand';

/**
 * Track whether an optional image failed to load — including when it failed
 * BEFORE React was watching.
 *
 * `onError` alone is not enough and the difference is invisible until somebody
 * renders it. These pages are server-rendered, so the browser begins fetching
 * `<img src>` while parsing the HTML; for a file that is simply absent the
 * error event has already fired and gone by the time React hydrates and
 * attaches a handler. The result is the worst of both: no fallback, and the
 * browser's own broken-image glyph sitting in the middle of the sign-in page.
 *
 * The effect therefore asks the element directly. `complete` with a
 * `naturalWidth` of 0 is precisely "finished, and there is no image" — the one
 * reliable way to read a load that ended before the listener existed.
 */
function useImageFallback() {
  const ref = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);

  return { ref, failed, onError: () => setFailed(true) };
}

export { useImageFallback };

/**
 * The installation's mark, or its initials when there is no image.
 *
 * The image lives in `public/` and may simply not be there — an operator who
 * never supplies a logo is the NORMAL case, not an error case, so this leans
 * on `onError` rather than on the file existing. A 404 flips one piece of
 * state and the initials take over; nothing logs, nothing warns, and no broken
 * image icon is ever shown.
 *
 * Two letters on a tile is a real mark rather than a placeholder, which is why
 * there is deliberately no bundled default image to fall back to. Shipping one
 * would put whoever's logo it is onto every other company's sign-in page —
 * exactly the defect that migration 0050 removed from the printed documents.
 */
/**
 * The bare glyph, with no tile behind it — the small mark beside the product
 * name at the foot of the rail. On a 404 it removes itself and the name stands
 * alone, which at 16px and 60% opacity is no loss at all; the initials tile
 * used by `BrandMark` would be heavier than what it decorates.
 */
export function BrandGlyph({ className = '' }: { className?: string }) {
  const { ref, failed, onError } = useImageFallback();
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={BRAND_MARK}
      alt=""
      className={failed ? 'hidden' : className}
      onError={onError}
    />
  );
}

export function BrandMark({ className = 'h-11 w-11', textClass = 'text-sm' }: {
  className?: string;
  textClass?: string;
}) {
  const { ref, failed, onError } = useImageFallback();
  const initials = initialsOf(APP_NAME);

  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-plate p-1.5 shadow-lg shadow-black/40 ${className}`}
    >
      {failed ? (
        <span className={`font-bold tracking-tight text-plate-ink ${textClass}`}>
          {initials || '·'}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={ref}
          src={BRAND_MARK}
          alt=""
          className="h-full w-full object-contain"
          onError={onError}
        />
      )}
    </div>
  );
}
