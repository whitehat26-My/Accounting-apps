/**
 * Typed result union for *expected* failures.
 *
 * Convention for this codebase (see CLAUDE.md):
 *   - Expected, recoverable failures  -> `Result`
 *   - Programmer errors (bugs)        -> thrown exceptions
 *
 * An unbalanced journal entry submitted by a user is expected. Adding MYR to
 * USD is a bug. The two must not be handled by the same mechanism.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}

/** Unwrap, throwing on error. Use in tests and at trusted boundaries only. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw new Error(`unwrap() on an error result: ${JSON.stringify(r.error)}`);
}
