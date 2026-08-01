-- =============================================================================
-- 0014_collections
--
-- M2: online collections — FPX, DuitNow and cards.
--
-- -----------------------------------------------------------------------------
-- GATEWAY MONEY IS NOT BANK MONEY.
--
-- A customer pays RM 1,080 by FPX on Monday. The gateway keeps RM 1.00 and
-- settles RM 1,079 to the bank on WEDNESDAY, batched with eleven other
-- payments as a single bank line. Booking Dr Bank / Cr AR on Monday breaks
-- three things at once: the bank never shows 1,080 so the line never matches,
-- the fee disappears into revenue, and the bank balance is overstated for two
-- days.
--
-- Everything here exists to route that money through a clearing account
-- instead. `payment.deposit_account_id` already accepts one — the comment on
-- that column in 0003 says "bank, cash or undeposited funds" — and the
-- UNDEPOSITED_FUNDS posting role has existed since 0002 without ever being
-- used. This migration is what finally uses it.
-- -----------------------------------------------------------------------------
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Gateway configuration
--
-- One row per provider per tenant. The clearing account is REQUIRED and the
-- fee account is not: a provider that charges nothing needs no fee account,
-- but a provider with no clearing account has nowhere to put money that has
-- been received and not yet banked, and would silently fall back to booking
-- straight to bank — the exact error this module exists to prevent.
--
-- ⚠️ `merchant_template` ships EMPTY and stays empty until PayNet confirms it.
-- See packages/domain/src/duitnow-qr.ts: a guessed merchant template produces a
-- QR that scans successfully and pays the wrong party, which is a worse failure
-- than any wrong number on a return.
-- -----------------------------------------------------------------------------
CREATE TABLE payment_gateway_config (
    tenant_id            UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                   UUID NOT NULL DEFAULT gen_random_uuid(),
    provider             TEXT NOT NULL,
    display_name         TEXT NOT NULL,
    /* Where money sits between "the customer paid" and "the bank received it". */
    clearing_account_id  UUID NOT NULL,
    fee_account_id       UUID,
    /* The bank account the provider settles into. Nullable until known. */
    settlement_bank_account_id UUID,
    /* EMVCo merchant account template, [[tag, value], ...]. Empty until
       verified against PayNet — never seeded with a plausible default. */
    merchant_template    JSONB NOT NULL DEFAULT '[]'::jsonb,
    merchant_name        TEXT,
    merchant_city        TEXT,
    merchant_category_code TEXT,
    is_active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, provider),
    FOREIGN KEY (tenant_id, clearing_account_id) REFERENCES account (tenant_id, id),
    FOREIGN KEY (tenant_id, fee_account_id)      REFERENCES account (tenant_id, id),
    FOREIGN KEY (tenant_id, settlement_bank_account_id)
                                                 REFERENCES bank_account (tenant_id, id),
    CHECK (jsonb_typeof(merchant_template) = 'array')
);

-- -----------------------------------------------------------------------------
-- Payment links
--
-- -----------------------------------------------------------------------------
-- THE TOKEN IS NEVER STORED. ONLY ITS SHA-256 DIGEST IS.
--
-- A pay link is a bearer credential: whoever holds the URL can see an invoice's
-- amount and the merchant's name without authenticating. That makes the token
-- table the same class of asset as `session` and `api_key`, and it gets the
-- same treatment — `hashToken()` from packages/db/src/identity.ts, digest
-- column only, so a database leak cannot be replayed as a working link.
--
-- `expires_at` is enforced in the lookup rather than by deletion, because an
-- expired link must still resolve internally: a payment can confirm minutes
-- after expiry while the payer was mid-flow at their bank, and that money is
-- real. See `advanceCollection` — EXPIRED still accepts PAID.
-- -----------------------------------------------------------------------------
CREATE TABLE payment_link (
    tenant_id        UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    invoice_id       UUID NOT NULL,
    /* SHA-256, base64url. The token itself is returned once and never again. */
    token_hash       TEXT NOT NULL,
    /* What the payer quotes on a DuitNow Transfer. Must survive
       referenceMatch() — see paymentReference() in the domain. */
    reference        TEXT NOT NULL,
    amount           NUMERIC(19,4) NOT NULL CHECK (amount > 0),
    currency         CHAR(3) NOT NULL DEFAULT 'MYR',
    status           TEXT NOT NULL DEFAULT 'CREATED'
                     CHECK (status IN ('CREATED','VIEWED','PENDING','PAID',
                                       'FAILED','EXPIRED','CANCELLED')),
    provider         TEXT,
    provider_ref     TEXT,
    /* Set when the collection confirms. The join to the ledger. */
    payment_id       UUID,
    expires_at       TIMESTAMPTZ NOT NULL,
    view_count       INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
    first_viewed_at  TIMESTAMPTZ,
    paid_at          TIMESTAMPTZ,
    created_by       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id),
    FOREIGN KEY (tenant_id, payment_id) REFERENCES payment (tenant_id, id),
    /* A link in a terminal paid state must say which payment settled it. */
    CHECK (status <> 'PAID' OR payment_id IS NOT NULL)
);

