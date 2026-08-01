import type { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Parse a request body, or fail with a 422 naming every problem.
 *
 * Reports ALL issues rather than the first. A client fixing one field at a time
 * across four round trips is a bad experience, and the same reasoning already
 * governs `validateJournalEntry` in the domain, which reports every violation
 * in one pass.
 *
 * ---------------------------------------------------------------------------
 * IT ALSO STRIPS `undefined` VALUES, RECURSIVELY, AND THAT IS NOT COSMETIC.
 *
 * The repository compiles with `exactOptionalPropertyTypes`, which distinguishes
 * a MISSING property from one that is present and `undefined`. The service
 * signatures in `packages/db` are written the strict way — `readonly dueDate?:
 * string`, never `string | undefined` — because an optional field that arrives
 * as a literal `undefined` is a field that can be written to a column as one.
 *
 * Zod produces the loose shape for every `.optional()`, and JSON bodies produce
 * present-and-undefined keys for everything a client omitted. Normalising here,
 * at the single boundary where untrusted input becomes typed input, is far
 * safer than a cast at each of a dozen call sites — a cast silences the checker
 * without changing the value.
 * ---------------------------------------------------------------------------
 */
export function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): Exact<z.infer<T>> {
  const result = schema.safeParse(body);

  if (!result.success) {
    throw new ValidationError(
      'The request body is not valid',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  return stripUndefined(result.data) as Exact<z.infer<T>>;
}

/** Recursively drop `undefined` values from plain objects and arrays. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item)) as unknown as T;
  }

  // Only plain objects. A Date or a Buffer must pass through untouched.
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) out[key] = stripUndefined(item);
  }
  return out as T;
}

/**
 * The `exactOptionalPropertyTypes` shape of a type: every `k?: T | undefined`
 * becomes `k?: T`, recursively.
 */
export type Exact<T> = T extends readonly (infer E)[]
  ? readonly Exact<E>[]
  : T extends Date
    ? T
    : T extends object
      ? { [K in RequiredKeys<T>]: Exact<T[K]> } & {
          [K in OptionalKeys<T>]?: Exact<Exclude<T[K], undefined>>;
        }
      : T;

type RequiredKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? never : K;
}[keyof T];

type OptionalKeys<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never;
}[keyof T];
