/*
 * The promises register — warranties as obligations the shop can see.
 *
 * One column, deliberately. The promise itself is DERIVED at read time:
 * a SOLD stock_unit already knows its serial, its outbound movement, and
 * through that movement the invoice, the customer, and the sale date
 * (stock_movement.moved_on). Multiplying `warranty_months` onto that gives
 * the promise window without asserting anything a second time — the same
 * rule 0028 stated for serials ("nothing is asserted twice"). A stored
 * warranty row would need creating on sale, voiding on return, and
 * correcting on both, and each of those is a bug this schema cannot have.
 *
 * What deriving cannot express — an ad-hoc extension, a goodwill promise on
 * a non-serialised cable — is stated in the register (§5.21) with its
 * unblocker, not silently approximated here.
 */

ALTER TABLE item
    ADD COLUMN warranty_months SMALLINT NOT NULL DEFAULT 0
    CONSTRAINT item_warranty_months_range CHECK (warranty_months BETWEEN 0 AND 120);

COMMENT ON COLUMN item.warranty_months IS
    'Months of warranty promised when a serialised unit of this item is sold. '
    '0 = no promise. The promise window is derived from the sale movement; '
    'this number is the only warranty state the schema holds.';