/*
 * Globally unique, NOT unique per tenant.
 *
 * The public resolver looks a token up BEFORE it knows which tenant it belongs
 * to — that is the whole point of a pay link. A per-tenant unique index would
 * permit the same digest under two tenants and make the pre-tenant lookup
 * ambiguous, so uniqueness is global, the same as `session.token_hash`.
 */
CREATE UNIQUE INDEX payment_link_token_idx ON payment_link (token_hash);
CREATE INDEX payment_link_invoice_idx ON payment_link (tenant_id, invoice_id);

-- -----------------------------------------------------------------------------
-- Gateway events — append-only
--
-- -----------------------------------------------------------------------------
-- THE UNIQUE CONSTRAINT IS THE WEBHOOK IDEMPOTENCY GUARANTEE.
--
-- Providers retry aggressively and cheerfully deliver the same event twice.
-- Processing a PAID twice settles an invoice twice, which posts a second
-- receipt against an invoice with nothing left owing. Deduplicating in a cache
-- means the guarantee evaporates on a restart or a cache eviction, so it lives
-- in the database: the INSERT is attempted first and the constraint rejects the
-- replay. Same reasoning as the Idempotency-Key interceptor, one layer down.
--
-- Append-only for the same reason the ledger is: this table is the evidence of
-- what a third party told us and when. An edited webhook log cannot be used to
-- reconstruct a disputed payment.
-- -----------------------------------------------------------------------------
CREATE TABLE gateway_event (
    tenant_id         UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id                UUID NOT NULL DEFAULT gen_random_uuid(),
    provider          TEXT NOT NULL,
    /* The provider's own event id. The de-duplication key. */
    provider_event_id TEXT NOT NULL,
    provider_ref      TEXT,
    event_type        TEXT NOT NULL CHECK (event_type IN ('PAID','FAILED','PENDING')),
    payment_link_id   UUID,
    amount            NUMERIC(19,4),
    fee               NUMERIC(19,4),
    currency          CHAR(3) NOT NULL DEFAULT 'MYR',
    /* When the provider says it sent this. Checked against the replay window. */
    sent_at           TIMESTAMPTZ,
    /* Verbatim, so a dispute can be argued from what actually arrived. */
    raw_payload       JSONB NOT NULL,
    signature_valid   BOOLEAN,
    processed_at      TIMESTAMPTZ,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, provider, provider_event_id),
    FOREIGN KEY (tenant_id, payment_link_id) REFERENCES payment_link (tenant_id, id)
);

CREATE INDEX gateway_event_link_idx ON gateway_event (tenant_id, payment_link_id);

-- -----------------------------------------------------------------------------
-- Settlements — the batch that becomes one bank line
--
-- This is the record the M4 matching engine reconciles against. A settlement's
-- net is what the bank statement will show; its items are the individual
-- collections it covers. `checkSettlement()` in the domain asserts
-- gross - fees = net, and a batch that does not add up is rejected rather than
-- leaving an unexplained residue in the clearing account.
-- -----------------------------------------------------------------------------
CREATE TABLE gateway_settlement (
    tenant_id        UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id               UUID NOT NULL DEFAULT gen_random_uuid(),
    provider         TEXT NOT NULL,
    /* The provider's batch reference, as printed on their settlement report. */
    provider_batch_id TEXT,
    settlement_date  DATE NOT NULL,
    currency         CHAR(3) NOT NULL DEFAULT 'MYR',
    gross_amount     NUMERIC(19,4) NOT NULL CHECK (gross_amount >= 0),
    fee_amount       NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
    net_amount       NUMERIC(19,4) NOT NULL,
    bank_account_id  UUID,
    /* Clearing → bank. Null until the settlement is posted. */
    journal_entry_id UUID,
    fee_journal_entry_id UUID,
    status           TEXT NOT NULL DEFAULT 'EXPECTED'
                     CHECK (status IN ('EXPECTED','POSTED','RECONCILED')),
    idempotency_key  TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    UNIQUE      (tenant_id, provider, provider_batch_id),
    UNIQUE      (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, bank_account_id)  REFERENCES bank_account  (tenant_id, id),
    FOREIGN KEY (tenant_id, journal_entry_id) REFERENCES journal_entry (tenant_id, id),
    FOREIGN KEY (tenant_id, fee_journal_entry_id) REFERENCES journal_entry (tenant_id, id),
    /* Enforced here as well as in the domain: a stored batch whose parts do not
       add up puts a difference into the clearing account that nobody will find. */
    CHECK (net_amount = gross_amount - fee_amount),
    CHECK (status <> 'POSTED' OR journal_entry_id IS NOT NULL)
);

