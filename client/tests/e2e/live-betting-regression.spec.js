const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const {
  BET_KIND,
  createLiveBettingMockState,
  installAppApiMocks,
} = require('./support/mockAppApi');

const getBoard = (page, betKind) => page.locator(`section[aria-labelledby="slip-board-title-${betKind}"]`);

const trackClientIssues = (page) => {
  const pageErrors = [];
  const apiFailures = [];

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/')) {
      apiFailures.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });

  return { apiFailures, pageErrors };
};

test('live betting main page flow is deterministic without a backend', async ({ page }) => {
  const state = createLiveBettingMockState();
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  const diagnostics = trackClientIssues(page);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/?ui=v2', { waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();

  const liveArticle = page.getByRole('article', { name: state.fixtures.liveEventName });
  const preMatchArticle = page.getByRole('article', { name: state.fixtures.preMatchEventName });
  const liveBoard = getBoard(page, BET_KIND.LIVE);
  const preMatchBoard = getBoard(page, BET_KIND.PRE_MATCH);
  const articles = page.getByRole('article');

  await expect(page.getByRole('heading', { name: 'Live now' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Pre-match' })).toBeVisible();
  await expect(articles.nth(0)).toHaveAttribute('aria-label', state.fixtures.liveEventName);
  await expect(articles.nth(1)).toHaveAttribute('aria-label', state.fixtures.preMatchEventName);
  await expect(liveArticle.getByLabel('Score Raptors 1, Sharks 0')).toBeVisible();
  await expect(liveArticle.getByText("11' Sharks yellow card")).toBeVisible();
  await expect(liveArticle.getByText('7 markets')).toBeVisible();
  await expect(liveArticle.locator('.event-market-card')).toHaveCount(7);
  await expect(liveArticle.getByText('Next Corner', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Next Yellow Card', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Next Red Card', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Next Penalty', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Half Time Result', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Kickoff Team', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Goal in First Minute', { exact: true })).toBeVisible();
  await expect(preMatchArticle.getByRole('button', { name: state.fixtures.preMatchSelectionLabel })).toBeVisible();
  await expect(liveArticle.locator('..')).not.toHaveClass(/col-xl-4/);
  await expect(preMatchArticle.locator('..')).toHaveClass(/col-xl-4/);
  const liveBounds = await liveArticle.boundingBox();
  const preMatchBounds = await preMatchArticle.boundingBox();
  const marketColumns = await liveArticle.locator('.event-market-grid').evaluate((element) => (
    getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
  ));
  const marketRows = await liveArticle.locator('.event-market-grid').evaluate((element) => (
    new Set(Array.from(element.children).map((card) => card.offsetTop)).size
  ));
  expect(liveBounds.width).toBeGreaterThan(preMatchBounds.width * 2.5);
  expect(liveBounds.height).toBeLessThan(800);
  expect(marketColumns).toBe(7);
  expect(marketRows).toBe(1);

  await page.getByRole('button', { name: state.fixtures.preMatchSelectionLabel }).click();
  await expect(preMatchBoard.locator('.slip-row-card__selection')).toHaveText('Draw');
  await page.getByRole('button', { name: state.fixtures.liveInitialSelectionLabel }).click();
  await expect(liveBoard.locator('.slip-row-card__selection')).toHaveText('Raptors');
  await expect(preMatchBoard.locator('.bet-kind-badge')).toContainText('Pre-match');
  await expect(liveBoard.locator('.bet-kind-badge')).toContainText('Live');
  await expect(page.getByRole('button', { name: state.fixtures.preMatchSelectionLabel })).toHaveClass(/product-button--selected/);
  await expect(page.getByRole('button', { name: state.fixtures.liveInitialSelectionLabel })).toHaveClass(/product-button--selected/);

  await page.getByLabel('Wager for PRE-MATCH SLIP').fill('14');
  await page.getByLabel('Wager for LIVE SLIP').fill('9');
  await expect(page.getByLabel('Wager for PRE-MATCH SLIP')).toHaveValue('14');
  await expect(page.getByLabel('Wager for LIVE SLIP')).toHaveValue('9');

  state.applyLiveSnapshot(state.snapshots.sequence2);
  await liveFeed.emitSnapshot(state.snapshots.sequence2);
  await expect(liveArticle.getByLabel('Score Raptors 1, Sharks 1')).toBeVisible();
  await expect(liveArticle.getByText("18' Sharks goal")).toBeVisible();
  await expect(liveArticle.getByText("11' Sharks yellow card")).toHaveCount(0);
  await expect(page.getByRole('button', { name: state.fixtures.liveUpdatedAwaySelectionLabel })).toBeVisible();
  await expect(page.getByRole('button', { name: state.fixtures.liveUpdatedHomeSelectionLabel })).toBeVisible();

  await liveFeed.emitSnapshot(state.snapshots.sequence2Ignored);
  await liveFeed.emitSnapshot(state.snapshots.sequence1Ignored);
  await expect(liveArticle.getByLabel('Score Raptors 1, Sharks 1')).toBeVisible();
  await expect(page.getByRole('button', { name: state.fixtures.liveUpdatedAwaySelectionLabel })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select Next Corner: Sharks at 9.9' })).toHaveCount(0);

  await page.getByRole('button', { name: state.fixtures.liveUpdatedAwaySelectionLabel }).click();
  await expect(liveBoard.locator('.slip-row-card__selection')).toHaveText('Sharks');
  await expect(preMatchBoard.locator('.slip-row-card__selection')).toHaveText('Draw');
  await expect(page.getByRole('button', { name: state.fixtures.preMatchSelectionLabel })).toHaveClass(/product-button--selected/);
  await expect(page.getByRole('button', { name: state.fixtures.liveUpdatedAwaySelectionLabel })).toHaveClass(/product-button--selected/);
  await expect(page.getByLabel('Wager for PRE-MATCH SLIP')).toHaveValue('14');
  await expect(page.getByLabel('Wager for LIVE SLIP')).toHaveValue('9');

  await liveBoard.getByRole('button', { name: 'BET!' }).click();
  await expect.poll(() => state.submissions.length).toBe(1);
  expect(state.getLastSubmission()).toMatchObject({
    betKind: BET_KIND.LIVE,
    slipId: 'live-draft-1',
    wager: 9,
    placementAttemptId: expect.any(String),
    expectedBoardRevision: 2,
    expectedBoardFingerprint: 'live-draft-1-fingerprint-2',
  });
  expect(state.getLastSubmission().rows.map((row) => row.betKind)).toEqual([BET_KIND.LIVE]);
  await expect(liveBoard.getByRole('button', { name: 'Awaiting review…' })).toBeDisabled();
  await expect(page.getByLabel('Wager for LIVE SLIP')).toBeDisabled();
  await expect(preMatchBoard.getByRole('button', { name: 'BET!' })).toBeEnabled();
  await expect(page.getByLabel('Wager for PRE-MATCH SLIP')).toBeEnabled();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();
  await expect(liveBoard.getByRole('button', { name: 'Awaiting review…' })).toBeDisabled();
  await expect(page.getByLabel('Wager for LIVE SLIP')).toBeDisabled();
  await expect(preMatchBoard.locator('.slip-row-card__selection')).toHaveText('Draw');
  await expect.poll(async () => (await liveFeed.getMetrics()).created).toBe(2);
  await expect.poll(async () => (await liveFeed.getMetrics()).closed).toBe(1);
  await expect.poll(async () => (await liveFeed.getMetrics()).open).toBe(1);

  const boardsBeforeDecline = state.requestCount('GET /api/slip/boards');
  state.applyModerationDecline();
  await liveFeed.emitSnapshot(state.snapshots.sequence3);
  await expect.poll(() => state.requestCount('GET /api/slip/boards'), { timeout: 5000 }).toBeGreaterThan(boardsBeforeDecline);
  await expect(liveBoard.getByText('Declined: Quote changed')).toBeVisible();
  await expect(liveBoard.getByText('Current quote 2.35')).toBeVisible();
  await expect(liveBoard.getByText('Quote v3')).toBeVisible();
  await expect(page.getByLabel('Wager for LIVE SLIP')).toBeEnabled();
  await expect(page.getByRole('button', { name: state.fixtures.liveReplacementSelectionLabel })).toBeVisible();
  await expect(preMatchBoard.locator('.slip-row-card__selection')).toHaveText('Draw');
  await expect(preMatchBoard.getByRole('button', { name: 'BET!' })).toBeEnabled();

  await page.getByLabel('Wager for LIVE SLIP').fill('13');
  await page.getByRole('button', { name: state.fixtures.liveReplacementSelectionLabel }).click();
  await expect(liveBoard.locator('.slip-row-card__odds')).toHaveText('2.35');
  await expect(page.getByLabel('Wager for LIVE SLIP')).toHaveValue('13');
  await liveBoard.getByRole('button', { name: 'BET!' }).click();
  await expect.poll(() => state.submissions.length).toBe(2);
  expect(state.getLastSubmission()).toMatchObject({
    betKind: BET_KIND.LIVE,
    slipId: 'live-draft-2',
    wager: 13,
    placementAttemptId: expect.any(String),
    expectedBoardRevision: 2,
    expectedBoardFingerprint: 'live-draft-2-fingerprint-2',
    rows: [
      expect.objectContaining({
        quoteVersion: 3,
        oddsValue: 2.35,
      }),
    ],
  });
  await expect(liveBoard.getByRole('button', { name: 'Awaiting review…' })).toBeDisabled();

  await page.getByRole('link', { name: 'My bets' }).click();
  const main = page.locator('main');
  const declinedCard = main.locator('.my-bets-card').filter({ hasText: 'Declined: Quote changed' }).first();
  const preMatchHistoryCard = main.locator('.my-bets-card').filter({ hasText: 'Historic Derby' }).first();

  await expect(declinedCard).toContainText('Live');
  await expect(declinedCard).toContainText('Void · Manual void');
  await expect(preMatchHistoryCard).toContainText('Pre-match');
  await expect.poll(async () => (await liveFeed.getMetrics()).open).toBe(0);
  await expect.poll(async () => (await liveFeed.getMetrics()).closed).toBe(2);

  expect(state.unhandledRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.apiFailures).toEqual([]);
});

test('kickoff countdown markets stay compact across responsive widths', async ({ page }) => {
  const state = createLiveBettingMockState();
  const liveFeed = await installFakeEventSource(page);
  const kickoffTime = Date.now() + 5 * 60_000;
  const kickoffAt = new Date(kickoffTime).toISOString();
  const quoteValidUntil = new Date(kickoffTime + 60_000).toISOString();

  state.events = [{
    eventId: 'countdown-1',
    name: 'South Henriton - Pfefferberg',
    time: kickoffAt,
    visibility: 'ONLINE',
    status: 'NO_RESULT',
    home: 'South Henriton',
    away: 'Pfefferberg',
    products: [],
    live: {
      kickoffAt,
      bettingStatus: 'OPEN',
      currentMarkets: [
        {
          marketId: 'kickoff-team',
          marketType: 'KICKOFF_TEAM',
          marketVersion: 1,
          quoteVersion: 1,
          status: 'OPEN',
          quoteValidUntil,
          selections: [
            { selectionId: 'home', side: 'HOME', odds: 1.85 },
            { selectionId: 'away', side: 'AWAY', odds: 2.05 },
          ],
        },
        {
          marketId: 'first-minute-goal',
          marketType: 'FIRST_MINUTE_GOAL',
          marketVersion: 1,
          quoteVersion: 1,
          status: 'OPEN',
          quoteValidUntil,
          selections: [
            { selectionId: 'yes', side: 'YES', odds: 6.5 },
            { selectionId: 'no', side: 'NO', odds: 1.1 },
          ],
        },
      ],
    },
  }];
  await installAppApiMocks(page, state);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/?ui=v2', { waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();

  const countdownArticle = page.getByRole('article', { name: 'South Henriton - Pfefferberg' });
  const marketCards = countdownArticle.locator('.event-market-card');
  const getWidestMarketRatio = async () => countdownArticle.evaluate((article) => {
    const articleWidth = article.getBoundingClientRect().width;
    return Math.max(
      ...Array.from(article.querySelectorAll('.event-market-card'))
        .map((card) => card.getBoundingClientRect().width / articleWidth),
    );
  });

  await expect(page.getByRole('timer')).toBeVisible();
  await expect(countdownArticle.locator('..')).not.toHaveClass(/col-xl-4/);
  await expect(marketCards).toHaveCount(2);
  await expect.poll(getWidestMarketRatio).toBeLessThan(0.3);

  await page.setViewportSize({ width: 768, height: 1000 });
  await expect.poll(getWidestMarketRatio).toBeLessThan(0.45);

  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('live betting layout stays usable on a mobile v3 viewport', async ({ page }) => {
  const state = createLiveBettingMockState();
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);

  state.selectSelection({
    eventId: 'prematch-1',
    productId: 'prematch-1x2',
    oddsId: 'draw',
  });
  state.selectSelection({
    eventId: 'live-1',
    marketId: 'market-corner',
    marketVersion: 1,
    quoteVersion: 1,
    selectionId: 'home',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?ui=v3&theme=light', { waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();

  await expect(page.getByRole('article', { name: state.fixtures.liveEventName })).toBeVisible();
  await expect(page.getByRole('article', { name: state.fixtures.preMatchEventName })).toBeVisible();
  await expect(getBoard(page, BET_KIND.LIVE)).toBeVisible();
  await expect(getBoard(page, BET_KIND.PRE_MATCH)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
