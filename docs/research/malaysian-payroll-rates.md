# Malaysian statutory payroll — rate research

**Researched 4 August 2026.** Read the caveat below before using any figure here.

This exists because payroll is the one outstanding Xero-parity feature that cannot be
built from a guess. EPF, SOCSO, EIS and PCB are statutory: an under-deduction is the
employer's liability, not the employee's, and a rate that merely *looks* right is worse
than an obvious gap. So the rates were researched rather than recalled, and everything
below carries a confidence level and a source.

---

## ⚠️ The caveat that governs this whole document

**Every Malaysian government site refused automated access.** `kwsp.gov.my`,
`perkeso.gov.my` and `hasil.gov.my` all returned HTTP 403 to direct fetches, including
the PDFs of the Third Schedule and the LHDN MTD specification.

So the figures below come from **search-engine summaries that quote those official pages**,
cross-checked against several independent payroll vendors. That is good corroboration and
it is **not** the same as having read the legal instrument. Nothing here should be loaded
into a production rate table until somebody has opened the primary documents listed at the
bottom and confirmed it.

---

## The finding that changes the design

**EPF, SOCSO and EIS are lookup TABLES, not percentages.**

This is the single most important thing the research turned up, and it is easy to get
wrong. For wages at or below RM20,000 a month, KWSP requires the employer to use the
**exact fixed amounts in the Third Schedule** — not the percentage multiplied out. SOCSO
and EIS work the same way: PERKESO publishes contribution tables in wage bands, and the
statutory amount is the table cell, not `wage × rate`.

The percentages below are therefore *descriptions of roughly what the tables do*, not the
calculation. A payroll built by multiplying percentages will disagree with the statutory
amount by a few sen on most salaries — which is precisely the plausible-but-wrong failure
this project refuses elsewhere for SST and withholding.

**Design consequence:** the schema must be effective-dated **rate table rows** (wage band
from, wage band to, employer amount, employee amount, category), loaded from the published
tables — the same treatment `tax_rate_version` already gets. Not a percentage column.

---

## EPF / KWSP — Employees Provident Fund Act 1991, Third Schedule

| Employee | Employee share | Employer share | Confidence |
| --- | --- | --- | --- |
| Malaysian citizen / PR, **under 60**, wages **≤ RM5,000** | 11% | **13%** | High — corroborated widely |
| Malaysian citizen / PR, **under 60**, wages **> RM5,000** | 11% | **12%** | High |
| Wages **above RM20,000/month** | 11% | 12% | High — percentages apply directly; the schedule tables stop here |
| **Non-Malaysian citizen** | **2%** | **2%** | High — Third Schedule **Part F** |
| Malaysian citizen, **aged 60–75** | ⚠️ **CONFLICTED** | ⚠️ **CONFLICTED** | **LOW — do not use** |

**Non-citizens became mandatory from the October 2025 wage month**, first payment due by
15 November 2025. This matters for a shop employing foreign staff — it is recent, and a
system built on older assumptions would under-contribute.

### The unresolved conflict

Sources disagree on the 60-and-over rate. Some state **employer 4% / employee 0%**; others
state **employee 5.5%**. Both patterns have existed historically, which is likely why the
secondary sources diverge. Contributions cease at age 75.

**This must be read off the Third Schedule itself before anyone aged 60+ is paid through
the system.** It is flagged rather than picked.

---

## SOCSO / PERKESO — Employees' Social Security Act 1969 (Act 4)

| Category | Who | Employer | Employee | Confidence |
| --- | --- | --- | --- | --- |
| **Category 1** — Employment Injury **and** Invalidity | Under 60 | **1.75%** | **0.5%** | High |
| **Category 2** — Employment Injury **only** | Aged 60 and above, or already receiving Invalidity Pension | **1.25%** | **0%** | High |

**Wage ceiling: RM6,000/month, effective 1 October 2024** (raised from RM5,000). Wages above
the ceiling contribute as if they were RM6,000.

---

## EIS / SIP — Employment Insurance System Act 2017 (Act 800)

| Employer | Employee | Total | Confidence |
| --- | --- | --- | --- |
| **0.2%** | **0.2%** | 0.4% | High |

- **Wage ceiling: RM6,000/month**, same October 2024 change as SOCSO.
- **Not payable for employees aged 60 and above** — they are SOCSO Category 2, and EIS does
  not apply. A payroll that deducts EIS from a 60-year-old is over-deducting.
- Age-of-first-entry rules (employees who first joined after a certain age) were **not
  confirmed** in this research and need checking.

---

## PCB / MTD — Monthly Tax Deduction, LHDN

PCB is not a rate; it is an algorithm. LHDN publishes
*Spesifikasi Kaedah Pengiraan Berkomputer PCB 2026*, which defines **five formula
categories** selected by the employee's residence status and circumstances. The document
states there is **no amendment to the MTD formula for 2026** — the changes are to the TP1
and TP3 relief-claim forms, reflecting Budget 2025 and 2026 relief adjustments.

The method: estimate the year's tax on annualised income less reliefs, subtract PCB already
deducted, and spread the remainder over the remaining months.

### Resident individual tax bands — YA 2025

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

⚠️ These are **YA 2025** bands (reported as unchanged from YA 2024). **The YA 2026 bands
were not confirmed** and must be checked against the Budget 2026 announcement before PCB is
computed for the 2026 year.

Reliefs feed the formula (individual, spouse, children, EPF and life insurance caps) and
are the part most likely to move year to year. They were not enumerated here because the
TP1/TP3 forms are the authority and both changed for 2026.

---

## What is still needed before payroll can be built

1. **The EPF Third Schedule table itself** — every wage band, all Parts A–F. Percentages
   are not sufficient; the fixed amounts are the law.
2. **The PERKESO contribution tables** for SOCSO Category 1 and 2 and for EIS, in wage
   bands, current as of the RM6,000 ceiling.
3. **Resolution of the EPF 60–75 conflict** above.
4. **The LHDN MTD specification PDF** — the five formulas, and the YA 2026 bands and
   reliefs.
5. Confirmation of **EIS age-of-entry** eligibility rules.

All five are downloadable by a human from the links below; they are refused to automated
fetching. The fastest path is for the shop owner or their accountant to save the four PDFs
and drop them into this repository, at which point the tables can be transcribed and
property-tested against LHDN's own PCB calculator.

## Primary sources — to be opened by a person

- EPF Act 1991 Third Schedule — https://www.kwsp.gov.my/en/epf-act-1991-third-schedule
- EPF employer mandatory contribution — https://www.kwsp.gov.my/en/employer/responsibilities/mandatory-contribution
- EPF for non-Malaysian citizens — https://www.kwsp.gov.my/en/employer/responsibilities/non-malaysian-citizen-employees
- PERKESO rate of contribution — https://www.perkeso.gov.my/en/rate-of-contribution.html
- PERKESO contribution rate PDF (Act 4) — https://www.perkeso.gov.my/images/lindung/lindung-24-jam/NewContributionRateIncludingSKBBK.pdf
- LHDN PCB 2026 specification — https://www.hasil.gov.my/media/arvlrzh5/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf
- LHDN official PCB calculator (to test against) — https://calcpcbplus.hasil.gov.my/

## How this will be verified once built

The PCB engine gets property tests against **LHDN's own calculator** at
`calcpcbplus.hasil.gov.my` — generate salary and relief combinations, compare our figure to
theirs, and fail on any disagreement. That is the only verification that means anything for
a statutory calculation: agreeing with the authority's own arithmetic, not with our reading
of a table.