CREATE TABLE gateway_settlement_item (
    tenant_id     UUID NOT NULL REFERENCES organisation (id) ON DELETE RESTRICT,
    id            UUID NOT NULL DEFAULT gen_random_uuid(),
    settlement_id UUID NOT NULL,
    payment_id    UUID NOT NULL,
    gross_amount  NUMERIC(19,4) NOT NULL CHECK (gross_amount > 0),
    fee_amount    NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, id),
    /* A payment settles once. Twice would credit the clearing account twice
       and overstate the bank. */
    UNIQUE      (tenant_id, payment_id),
    FOREIGN KEY (tenant_id, settlement_id) REFERENCES gateway_settlement (tenant_id, id)
                                           ON DELETE CASCADE,
    FOREIGN KEY (tenant_id, payment_id)    REFERENCES payment (tenant_id, id)
);

CREATE INDEX gateway_settlement_item_batch_idx
    ON gateway_settlement_item (tenant_id, settlement_id);

-- -----------------------------------------------------------------------------
-- Append-only enforcement on the webhook log
--
-- Mirrors forbid_posted_journal_mutation(): the evidence of what a third party
-- sent is not editable. `processed_at` is the single exception — marking an
-- event handled is bookkeeping about our own processing, not a change to what
-- arrived — so it is allowed to move from NULL to a timestamp and nowhere else.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_gateway_event_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Gateway events are append-only; event % cannot be deleted', OLD.id
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.processed_at IS DISTINCT FROM OLD.processed_at AND OLD.processed_at IS NULL THEN
        /* Only the processing stamp moved. Everything else must be identical. */
        IF (NEW.tenant_id, NEW.id, NEW.provider, NEW.provider_event_id, NEW.event_type,
            NEW.amount, NEW.fee, NEW.raw_payload, NEW.received_at)
           IS DISTINCT FROM
           (OLD.tenant_id, OLD.id, OLD.provider, OLD.provider_event_id, OLD.event_type,
            OLD.amount, OLD.fee, OLD.raw_payload, OLD.received_at)
        THEN
            RAISE EXCEPTION
                'Gateway event % is append-only; only processed_at may be set', OLD.id
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Gateway event % is append-only and cannot be modified', OLD.id
        USING ERRCODE = 'restrict_violation';
END $$;

CREATE TRIGGER trg_gateway_event_append_only
    BEFORE UPDATE OR DELETE ON gateway_event
    FOR EACH ROW EXECUTE FUNCTION forbid_gateway_event_mutation();

-- -----------------------------------------------------------------------------
-- Posting role: the gateway's cut
--
-- An expense in its own right, never netted against revenue. Netting produces
-- the same profit, so nothing looks wrong, and the business never learns what
-- it pays its payment provider — over a year of FPX and card volume that is a
-- real number they are entitled to see.
-- -----------------------------------------------------------------------------
ALTER TABLE posting_account_map DROP CONSTRAINT posting_account_map_role_check;
ALTER TABLE posting_account_map
    ADD CONSTRAINT posting_account_map_role_check
        CHECK (role IN ('AR','AP','SST_PAYABLE','SST_CLAIMABLE',
                        'ROUNDING','FX_GAIN_LOSS','RETAINED_EARNINGS',
                        'UNDEPOSITED_FUNDS','SUSPENSE',
                        'AR_REVALUATION','UNREALISED_FX','AP_REVALUATION',
                        'WHT_PAYABLE',
                        -- Merchant discount / transaction fees charged by a
                        -- payment gateway. Expense, not contra-revenue.
                        'GATEWAY_FEE'));

