-- ---------------------------------------------------------------------------
-- The six accounts a month-end adjustment actually lands in.
--
-- `DEFAULT_CHART` gained Prepayments, Fixed Assets, Accumulated Depreciation,
-- Accrued Expenses, Depreciation and Bank Charges, because the journal pairing
-- engine names accounts by CODE and a rule pointing at a code nobody has is a
-- rule that never fires. That change only reaches tenants onboarded from now
-- on. This is the same six for everybody already here.
--
-- WHY A MIGRATION RATHER THAN A ROUTE. Account creation is already an API call,
-- so a shop could add these by hand — six times, correctly spelled, with the
-- right type, in every tenant. The pairing rules key on the exact codes, so
-- "1450" or "Prepaid" produces a chart that looks right and an engine that
-- stays silent forever with nothing to explain why. Getting it uniform is the
-- entire point, and uniform across tenants is something only a migration can
-- do: the API is scoped to one tenant by RLS and cannot see the others.
--
-- Migrations run as a role that bypasses RLS (asserted by 0021), which is what
-- makes the cross-tenant INSERT below legal here and impossible from the API.
--
-- IDEMPOTENT, and not merely by convention. `NOT EXISTS` on (tenant_id, code)
-- rather than ON CONFLICT DO NOTHING, because a tenant may already have created
-- their own account at one of these codes — with their own name for it, and
-- postings against it. Skipping theirs is right; overwriting the name of an
-- account that already has history in it is not.
-- ---------------------------------------------------------------------------

INSERT INTO account (tenant_id, code, name, type)
SELECT o.id, seed.code, seed.name, seed.type
  FROM organisation o
 CROSS JOIN (
     VALUES
         ('1400', 'Prepayments',              'ASSET'),
         ('1500', 'Fixed Assets — at Cost',   'ASSET'),
         -- Contra-asset: it holds a credit balance and nets against 1500.
         -- `buildBalanceSheet` sums assets debit-positive, so this needs no
         -- special handling to present the way a reader expects.
         ('1590', 'Accumulated Depreciation', 'ASSET'),
         ('2400', 'Accrued Expenses',         'LIABILITY'),
         ('6300', 'Depreciation',             'EXPENSE'),
         ('6400', 'Bank Charges',             'EXPENSE')
 ) AS seed(code, name, type)
 WHERE NOT EXISTS (
     SELECT 1 FROM account a
      WHERE a.tenant_id = o.id AND a.code = seed.code
 );

-- No statement tags, deliberately. Every tag in use (`cash_and_bank`,
-- `trade_receivables`, `trade_payables`, `ap_revaluation`) changes how a report
-- classifies the account: `trade_payables` on an accrual files a non-trade
-- liability under trade payables, and `trade_receivables` on a prepayment calls
-- it a debt owed to the shop. cash-flow.ts states that anything less than
-- certain is left to explicit configuration. These are less than certain.
