-- =============================================================================
-- 0038 — PCB / MTD: the Monthly Tax Deduction schedule and reliefs
--
-- Source: Lembaga Hasil Dalam Negeri Malaysia, "Specification for Monthly Tax
-- Deduction (MTD) Calculations using Computerized Calculation for 2026",
-- updated 01 January 2026. Committed at
-- `docs/research/sources/lhdn-mtd-computerised-specification-2026.pdf`.
--
-- Rule 7 again: these are effective-dated data, not constants. Table 1 and the
-- relief limits change with each Budget — Budget 2026 changed several limits
-- and left the formula alone — so a payroll re-run for an earlier year must
-- read that year's rows, not this year's.
--
-- -----------------------------------------------------------------------------
-- WHY `b` IS TWO COLUMNS AND WHY IT CAN BE NEGATIVE.
--
-- B is "the amount of tax on M after deduction of tax rebate for individual and
-- husband or wife, if qualified" (page 11). The rebate is baked into it, which
-- is why the first two bands carry NEGATIVE values: −400 for a single filer and
-- −800 where a spouse rebate also applies. That negativity is doing real work.
-- A RM2,500-a-month shop wage has RM17,700 of chargeable income and RM127 of
-- tax on it, and the reason nothing is deducted is that the RM400 rebate is
-- larger. Store B as published, signed, and let the arithmetic fall out.
--
-- Categories 1 and 3 share a column because they share a value; they are kept
-- as one column rather than three because the specification prints one column.
--
-- -----------------------------------------------------------------------------
-- GLOBAL, LIKE 0037. Same reasoning, same exemptions.
--
-- National rates, identical for every tenant, SELECT-only to the application
-- role, changed only by a migration. Listed with that reason in rls.test.ts and
-- audit.test.ts rather than silently skipped.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Table 1, page 11 — the annual tax on chargeable income P.
-- ---------------------------------------------------------------------------
CREATE TABLE statutory_mtd_band (
    effective_from DATE NOT NULL,
    -- Inclusive lower bound of P. The first band starts at 5,000.01: below it
    -- there is no band and no tax, and the absence IS the rule.
    p_from         NUMERIC(19,4) NOT NULL CHECK (p_from >= 0),
    -- Inclusive upper bound. NULL on the final, unbounded band.
    p_to           NUMERIC(19,4),
    -- M — the first chargeable income of the range.
    m              NUMERIC(19,4) NOT NULL CHECK (m >= 0),
    -- R, in basis points. 1% is 100 and 26% is 2600, so a rate is an exact
    -- integer and never a float that has to be trusted to two places.
    rate_bp        INTEGER NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),
    -- B. Signed on purpose — see the header.
    b_category_1_3 NUMERIC(19,4) NOT NULL,
    b_category_2   NUMERIC(19,4) NOT NULL,

    PRIMARY KEY (effective_from, p_from),
    CHECK (p_to IS NULL OR p_to > p_from)
);

-- ---------------------------------------------------------------------------
-- The compulsory deductions, pages 26–28, plus the non-resident rate (page 9).
--
-- One row per effective date rather than one row per relief: they are read
-- together, always, and a shape that let a payroll run find D for 2026 and Q
-- for 2025 would be a shape that eventually did.
-- ---------------------------------------------------------------------------
CREATE TABLE statutory_mtd_relief (
    effective_from        DATE NOT NULL PRIMARY KEY,
    -- D — individual and dependent relatives. Granted automatically.
    individual            NUMERIC(19,4) NOT NULL CHECK (individual >= 0),
    -- S — husband or wife with no source of income.
    spouse                NUMERIC(19,4) NOT NULL CHECK (spouse >= 0),
    -- Q — per qualifying child. Multiplied by C, where a child in tertiary
    -- education counts as FOUR children and a disabled child in tertiary
    -- education as eight (page 27). The multiplier lives in C, as published.
    per_child             NUMERIC(19,4) NOT NULL CHECK (per_child >= 0),
    -- DU and SU — further deductions for a disabled employee or spouse.
    disabled_individual   NUMERIC(19,4) NOT NULL CHECK (disabled_individual >= 0),
    disabled_spouse       NUMERIC(19,4) NOT NULL CHECK (disabled_spouse >= 0),
    -- The annual cap on K + K1 + K2 + Kt. A cap on the RELIEF, not on the
    -- contribution: an employee on RM5,000 contributes RM6,600 a year and gets
    -- relief on RM4,000 of it.
    epf_annual_limit      NUMERIC(19,4) NOT NULL CHECK (epf_annual_limit >= 0),
    -- Page 9: a non-resident is a flat rate on gross, with no reliefs at all.
    non_resident_rate_bp  INTEGER NOT NULL CHECK (non_resident_rate_bp BETWEEN 0 AND 10000),
    source                TEXT NOT NULL CHECK (length(source) >= 8)
);

GRANT SELECT ON statutory_mtd_band, statutory_mtd_relief TO emil_app;
GRANT SELECT ON statutory_mtd_band, statutory_mtd_relief TO emil_worker;

-- ---------------------------------------------------------------------------
-- Table 1 as printed on page 11 and reprinted on page 50.
-- ---------------------------------------------------------------------------
INSERT INTO statutory_mtd_band
    (effective_from, p_from, p_to, m, rate_bp, b_category_1_3, b_category_2) VALUES
    ('2026-01-01',       5000.01,     20000,       5000,  100,   -400,   -800),
    ('2026-01-01',      20000.01,     35000,      20000,  300,   -250,   -650),
    ('2026-01-01',      35000.01,     50000,      35000,  600,    600,    600),
    ('2026-01-01',      50000.01,     70000,      50000, 1100,   1500,   1500),
    ('2026-01-01',      70000.01,    100000,      70000, 1900,   3700,   3700),
    ('2026-01-01',     100000.01,    400000,     100000, 2500,   9400,   9400),
    ('2026-01-01',     400000.01,    600000,     400000, 2600,  84400,  84400),
    ('2026-01-01',     600000.01,   2000000,     600000, 2800, 136400, 136400),
    ('2026-01-01',    2000000.01,      NULL,    2000000, 3000, 528400, 528400);

INSERT INTO statutory_mtd_relief (
    effective_from, individual, spouse, per_child,
    disabled_individual, disabled_spouse, epf_annual_limit,
    non_resident_rate_bp, source
) VALUES (
    '2026-01-01', 9000, 4000, 2000, 7000, 6000, 4000, 3000,
    'LHDN Specification for MTD Computerized Calculation 2026 (updated 01/01/2026), pages 9 and 26-28'
);
