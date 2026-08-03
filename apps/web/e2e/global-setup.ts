import { execFileSync, execSync } from 'node:child_process';

/**
 * Provision the e2e database exactly as the API expects it in production:
 * migrated by a superuser, served to an unprivileged login role that inherits
 * `emil_app` and cannot bypass RLS. Mirrors packages/db/test/helpers.ts.
 *
 * `execFileSync` with argument arrays, never a shell string — the role-creation
 * DO block contains `$$`, which a shell mangles into its own PID.
 */
export default function globalSetup(): void {
  const db = 'emil_web_e2e';

  const psql = (sql: string, database = 'postgres') =>
    execFileSync(
      'psql',
      [`postgres://postgres@127.0.0.1:55432/${database}`, '-v', 'ON_ERROR_STOP=1', '-c', sql],
      { stdio: 'pipe' },
    );

  psql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  psql(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emil_app_login') THEN
          CREATE ROLE emil_app_login LOGIN NOBYPASSRLS;
      END IF;
  END $$;`);
  psql(`CREATE DATABASE ${db}`);

  execSync(`pnpm --filter @emil/db migrate`, {
    cwd: '../..',
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: `postgres://postgres@127.0.0.1:55432/${db}` },
  });

  psql(`GRANT emil_app TO emil_app_login`, db);
  psql(`GRANT CONNECT ON DATABASE ${db} TO emil_app_login`, db);
  psql(`GRANT USAGE ON SCHEMA public TO emil_app_login`, db);
}
