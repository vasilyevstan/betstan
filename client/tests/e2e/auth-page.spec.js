const { test, expect } = require('@playwright/test');
const authCopy = require('../../src/pages/auth/authCopy.json');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

// Browser-only claims for the one tabbed auth page and the Forgot password page: the pinned
// release-gate selectors, real keyboard and history routing, computed layout and the reset
// journey against the mocked API. Rendering, validation and request shapes are proven by the
// unit tests. The selectors and the confirmation are literals on purpose: they are contracts.
const CONFIRMATION = 'If that account exists, its password is now abcdef. Log in with it.';
const UI_VARIANTS = ['v1', 'v2', 'v3'];
const THEMES = ['dark', 'light'];

const prepareAuth = async (page, overrides) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await installFakeEventSource(page);
  const state = createShellMockState(overrides);
  await installAppApiMocks(page, state);
  return { state, pageErrors };
};

const logInTab = (page) => page.getByRole('tab', { name: 'Log in', exact: true });
const createAccountTab = (page) => page.getByRole('tab', { name: 'Create account', exact: true });
const bodiesOf = (state, key) => state.requests.filter((request) => request.key === key).map(({ body }) => body);

test('/login opens on the Log in tab and every pinned release-gate selector resolves to exactly one element', async ({ page }) => {
  const { pageErrors } = await prepareAuth(page);
  await page.goto('/login?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', { level: 1, name: authCopy.login.title })).toBeVisible();
  await expect(page.getByLabel('Username or email')).toHaveCount(1);
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(1);
  // The header icon is the only element titled Log in; the tab and the submit button have no title.
  await expect(page.getByTitle('Log in')).toHaveCount(1);
  await expect(page.getByTitle('Log out')).toHaveCount(0);

  await expect(page.getByRole('tablist', { name: 'Account access' }).getByRole('tab')).toHaveText(['Log in', 'Create account']);
  await expect(logInTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(createAccountTab(page)).toHaveAttribute('aria-selected', 'false');
  expect(await logInTab(page).getAttribute('title')).toBeNull();
  await expect(page.locator('[role="tab"][title]')).toHaveCount(0);

  // Only the active form is mounted, and its tab names the panel. The Slip beside the card has
  // tabs of its own, so these are scoped to the auth card.
  const card = page.getByRole('region', { name: authCopy.login.title });
  const panel = card.getByRole('tabpanel');
  await expect(panel).toHaveCount(1);
  await expect(panel).toHaveAccessibleName('Log in');
  await expect(panel.locator('form')).toHaveCount(1);
  await expect(page.locator('#auth-panel-signup')).toHaveCount(0);
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(0);

  // The link is not a label of the Password field.
  await expect(page.getByRole('link', { name: 'Forgot password?', exact: true }))
    .toHaveAttribute('href', '/forgot-password?ui=v2&theme=dark');
  expect(pageErrors).toEqual([]);
});

test('the keyboard switches tabs on one URL concept, and history, Home/End and deep links agree', async ({ page }) => {
  const { pageErrors } = await prepareAuth(page);
  await page.goto('/login?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });

  await logInTab(page).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page).toHaveURL('/signup?ui=v2&theme=dark');
  await expect(createAccountTab(page)).toBeFocused();
  await expect(createAccountTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(logInTab(page)).toHaveAttribute('aria-selected', 'false');
  expect(await createAccountTab(page).evaluate((tab) => {
    const style = getComputedStyle(tab);
    return { style: style.outlineStyle, width: style.outlineWidth };
  })).toEqual({ style: 'solid', width: '3px' });
  await expect(page.getByRole('heading', { level: 1, name: authCopy.signup.title })).toBeVisible();

  // One form with one Password field, and none of the login controls.
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Username', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('Username or email')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Forgot password?' })).toHaveCount(0);

  // Roving tabindex: the tablist is one Tab stop and the next stop is the form.
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Username', { exact: true })).toBeFocused();

  await createAccountTab(page).focus();
  await page.keyboard.press('Home');
  await expect(page).toHaveURL('/login?ui=v2&theme=dark');
  await expect(logInTab(page)).toBeFocused();
  await expect(logInTab(page)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(page).toHaveURL('/signup?ui=v2&theme=dark');
  await expect(createAccountTab(page)).toBeFocused();

  await page.goBack();
  await expect(page).toHaveURL('/login?ui=v2&theme=dark');
  await expect(logInTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Username or email')).toHaveCount(1);
  await page.goForward();
  await expect(page).toHaveURL('/signup?ui=v2&theme=dark');
  await expect(createAccountTab(page)).toHaveAttribute('aria-selected', 'true');

  // /signup is a deep link that opens Create account, with the same single Password field.
  await page.goto('/signup?ui=v3&theme=light', { waitUntil: 'domcontentloaded' });
  await expect(createAccountTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { level: 1, name: authCopy.signup.title })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(1);
  expect(pageErrors).toEqual([]);
});

