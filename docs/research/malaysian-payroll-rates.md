# Malaysian statutory payroll — rate research

**Researched 4 August 2026. EPF and EIS updated the same day from primary documents
supplied by the shop owner.**

This exists because payroll is the one outstanding Xero-parity feature that cannot be built
from a guess. EPF, SOCSO, EIS and PCB are statutory: an under-deduction is the employer's
liability, not the employee's, and a rate that merely *looks* right is worse than an obvious
gap. Every figure below carries a source and a confidence level.

## Status

| Scheme | State |
| --- | --- |
| **EPF** | ✅ **VERIFIED from the legal instrument.** Full Third Schedule transcribed — 1,203 wage bands. |
| **EIS** | ✅ **VERIFIED from perkeso.gov.my**, including the age rules. |
| **SOCSO** | ⚠️ Percentages corroborated; the **banded contribution table is still needed**. |
| **PCB** | ⚠️ Method understood; the **LHDN specification and YA 2026 bands are still needed**. |

---

## The finding that shapes the design

**EPF and SOCSO are lookup TABLES, not percentages.**

For wages up to RM20,000 a month, EPF contributions are the **exact fixed amounts in the
Third Schedule** — not a percentage multiplied out. The transcription below proves why this
matters: the bands are RM20 wide at the bottom and RM100 wide at the top, and the amount is
the band's cell. A payroll that multiplies percentages will disagree with the statutory
figure on most salaries.

Above RM20,000 the schedule stops and a percentage applies, with the **total rounded up to
the next ringgit** — itself a rule no naive calculation reproduces.

**Design consequence:** effective-dated **wage-band rows**, the same treatment
`tax_rate_version` already has. Not a rate column.

---

## EPF / KWSP — ✅ verified

**Source:** *Employees Provident Fund Act 1991, Third Schedule, in force from 1 October
2025* — the PDF itself is committed at
`docs/research/sources/epf-third-schedule-from-2025-10-01.pdf`.

**Transcribed to** `docs/research/sources/epf-third-schedule-2025-10-01.csv` —
1,203 rows (401 bands × 3 Parts), machine-extracted from the PDF text layer and validated:
every row's employer + employee equals the stated total, and the bands are continuous from
RM0.01 to RM20,000.00 with no gap or overlap in any Part.

### Which Part applies to whom

| Part | Applies to | Above RM20,000 |
| --- | --- | --- |
| **A** | Under 60: Malaysian citizens; PRs; non-citizens who elected before 1 Aug 1998 | employee **11%**, employer **12%** |
| **B** | **Deleted by Act A1760/2025** | — |
| **C** | Aged 60+: PRs, and non-citizens who elected before 1 Aug 1998 *(citizens removed by P.U.(A) 370/2018)* | employee **5.5%**, employer **6%** |
| **D** | **Deleted by Act A1760/2025** | — |
| **E** | Aged 60+: **Malaysian citizens** | employee **0.0%**, employer **4%** |
| **F** | **Non-Malaysian citizens** | **2%** employer / **2%** employee — a flat percentage, no table |

In every Part, the total including cents is **rounded up to the next ringgit**.

### The conflict from the earlier research — resolved

The secondary sources that disagreed about the 60-and-over rate were each quoting a
different Part, and neither said so:

- **Employer 4% / employee 0%** is **Part E** — Malaysian citizens aged 60+. Correct for
  the staff this shop is likely to employ.
- **Employee 5.5% / employer 6%** is **Part C** — permanent residents aged 60+. A different
  population entirely.

Verified against the table itself: Part E's RM19,900.01–20,000.00 band reads employer
**800.00**, employee **0.00** — exactly 4% and 0% of RM20,000.

The employer rate for the under-60 case is likewise visible in the data rather than assumed:
at RM3,000 wages Part A reads employer **390.00** (13%) and employee **330.00** (11%); at
RM20,000 it reads employer **2,400.00** (12%). The 13%-below-RM5,000 / 12%-above split is
real and is baked into the band amounts.

**Non-citizens (Part F) became mandatory from the October 2025 wage month.** Recent, and
easy to miss — a system built on older assumptions under-contributes for foreign staff.

---

