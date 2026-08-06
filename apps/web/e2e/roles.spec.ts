import { expect, test, type Page } from '@playwright/test';

/**
 * What each role can reach, driven through the browser.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS EXISTS TO PREVENT COMING BACK.
 *
 * The nav rail has always been role-aware, so a technician never SAW a link to
 * Payroll. Typing `/payroll` into the address bar, however, rendered the whole
 * payroll console around skeletons that loaded forever — every request behind
 * it answered 403, so no figure ever arrived, but a page that looks like it is
 * loading the boss's payroll invites the next person to try the address bar on
 * something else.
 *
 * The guard and the nav now read the same map. This asserts both halves for
 * three roles: the link is absent AND the address bar is refused, on the same
 * screen, for the same person. Asserting only the nav would pass with the
 * guard deleted, which is exactly the state this file was written about.
 *
 * The API is still the security boundary and is tested as such in
 * `apps/api/test/team.e2e.test.ts`. This is about what the screen shows.
 * ---------------------------------------------------------------------------
 */

const password = 'a-long-enough-password';
const stamp = Date.now().toString(36);
const emailFor = (who: string) => `${who}-${stamp}@roles.example`;

const STAFF = [
  { role: 'TECHNICIAN', who: 'tech', label: 'Technician' },
  { role: 'SALES', who: 'cashier', label: 'Cashier / Sales' },
  { role: 'ACCOUNTANT', who: 'books', label: 'Accountant' },
] as const;

test.describe.configure({ mode: 'serial' });

test('the shop takes on staff', async ({ page, request }) => {
  // ---- The owner sets the shop up ----------------------------------------
  await page.goto('/login');
  await page.getByText('New here? Create an account').click();
  await page.getByLabel('Your name').fill('Sharif');
  await page.getByLabel('Email').fill(emailFor('boss'));
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();

  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel('Business name').fill('Roles Sdn Bhd');
  await page.getByLabel('First day of your financial year').fill('2026-01-01');
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3000/');

  /*
   * The staff are created over the API rather than through the screens.
   * Deliberate: adding a member needs the person to already hold an account,
   * so the UI path is "they register, you invite" — two browsers and a
   * mailbox. That flow is not what this file is about, and simulating it here
   * would make the interesting assertions hostage to it.
   */
  const session = await page.evaluate(() => window.localStorage.getItem('emil.session'));
  const { accessToken, tenantId } = JSON.parse(session!) as {
    accessToken: string;
    tenantId: string;
  };

  for (const person of STAFF) {
    const email = emailFor(person.who);
    const registered = await request.post('/api/v1/auth/register', {
      headers: { 'idempotency-key': `${stamp}-reg-${person.who}` },
      data: { email, password, fullName: person.label },
    });
    expect(registered.ok()).toBe(true);

    const added = await request.post('/api/v1/auth/members', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'x-tenant-id': tenantId,
        'idempotency-key': `${stamp}-add-${person.who}`,
      },
      data: { email, role: person.role },
    });
    expect(added.ok()).toBe(true);
  }
});

/**
 * Screens are identified by their `<h1>`, not by any text on the page.
 *
 * "Payroll" appears in the nav rail as well as at the top of the payroll
 * screen, so a plain text match would pass on a page that never rendered —
 * the exact false negative that let the original defect sit unnoticed. A
 * heading only exists when the screen itself is on the page.
 *
 * @param reach the nav link must be there AND the heading must render.
 * @param refuse the nav link must be ABSENT and typing the address must land
 *   on the refusal, with the screen's own heading nowhere on the page.
 */
const EXPECTATIONS: {
  who: string;
  label: string;
  reach: { path: string; nav: string; heading: string }[];
  refuse: { path: string; nav: string; heading: string }[];
}[] = [
  {
    who: 'tech',
    label: 'Technician',
    reach: [
      { path: '/repairs', nav: 'Repairs', heading: 'Repairs' },
      { path: '/stock', nav: 'Stock', heading: 'Stock' },
    ],
    refuse: [
      // The original defect, exactly.
      { path: '/payroll', nav: 'Payroll', heading: 'Payroll' },
      { path: '/reports', nav: 'Reports', heading: 'Reports' },
      { path: '/pos', nav: 'Point of sale', heading: 'Point of sale' },
      { path: '/audit', nav: 'Audit', heading: 'Audit trail' },
    ],
  },
  {
    who: 'cashier',
    label: 'Cashier / Sales',
    reach: [
      { path: '/pos', nav: 'Point of sale', heading: 'Point of sale' },
      { path: '/repairs', nav: 'Repairs', heading: 'Repairs' },
    ],
    refuse: [
      { path: '/payroll', nav: 'Payroll', heading: 'Payroll' },
      // A cashier holds no report.read: the shop's figures are not counter work.
      { path: '/reports', nav: 'Reports', heading: 'Reports' },
      { path: '/banking', nav: 'Banking', heading: 'Banking' },
    ],
  },
  {
    who: 'books',
    label: 'Accountant',
    reach: [
      { path: '/reports', nav: 'Reports', heading: 'Reports' },
      { path: '/payroll', nav: 'Payroll', heading: 'Payroll' },
    ],
    // An accountant holds everything except managing the organisation itself.
    refuse: [],
  },
];

for (const person of EXPECTATIONS) {
  test(`a ${person.label} sees their own work and nothing else`, async ({ page }) => {
    await signIn(page, emailFor(person.who));

    await expect(page.getByText(person.label, { exact: true })).toBeVisible();

    for (const screen of person.reach) {
      await expect(page.locator('aside').getByRole('link', { name: screen.nav })).toBeVisible();
      await page.goto(screen.path);
      await expect(page.getByRole('heading', { name: screen.heading, exact: true }))
        .toBeVisible();
      await expect(page.getByText('Not part of your work here')).toBeHidden();
    }

    for (const screen of person.refuse) {
      await expect(page.locator('aside').getByRole('link', { name: screen.nav })).toHaveCount(0);

      await page.goto(screen.path);
      await expect(page.getByText('Not part of your work here')).toBeVisible();
      // The refusal names the ROLE, so the person knows who to ask.
      await expect(page.getByText(person.label).first()).toBeVisible();
      /*
       * And the screen itself is not behind it. This is the assertion that
       * fails if the guard is removed: the heading would render, the figures
       * would not, and only this line would notice.
       */
      await expect(page.getByRole('heading', { name: screen.heading, exact: true }))
        .toHaveCount(0);
    }

    // The way back is a real link, not the browser's back button — a refusal
    // that strands somebody is a refusal they work around.
    if (person.refuse.length > 0) {
      await page.getByRole('link', { name: 'Back to Today' }).click();
      await expect(page).toHaveURL('http://127.0.0.1:3000/');
    }
  });
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  // A member of exactly one organisation is switched straight into it.
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:3000/');
}
