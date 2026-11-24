const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const {
  BET_KIND,
  createLiveBettingMockState,
  installAppApiMocks,
} = require('./support/mockAppApi');

// Browser-only claims for the unified Slip window: computed layout, the focus ring, the hidden
// panel and real routing. Tab semantics and keyboard behaviour are proven by the unit tests.
const PRE_MATCH_DRAW = { eventId: 'prematch-1', productId: 'prematch-1x2', oddsId: 'draw' };
const PRE_MATCH_HOME = { eventId: 'prematch-1', productId: 'prematch-1x2', oddsId: 'home' };
const LIVE_CORNER_HOME = {
  eventId: 'live-1',
  marketId: 'market-corner',
  marketVersion: 1,
  quoteVersion: 1,
  selectionId: 'home',
};
const UI_VARIANTS = ['v1', 'v2', 'v3'];
const THEMES = ['dark', 'light'];

const PRE_MATCH_TAB = /^Pre-match\b/;
const LIVE_TAB = /^Live\b/;
const slipTab = (page, name) => page.getByRole('tablist', { name: 'Slip' }).getByRole('tab', { name });
const slipBoard = (page, betKind) => page.locator(`section[aria-labelledby="slip-board-title-${betKind}"]`);

const openEvents = async (page, state, path) => {
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();
  return liveFeed;
};

// Mocks a sign-in the way the real server behaves: the account accepts the credentials, and on its first
// signed-in read of the boards it merges the guest's draft into its own (here, a pick it already held).
// The shared mock serves one set of boards to everyone, so without the held pick a client that never
// re-read the boards after the login would pass just as well.
const mockSignIn = async (page, state, { account, heldPick }) => {
  let merged = false;
  await page.route('**/api/auth/login', async (route) => {
    state.currentUser = account;
    await route.fallback();
  });
  await page.route('**/api/slip/boards', async (route) => {
    if (state.currentUser && !merged) {
      merged = true;
      state.selectSelection(heldPick);
    }
    await route.fallback();
  });
};

