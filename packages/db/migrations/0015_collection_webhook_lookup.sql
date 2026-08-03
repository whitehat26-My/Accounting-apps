-- =============================================================================
-- 0015_collection_webhook_lookup
--
-- Resolving an inbound webhook to a tenant, before a tenant is known.
--
-- -----------------------------------------------------------------------------
-- WHY THIS IS NOT PART OF 0014.
--
-- The runner is forward-only and records each file in `schema_migration`, so a
-- database that has already applied 0014 would never see an edit to it. Editing
-- a landed migration produces two databases with the same recorded history and
-- different schemas, which is the failure mode forward-only migrations exist to
-- prevent. New behaviour gets a new file, even a small one.
-- -----------------------------------------------------------------------------
--
-- -----------------------------------------------------------------------------
-- THE PROBLEM: A WEBHOOK ARRIVES WITH NO TENANT.
--
-- A gateway POSTs to a callback URL. There is no session, no `X-Tenant-Id`, and
-- RLS therefore denies everything — `current_tenant_id()` is NULL. Something in
-- the payload has to say which organisation it belongs to.
--
-- Two candidates were rejected, both of which look reasonable:
--
--   * THE PROVIDER'S OWN REFERENCE. Unique within their namespace, NOT across
--     merchants — two tenants on one provider can be handed the same id. That
--     means either refusing a legitimate payment or, far worse, applying a
--     webhook to the wrong tenant's invoice. A unique index would turn the
--     silent version into a loud one, but it would still be betting on a
--     property the provider never promised.
--
--   * THE PAY-LINK TOKEN in the callback URL. It resolves cleanly with the
--     function already written in 0014, and it is the PAYER's bearer
--     credential: handing it to a third party puts it in their logs and their
--     support tooling, turning one compromised vendor into read access to
--     invoices.
--
-- So the routing key is the PAY LINK'S OWN UUID, sent to the gateway as the
-- merchant order id — a field every gateway carries so a merchant can recognise
-- its own payment — and echoed back on every event. Globally unique by
-- construction, and not a credential.
--
-- The lookup returns only what routing needs. No amounts, no invoice details:
-- the caller re-reads those inside a tenant transaction once the tenant is
-- known.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- WHO POSTED A JOURNAL ENTRY NOBODY TRIGGERED?
--
-- `journal_entry` CHECKs that a POSTED row has both `posted_at` and
-- `posted_by`. A webhook has no session and no human — so a collection
-- confirmed by a gateway had, on first attempt, nobody to attribute the entry
-- to, and the insert failed against that constraint.
--
-- The constraint is right and the fix is not to relax it. Every posted entry in
-- this ledger names someone accountable for it, and "the system did it" is
-- exactly the attribution an auditor cannot follow up.
--
-- The accountable person is the one who ISSUED THE PAY LINK. They chose to
-- invite this payment, against this invoice, for this amount; the gateway
-- merely reported that it arrived. That is a real person, already recorded, and
-- traceable from the entry back through the link to the invoice.
--
-- `created_by` therefore becomes NOT NULL: a link with no creator would produce
-- a collection that can never be posted, discovered only when a customer's
-- money has already moved.
-- -----------------------------------------------------------------------------
ALTER TABLE payment_link ALTER COLUMN created_by SET NOT NULL;

-- -----------------------------------------------------------------------------
-- A GATEWAY FEE IS BOOKED EXACTLY ONCE, AND WITHOUT THIS COLUMN IT WAS BOOKED
-- TWICE.
--
-- Providers report the fee twice: once on the PAID webhook, and again on the
-- settlement report that pays the batch into the bank. It is the same ringgit
-- described from two angles, not two charges.
--
-- Booking both leaves the clearing account permanently short by the total fees
-- and overstates expenses by the same amount. The books still balance — the
-- difference lands in undeposited funds — so nothing fails, nothing is flagged,
-- and the only symptom is a clearing account that never returns to zero and
-- which nobody can explain. That is precisely the class of error the clearing
-- treatment exists to make visible, so it is worth an explicit column rather
-- than a convention.
--
-- `fee_amount` records what confirmation already booked. A settlement then
-- books only the remainder.
-- -----------------------------------------------------------------------------
ALTER TABLE payment_link
    ADD COLUMN fee_amount NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (fee_amount >= 0);

CREATE OR REPLACE FUNCTION find_payment_link_for_webhook(p_link_id UUID)
RETURNS TABLE (
    tenant_id  UUID,
    id         UUID,
    status     TEXT,
    created_by UUID,
    expires_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT pl.tenant_id, pl.id, pl.status, pl.created_by, pl.expires_at
      FROM payment_link pl
     WHERE pl.id = p_link_id
$$;

REVOKE ALL ON FUNCTION find_payment_link_for_webhook(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION find_payment_link_for_webhook(UUID) TO emil_app;