## EIS / SIP — ✅ verified

**Source:** perkeso.gov.my, Employment Insurance System Act 2017 (Act 800), Second Schedule
and section 18.

| Employer | Employee | Total |
| --- | --- | --- |
| **0.2%** | **0.2%** | 0.4% |

- **Capped at an assumed monthly salary of RM6,000.**
- **Employees aged 18 to 60 must contribute.**
- **Employees aged 57 and above who have no prior contribution before age 57 are exempt** —
  this was the open question in the first draft, and it is now answered.
- **Government employees, domestic workers and the self-employed are exempt.**

---

## SOCSO / PERKESO — ⚠️ percentages only

**Employees' Social Security Act 1969 (Act 4).**

| Category | Who | Employer | Employee |
| --- | --- | --- | --- |
| **Category 1** — Employment Injury **and** Invalidity | Under 60 | 1.75% | 0.5% |
| **Category 2** — Employment Injury **only** | Aged 60+, or already receiving Invalidity Pension | 1.25% | nil |

**Wage ceiling RM6,000/month, effective 1 October 2024** (raised from RM5,000).

**Still needed: the banded contribution table.** SOCSO works the same way EPF does — the
statutory amount is a table cell, not the percentage. The percentages above describe the
table; they are not the calculation.

---

## PCB / MTD — ⚠️ method understood, figures outstanding

PCB is an algorithm, not a rate. LHDN publishes *Spesifikasi Kaedah Pengiraan Berkomputer
PCB 2026*, defining **five formula categories** chosen by residence status. LHDN states
there is **no amendment to the MTD formula for 2026** — the changes are to the TP1 and TP3
relief-claim forms.

Method: estimate the year's tax on annualised income less reliefs, subtract PCB already
deducted, spread the remainder over the remaining months.

### Resident individual bands — YA 2025

| Chargeable income | Rate |
| --- | --- |
| First RM5,000 | 0% |
| RM5,001 – RM20,000 | 1% |
| RM20,001 – RM35,000 | 3% |
| RM35,001 – RM50,000 | 6% |
| RM50,001 – RM70,000 | 11% |
| RM70,001 – RM100,000 | 19% |
| RM100,001 – RM400,000 | 25% |
| RM400,001 – RM600,000 | 26% |
| RM600,001 – RM2,000,000 | 28% |
| Above RM2,000,000 | 30% |

⚠️ These are **YA 2025** (reported unchanged from YA 2024). **YA 2026 is unconfirmed** and
must be checked against Budget 2026 before PCB is computed for the 2026 year. The reliefs
that feed the formula are on the TP1/TP3 forms, both of which changed for 2026.

---

## What is still needed

1. **PERKESO's banded SOCSO contribution table** (Category 1 and 2), current at the RM6,000
   ceiling — `perkeso.gov.my/en/rate-of-contribution.html`.
2. **LHDN's PCB 2026 specification PDF** — the five formulas and the reliefs —
   `hasil.gov.my` → Majikan → Spesifikasi Data.
3. **Confirmation of the YA 2026 tax bands.**

EPF needs nothing further. EIS needs nothing further.

## How this will be verified once built

The PCB engine gets property tests against **LHDN's own calculator** at
`calcpcbplus.hasil.gov.my`: generate salary and relief combinations, compare our figure to
theirs, fail on any disagreement. Agreeing with the authority's own arithmetic is the only
check worth anything on a statutory figure — agreeing with our reading of a table is not.

The EPF tables get a cheaper but equally strict test: for every one of the 1,203 bands,
assert the transcribed amount is what the engine returns, and assert the above-RM20,000
percentage path rounds up to the next ringgit.

## Sources

- **EPF Third Schedule from 1 October 2025** — committed at `sources/epf-third-schedule-from-2025-10-01.pdf` (supplied by the shop owner; kwsp.gov.my refuses automated download)
- PERKESO contribution rates and EIS eligibility — https://www.perkeso.gov.my/en/rate-of-contribution.html (read from screenshots, same reason)
- LHDN PCB 2026 specification — https://www.hasil.gov.my/media/arvlrzh5/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf
- LHDN PCB calculator — https://calcpcbplus.hasil.gov.my/
