-- =============================================================================
-- 0033_technician
--
-- The bench role: repairs and stock, never money.
--
-- -----------------------------------------------------------------------------
-- The shop this system serves has five people: the boss, a cashier, two
-- technicians, and a technician who doubles as the accountant. The existing
-- roles cover four of them — OWNER, SALES (the counter), ACCOUNTANT — but a
-- pure technician had no honest role: SALES can ring sales and see invoices,
-- READ_ONLY sees the whole ledger. A technician needs to work a repair job,
-- look up a part and its shelf quantity, and read the customer's name off the
-- job — and NOTHING with a ringgit sign on it.
--
-- Deliberately absent: pos.sale (the bench does not take money), invoice.read
-- (prices and margins are not bench business), report.read, stock.adjust
-- (found-a-discrepancy goes through someone who answers for shrinkage).
-- Repair pricing stays safe because the repair module already frozen-quotes
-- prices at approval and money only moves at collection — which is an invoice,
-- which a TECHNICIAN cannot raise.
-- -----------------------------------------------------------------------------

/* Ranks stay distinct — the domain test insists, because two roles sharing a
   rank could grant each other. TECHNICIAN slots below SALES; the read-only
   roles shift down one. */
UPDATE app_role SET rank = 8 WHERE code = 'EXTERNAL_AUDITOR';
UPDATE app_role SET rank = 7 WHERE code = 'READ_ONLY';

INSERT INTO app_role (code, name, description, rank) VALUES
    ('TECHNICIAN', 'Technician',
     'Repair jobs, parts and stock levels; no sales, no money, no reports', 6);

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('TECHNICIAN', 'repair.read'),
    ('TECHNICIAN', 'repair.write'),
    ('TECHNICIAN', 'item.read'),
    ('TECHNICIAN', 'stock.read'),
    ('TECHNICIAN', 'contact.read');

-- -----------------------------------------------------------------------------
-- The team page needs two narrow definer functions, in the 0012 style:
-- `app_user` has no direct SELECT for emil_app, and that stays true.
-- -----------------------------------------------------------------------------

/*
 * The members of the CURRENT tenant, with the email and name that make the
 * list readable. Derives the tenant from the session setting rather than
 * taking one — the property that makes it safe: a caller cannot name a tenant
 * they are not already operating as, and with no tenant set it returns
 * nothing.
 */
CREATE OR REPLACE FUNCTION members_of_current_tenant()
RETURNS TABLE (
    membership_id UUID,
    user_id       UUID,
    email         TEXT,
    full_name     TEXT,
    role_code     TEXT,
    status        TEXT,
    expires_at    TIMESTAMPTZ,
    joined_at     TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT m.id, m.user_id, u.email, u.full_name, m.role_code, m.status,
           m.expires_at, m.joined_at
      FROM membership m
      JOIN app_user u ON u.id = m.user_id
     WHERE m.tenant_id = current_tenant_id()
     ORDER BY m.joined_at
$$;

/*
 * Resolve an email to a user id, for "add my cashier by email". Returns only
 * the id — no name, no status detail — and the route gating it requires
 * `user.manage`, so the only people who can probe are the ones who can
 * already see the member list.
 */
CREATE OR REPLACE FUNCTION user_id_for_email(p_email TEXT)
RETURNS UUID
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
    SELECT u.id FROM app_user u
     WHERE lower(u.email) = lower(p_email) AND u.status = 'ACTIVE'
$$;

GRANT EXECUTE ON FUNCTION members_of_current_tenant() TO emil_app;
GRANT EXECUTE ON FUNCTION user_id_for_email(TEXT)     TO emil_app;
