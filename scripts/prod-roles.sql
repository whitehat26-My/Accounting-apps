-- Production login roles, idempotent. Mirrors what the test harness does
-- (packages/db/test/helpers.ts) so production runs the shape the suite proves.
--
-- Migrations create emil_app and emil_worker as NOLOGIN group roles and grant
-- them everything they hold. Nothing connects AS a group role: each service
-- gets its own LOGIN role that inherits one group, so a leaked API credential
-- carries the API's permissions and nothing more — in particular, never the
-- worker's cross-tenant definer functions. NOBYPASSRLS is stated, not
-- assumed: these are the roles row-level security exists to constrain.
--
-- Run as the schema owner AFTER migrations, with the passwords in psql vars:
--   psql "$DATABASE_URL" \
--     -v app_password="'$EMIL_APP_PASSWORD'" \
--     -v worker_password="'$EMIL_WORKER_PASSWORD'" \
--     -f scripts/prod-roles.sql

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emil_app_login') THEN
        CREATE ROLE emil_app_login LOGIN NOBYPASSRLS IN ROLE emil_app;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'emil_worker_login') THEN
        CREATE ROLE emil_worker_login LOGIN NOBYPASSRLS IN ROLE emil_worker;
    END IF;

    EXECUTE format('GRANT CONNECT ON DATABASE %I TO emil_app_login',    current_database());
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO emil_worker_login', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO emil_app_login;
GRANT USAGE ON SCHEMA public TO emil_worker_login;

-- Re-runs rotate the passwords — that is the point of running it again.
ALTER ROLE emil_app_login    PASSWORD :app_password;
ALTER ROLE emil_worker_login PASSWORD :worker_password;
