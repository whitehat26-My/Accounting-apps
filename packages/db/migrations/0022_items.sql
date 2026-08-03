-- =============================================================================
-- 0022_items
--
-- M8: the item catalogue gets code, and the columns it was always missing.
--
-- `item` was created in 0002 with a sale price, a sale account, a tax code, a
-- unit of measure and a MyInvois classification code. `invoice_line.item_id`
-- and `bill_line.item_id` have accepted an id since the same migration.
-- Nothing ever wrote an item and nothing ever read one, so the `itemId` a line
-- accepts has been stored and ignored — and there has been no way to create an
-- item at all, which means no real user could ever have populated it.
--
-- The cost of that shows up somewhere specific. MyInvois rejects an invoice
-- line with no classification code, and the rejection arrives asynchronously as
-- a dead-lettered outbox event days later rather than as a form error. The
-- catalogue is where that code belongs: set once, per item, instead of retyped
-- on every line by somebody who has no reason to know it exists.
--
-- -----------------------------------------------------------------------------
-- STILL NOT INVENTORY. THAT IS A DECISION, NOT AN OMISSION.
--
-- No quantity on hand, no stock valuation, no cost of goods sold posted on
-- sale, no reorder level. Perpetual inventory needs a costing method, posts to
-- the ledger on movement rather than on invoice, needs stock takes and variance
-- accounts, and under MPERS §13 the measurement basis carries disclosure
-- consequences. A `quantity_on_hand` column here would be a number that looks
-- like stock, is maintained by nothing, and ends up on a balance sheet.
-- -----------------------------------------------------------------------------
-- =============================================================================

-- -----------------------------------------------------------------------------
-- What an item was missing
-- -----------------------------------------------------------------------------

/* Trigram search on item names. `ILIKE '%term%'` — which is what a catalogue
   search box does — cannot use a btree index, and scanning is fine at 50 items
   and not at 50,000. */
CREATE EXTENSION IF NOT EXISTS pg_trgm;

/* 0002 gave every item a sale price AND a purchase price with no way to say
   which side it is actually used on. An item that is only bought would still
   offer itself on an invoice, defaulting a NULL revenue account. */
ALTER TABLE item ADD COLUMN is_sold      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE item ADD COLUMN is_purchased BOOLEAN NOT NULL DEFAULT FALSE;

/* Derive the flags from the data BEFORE the constraints below are added.
   No tenant has an item today — nothing could ever create one — so this is a
   no-op in practice. Written anyway: a migration that is only correct because
   the table happens to be empty is a migration that fails the first time it is
   run somewhere it is not. */
UPDATE item
   SET is_sold      = (sale_account_id     IS NOT NULL),
       is_purchased = (purchase_account_id IS NOT NULL);

/* And an item that has neither would violate `item_has_a_direction`. There is
   no way to guess which side it belongs on, so it is deactivated and left for
   a human — never silently assigned one. */
UPDATE item SET is_sold = TRUE, is_active = FALSE
 WHERE NOT is_sold AND NOT is_purchased;

/* `name` is the label in a picker; `description` is what lands on the invoice
   line a customer reads. Conflating them means either a picker full of
   paragraphs or an invoice full of abbreviations. */
ALTER TABLE item ADD COLUMN description TEXT
    CHECK (description IS NULL OR length(description) <= 1000);

/* The MyInvois unit-of-measure code. See the reference table below for why it
   is not derived from `unit_of_measure`. */
ALTER TABLE item ADD COLUMN uom_code TEXT;

ALTER TABLE item ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

/* An item nobody buys and nobody sells cannot appear on any document, so it is
   a row that exists only to be confusing. */
ALTER TABLE item ADD CONSTRAINT item_has_a_direction
    CHECK (is_sold OR is_purchased);

/* Sold means invoiceable, and an invoice line needs somewhere to post revenue.
   Enforced here rather than only in the service because the service is not the
   only thing that will ever insert a row — a data import is the obvious case,
   and it is exactly the path that produces items nobody checked. */
ALTER TABLE item ADD CONSTRAINT item_sold_has_account
    CHECK (NOT is_sold OR sale_account_id IS NOT NULL);
ALTER TABLE item ADD CONSTRAINT item_purchased_has_account
    CHECK (NOT is_purchased OR purchase_account_id IS NOT NULL);

/* A negative price is a credit note, not a price. */
ALTER TABLE item ADD CONSTRAINT item_prices_not_negative
    CHECK ((sale_unit_price     IS NULL OR sale_unit_price     >= 0)
       AND (purchase_unit_price IS NULL OR purchase_unit_price >= 0));

/* The tax code columns were declared in 0002 with NO foreign key, so an item
   could name a tax code from another tenant or one that does not exist. */
