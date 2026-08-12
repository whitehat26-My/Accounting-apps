/*
 * Which of EMVCo tags 26–51 carries DuitNow.
 *
 * ---------------------------------------------------------------------------
 * THE SCHEMA COULD NOT HOLD A COMPLETE MERCHANT TEMPLATE.
 *
 * `MerchantAccountTemplate` in packages/domain/src/duitnow-qr.ts is two things:
 *
 *     { tag: "26".."51", fields: [[subTag, value], …] }
 *
 * `payment_gateway_config.merchant_template` has stored only the FIELDS since
 * 0014. The tag — which of the reserved merchant-account slots PayNet assigns
 * to DuitNow — had nowhere to live, so even with PayNet's specification in hand
 * the configuration could not be written down. The blocker was recorded as
 * "waiting on PayNet"; half of it was actually waiting on this column.
 *
 * Nullable, because every existing row has an empty template and nothing to put
 * here. The CHECK below makes it mandatory exactly when a template exists, which
 * is the same shape as the attribution constraint 0018 added: a template that
 * cannot say where it came from, or which tag it belongs in, is not a template.
 *
 * The range is constrained to 26–51 because that is the EMVCo-reserved band for
 * merchant account information, and a value outside it would produce a QR that
 * either fails to scan or is silently interpreted as some other field. That part
 * is the public standard, so it can be enforced here; WHICH tag inside the band
 * is PayNet's to say, so it is not defaulted.
 * ------------------------------------------------------------------------- */

ALTER TABLE payment_gateway_config
    ADD COLUMN merchant_template_tag TEXT
        CHECK (
            merchant_template_tag IS NULL
            OR (merchant_template_tag ~ '^[0-9]{2}$'
                AND merchant_template_tag::int BETWEEN 26 AND 51)
        );

COMMENT ON COLUMN payment_gateway_config.merchant_template_tag IS
    'Which EMVCo merchant-account tag (26-51) carries DuitNow, per PayNet. '
    'Required whenever merchant_template is non-empty. Not defaulted: guessing '
    'it produces a QR that scans cleanly and pays the wrong party.';

/*
 * A non-empty template needs BOTH a tag and a source.
 *
 * Replacing rather than adding a second constraint, so there is one rule about
 * what makes a template complete instead of two that have to be read together.
 */
ALTER TABLE payment_gateway_config
    DROP CONSTRAINT IF EXISTS payment_gateway_config_template_attributed;

ALTER TABLE payment_gateway_config
    ADD CONSTRAINT payment_gateway_config_template_attributed
        CHECK (
            jsonb_array_length(merchant_template) = 0
            OR (
                merchant_template_source IS NOT NULL
                AND length(btrim(merchant_template_source)) >= 8
                AND merchant_template_tag IS NOT NULL
            )
        );
