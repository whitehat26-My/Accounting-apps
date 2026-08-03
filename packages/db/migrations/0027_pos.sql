-- =============================================================================
-- 0027_pos
--
-- Point of sale: the counter operation.
--
-- -----------------------------------------------------------------------------
-- WHAT A CASH SALE IS, AND WHAT IT IS NOT.
--
-- A walk-in customer pays at the till. In accounting terms that is an invoice
-- and its receipt happening in the same breath — and this migration adds NO
-- new document type for it, deliberately. `recordCashSale` composes the two
-- writers that already exist (`issueInvoice`, `recordReceipt`) inside one
-- transaction, so every rule they enforce — SST at the right rate version,
-- gapless numbering, COGS at weighted average, the AR subledger invariant —
-- applies at the counter exactly as it applies to a 30-day trade invoice.
-- A parallel "POS receipt" document would be a second sales path that drifts.
--
-- What the schema actually needs is small: somewhere for the anonymous
-- customer to live, and a permission for the act.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- The walk-in customer
--
-- Every invoice requires a contact (AR is a subledger by contact; rule-level,
-- not negotiable). A till serves people who will never give a name, so each
-- tenant gets ONE designated walk-in contact, created lazily on first cash
-- sale and remembered here. A column rather than a magic name: names are user
-- data, and "Walk-in customer" typed by a user must not silently become the
-- system's anonymous bucket.
--
-- The walk-in contact deliberately has NO TIN. Consolidating nameless counter
-- sales into a periodic e-Invoice uses LHDN's general-public arrangement, and
-- which TIN that consolidation carries is a MyInvois-adapter question —
-- flagged in docs/SETTLEMENT-REGISTER.md §3.2, not guessed here.
-- -----------------------------------------------------------------------------
ALTER TABLE organisation ADD COLUMN walk_in_contact_id UUID;

ALTER TABLE organisation ADD CONSTRAINT organisation_walk_in_contact_fk
    FOREIGN KEY (id, walk_in_contact_id) REFERENCES contact (tenant_id, id);

COMMENT ON COLUMN organisation.walk_in_contact_id IS
    'The tenant''s designated anonymous counter customer. Created lazily by the '
    'first cash sale. One per tenant so nameless sales aggregate under one AR '
    'contact instead of polluting the customer list.';

-- -----------------------------------------------------------------------------
-- Permission
--
-- Its own permission rather than requiring invoice.create + receipt.create,
-- because the pair would force giving the sales desk GENERAL receipt powers —
-- the ability to take money against any invoice, which is more than a till
-- needs. pos.sale is narrower in practice: the receipt it records is bound to
-- the invoice it just raised, in full, in one transaction.
-- -----------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('pos.sale', 'Ring a counter sale: invoice plus immediate receipt, and read the day''s takings');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER',      'pos.sale'),
    ('ADMIN',      'pos.sale'),
    ('ACCOUNTANT', 'pos.sale'),
    ('BOOKKEEPER', 'pos.sale'),
    ('SALES',      'pos.sale');
