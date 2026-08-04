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
  await page.getByLabel('Code').fill('SETUP');
  await page.getByLabel('Name').fill('PC setup service');
  await page.getByLabel('Selling price (RM)').fill('150.00');
  await page.getByRole('button', { name: 'Service', exact: true }).click();
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByRole('cell', { name: 'PC setup service' })).toBeVisible();

  // ---- Ring it at the till ------------------------------------------------
  await page.getByRole('link', { name: 'Point of sale' }).click();
  await page.getByText('PC setup service').click();
  await page.getByLabel('Cash tendered (for change)').fill('200.00');
  await page.getByRole('button', { name: 'Ring sale' }).click();

  await expect(page.getByTestId('change-due')).toHaveText('RM 50.00');
  await expect(page.getByText(/Done — INV-/)).toBeVisible();

  // ---- The day knows ------------------------------------------------------
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page.getByText('RM 150.00').first()).toBeVisible();

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
});
