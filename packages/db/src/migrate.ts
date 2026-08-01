/**
 * Forward-only migration runner.
 *
 * Runs as the schema owner, NOT as `emil_app` — the application role has no
 * DDL rights and no BYPASSRLS. Each file runs in its own transaction and is
 * recorded in `schema_migration`, so re-running is a no-op.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export async function migrate(connectionString: string): Promise<string[]> {
  const sql = postgres(connectionString, { max: 1, onnotice: () => {} });
  const applied: string[] = [];

  try {
    await sql`
        CREATE TABLE IF NOT EXISTS schema_migration (
            filename   TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `;

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const filename of files) {
      const done = await sql`SELECT 1 FROM schema_migration WHERE filename = ${filename}`;
      if (done.length > 0) continue;

      const contents = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
        await tx`INSERT INTO schema_migration (filename) VALUES (${filename})`;
      });

      applied.push(filename);
    }
  } finally {
    await sql.end();
  }

  return applied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const applied = await migrate(url);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date');
}
