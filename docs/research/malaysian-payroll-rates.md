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
| **EIS** | ✅ **VERIFIED** — full 65-band table transcribed from the Act 800 schedule, plus the age rules. |
| **SOCSO** | ✅ **VERIFIED** — full 65-band table transcribed from the Act 4 schedule **including SKBBK**, in force since 01/06/2026. |
| **PCB** | ⚠️ **Tax schedule verified** from LHDN with cumulative amounts, arithmetic-checked. The **five formula definitions** are still needed. |

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

## EIS / SIP — ✅ verified, table transcribed

**Employment Insurance System Act 2017 (Act 800), Second Schedule.** Source committed at
`docs/research/sources/eis-akta800-contribution-rates.pdf` (an image-only scan, read by
rendering it), transcribed to `eis-akta800-from-2024-10-01.csv`.

**65 bands, identical wage boundaries to the SOCSO schedule.** Employer and employee pay the
same amount in every band. The top band is RM11.90 each — 0.2% of the RM5,950 band midpoint,
which is how the headline "0.2%" is actually realised.

- **Ceiling RM6,000/month**; band 65 repeats band 64, as in SOCSO.
- **Employees aged 18 to 60 contribute.**
- **Aged 57 or above with no contribution before 57: exempt.**
- **Government employees, domestic workers and the self-employed: exempt.**

Transcribed with a cross-check rather than by eye alone: rows 10 to 64 step by a flat 20 sen,
so the transcription was asserted against that pattern at five independent points. The check
caught a real slip — the ceiling row repeats rather than continuing the step.

## SOCSO / PERKESO — ✅ verified, and the rates have CHANGED

**Employees' Social Security Act 1969 (Act 4).** Source:
*Kadar Caruman Baharu Merangkumi Skim Kemalangan Bukan Bencana Kerja (SKBBK)* —
committed at `docs/research/sources/socso-akta4-skbbk-schedule.pdf`, transcribed to
`socso-akta4-skbbk-from-2026-06-01.csv` (65 bands, every row's components validated
against its stated total).

### ⚠️ The correction that matters

The first draft of this document said Category 2 was *employer 1.25%, employee nil*. **That
is now wrong.** PERKESO introduced **SKBBK — Skim Kemalangan Bukan Bencana Kerja**, the
24-hour "LINDUNG 24 Jam" non-work-accident scheme, **effective 1 June 2026**. It is already
in force.

SKBBK adds an **employee** contribution of roughly **0.75% of wages**, and it applies to
**both** categories — so Category 2, which previously took nothing from the employee, now
does. Any payroll built on the pre-June-2026 figures under-deducts from every employee.

This is precisely the failure the tables exist to prevent: the widely-repeated
"1.75% / 0.5%" summary describes a scheme that was superseded two months ago.

### Structure of the schedule

| | Category 1 (Employment Injury + Invalidity + SKBBK) | Category 2 (Employment Injury + SKBBK) |
| --- | --- | --- |
| Who | Under 60 | Aged 60+, or already on Invalidity Pension |
| Employer | one column | one column |
| Employee | **two** columns — Invalidity, and SKBBK | **one** column — SKBBK |

At the RM5,900.01–6,000.00 band: Category 1 is employer **104.15**, employee invalidity
**29.75**, employee SKBBK **44.65**, total **178.55**. Category 2 is employer **74.40**,
employee SKBBK **44.65**, total **119.05**.

**Ceiling RM6,000/month** — the 65th band ("exceeding RM6,000") repeats the 64th exactly,
which is how the ceiling is expressed in the schedule rather than as a separate rule.

## PCB / MTD — ⚠️ bands verified, formula spec still outstanding

PCB is an algorithm, not a rate. LHDN publishes *Spesifikasi Kaedah Pengiraan Berkomputer
PCB 2026*, defining **five formula categories** chosen by residence status, and states there
is **no amendment to the MTD formula for 2026** — the changes are to the TP1 and TP3
relief-claim forms.

Method: estimate the year's tax on annualised income less reliefs, subtract PCB already
deducted, spread the remainder over the remaining months.

### ✅ The tax schedule — verified from LHDN

**Source:** *Navigasi HASiL 2026*, Lembaga Hasil Dalam Negeri Malaysia, committed at
`docs/research/sources/navigasi-hasil-2026.pdf` (text extract beside it as `.txt` so it is
greppable without re-parsing).

The document gives the schedule as **cumulative tax plus a rate on the balance**, which is
the form a PCB engine actually needs — not the bare percentages a summary would give you.

| Cat | Chargeable income | Tax on the lower figure (RM) | Rate on the remainder |
| --- | --- | --- | --- |
| A | 0 – 5,000 | 0 | 0% |
| B | 5,001 – 20,000 | 0 | 1% |
| C | 20,001 – 35,000 | 150 | 3% |
| D | 35,001 – 50,000 | 600 | 6% |
| E | 50,001 – 70,000 | 1,500 | 11% |
| F | 70,001 – 100,000 | 3,700 | 19% |
| G | 100,001 – 400,000 | 9,400 | 25% |
| H | 400,001 – 600,000 | 84,400 | 26% |
| I | 600,001 – 2,000,000 | 136,400 | 28% |
| J | Exceeding 2,000,000 | 528,400 | 30% |

**Validated arithmetically.** Every cumulative figure equals the previous one plus the band
width at the previous rate — 9,400 + (400,000 − 100,000) × 25% = 84,400, and so on for all
ten. The chain closes exactly, which is good evidence the table was read correctly rather
than plausibly.

⚠️ **The schedule is labelled Year of Assessment 2025.** That is the year being filed during
2026, and LHDN's own 2026 navigation booklet carries it, so it is current — but PCB deducted
during calendar 2026 belongs to **YA 2026**, and whether these bands carry forward unchanged
is **not confirmed by this document**. To be checked before PCB runs for a 2026 payroll.

### Reliefs

Present in the same source, pages 21–26, headed *Pelepasan Tahun Taksiran 2025*. Individual
and dependent relatives RM9,000; disabled individual additional RM6,000; spouse or alimony
RM4,000; disabled spouse RM6,000; children by category; and a long tail of specific reliefs
with their own limits and conditions. Not transcribed here yet — they are in the committed
text extract and will be lifted into an effective-dated table when the PCB engine is built.

## What is still needed

**One thing:** LHDN's **five MTD formula definitions** — the algorithm that turns a monthly
wage into a deduction. *Spesifikasi Kaedah Pengiraan Berkomputer PCB* on `hasil.gov.my`
(Majikan → Spesifikasi Data). The tax bands and the reliefs are known; the formula is not.

Also worth confirming, though not blocking: whether the YA 2025 bands carry into YA 2026.

EPF, SOCSO and EIS need nothing further — all three are transcribed from their schedules and
can be built today.

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
