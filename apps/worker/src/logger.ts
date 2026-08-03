/**
 * Structured logging, on stdout, with no dependency.
 *
 * One line of JSON per event, because a worker's output is read by a log
 * aggregator far more often than by a person, and a human-friendly format that
 * has to be reparsed downstream is friendly to nobody.
 *
 * ---------------------------------------------------------------------------
 * NOTHING TENANT-IDENTIFYING BEYOND THE TENANT ID, AND NO PAYLOADS.
 *
 * The relay handles every tenant's events in one process, so its log is the one
 * place in the system where every organisation's activity is interleaved. An
 * event payload carries invoice numbers and amounts; a customer name would
 * carry more. Logs are the least access-controlled store an application has —
 * shipped to a third party, searched by anyone on call, retained for years —
 * so the payload stays in the database, where RLS still applies to it, and the
 * log carries identifiers a person can look up if they are entitled to.
 * ---------------------------------------------------------------------------
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, detail?: Record<string, unknown>): void;
  info(message: string, detail?: Record<string, unknown>): void;
  warn(message: string, detail?: Record<string, unknown>): void;
  error(message: string, detail?: Record<string, unknown>): void;
}

export function createLogger(
  minimum: LogLevel = 'info',
  sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const emit = (level: LogLevel, message: string, detail?: Record<string, unknown>) => {
    if (RANK[level] < RANK[minimum]) return;
    sink(
      JSON.stringify({
        level,
        message,
        // ISO-8601 UTC. Deliberately not Asia/Kuala_Lumpur: display dates are
        // local per CLAUDE.md §8, but a log timestamp is correlated against
        // other systems and must be unambiguous.
        at: new Date().toISOString(),
        ...detail,
      }),
    );
  };

  return {
    debug: (m, d) => emit('debug', m, d),
    info: (m, d) => emit('info', m, d),
    warn: (m, d) => emit('warn', m, d),
    error: (m, d) => emit('error', m, d),
  };
}

/** Captures lines instead of writing them. For tests. */
export function createTestLogger(): Logger & { readonly lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger('debug', (line) => {
    lines.push(JSON.parse(line) as Record<string, unknown>);
  });
  return Object.assign(logger, { lines });
}