test('Slip tabs are touch-sized, fit narrow screens, show one board and a focus ring in every profile and theme', async ({ page }) => {
  const state = createLiveBettingMockState();
  state.selectSelection(PRE_MATCH_DRAW);
  state.selectSelection(LIVE_CORNER_HOME);
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);

  for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const ui of UI_VARIANTS) {
      for (const theme of THEMES) {
        const label = `${ui} ${theme} ${viewport.width}px`;
        await page.goto(`/?ui=${ui}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
        await liveFeed.waitForSource();
        await liveFeed.openAll();

        const tablist = page.getByRole('tablist', { name: 'Slip' });
        await expect(tablist).toBeVisible();
        await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAccessibleName('Pre-match (1)');
        await expect(slipTab(page, LIVE_TAB)).toHaveAccessibleName('Live (1)');

        const geometry = await tablist.evaluate((list) => {
          const box = (element) => {
            const { left, right, width, height } = element.getBoundingClientRect();
            return { left, right, width, height };
          };
          return {
            tabs: [...list.querySelectorAll('[role="tab"]')].map(box),
            listOverflow: list.scrollWidth - list.clientWidth,
            documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
          };
        });
        expect(geometry.tabs, label).toHaveLength(2);
        expect(geometry.tabs.every(({ width, height }) => width >= 44 && height >= 44), label).toBe(true);
        expect(geometry.tabs.every(({ left, right }) => left >= 0 && right <= viewport.width), label).toBe(true);
        expect(geometry.listOverflow, label).toBeLessThanOrEqual(1);
        expect(geometry.documentOverflow, label).toBeLessThanOrEqual(1);

        // Both boards have rows, so Pre-match is open; the Live panel is truly not rendered.
        await expect(slipBoard(page, BET_KIND.PRE_MATCH), label).toBeVisible();
        expect(await page.locator('#slip-panel-LIVE').evaluate((panel) => getComputedStyle(panel).display), label)
          .toBe('none');

        // Arrow keys move focus and selection; the focused tab keeps the shared 3px ring.
        await slipTab(page, PRE_MATCH_TAB).focus();
        await page.keyboard.press('ArrowRight');
        await expect(slipTab(page, LIVE_TAB), label).toBeFocused();
        await expect(slipTab(page, LIVE_TAB), label).toHaveAttribute('aria-selected', 'true');
        expect(await slipTab(page, LIVE_TAB).evaluate((tab) => {
          const style = getComputedStyle(tab);
          return { style: style.outlineStyle, width: style.outlineWidth };
        }), label).toEqual({ style: 'solid', width: '3px' });
        await expect(slipBoard(page, BET_KIND.LIVE), label).toBeVisible();
        await expect(slipBoard(page, BET_KIND.PRE_MATCH), label).toBeHidden();
        expect(await page.locator('#slip-panel-PRE_MATCH').evaluate((panel) => getComputedStyle(panel).display), label)
          .toBe('none');
      }
    }
  }
});

test('the Slip opens on the only kind that has rows and jumps to the kind of every new pick', async ({ page }) => {
  const state = createLiveBettingMockState();
  state.selectSelection(LIVE_CORNER_HOME);
  await openEvents(page, state, '/?ui=v2&theme=dark');

  await expect(slipTab(page, LIVE_TAB)).toHaveAttribute('aria-selected', 'true');
  await expect(slipBoard(page, BET_KIND.LIVE)).toBeVisible();
  await expect(slipBoard(page, BET_KIND.PRE_MATCH)).toBeHidden();

  await page.getByRole('button', { name: state.fixtures.preMatchSelectionLabel }).click();
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAttribute('aria-selected', 'true');
  await expect(slipBoard(page, BET_KIND.PRE_MATCH)).toBeVisible();

  // The same kind twice in a row still jumps back after the user chose the other tab.
  await slipTab(page, LIVE_TAB).click();
  await expect(slipTab(page, LIVE_TAB)).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /^Select 1X2 1: Falcons/ }).click();
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAttribute('aria-selected', 'true');
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAccessibleName('Pre-match (2)');

  await page.getByRole('button', { name: 'Select Next Yellow Card: Raptors at 3.4' }).click();
  await expect(slipTab(page, LIVE_TAB)).toHaveAttribute('aria-selected', 'true');
  await expect(slipBoard(page, BET_KIND.LIVE)).toBeVisible();
  await expect(slipBoard(page, BET_KIND.PRE_MATCH)).toBeHidden();
});

test('a guest builds a pre-match and a live slip that survive a reload, then "Log in to bet" leads to a login that keeps them', async ({ page }) => {
  const state = createLiveBettingMockState();
  const account = state.currentUser;
  state.currentUser = null;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const liveFeed = await openEvents(page, state, '/?ui=v2&theme=dark');
  await mockSignIn(page, state, { account, heldPick: PRE_MATCH_HOME });
  const selections = (betKind) => slipBoard(page, betKind).locator('.slip-row-card__selection');
  const livePick = page.getByRole('button', { name: state.fixtures.liveInitialSelectionLabel });

  // A guest starts with the same empty slip as a signed-in user.
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAccessibleName(/^Pre-match$/);
  await expect(slipTab(page, LIVE_TAB)).toHaveAccessibleName(/^Live$/);
  await expect(slipBoard(page, BET_KIND.PRE_MATCH)).toContainText('Build your pre-match slip');
  await expect(slipBoard(page, BET_KIND.LIVE)).toContainText('Build your live slip');

  const pick = page.getByRole('button', { name: state.fixtures.preMatchSelectionLabel });
  await pick.click();
  await expect(slipBoard(page, BET_KIND.PRE_MATCH).locator('.slip-row-card__selection')).toHaveText('Draw');
  await expect(pick).toHaveClass(/product-button--selected/);
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAccessibleName('Pre-match (1)');

  // A live pick moves the Slip to the Live tab, and each tab shows its own count.
  await livePick.click();
  await expect(slipTab(page, LIVE_TAB)).toHaveAttribute('aria-selected', 'true');
  await expect(slipBoard(page, BET_KIND.LIVE)).toBeVisible();
  await expect(slipBoard(page, BET_KIND.PRE_MATCH)).toBeHidden();
  await expect(selections(BET_KIND.LIVE)).toHaveText('Raptors');
  await expect(livePick).toHaveClass(/product-button--selected/);
  await expect(slipTab(page, LIVE_TAB)).toHaveAccessibleName('Live (1)');
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAccessibleName('Pre-match (1)');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();
  await expect(slipBoard(page, BET_KIND.PRE_MATCH).locator('.slip-row-card__selection')).toHaveText('Draw');
  await expect(page.getByRole('button', { name: state.fixtures.preMatchSelectionLabel }))
    .toHaveClass(/product-button--selected/);
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAccessibleName('Pre-match (1)');
  // Both boards come back for the guest, and with rows in both kinds the first load opens Pre-match again.
  await expect(slipTab(page, LIVE_TAB)).toHaveAccessibleName('Live (1)');
  await expect(selections(BET_KIND.LIVE)).toHaveText('Raptors');
  await expect(livePick).toHaveClass(/product-button--selected/);
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAttribute('aria-selected', 'true');

  const logInToBet = slipBoard(page, BET_KIND.PRE_MATCH).getByRole('button', { name: 'Log in to bet', exact: true });
  await expect(logInToBet).toBeEnabled();
  expect(await logInToBet.getAttribute('title')).toBeNull();
  // The release-gate selectors for the header icon and the login submit stay unique.
  const slip = page.getByRole('complementary');
  await expect(slip.getByTitle('Log in')).toHaveCount(0);
  await expect(slip.getByRole('button', { name: 'Log in', exact: true })).toHaveCount(0);
  expect(state.requestCount('POST /api/slip/bet')).toBe(0);
  expect(pageErrors).toEqual([]);

  // A wager typed on each kind as a guest, then the Live board's button (the tab the visitor is on) leaves for the login.
  await page.getByLabel('Wager for PRE-MATCH SLIP', { exact: true }).fill('3');
  await slipTab(page, LIVE_TAB).click();
  await page.getByLabel('Wager for LIVE SLIP', { exact: true }).fill('5');
  const liveLogInToBet = slipBoard(page, BET_KIND.LIVE).getByRole('button', { name: 'Log in to bet', exact: true });
  await expect(liveLogInToBet).toBeEnabled();
  expect(await liveLogInToBet.getAttribute('title')).toBeNull();

  await liveLogInToBet.click();
  await expect(page).toHaveURL(/\/login\?ui=v2&theme=dark$/);
  expect(state.requestCount('POST /api/slip/bet')).toBe(0);

  // The slip stays beside the login form, and none of its buttons is the form's submit button.
  const submit = page.getByRole('button', { name: 'Log in', exact: true });
  await expect(submit).toHaveCount(1);
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAccessibleName('Pre-match (1)');
  await expect(slipTab(page, LIVE_TAB)).toHaveAccessibleName('Live (1)');
  await page.getByLabel('Username or email').fill(account.email);
  await page.getByLabel('Password', { exact: true }).fill('Password123!');
  await submit.click();

  // Signing in is a new auth generation: the account's boards are read again (they now hold the guest's picks next
  // to the pick the account already had), the typed wagers carry over and the visitor stays on the Live tab.
  await expect(page).toHaveURL(/\/\?ui=v2&theme=dark$/);
  await liveFeed.waitForSource();
  await liveFeed.openAll();
  await expect(slipTab(page, PRE_MATCH_TAB)).toHaveAccessibleName('Pre-match (2)');
  await expect(slipTab(page, LIVE_TAB)).toHaveAccessibleName('Live (1)');
  await expect(slipTab(page, LIVE_TAB)).toHaveAttribute('aria-selected', 'true');
  await expect(selections(BET_KIND.PRE_MATCH)).toHaveText(['Draw', 'Falcons']);
  await expect(selections(BET_KIND.LIVE)).toHaveText('Raptors');
  await expect(page.getByLabel('Wager for PRE-MATCH SLIP', { exact: true })).toHaveValue('3');
  await expect(page.getByLabel('Wager for LIVE SLIP', { exact: true })).toHaveValue('5');
  await expect(slipBoard(page, BET_KIND.LIVE).getByRole('button', { name: 'BET!', exact: true })).toBeEnabled();
  await expect(page.locator('button', { hasText: 'Log in to bet' })).toHaveCount(0);
  for (const picked of [pick, page.getByRole('button', { name: /^Select 1X2 1: Falcons/ }), livePick]) {
    await expect(picked).toHaveClass(/product-button--selected/);
  }
  await expect(page.getByRole('complementary', { name: 'Slip' }).getByRole('alert')).toHaveCount(0);
  expect(state.requestCount('POST /api/auth/login')).toBe(1);
  expect(state.requestCount('POST /api/slip/bet')).toBe(0);
  expect(state.unhandledRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});
