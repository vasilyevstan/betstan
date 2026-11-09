const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

test.use({ timezoneId: 'Europe/Tallinn' });

const prepareProfile = async (page) => {
  await installFakeEventSource(page);
  const state = createShellMockState();
  state.currentUser = {
    id: 'profile-owner',
    email: `${'long-login-'.repeat(7)}player@example.invalid`,
    displayName: 'Player with a private display name',
  };
  state.stats = [{ userKey: 'public-alias', displayName: 'Public alias', betCount: 15, wagerTotal: 10 }];
  state.profileStats = {
    acceptedBets: 12, wins: 7, losses: 2, openBets: 1, voidedBets: 1, cashBackBets: 1,
    pendingSubmissions: 2, declinedSubmissions: 1, totalStaked: '1234567890123456789.123',
  };
  await installAppApiMocks(page, state);
  return state;
};

test('private profile fits the existing desktop, tablet and mobile shell', async ({ page }, testInfo) => {
  const state = await prepareProfile(page);
  for (const [width, height, ui, theme] of [
    [1600, 1000, 'v1', 'dark'],
    [992, 1000, 'v2', 'light'],
    [390, 844, 'v3', 'dark'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(`/profile?ui=${ui}&theme=${theme}`);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'My profile', level: 1 })).toBeVisible();
    await expect(main.locator('.profile-totals')).toContainText('1234567890123456789.123');
    await expect(main.locator('.profile-totals > div').filter({ hasText: /^Bets/ }).locator('dd'))
      .toHaveText(String(state.stats[0].betCount));
    await expect(page.locator('.stat-row').filter({ hasText: 'Public alias' }).locator('.stat-row__count'))
      .toHaveText(String(state.stats[0].betCount));
    await expect(main.getByLabel('Display name')).toHaveValue(state.currentUser.displayName);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    const targets = await main.locator('button, input').evaluateAll((controls) => controls.map((control) => {
      const box = control.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }));
    expect(targets.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
    await main.getByLabel('Display name').focus();
    await expect(main.getByLabel('Display name')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`profile-${ui}-${theme}-${width}.png`), fullPage: true });

    const navigation = page.getByRole('navigation', { name: 'Primary navigation' });
    const toggle = navigation.getByRole('button', { name: 'Toggle navigation' });
    if (width < 992) await toggle.click();
    const profileLink = navigation.getByRole('link', { name: 'My profile' });
    await expect(profileLink).toHaveAttribute('aria-current', 'page');
    await expect(profileLink).toHaveAttribute('href', `/profile?ui=${ui}&theme=${theme}`);
    await profileLink.click();
    if (width < 992) await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  }
  expect(state.unhandledRequests).toEqual([]);
});

test('name editing persists privately and local date ranges respect daylight saving', async ({ page }) => {
  const state = await prepareProfile(page);
  await page.goto('/profile?ui=v2&theme=light');
  const main = page.getByRole('main');
  await main.getByLabel('Display name').fill('Updated private name');
  await main.getByRole('button', { name: 'Save name' }).click();
  await expect(main.getByRole('status')).toHaveText('Name saved.');
  expect(state.currentUser.displayName).toBe('Updated private name');
  expect(state.stats[0].displayName).toBe('Public alias');
  await page.reload();
  await expect(main.getByLabel('Display name')).toHaveValue('Updated private name');
  await main.getByLabel('From', { exact: true }).fill('2026-03-29');
  await main.getByLabel('To', { exact: true }).fill('2026-03-29');
  const filtered = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/bet/me/stats' && url.searchParams.has('from');
  });
  await main.getByRole('button', { name: 'Apply dates' }).click();
  const query = new URL((await filtered).url()).searchParams;
  expect(query.get('from')).toBe('2026-03-28T22:00:00.000Z');
  expect(query.get('toExclusive')).toBe('2026-03-29T21:00:00.000Z');
  await expect(main.locator('.profile-totals')).toBeVisible();
  await main.getByRole('button', { name: 'All time', exact: true }).click();
  await expect(main.getByLabel('From', { exact: true })).toHaveValue('');
  await expect(main.getByLabel('To', { exact: true })).toHaveValue('');
  expect(state.unhandledRequests).toEqual([]);
});

test('statistics recovery preserves unsaved input and never displays fabricated zero activity', async ({ page }) => {
  const state = await prepareProfile(page);
  state.profileStatsResponse = { status: 503, body: { errors: [{ message: 'Statistics unavailable' }] } };
  await page.goto('/profile');
  const main = page.getByRole('main');
  await expect(main.getByRole('alert')).toContainText('statistics are unavailable');
  await expect(main.getByText('Total staked', { exact: true })).toHaveCount(0);
  await main.getByLabel('Display name').fill('Unsaved draft');
  state.profileStatsResponse = undefined;
  await main.getByRole('button', { name: 'Refresh statistics' }).click();
  await expect(main.locator('.profile-totals')).toBeVisible();
  await expect(main.getByLabel('Display name')).toHaveValue('Unsaved draft');
  expect(state.unhandledRequests).toEqual([]);
});

test('anonymous visitors receive sign-in guidance without a private statistics request', async ({ page }) => {
  const state = await prepareProfile(page);
  state.currentUser = null;
  await page.goto('/profile?ui=v3&theme=light');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login?ui=v3&theme=light');
  await expect(main.getByLabel('Display name')).toHaveCount(0);
  expect(state.requestCount('GET /api/bet/me/stats')).toBe(0);
});
