import { z } from 'zod';

/**
 * The scalar shapes every request in this API is built from.
 *
 * ---------------------------------------------------------------------------
 * `decimal` EXISTED IN FIVE CONTROLLERS. FOUR WERE IDENTICAL AND ONE WAS NOT.
 *
 * `accounting`, `banking`, `collections` and `ledger` all used
 * `/^-?\d+(\.\d{1,4})?$/`. `items` used `/^\d+(\.\d{1,4})?$/` — no leading
 * minus — which is CORRECT for an item price and is backed by a database
 * constraint, so it is not a mistake.
 *
 * The problem is that both were called `decimal`. A reader comparing two
 * controllers cannot tell a deliberate narrowing from a typo, and neither can
 * a generated client: the same name meant two constraints, so a client built
 * from one would send values the other rejects.
 *
 * So the narrowing gets its own name. `decimal` accepts a sign,
 * `positiveDecimal` does not, and a route says which it means.
 * ---------------------------------------------------------------------------
 */

/**
 * Money on the wire.
 *
 * ---------------------------------------------------------------------------
 * A DECIMAL STRING. NEVER A JSON NUMBER.
 *
 * A JSON number is an IEEE-754 double, so `0.1 + 0.2` is `0.30000000000000004`
 * and 92,233,720,368.54776 is the largest amount that survives a round trip
 * intact. An accounting API that accepts numbers has already lost, and it loses
 * silently — the value parses, the arithmetic runs, and the sen goes missing
 * somewhere nobody is looking.
 *
 * Four decimal places, matching `NUMERIC(19,4)` and `Money`'s minor-unit scale.
 * ---------------------------------------------------------------------------
 */
export const decimal = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, 'Money must be a decimal string with at most 4 decimal places')
  .describe('A decimal string, e.g. "1234.56". Never a JSON number — see the API guide.');

/** The same, refusing a negative. Prices and quantities. */
export const positiveDecimal = z
  .string()
  .regex(/^\d+(\.\d{1,4})?$/, 'Must be a non-negative decimal string')
  .describe('A non-negative decimal string, e.g. "1234.56".');

export const quantity = positiveDecimal.describe('A quantity as a decimal string, e.g. "2.5".');

/**
 * An accounting date.
 *
 * ISO on the wire and `DD/MM/YYYY` in the interface — CLAUDE.md §8. The two are
 * deliberately different: `01/02/2026` is the first of February to a Malaysian
 * reader and the second of January to an American one, and a wire format that
 * inherits that ambiguity produces invoices dated a month out with nothing to
 * detect it.
 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be YYYY-MM-DD')
  .describe('A date as YYYY-MM-DD. Displayed as DD/MM/YYYY; never sent that way.');

export const uuid = z.string().uuid().describe('A UUID.');

export const currencyCode = z
  .string()
  .length(3)
  .describe('An ISO 4217 alphabetic code. The base currency is MYR.');

/** Basis points. 1000 = 10%. Integer, because a percentage as a float rounds. */
export const basisPoints = z
  .number()
  .int()
  .min(0)
  .max(10_000)
  .describe('Basis points; 1000 is 10%.');

// ---------------------------------------------------------------------------
// Error responses
// ---------------------------------------------------------------------------

/**
 * The error envelope, which every failure in this API uses.
 *
 * Documented as a schema rather than described in prose because a client's
 * error handling is the part most likely to be written from the spec alone.
 */
export const errorResponse = z.object({
  error: z
    .string()
    .describe('A stable machine-readable code, e.g. `validation_failed`, `not_found`.'),
  message: z.string().describe('Human-readable. Safe to show a user; may be reworded.'),
  requestId: z
    .string()
    .describe('Quote this when reporting a problem. It keys the server-side log.'),
  detail: z.unknown().optional().describe('Structured context, shape varies by error.'),
});

export type ErrorResponse = z.infer<typeof errorResponse>;