-- New financial events worth an immutable record.
--
-- The full list is restated because PostgreSQL has no "add a value to a CHECK".
-- That makes this the one place a value can be silently LOST — restating the
-- list as it stood two migrations ago drops whatever landed in between, and the
-- only symptom is an insert failing at runtime. It happened while writing this
-- one: 0013's BILL_APPROVED and BILL_REJECTED were dropped by rebuilding from
-- 0012's version. Read the live constraint, not an older migration.
ALTER TABLE financial_event_log DROP CONSTRAINT financial_event_log_event_type_check;
ALTER TABLE financial_event_log
    ADD CONSTRAINT financial_event_log_event_type_check
        CHECK (event_type IN (
            'LOCKED_PERIOD_OVERRIDE',
            'PERIOD_LOCKED',
            'PERIOD_UNLOCKED',
            'BANK_DETAILS_CHANGED',
            'ROLE_CHANGED',
            'API_KEY_ISSUED',
            'API_KEY_REVOKED',
            'RECONCILIATION_COMPLETED',
            'YEAR_END_CLOSED',
            'BILL_APPROVED',
            'BILL_REJECTED',
            -- Which account collections clear through, and where fees land.
            -- Changing it silently redirects customer money.
            'GATEWAY_CONFIG_CHANGED',
            'GATEWAY_SETTLEMENT_POSTED'));

-- =============================================================================
-- RLS
-- =============================================================================
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'payment_gateway_config', 'payment_link', 'gateway_event',
        'gateway_settlement', 'gateway_settlement_item'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                 USING      (tenant_id = current_tenant_id())
                 WITH CHECK (tenant_id = current_tenant_id())', t);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO emil_app', t);
    END LOOP;

    /* Append-only in the grant as well as the trigger. Defence in depth: the
       trigger states the rule, the grant means a bug cannot even attempt it. */
    REVOKE UPDATE, DELETE ON gateway_event FROM emil_app;
    /* Marking an event processed is the one permitted update. */
    GRANT UPDATE (processed_at) ON gateway_event TO emil_app;
END $$;

-- -----------------------------------------------------------------------------
-- Resolving a pay link before a tenant is known
--
-- -----------------------------------------------------------------------------
-- THIS IS THE ONLY UNAUTHENTICATED PATH THAT TOUCHES TENANT DATA.
--
-- A pay page is opened by someone with no session and no tenant context, so RLS
-- cannot help: `current_tenant_id()` is NULL and every policy denies. The same
-- problem `find_user_for_authentication` solves for login, solved the same way
-- — a SECURITY DEFINER function that takes a DIGEST, not a token, and returns
-- the minimum needed to render a payment page.
--
-- What it deliberately does NOT return: the customer's name, address, email,
-- the invoice's line items, or anything about the tenant beyond a display name.
-- A leaked or brute-forced link must expose one invoice's amount and nothing
-- that helps anyone enumerate further.
--
-- Expiry is NOT filtered here. An expired link must still resolve so the caller
-- can decide: the public route refuses it, but a webhook confirming a payment
-- made seconds before expiry must still find the link. Returning nothing would
-- take a customer's money and leave the invoice outstanding.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION find_payment_link_by_digest(p_digest TEXT)
RETURNS TABLE (
    tenant_id     UUID,
    id            UUID,
    invoice_id    UUID,
    invoice_no    TEXT,
    reference     TEXT,
    amount        NUMERIC(19,4),
    amount_due    NUMERIC(19,4),
    currency      CHAR(3),
    status        TEXT,
    merchant_name TEXT,
    expires_at    TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT pl.tenant_id,
           pl.id,
           pl.invoice_id,
           i.invoice_no,
           pl.reference,
           pl.amount,
           i.amount_due,
           pl.currency,
           pl.status,
           o.name,
           pl.expires_at
      FROM payment_link pl
      JOIN invoice      i ON i.tenant_id = pl.tenant_id AND i.id = pl.invoice_id
      JOIN organisation o ON o.id = pl.tenant_id
     WHERE pl.token_hash = p_digest
$$;

REVOKE ALL ON FUNCTION find_payment_link_by_digest(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_payment_link_by_digest(TEXT) TO emil_app;

-- Collections clear through undeposited funds, which is a current asset —
-- money the gateway owes us. It already carries its SOFP tag from 0002.