ALTER TABLE item ADD CONSTRAINT item_sale_tax_code_fk
    FOREIGN KEY (tenant_id, sale_tax_code_id) REFERENCES tax_code (tenant_id, id);
ALTER TABLE item ADD CONSTRAINT item_purchase_tax_code_fk
    FOREIGN KEY (tenant_id, purchase_tax_code_id) REFERENCES tax_code (tenant_id, id);

/* Searching a catalogue by name is the single most common thing a user does
   with one, and `ILIKE '%term%'` cannot use a btree index. */
CREATE INDEX item_active_idx ON item (tenant_id, code) WHERE is_active;
CREATE INDEX item_name_trgm_idx ON item USING gin (name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- Units of measure, as a code list rather than a guess
--
-- MyInvois expects a unit-of-measure code from a published list. It is NOT
-- derivable from the free-text unit a user types: "box", "carton" and "ctn"
-- are the same thing to a human and three different strings here, and mapping
-- any of them onto a code by inference would put an unverified value on a
-- submission to a tax authority.
--
-- ⚠️ SEEDED EMPTY, ON PURPOSE. The same treatment
-- `einvoice_classification_code`, `wht_rate` and the DuitNow merchant template
-- get: the list must be loaded from LHDN's published SDK reference data, and a
-- plausible-looking wrong code is worse than an explicit gap. `uom_code` is
-- therefore validated against whatever is loaded, and an empty table means no
-- item can claim a code it cannot support.
--
-- Global reference data, no RLS — every tenant needs the same list, and there
-- is nothing tenant-specific in it.
-- -----------------------------------------------------------------------------
CREATE TABLE einvoice_uom_code (
    code        TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    /* Where this row came from. A code with no provenance is a guess somebody
       will later mistake for verified reference data. */
    source_reference TEXT NOT NULL
                     CHECK (length(source_reference) BETWEEN 8 AND 300),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON einvoice_uom_code TO emil_app;

ALTER TABLE item ADD CONSTRAINT item_uom_code_fk
    FOREIGN KEY (uom_code) REFERENCES einvoice_uom_code (code);

-- -----------------------------------------------------------------------------
-- Keeping a document's copy of an item, rather than a reference to it
--
-- `invoice_line` already stores description, quantity, unit price, account and
-- tax code — the resolved values, copied at issue. That is what makes a May
-- invoice still say RM 80 after the item's price rises to RM 95 in June, and
-- it is the reason `item_id` must never be joined to for an amount.
--
-- The one thing it was missing is the unit, which an e-Invoice line carries
-- and which was therefore unpopulated on every document ever built.
-- -----------------------------------------------------------------------------
ALTER TABLE invoice_line ADD COLUMN unit_of_measure TEXT;
ALTER TABLE invoice_line ADD COLUMN uom_code        TEXT;
ALTER TABLE bill_line    ADD COLUMN unit_of_measure TEXT;
ALTER TABLE bill_line    ADD COLUMN uom_code        TEXT;

/* Deliberately NOT foreign keys to `einvoice_uom_code`.
   These are the SNAPSHOT. If LHDN retires a code, or an operator deactivates
   a row, an invoice issued last year must still reprint exactly as it was
   submitted — a foreign key would make retiring a code either impossible or
   destructive to history. Same reasoning as the stored e-Invoice payload. */

-- -----------------------------------------------------------------------------
-- Permissions
--
-- The catalogue is master data that decides which account revenue posts to, so
-- editing it is not a sales-desk operation. Reading it is: anyone who can raise
-- an invoice needs to pick from it.
-- -----------------------------------------------------------------------------
INSERT INTO app_permission (code, description) VALUES
    ('item.read',  'View the item catalogue'),
    ('item.write', 'Create and edit items, including their posting accounts');

INSERT INTO role_permission (role_code, permission_code) VALUES
    ('OWNER',            'item.read'),  ('OWNER',      'item.write'),
    ('ADMIN',            'item.read'),  ('ADMIN',      'item.write'),
    ('ACCOUNTANT',       'item.read'),  ('ACCOUNTANT', 'item.write'),
    ('BOOKKEEPER',       'item.read'),  ('BOOKKEEPER', 'item.write'),
    ('APPROVER',         'item.read'),
    -- Sales can pick an item; it cannot decide which account revenue posts to.
    ('SALES',            'item.read'),
    ('READ_ONLY',        'item.read'),
    ('EXTERNAL_AUDITOR', 'item.read');

-- `item` has been RLS-enabled and audited by sweep since 0002 and 0016
-- respectively, so there is nothing to add here — which is the payoff of doing
-- both by sweep rather than table by table.
