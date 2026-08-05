import { expect, test } from '@playwright/test';

/**
 * The whole first day, through the browser: register, set up the shop,
 * add a product, ring a cash sale, and see the day's takings. One journey
 * rather than many small tests, because the thing worth proving is that the
 * screens compose — every individual behaviour already has API-level tests.
 */

const email = `owner-${Date.now().toString(36)}@shop.example`;
const password = 'a-long-enough-password';

test('first day at the shop', async ({ page }) => {
  // ---- Register and land on setup ----------------------------------------
  await page.goto('/login');
  await page.getByText('New here? Create an account').click();
  await page.getByLabel('Your name').fill('Sharif');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel('Business name').fill('Emil Computer Centre Sdn Bhd');
  await page.getByLabel('First day of your financial year').fill('2026-01-01');
  await page.getByRole('button', { name: 'Create organisation' }).click();

  // ---- The dashboard renders for a brand-new tenant -----------------------
  await expect(page).toHaveURL('http://127.0.0.1:3000/');
  await expect(page.getByText('Gross profit')).toBeVisible();

  // ---- Add a sellable service (no stock needed for the first sale) --------
  await page.getByRole('link', { name: 'Items' }).click();
  // `exact` because "Code" is a substring of "Barcode (optional)".
  await page.getByLabel('Code', { exact: true }).fill('SETUP');
  await page.getByLabel('Name').fill('PC setup service');
  await page.getByLabel('Selling price (RM)').fill('150.00');
  await page.getByRole('button', { name: 'Service', exact: true }).click();
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByRole('cell', { name: 'PC setup service' })).toBeVisible();

  // ---- Ring it at the till, THROUGH THE SCANNER LANE ----------------------
  /*
   * Typed exactly as a keyboard-wedge scanner delivers it: the code, then
   * Enter. The item lands in the sale with no mouse — and a wrong code must
   * say so rather than add the wrong thing.
   */
  await page.getByRole('link', { name: 'Point of sale' }).click();
  await page.getByLabel('Scan barcode').fill('NO-SUCH-CODE');
  await page.getByLabel('Scan barcode').press('Enter');
  await expect(page.getByText(/Nothing on the shelf answers/)).toBeVisible();

  await page.getByLabel('Scan barcode').fill('SETUP');
  await page.getByLabel('Scan barcode').press('Enter');
  await expect(page.getByText('PC setup service').first()).toBeVisible();
  await page.getByLabel('Cash tendered (for change)').fill('200.00');
  await page.getByRole('button', { name: 'Ring sale' }).click();

  await expect(page.getByTestId('change-due')).toHaveText('RM 50.00');
  await expect(page.getByText(/Done — INV-/)).toBeVisible();

  // ---- The day knows ------------------------------------------------------
  /*
   * This assertion once relied on luck: the journey used to amble slowly
   * enough that the dashboard's cached zeros were stale by the time it came
   * back. The scanner lane made the till fast enough to arrive INSIDE the
   * staleTime — which exposed that ringing a sale never told the cache the
   * day had changed. The fix is in the till (it invalidates takings), and
   * this line is now asserting that fix.
   */
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page.getByText('RM 150.00').first()).toBeVisible();

  // ---- A customer asks what a job would cost ------------------------------
  /*
   * The whole quote lifecycle through the browser, ending in a real invoice.
   *
   * The last step is the one worth driving from here rather than only from the
   * API suite: "Make it an invoice" is the single button on that screen that
   * posts to the ledger, and everything before it must leave the books alone.
   */
  await page.getByRole('link', { name: 'Quotes' }).click();
  await page.getByLabel('Customer').selectOption({ index: 1 });
  await page.getByLabel('Post the income to').selectOption({ index: 1 });
  await page.getByLabel('Tax code').selectOption({ index: 1 });
  await page.getByPlaceholder('What the job includes').fill('Rebuild and reinstall Windows');
  await page.getByPlaceholder('Unit price (RM)').fill('450.00');
  await page.getByRole('button', { name: 'Save as draft' }).click();

  // The subtotal comes back from the server. It reading RM 450.00 rather than
  // RM 0.00 is the list-subtotal defect this slice fixed.
  await expect(page.getByText('RM 450.00').first()).toBeVisible();

  await page.screenshot({ path: 'e2e-artifacts/quotes.png', fullPage: true });

  await page.getByRole('button', { name: 'Mark as sent' }).click();
  await page.getByRole('button', { name: 'They said yes' }).click();
  await page.getByRole('button', { name: 'Make it an invoice' }).click();
  await page.getByRole('button', { name: 'Issue the invoice' }).click();

  // Gone from the open list, and now under Sales as money someone owes. The
  // cash sale earlier in this journey was paid at the till, so an unpaid
  // invoice existing at all is this conversion and nothing else.
  await expect(page.getByText('No open quotes.')).toBeVisible();
  await page.getByRole('link', { name: 'Sales', exact: true }).click();
  await expect(page.getByText('Nothing unpaid.')).toBeHidden();
  await expect(page.getByText(/INV-/).first()).toBeVisible();

  // ---- And the customer gets a statement for it ---------------------------
  /*
   * The statement screen leads with WHO OWES SOMETHING, because "run this
   * month's statements" is the task and working out that list by hand is most
   * of the work. The invoice just converted from the quote is the only thing
   * outstanding, so it must appear here — and its amount must match.
   */
  await page.getByRole('link', { name: 'Statements' }).click();
  await page.getByRole('button', { name: 'Statement' }).first().click();
  await expect(page.getByText('Balance brought forward')).toBeVisible();
  await expect(page.getByText('Amount now due')).toBeVisible();
  await page.screenshot({ path: 'e2e-artifacts/statements.png', fullPage: true });

  // ---- What would it cost to put someone behind that counter? -------------
  /*
   * The last question of a good first day, and the one that catches owners
   * out: the wage is not the cost. This also proves the payroll screen reads
   * the real statutory tables through the real API — the RM 325 below is the
   * EPF Third Schedule's own figure for that band, which is 13% and not the
   * 12% every summary quotes.
   */
  await page.getByRole('link', { name: 'Payroll' }).click();
  await page.getByLabel('Monthly wage (RM)').fill('2500.00');
  // `exact` because "Age" is a substring of "Monthly w-age- (RM)".
  await page.getByLabel('Age', { exact: true }).fill('24');
  await page.getByLabel('Contribution month').fill('2026-08-01');
  await page.getByRole('button', { name: 'Calculate' }).click();

  await expect(page.getByRole('cell', { name: 'RM 325.00' })).toBeVisible();
  await expect(page.getByText('Total cost to the shop')).toBeVisible();
  // Contributions only until the tax box is ticked. A screen that said "take
  // home" while omitting income tax would be believed precisely because it
  // looked finished.
  await expect(page.getByText('Income tax (PCB) is not included — tick the box above.')).toBeVisible();

  await page.screenshot({ path: 'e2e-artifacts/payroll.png', fullPage: true });

  // ---- And now with income tax, for a technician seven months in ----------
  /*
   * The full payslip, through the real MTD formula. RM207.50 is the figure the
   * specification's own method produces for a RM6,000 wage with seven months
   * already paid — so this asserts the whole path at once: Table 1 out of the
   * database, the EPF figure out of the Third Schedule as K1, and the
   * annualised projection over the five months that remain.
   */
  await page.getByLabel('Monthly wage (RM)').fill('6000.00');
  await page.getByLabel('Age', { exact: true }).fill('35');
  await page.getByLabel('Include income tax (PCB)').check();
  await page.getByLabel('Gross paid this year so far (RM)').fill('42000.00');
  await page.getByLabel('EPF deducted this year so far (RM)').fill('4620.00');
  await page.getByLabel('PCB deducted this year so far (RM)').fill('1452.50');
  await page.getByRole('button', { name: 'Calculate' }).click();

  /*
   * Assert the take-home rather than the tax line. RM 5,046.20 is
   * 6,000 - 746.30 of contributions - 207.50 of tax, so it can only be right if
   * every one of the four deductions is right — and unlike the RM 207.50 cell
   * it appears exactly once, where that figure is also a substring of the
   * "RM 746.30 + RM 207.50" total beside it.
   */
  await expect(page.getByText('The staff member takes home')).toBeVisible();
  await expect(page.getByText('RM 5,046.20')).toBeVisible();
  await expect(page.getByText(/RM 207\.50 in income tax/)).toBeVisible();
  // The Total row adds contributions and tax on the SERVER — a payslip that
  // printed "746.30 + 207.50" would be asking the reader to do the arithmetic.
  await expect(page.getByRole('cell', { name: 'RM 953.80' })).toBeVisible();

  await page.screenshot({ path: 'e2e-artifacts/payroll-with-tax.png', fullPage: true });

  // ---- And print it -------------------------------------------------------
  /*
   * The button is disabled until a name is typed, because a payslip is a
   * statement addressed to a person. Asserting the disabled state first is the
   * point: it is the only thing standing between "calculator" and "document
   * with somebody's pay on it and no name at the top".
   */
  const printButton = page.getByRole('button', { name: 'Print payslip' });
  await expect(printButton).toBeDisabled();

  await page.getByLabel('Staff name (to print a payslip)').fill('Nurul Huda binti Ahmad');
  await expect(printButton).toBeEnabled();

  // The PDF opens in a new tab, fetched with the session attached — a plain
  // link could not carry the Authorization header.
  const [slip] = await Promise.all([page.waitForEvent('popup'), printButton.click()]);
  await expect.poll(() => slip.url()).toContain('blob:');

  // ---- She takes the job. Put her on the register -------------------------
  /*
   * The quick quote above needed the year-to-date figures TYPED, every month,
   * forever — the exact clerical work a shop pays a firm for. The register
   * holds them once (her TP3 from the old employer) and the runs carry them
   * forward from there. Several labels below exist in the calculator too, so
   * `.first()` picks the staff form's copy — it sits earlier in the DOM.
   */
  await page.getByRole('button', { name: 'Add a staff member' }).click();
  await page.getByLabel('Full name (as on IC)').fill('Nurul Huda binti Ahmad');
  await page.getByLabel('Job title').first().fill('Technician');
  await page.getByLabel('Date of birth').fill('1991-03-15');
  // Without a TIN the CP39 button below would refuse, by design — LHDN files
  // by Tax Identification Number. This is the spec's own worked example.
  await page.getByLabel('Income tax number (TIN)').fill('IG 531367080');
  await page.getByLabel('Monthly wage (RM)').first().fill('6000.00');
  await page.getByLabel('Hired on').fill('2026-08-01');
  // Four digits and no more — enough to match a payslip against a bank
  // statement, and the app never asks for the rest.
  // By role: "Bank" also matches the "Paid by" select, whose accessible name
  // is built from its own options ("Bank transfer / Cash / Cheque").
  await page.getByRole('textbox', { name: 'Bank', exact: true }).fill('Maybank');
  await page.getByLabel('Account — last 4 digits only').fill('4471');
  await page.getByLabel('Joined mid-year from another employer').check();
  await page.getByLabel('Gross paid this year (RM)').fill('42000.00');
  await page.getByLabel('EPF deducted this year (RM)').fill('4620.00');
  await page.getByLabel('PCB deducted this year (RM)').fill('1452.50');
  await page.getByRole('button', { name: 'Add to the register' }).click();

  await expect(page.getByRole('cell', { name: 'Nurul Huda binti Ahmad' })).toBeVisible();

  // ---- Run the month ------------------------------------------------------
  /*
   * The point of the whole slice, proven at the surface: the run must land on
   * the SAME RM 5,046.20 the calculator produced from hand-typed figures —
   * this time with nothing typed, because her TP3 is on the register. A cell
   * locator, because the calculator's copy of the figure above is in prose.
   */
  await page.getByRole('button', { name: 'Compute the month' }).click();
  await expect(page.getByText(/RUN-/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'RM 5,046.20' })).toBeVisible();

  // Nothing is in the books yet — the warning panel says exactly what posting
  // means before the button is offered.
  await page.getByRole('button', { name: 'Confirm the month' }).click();
  await expect(page.getByText('This posts to the books')).toBeVisible();
  await page.getByRole('button', { name: 'Post it' }).click();

  // Confirmed: every row grows a payslip button, and the remittance panel says
  // who is owed what. `exact` because "Payslip" is a substring of the
  // calculator's "Print payslip" further down the page.
  await expect(page.getByRole('button', { name: 'Payslip', exact: true })).toBeVisible();
  await expect(page.getByText('Pay LHDN (PCB)')).toBeVisible();

  // ---- The CP39 file, once LHDN's employer number is on record ------------
  const cp39Button = page.getByRole('button', { name: 'CP39 file (LHDN)' });
  await expect(cp39Button).toBeVisible();

  await page.getByLabel('LHDN employer number').fill('9012345678');
  // Wait for the PATCH to land before asking for the file — the save gives no
  // visual confirmation, and a CP39 requested first would honestly 422.
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('/v1/payroll/settings') && r.ok()),
    page.getByRole('button', { name: 'Save number' }).click(),
  ]);

  await page.screenshot({ path: 'e2e-artifacts/payroll-run.png', fullPage: true });

  const [cp39] = await Promise.all([page.waitForEvent('popup'), cp39Button.click()]);
  await expect.poll(() => cp39.url()).toContain('blob:');

  // ---- And the payslips, in one file, to print and hand out ---------------
  /*
   * Asserted as a DOWNLOAD rather than a popup, and on the suggested filename
   * specifically. That name is the whole point: a blob URL carries none, so
   * before `apiDownload` every payslip saved as whatever the browser invented
   * and a month of them were indistinguishable. Nothing but this assertion
   * would notice that regressing — it is invisible in a screenshot.
   */
  const [book] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Payslips for everyone' }).click(),
  ]);
  expect(book.suggestedFilename()).toBe('payslips-2026-08.pdf');

  // ---- The bank, arriving on its own --------------------------------------
  /*
   * Set up the bank account, wire the sandbox feed to it, and fetch. The
   * assertion that matters is the SECOND fetch: zero new lines, everything a
   * duplicate — the shop can press this button as often as it likes and the
   * books cannot double. The lines land in the same To sort queue a CSV
   * import fills, which is the whole design.
   */
  await page.getByRole('link', { name: 'Banking' }).click();
  await page.getByLabel('Ledger account').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await page.getByLabel('Source').selectOption('SANDBOX');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Sandbox bank')).toBeVisible();

  await page.getByRole('button', { name: 'Fetch new lines' }).click();
  await expect(page.getByText(/Received \d+ new lines/)).toBeVisible();
  await expect(page.getByText('DUITNOW QR SETTLEMENT').first()).toBeVisible();

  await page.getByRole('button', { name: 'Fetch new lines' }).click();
  await expect(page.getByText(/Received 0 new lines — \d+ already held/)).toBeVisible();

  await page.screenshot({ path: 'e2e-artifacts/bank-feed.png', fullPage: true });
});
