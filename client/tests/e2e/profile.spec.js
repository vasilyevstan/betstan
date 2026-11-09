const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

test.use({ timezoneId: 'Europe/Tallinn', locale: 'en-US' });

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
    preMatchBets: 12, liveBets: 3, singleBets: 11, accumulatorBets: 4,
    favouriteMarket: { name: 'NEXT_CORNER', selections: 9 },
  };
  await installAppApiMocks(page, state);
  return state;
};

const figure = (main, label) => main.locator('.profile-figures > div')
  .filter({ has: main.page().getByText(label, { exact: true }) }).locator('.profile-figure');

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
    await expect(main.getByRole('heading', { name: state.currentUser.displayName, level: 2 })).toBeVisible();
    await expect(figure(main, 'Total staked')).toHaveText('1,234,567,890,123,456,789.123');
    await expect(figure(main, 'Bets')).toHaveText(String(state.stats[0].betCount));
    await expect(figure(main, 'Win rate')).toHaveText('78%');
    await expect(main.locator('.profile-favourite')).toContainText('Next Corner Kick');
    await expect(page.locator('.stat-row').filter({ hasText: 'Public alias' }).locator('.stat-row__count'))
      .toHaveText(String(state.stats[0].betCount));
    await expect(main.getByLabel('Display name', { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    expect(await main.locator('.profile-figure').evaluateAll((nodes) => nodes
      .every((node) => node.scrollWidth <= node.clientWidth + 1))).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`profile-${ui}-${theme}-${width}.png`), fullPage: true });

    await main.getByRole('button', { name: 'Edit name' }).click();
    await expect(main.getByLabel('Display name', { exact: true })).toBeFocused();
    await expect(main.getByLabel('Display name', { exact: true })).toHaveValue(state.currentUser.displayName);
    await main.getByRole('button', { name: 'Custom dates' }).click();
    await expect(main.getByLabel('From', { exact: true })).toBeFocused();
    const targets = await main.locator('button, input, summary').evaluateAll((controls) => controls.map((control) => {
      const box = control.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }));
    expect(targets.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`profile-${ui}-${theme}-${width}-editing.png`), fullPage: true });
    await main.getByLabel('Display name', { exact: true }).press('Escape');
    await expect(main.getByRole('button', { name: 'Edit name' })).toBeFocused();

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
  await main.getByRole('button', { name: 'Edit name' }).click();
  await main.getByLabel('Display name', { exact: true }).fill('Updated private name');
  await main.getByRole('button', { name: 'Save name' }).click();
  await expect(main.getByText('Name saved.')).toBeVisible();
  expect(state.currentUser.displayName).toBe('Updated private name');
  expect(state.stats[0].displayName).toBe('Public alias');
  await page.reload();
  await expect(main.getByRole('heading', { name: 'Updated private name', level: 2 })).toBeVisible();
  await main.getByRole('button', { name: 'Custom dates' }).click();
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
  await expect(main.locator('.profile-figures')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Custom dates' })).toHaveAttribute('aria-pressed', 'true');
  await main.getByRole('button', { name: 'All time', exact: true }).click();
  await expect(main.getByLabel('From', { exact: true })).toHaveCount(0);
  await expect(main.getByRole('button', { name: 'All time', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(state.unhandledRequests).toEqual([]);
});

test('statistics recovery preserves unsaved input and never displays fabricated zero activity', async ({ page }) => {
  const state = await prepareProfile(page);
  state.profileStatsResponse = { status: 503, body: { errors: [{ message: 'Statistics unavailable' }] } };
  await page.goto('/profile');
  const main = page.getByRole('main');
  await expect(main.getByRole('alert')).toContainText('statistics are unavailable');
  await expect(main.getByText('Total staked', { exact: true })).toHaveCount(0);
  await main.getByRole('button', { name: 'Edit name' }).click();
  await main.getByLabel('Display name', { exact: true }).fill('Unsaved draft');
  state.profileStatsResponse = undefined;
  await main.getByRole('button', { name: 'Refresh statistics' }).click();
  await expect(main.locator('.profile-figures')).toBeVisible();
  await expect(main.getByLabel('Display name', { exact: true })).toHaveValue('Unsaved draft');
  expect(state.unhandledRequests).toEqual([]);
});

test('anonymous visitors receive sign-in guidance without a private statistics request', async ({ page }) => {
  const state = await prepareProfile(page);
  state.currentUser = null;
  await page.goto('/profile?ui=v3&theme=light');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/login?ui=v3&theme=light');
  await expect(main.getByRole('button', { name: 'Edit name' })).toHaveCount(0);
  expect(state.requestCount('GET /api/bet/me/stats')).toBe(0);
});
