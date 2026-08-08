/*
 * A tenant's own letterhead.
 *
 * ---------------------------------------------------------------------------
 * THE APP WAS MULTI-TENANT IN THE DATA AND SINGLE-BRAND IN THE PRESENTATION.
 *
 * Every row in this database has carried `tenant_id` since 0001, with RLS
 * ENABLED and FORCED — a second company's books have always been genuinely
 * separate. But the LOGO on every printed invoice was a file compiled into the
 * API image, so a second company issuing an invoice would have issued it under
 * the first company's mark. That is not a cosmetic complaint: an invoice is the
 * document that says who is owed money, and it must carry the name and mark of
 * the party actually owed.
 *
 * So the brand moves from the build into the row. A tenant with no logo prints
 * its name alone, set large — which is a perfectly good letterhead and is what
 * every organisation gets on the day it signs up.
 * ---------------------------------------------------------------------------
 *
 * COLUMNS ON `organisation`, NOT A TABLE.
 *
 * One row per tenant, never queried across tenants, never the target of a
 * foreign key. A table here would be normalisation for its own sake — the same
 * reasoning as `repair_job.accessories` in 0048.
 *
 * The bytes sit beside the name rather than in a split data table the way
 * `repair_job_photo` does. That split exists so that REPLACING a photograph is
 * detectable against an audited digest, which is the whole point of evidence. A
 * logo is not evidence: it is presentation the tenant may change whenever they
 * please, and nobody needs to prove which logo was in force last March.
 */

ALTER TABLE organisation
    ADD COLUMN logo BYTEA,
    ADD COLUMN logo_content_type TEXT,
    ADD COLUMN brand_colour TEXT;

/*
 * 256 KB is a letterhead, not a photograph.
 *
 * The image is embedded in every PDF this tenant prints, so its size is paid
 * again on each document — a 4 MB camera shot of a signboard would make a
 * one-page invoice bigger than the year's ledger. The web app downscales
 * before uploading; this is the ceiling that makes that non-optional.
 */
ALTER TABLE organisation
    ADD CONSTRAINT organisation_logo_sane CHECK (
        (logo IS NULL AND logo_content_type IS NULL)
        OR (
            logo IS NOT NULL
            AND logo_content_type IN ('image/png', 'image/jpeg')
            AND octet_length(logo) BETWEEN 1 AND 262144
        )
    );

/*
 * PNG and JPEG only, and this is a correctness constraint rather than a taste
 * one: pdfkit embeds exactly those two. A WebP accepted here would store
 * cleanly and then fail at the moment somebody tried to print an invoice,
 * which is the worst possible time to discover it.
 */
COMMENT ON COLUMN organisation.logo IS
    'Letterhead mark for this tenant''s printed documents. PNG or JPEG because '
    'those are what pdfkit can embed — see 0050.';

/*
 * Lowercase six-digit hex, anchored. Unanchored, '#1875BE; drop table' would
 * pass and then be interpolated into a PDF colour operator.
 */
ALTER TABLE organisation
    ADD CONSTRAINT organisation_brand_colour_hex CHECK (
        brand_colour IS NULL OR brand_colour ~ '^#[0-9a-f]{6}$'
    );

COMMENT ON COLUMN organisation.brand_colour IS
    'Accent on printed documents. NULL means the product default.';
