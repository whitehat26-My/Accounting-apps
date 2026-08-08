'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * The app's one channel for "that happened".
 *
 * ---------------------------------------------------------------------------
 * TWO GAPS, AND THEY ARE THE SAME GAP.
 *
 * The app told you when something FAILED — `ErrorNote`, beside the form — and
 * told you nothing at all when something WORKED. The screen changed and you
 * inferred it. Meanwhile four places still called `window.alert`, which is a
 * modal browser box thrown up at a counter with a customer waiting, and which
 * the shop cannot style, cannot stack, and cannot ignore.
 *
 * Both are the same missing thing: somewhere for the application to say a
 * short sentence that is not attached to a field.
 *
 * IT IS ALSO THE ANNOUNCEMENT CHANNEL, which is the real reason it is one
 * component rather than a banner per screen. Before the till's change-due
 * panel there were ZERO live regions in this app — every confirmation was
 * available only to someone looking directly at the right part of the screen.
 * A single mount means every notice is announced by construction, rather than
 * by whoever adds the next screen remembering to.
 *
 * WHAT THIS IS NOT: a replacement for `ErrorNote`. A validation failure
 * belongs beside the field that caused it, where the person is already
 * looking — moving those into a corner of the screen would be a downgrade
 * dressed as a feature. This is for what happens AWAY from the form: a PDF
 * that would not open, a job that moved on the board, a sale that landed.
 * ---------------------------------------------------------------------------
 */

type Tone = 'success' | 'failure';

interface Notice {
  id: number;
  tone: Tone;
  message: string;
}

interface NoticeApi {
  /** Something worked. Short and factual — never a cheer. */
  ok: (message: string) => void;
  /**
   * Something did not. Announced assertively; it interrupts on purpose.
   *
   * `context` says what was being ATTEMPTED, and it is not optional politeness.
   * A rejected `fetch` says "Failed to fetch", which tells the shop nothing —
   * it does not name the receipt, the warranty card or the report that did not
   * arrive. The caller knows; the error does not. "Could not open the receipt
   * — Failed to fetch" is a sentence somebody can act on.
   */
  error: (error: unknown, context?: string) => void;
}

const NoticeContext = createContext<NoticeApi | null>(null);

/**
 * Success clears itself; failure lingers.
 *
 * A confirmation you missed cost you nothing — the thing still happened, and
 * the screen already shows it. A failure you missed means you believe a
 * receipt printed when it did not, so it stays until it is dismissed or
 * pushed out by something newer.
 */
const CLEAR_AFTER_MS = 4200;

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setNotices((current) => current.filter((n) => n.id !== id));
  }, []);

  const push = useCallback(
    (tone: Tone, message: string) => {
      const id = nextId.current++;
      // Newest first, and capped: a failing loop must not paper the screen.
      setNotices((current) => [{ id, tone, message }, ...current].slice(0, 3));
      if (tone === 'success') {
        setTimeout(() => dismiss(id), CLEAR_AFTER_MS);
      }
    },
    [dismiss],
  );

  const api = useMemo<NoticeApi>(
    () => ({
      ok: (message) => push('success', message),
      error: (error, context) => {
        const reason = error instanceof Error ? error.message : String(error);
        push('failure', context === undefined ? reason : `${context} — ${reason}`);
      },
    }),
    [push],
  );

  return (
    <NoticeContext.Provider value={api}>
      {children}
      {/*
        `pointer-events-none` on the stack, restored on each notice: the layer
        spans the corner of the screen, and a shop that cannot click the button
        underneath an invisible container would be a worse bug than the one
        this fixes.
      */}
      {/*
        `sm:bottom-20` clears the assistant's launcher, which sits at
        bottom-right and was being covered by the first notice — a shop that
        rings three sales in a row would have lost the button entirely. On a
        phone the notices go bottom-CENTRE, where nothing else lives.
      */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:bottom-20 sm:right-5 sm:items-end sm:p-0">
        {notices.map((notice) => (
          <div
            key={notice.id}
            /*
             * `status`/polite waits for a gap in what the screen reader is
             * already saying; `alert`/assertive interrupts. A confirmation
             * that talked over the till's change-due announcement would be
             * exactly backwards.
             */
            role={notice.tone === 'success' ? 'status' : 'alert'}
            aria-live={notice.tone === 'success' ? 'polite' : 'assertive'}
            className={`emil-rise pointer-events-auto flex max-w-sm items-start gap-3 rounded-xl px-3.5 py-2.5 text-sm shadow-lg ring-1 ring-inset ${
              notice.tone === 'success'
                ? 'bg-positive-soft text-positive ring-positive/30'
                : 'bg-negative-soft text-negative ring-negative/30'
            }`}
          >
            <span className="min-w-0 flex-1">{notice.message}</span>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(notice.id)}
              className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </NoticeContext.Provider>
  );
}

/**
 * Never throws when there is no provider.
 *
 * A missing provider would otherwise turn a failed PDF download — already the
 * unhappy path — into a blank screen, which is the one outcome worse than the
 * alert box this replaces. It returns a no-op instead, and the static demo
 * build (which renders components outside the app shell) keeps working.
 */
export function useNotice(): NoticeApi {
  return useContext(NoticeContext) ?? NO_NOTICES;
}

const NO_NOTICES: NoticeApi = { ok: () => undefined, error: () => undefined };