test('the auth pages fit and keep touch-sized controls in every profile and theme, narrow and wide', async ({ page }) => {
  const { pageErrors } = await prepareAuth(page);
  const routes = [
    { path: '/login', controls: ['a', 'button', 'tab', 'tab'] },
    { path: '/signup', controls: ['button', 'tab', 'tab'] },
    { path: '/forgot-password', controls: ['a', 'button'] },
  ];

  for (const width of [320, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const ui of UI_VARIANTS) {
      for (const theme of THEMES) {
        for (const { path, controls } of routes) {
          const label = `${path} ${ui} ${theme} ${width}px`;
          await page.goto(`${path}?ui=${ui}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
          await expect(page.locator('.auth-card'), label).toBeVisible();

          const metrics = await page.locator('.auth-card').evaluate((card) => {
            const frame = card.getBoundingClientRect();
            const box = (element) => {
              const { left, right, width: boxWidth, height } = element.getBoundingClientRect();
              return {
                kind: element.getAttribute('role') === 'tab' ? 'tab' : element.tagName.toLowerCase(),
                left, right, width: boxWidth, height,
              };
            };
            const targets = [...card.querySelectorAll('[role="tab"], a, button')]
              .filter((element) => element.getClientRects().length > 0).map(box);
            const fields = [...card.querySelectorAll('input')].map(box);
            return {
              kinds: targets.map(({ kind }) => kind).sort(),
              undersized: targets.filter(({ width: w, height }) => w < 44 || height < 44)
                .map(({ kind, width: w, height }) => `${kind} ${Math.round(w)}x${Math.round(height)}`),
              escaping: [...targets, ...fields]
                .filter(({ left, right }) => left < frame.left - 1 || right > frame.right + 1)
                .map(({ kind }) => kind),
              documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          });
          expect(metrics.kinds, label).toEqual(controls);
          expect(metrics.undersized, label).toEqual([]);
          expect(metrics.escaping, label).toEqual([]);
          expect(metrics.documentOverflow, label).toBeLessThanOrEqual(1);
        }
      }
    }
  }

  // The reset confirmation is the longest copy on any auth page; it must fit the narrowest card.
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/forgot-password?ui=v3&theme=dark', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username or email').fill('qa-narrow');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  const confirmation = page.getByText(CONFIRMATION, { exact: true });
  await expect(confirmation).toBeVisible();
  const fit = await confirmation.evaluate((message) => {
    const frame = message.closest('.auth-card').getBoundingClientRect();
    const bounds = message.getBoundingClientRect();
    return {
      inside: bounds.left >= frame.left && bounds.right <= frame.right,
      clipped: message.scrollWidth > message.clientWidth,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  expect(fit.inside).toBe(true);
  expect(fit.clipped).toBe(false);
  expect(fit.documentOverflow).toBeLessThanOrEqual(1);
  expect(pageErrors).toEqual([]);
});

test('logging in from the tabbed page returns home and swaps the header icon to Log out', async ({ page }) => {
  const { state, pageErrors } = await prepareAuth(page);
  await page.goto('/login?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
  await expect(page.getByTitle('Log in')).toHaveCount(1);
  await expect(page.getByTitle('Log out')).toHaveCount(0);

  await page.getByLabel('Username or email').fill('stan_1');
  await page.getByLabel('Password', { exact: true }).fill('Password123!');
  // The session the server would start when it accepts the credentials.
  state.currentUser = { id: 'auth-page-user', email: 'stan_1@example.com', role: 'USER' };
  await page.getByRole('button', { name: 'Log in', exact: true }).click();

  await expect(page).toHaveURL('/?ui=v2&theme=dark');
  await expect(page.getByTitle('Log out')).toHaveCount(1);
  await expect(page.getByTitle('Log in')).toHaveCount(0);
  expect(bodiesOf(state, 'POST /api/auth/login')).toEqual([{ email: 'stan_1', password: 'Password123!' }]);
  expect(state.unhandledRequests.filter((key) => key.includes('/api/auth/'))).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Forgot password sends the identifier, rejects a 400, shows the exact confirmation, then returns to the login tab', async ({ page }) => {
  const { state, pageErrors } = await prepareAuth(page);
  await page.goto('/login?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });

  // The link is a real Tab stop right after the submit button.
  await page.getByLabel('Password', { exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Forgot password?', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL('/forgot-password?ui=v2&theme=dark');
  await expect(page.getByRole('heading', { level: 1, name: authCopy.forgotPassword.title })).toBeVisible();
  const card = page.getByRole('region', { name: authCopy.forgotPassword.title });
  const field = card.getByLabel('Username or email');
  const status = card.getByRole('status');
  await expect(field).toHaveCount(1);
  await expect(card.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('tablist')).toHaveCount(0);
  await expect(status).toBeEmpty();

  // A 400 shows the validation message the way the login form does and no confirmation.
  state.auth.forgotPasswordError = 'Enter a valid username or email';
  await field.fill('qa-unknown');
  await card.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Please check your details');
  await expect(card.getByRole('alert')).toContainText('Enter a valid username or email');
  await expect(status).toBeEmpty();

  // A 200 shows exactly the confirmation and clears the error; Enter submits from the field.
  state.auth.forgotPasswordError = null;
  await field.press('Enter');
  await expect(status).toHaveText(CONFIRMATION);
  await expect(card.getByRole('alert')).toHaveCount(0);

  // Editing the identifier withdraws the confirmation for the old one.
  await field.fill('qa-other');
  await expect(status).toBeEmpty();
  await field.fill('qa-unknown');
  await field.press('Enter');
  await expect(status).toHaveText(CONFIRMATION);

  await card.getByRole('link', { name: 'Back to log in', exact: true }).click();
  await expect(page).toHaveURL('/login?ui=v2&theme=dark');
  await expect(logInTab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { level: 1, name: authCopy.login.title })).toBeVisible();
  await expect(page.getByLabel('Username or email')).toHaveValue('');

  expect(bodiesOf(state, 'POST /api/auth/forgot-password')).toEqual([
    { email: 'qa-unknown' },
    { email: 'qa-unknown' },
    { email: 'qa-unknown' },
  ]);
  expect(state.unhandledRequests.filter((key) => key.includes('/api/auth/'))).toEqual([]);
  expect(pageErrors).toEqual([]);
});
