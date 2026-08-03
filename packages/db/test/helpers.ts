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

/**
 * The role the WORKER connects as.
 *
 * Separate from the application role on purpose, and the separation is the
 * thing worth testing. `emil_worker` holds EXECUTE on the SECURITY DEFINER
 * functions that read the outbox across every tenant; `emil_app`, which is what
 * the internet-facing API connects as, does not. A suite that drove the relay
 * through the app connection would prove the relay works and prove nothing
 * about the boundary — and would quietly pass if the GRANT were widened.
 */
const WORKER_LOGIN_ROLE = 'emil_worker_login';

export interface TestDatabase {
  /** Connected as the unprivileged application role. Subject to RLS. */
  readonly sql: Sql;
  /** Connected as the owner. Used for provisioning only. */
  readonly admin: Sql;
  /**
   * Connected as the worker role: `emil_app` plus EXECUTE on the outbox and
   * scheduler claim functions. Still unprivileged, still subject to RLS for
   * every ordinary query.
   */
  readonly worker: Sql;
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
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${WORKER_LOGIN_ROLE}') THEN
              CREATE ROLE ${WORKER_LOGIN_ROLE} LOGIN NOBYPASSRLS;
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
      GRANT emil_worker TO ${WORKER_LOGIN_ROLE};
      GRANT CONNECT ON DATABASE ${dbName} TO ${WORKER_LOGIN_ROLE};
      GRANT USAGE ON SCHEMA public TO ${WORKER_LOGIN_ROLE};
  `);

  const appUrl = adminUrl.replace('//postgres@', `//${APP_LOGIN_ROLE}@`);
  const sql = createClient(appUrl);
  const worker = createClient(adminUrl.replace('//postgres@', `//${WORKER_LOGIN_ROLE}@`));

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
    worker,
    drop: async () => {
      await sql.end();
      await worker.end();
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
  readonly supplierId: string;
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
      // Carries the closing-rate adjustment to receivables. Presented on the
      // same SOFP line as AR — see packages/domain/src/revaluation.ts.
      ['1190', 'AR Currency Revaluation', 'ASSET'],
      ['6910', 'Unrealised Foreign Exchange Gain/Loss', 'EXPENSE'],
      // The payables mirrors of 1190 and 1100's revaluation pairing.
      ['2090', 'AP Currency Revaluation', 'LIABILITY'],
      // Recoverable input tax. Under SST this is the EXCEPTION — input tax is
      // normally absorbed as a cost — but the account has to exist for the
      // RECOVERABLE branch of buildPurchaseJournal to be exercisable at all.
      ['1150', 'SST Claimable', 'ASSET'],
      // Withholding retained from a payment and owed to LHDN until remitted.
      ['2200', 'Withholding Tax Payable', 'LIABILITY'],
      // Money a customer has paid and the gateway has not yet settled to the
      // bank. Deliberately NOT tagged 'cash_and_bank': whether funds in transit
      // from a payment provider present as a cash equivalent or as other
      // receivables under MPERS is a presentation question for the reporting
      // framework, and the ACCOUNT_TYPE catch-all keeps it on the SOFP either
      // way. Flagged rather than decided here.
      ['1200', 'Undeposited Funds', 'ASSET'],
      // What the gateway keeps. An expense in its own right — see
      // buildGatewayFeeJournal on why it is never netted into revenue.
      ['6100', 'Payment Gateway Fees', 'EXPENSE'],
      // Perpetual inventory: the shelf as an asset, its relief on sale, and
      // the line shrinkage posts to so it stays visible (0026).
      ['1300', 'Inventory on Hand', 'ASSET'],
      ['5100', 'Cost of Goods Sold', 'EXPENSE'],
      ['5900', 'Stock Shrinkage', 'EXPENSE'],
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

    // A full twelve-month calendar. January is LOCKED so period-lock behaviour
    // has something to test against; the rest are open.
    const monthEnds = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const periodIds: Record<number, string> = {};

    for (let month = 1; month <= 12; month++) {
      const mm = String(month).padStart(2, '0');
      const [period] = await tx<{ id: string }[]>`
          INSERT INTO fiscal_period (tenant_id, fiscal_year_id, sequence, start_date, end_date, status)
          VALUES (${tenantId}, ${year!.id}, ${month},
                  ${`2026-${mm}-01`}, ${`2026-${mm}-${monthEnds[month - 1]}`},
                  ${month === 1 ? 'LOCKED' : 'OPEN'})
          RETURNING id
      `;
      periodIds[month] = period!.id;
    }

    const openPeriod = { id: periodIds[8]! };
    const lockedPeriod = { id: periodIds[1]! };

    await tx`
        INSERT INTO number_sequence (tenant_id, document_type, prefix, next_value, padding)
        VALUES (${tenantId}, 'JOURNAL', 'JE-', 1, 5),
               (${tenantId}, 'INVOICE', 'INV-', 1, 5),
               (${tenantId}, 'PAYMENT', 'PAY-', 1, 5),
               (${tenantId}, 'CREDIT_NOTE', 'CN-', 1, 5),
               (${tenantId}, 'BILL', 'BILL-', 1, 5),
               (${tenantId}, 'DEBIT_NOTE', 'DN-', 1, 5)
    `;

    // Which account plays which structural role.
    await tx`
        INSERT INTO posting_account_map (tenant_id, role, account_id)
        VALUES (${tenantId}, 'AR',           ${accounts['1100']!}),
               (${tenantId}, 'AP',           ${accounts['2000']!}),
               (${tenantId}, 'SST_PAYABLE',  ${accounts['2100']!}),
               (${tenantId}, 'FX_GAIN_LOSS',   ${accounts['6900']!}),
               (${tenantId}, 'AR_REVALUATION', ${accounts['1190']!}),
               (${tenantId}, 'UNREALISED_FX',  ${accounts['6910']!}),
               (${tenantId}, 'AP_REVALUATION', ${accounts['2090']!}),
               (${tenantId}, 'SST_CLAIMABLE',  ${accounts['1150']!}),
               (${tenantId}, 'WHT_PAYABLE',    ${accounts['2200']!}),
               (${tenantId}, 'UNDEPOSITED_FUNDS', ${accounts['1200']!}),
               (${tenantId}, 'GATEWAY_FEE',       ${accounts['6100']!}),
               -- Where a closed year's profit is carried. In the CHECK since
               -- 0002 and mapped by nothing until the year-end close existed.
               (${tenantId}, 'RETAINED_EARNINGS', ${accounts['3000']!}),
               (${tenantId}, 'INVENTORY',       ${accounts['1300']!}),
               (${tenantId}, 'COGS',            ${accounts['5100']!}),
               (${tenantId}, 'STOCK_SHRINKAGE', ${accounts['5900']!})
    `;

    // Tags let the GLOBAL statement templates address this chart without
    // knowing its ids or numbering. The AR revaluation account carries the same
    // tag as the AR control account, so both present on one SOFP line.
    await tx`
        INSERT INTO account_tag (tenant_id, account_id, tag)
        VALUES (${tenantId}, ${accounts['1000']!}, 'cash_and_bank'),
               (${tenantId}, ${accounts['1100']!}, 'trade_receivables'),
               (${tenantId}, ${accounts['1190']!}, 'trade_receivables'),
               (${tenantId}, ${accounts['2000']!}, 'trade_payables'),
               (${tenantId}, ${accounts['2100']!}, 'trade_payables'),
               (${tenantId}, ${accounts['2200']!}, 'trade_payables'),
               (${tenantId}, ${accounts['1150']!}, 'trade_receivables'),
               (${tenantId}, ${accounts['2090']!}, 'ap_revaluation')
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

    // A RECOVERABLE code. FIXTURES ONLY, and deliberately not representative:
    // under SST input tax is normally a COST. This exists so the recoverable
    // branch of buildPurchaseJournal has something to exercise it, and so the
    // "recoverable without a claimable account" failure can be provoked.
    const [rec] = await tx<{ id: string }[]>`
        INSERT INTO tax_code (tenant_id, code, name, regime, input_treatment)
        VALUES (${tenantId}, 'SST-REC', 'Recoverable input tax', 'SST_SALES', 'RECOVERABLE')
        RETURNING id
    `;
    taxCodes['SST-REC'] = rec!.id;

    await tx`
        INSERT INTO tax_rate_version (tenant_id, tax_code_id, rate_basis_points, valid_from, valid_to)
        VALUES (${tenantId}, ${rec!.id}, 600, '2018-09-01', NULL)
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

    // A supplier. Separate from the customer on purpose: a single contact
    // flagged as both would let a test accidentally settle a bill against an
    // invoice and still look green.
    const [supplier] = await tx<{ id: string }[]>`
        INSERT INTO contact (tenant_id, name, is_supplier, tin, id_type, id_value,
                             payment_terms_days, default_currency)
        VALUES (${tenantId}, 'Selangor Supplies Sdn Bhd', TRUE, 'C1234567890',
                'BRN', '201901019876', 30, 'MYR')
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
      supplierId: supplier!.id,
    };
  });
}
