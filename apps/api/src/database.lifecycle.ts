import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Sql } from '@emil/db';
import { SQL } from './tokens.js';

/**
 * Close the connection pool when the application shuts down.
 *
 * ---------------------------------------------------------------------------
 * THE POOL WAS NEVER CLOSED, AND NOTHING NOTICED UNTIL NOW.
 *
 * `createClient()` is handed to Nest through a `useFactory`, and a factory's
 * return value gets no lifecycle hooks — a plain object has no
 * `onApplicationShutdown` for Nest to call. So `app.close()` tore down the HTTP
 * server and left the PostgreSQL connections open.
 *
 * In production that is a graceful shutdown that is not graceful: a deploy
 * severs live connections mid-query instead of draining them, and PostgreSQL
 * holds the backends until they time out.
 *
 * It surfaced in the test suite, where one file drops its database while the
 * previous file's pool is still connected — the dropped database then raises
 * an asynchronous connection error attributed to whichever file happens to be
 * running. That is a symptom, not the bug; the bug is a resource this process
 * opens and never releases.
 * ---------------------------------------------------------------------------
 */
@Injectable()
export class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  async onApplicationShutdown(): Promise<void> {
    // `{ timeout: 5 }` drains in-flight queries rather than severing them, and
    // gives up after five seconds so a stuck query cannot block a deploy.
    await this.sql.end({ timeout: 5 });
  }
}
