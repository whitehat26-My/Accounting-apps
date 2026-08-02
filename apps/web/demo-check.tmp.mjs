import { chromium } from '@playwright/test';

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
const base = 'http://127.0.0.1:8123/Accounting-apps';

// First run: login → register path lands on setup, then the shop works.
await page.goto(`${base}/login/`);
await page.getByText('New here? Create an account').click();
await page.getByLabel('Your name').fill('Demo');
await page.getByLabel('Email').fill('demo@shop.example');
await page.getByLabel('Password').fill('a-long-enough-password');
await page.getByRole('button', { name: 'Register', exact: true }).click();
await page.waitForURL(/\/setup/);
await page.getByLabel('Business name').fill('Demo Computer Shop');
await page.getByRole('button', { name: 'Create organisation' }).click();
await page.waitForURL(new RegExp('/Accounting-apps/?$'));

// Dashboard shows the seeded takings.
await page.getByText('Gross profit').waitFor();

// POS: sell the seeded SSD, tender 500, expect change 100.
await page.goto(`${base}/pos/`);
await page.getByText('1TB NVMe SSD').click();
await page.getByLabel('Cash tendered (for change)').fill('500.00');
await page.getByRole('button', { name: 'Ring sale' }).click();
const change = await page.getByTestId('change-due').textContent();
if (change !== 'RM 100.00') throw new Error(`change wrong: ${change}`);

// Stock reflects the sale: 7 left.
await page.goto(`${base}/stock/`);
await page.getByRole('cell', { name: '7' }).first().waitFor();

// Repairs queue shows the seeded job.
await page.goto(`${base}/repairs/`);
await page.getByText('JOB-00001').waitFor();

console.log('DEMO-SMOKE-OK change=' + change);
await browser.close();
