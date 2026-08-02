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
  await page.getByRole('button', { name: 'Register', exact: true }).click();

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
});
