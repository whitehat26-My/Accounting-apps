import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createClient, withTenant, type Sql } from '../src/client.js';
import { migrate } from '../src/migrate.js';

export const ADMIN_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:55432/postgres';

/**
 * The login role the tests use for anything that must be subject to RLS.
 *
 * This matters more than it looks. PostgreSQL superusers — and any role with
 * BYPASSRLS — ignore row-level security entirely, INCLUDING `FORCE ROW LEVEL
 * SECURITY`. A test suite that connects as the `postgres` superuser will watch
 * every isolation assertion pass while the policies do nothing at all.
 *
 * So: provisioning runs as the owner, and every assertion runs as an
 * unprivileged role that mirrors how the application actually connects.
 */
const APP_LOGIN_ROLE = 'emil_app_login';

export interface TestDatabase {
  /** Connected as the unprivileged application role. Subject to RLS. */
  readonly sql: Sql;
  /** Connected as the owner. Used for provisioning only. */
  readonly admin: Sql;
  readonly drop: () => Promise<void>;
}

export async function createTestDatabase(name: string): Promise<TestDatabase> {
  const dbName = `emil_test_${name}_${Date.now().toString(36)}`;
  const cluster = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });

  await cluster.unsafe(`
      DO $$
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_LOGIN_ROLE}') THEN
              CREATE ROLE ${APP_LOGIN_ROLE} LOGIN NOBYPASSRLS;
          END IF;
      END $$;
  `);
  await cluster.unsafe(`CREATE DATABASE ${dbName}`);
  await cluster.end();

  const adminUrl = ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
  await migrate(adminUrl);

  const admin = createClient(adminUrl);
  await admin.unsafe(`
      GRANT emil_app TO ${APP_LOGIN_ROLE};
      GRANT CONNECT ON DATABASE ${dbName} TO ${APP_LOGIN_ROLE};
      GRANT USAGE ON SCHEMA public TO ${APP_LOGIN_ROLE};
  `);

  const appUrl = adminUrl.replace('//postgres@', `//${APP_LOGIN_ROLE}@`);
  const sql = createClient(appUrl);

  // Guard the guard: if this ever connects with RLS-bypassing privileges, every
  // isolation test below becomes meaningless. Fail loudly instead.
  const [priv] = await sql<{ superuser: boolean; bypassrls: boolean }[]>`
      SELECT rolsuper AS superuser, rolbypassrls AS bypassrls
        FROM pg_roles WHERE rolname = current_user
  `;
  if (priv?.superuser || priv?.bypassrls) {
    throw new Error(
      `Test client connected as a privileged role (${JSON.stringify(priv)}). ` +
        'RLS would be bypassed and the isolation tests would pass vacuously.',
    );
  }

  return {
    sql,
    admin,
    drop: async () => {
      await sql.end();
      await admin.end();
      const cleanup = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export interface Tenant {
  readonly tenantId: string;
  readonly userId: string;
  readonly periodId: string;
  readonly lockedPeriodId: string;
  readonly accounts: Record<string, string>;
  readonly taxCodes: Record<string, string>;
  readonly customerId: string;
}

/**
 * Provision one organisation: a minimal Malaysian chart of accounts, a
 * financial year with an open and a locked period, and document sequences.
 *
 * Runs on the ADMIN connection — tenant provisioning is an elevated operation
 * in production too, not something a tenant session performs on itself.
 */
export async function seedTenant(admin: Sql, name = 'Emil Demo Sdn Bhd'): Promise<Tenant> {
  const tenantId = randomUUID();
  const userId = randomUUID();

  return withTenant(admin, { tenantId }, async (tx) => {
    await tx`
        INSERT INTO organisation (id, name, base_currency, fye_month,
                                  reporting_framework, sst_registered, sst_no)
        VALUES (${tenantId}, ${name}, 'MYR', 12, 'MPERS', TRUE, 'W10-1808-32000123')
    `;

    const chart: [string, string, string][] = [
      ['1000', 'Cash and Bank', 'ASSET'],
      ['1100', 'Accounts Receivable', 'ASSET'],
      ['2000', 'Accounts Payable', 'LIABILITY'],
      ['2100', 'SST Payable', 'LIABILITY'],
      ['3000', 'Retained Earnings', 'EQUITY'],
      ['4000', 'Sales Revenue', 'INCOME'],
      ['5000', 'Cost of Sales', 'EXPENSE'],
      ['6000', 'Office Expenses', 'EXPENSE'],
      ['6900', 'Foreign Exchange Gain/Loss', 'EXPENSE'],
    ];

    const accounts: Record<string, string> = {};
    for (const [code, accountName, type] of chart) {
      const [row] = await tx<{ id: string }[]>`
          INSERT INTO account (tenant_id, code, name, type)
          VALUES (${tenantId}, ${code}, ${accountName}, ${type})
          RETURNING id
      `;
      accounts[code] = row!.id;
    }

    const [year] = await tx<{ id: string }[]>`
        INSERT INTO fiscal_year (tenant_id, label, start_date, end_date)
        VALUES (${tenantId}, 'FY2026', '2026-01-01', '2026-12-31')
        RETURNING id
    `;

    const [openPeriod] = await tx<{ id: string }[]>`
        INSERT INTO fiscal_period (tenant_id, fiscal_year_id, sequence, start_date, end_date, status)
        VALUES (${tenantId}, ${year!.id}, 8, '2026-08-01', '2026-08-31', 'OPEN')
        RETURNING id
    `;

    const [lockedPeriod] = await tx<{ id: string }[]>`
        INSERT INTO fiscal_period (tenant_id, fiscal_year_id, sequence, start_date, end_date, status)
        VALUES (${tenantId}, ${year!.id}, 1, '2026-01-01', '2026-01-31', 'LOCKED')
        RETURNING id
    `;

    await tx`
        INSERT INTO number_sequence (tenant_id, document_type, prefix, next_value, padding)
        VALUES (${tenantId}, 'JOURNAL', 'JE-', 1, 5),
               (${tenantId}, 'INVOICE', 'INV-', 1, 5),
               (${tenantId}, 'PAYMENT', 'PAY-', 1, 5),
               (${tenantId}, 'CREDIT_NOTE', 'CN-', 1, 5)
    `;

    // Which account plays which structural role.
    await tx`
        INSERT INTO posting_account_map (tenant_id, role, account_id)
        VALUES (${tenantId}, 'AR',           ${accounts['1100']!}),
               (${tenantId}, 'AP',           ${accounts['2000']!}),
               (${tenantId}, 'SST_PAYABLE',  ${accounts['2100']!}),
               (${tenantId}, 'FX_GAIN_LOSS', ${accounts['6900']!})
    `;

    // Tax codes. FIXTURES ONLY — not authoritative Malaysian rates. The point
    // is to exercise rate versioning across a change date, not to assert what
    // the statutory rate is. Real values come from a verified seed.
    const taxCodes: Record<string, string> = {};

    const [svc] = await tx<{ id: string }[]>`
        INSERT INTO tax_code (tenant_id, code, name, regime, input_treatment)
        VALUES (${tenantId}, 'SST-SVC', 'Service tax', 'SST_SERVICE', 'COST')
        RETURNING id
    `;
    taxCodes['SST-SVC'] = svc!.id;

    await tx`
        INSERT INTO tax_rate_version (tenant_id, tax_code_id, rate_basis_points, valid_from, valid_to)
        VALUES (${tenantId}, ${svc!.id}, 600, '2018-09-01', '2024-02-29'),
               (${tenantId}, ${svc!.id}, 800, '2024-03-01', NULL)
    `;

    const [none] = await tx<{ id: string }[]>`
        INSERT INTO tax_code (tenant_id, code, name, regime, input_treatment)
        VALUES (${tenantId}, 'NONE', 'Out of scope', 'NONE', 'COST')
        RETURNING id
    `;
    taxCodes['NONE'] = none!.id;

    const [customer] = await tx<{ id: string }[]>`
        -- TIN shape is a FIXTURE, not an assertion about the real format.
        -- The authoritative check is LHDN's TIN lookup; the local pattern is
        -- configurable per tenant precisely because this cannot be asserted here.
        INSERT INTO contact (tenant_id, name, is_customer, tin, id_type, id_value,
                             payment_terms_days, default_currency)
        VALUES (${tenantId}, 'Nusantara Retail Sdn Bhd', TRUE, 'C9876543210',
                'BRN', '202301012345', 30, 'MYR')
        RETURNING id
    `;

    return {
      tenantId,
      userId,
      periodId: openPeriod!.id,
      lockedPeriodId: lockedPeriod!.id,
      accounts,
      taxCodes,
      customerId: customer!.id,
    };
  });
}
