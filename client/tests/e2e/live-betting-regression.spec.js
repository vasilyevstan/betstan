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

// Dense sections retain the Bootstrap 1/2/3-column breakpoints. Sparse one-card sections expand
// to a bounded two-thirds stage at xl and the full stage below xl.
const REPRESENTATIVE_VIEWPORTS = [
  { label: '1600px', width: 1600, height: 1000, expectedColumns: 3 },
  { label: '768px', width: 768, height: 1000, expectedColumns: 2 },
  { label: '390px', width: 390, height: 844, expectedColumns: 1 },
];
const UI_VARIANTS = ['v1', 'v2', 'v3'];
const THEMES = ['dark', 'light'];

// Ten distinct, plausible score/price pairs backing the Correct Score fixture below, shared
// between the fixture builder and the test assertions so they can never drift apart.
const CORRECT_SCORE_OPTIONS = [
  ['1 - 0', '6'], ['0 - 0', '7'], ['1 - 1', '8'], ['2 - 0', '9'], ['2 - 1', '10'],
  ['0 - 1', '11'], ['1 - 2', '12'], ['2 - 2', '13'], ['0 - 2', '14'], ['3 - 1', '15'],
];

// Counts how many of the "Pre-match" section's sibling cards share the same top offset as the
// first one, i.e. how many columns the current viewport lays out in the first row.
const getPreMatchColumnCount = (page) => page.evaluate(() => {
  const heading = Array.from(document.querySelectorAll('h2'))
    .find((candidate) => candidate.textContent.trim() === 'Pre-match');
  const section = heading?.closest('section');
  const cards = Array.from(section?.querySelectorAll(':scope > .row > [class*="col-"]') ?? []);
  if (cards.length === 0) {
    return 0;
  }
  const firstTop = cards[0].getBoundingClientRect().top;
  return cards.filter((card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2).length;
});

const getSectionCardMetrics = (page, title) => page.evaluate((sectionTitle) => {
  const heading = Array.from(document.querySelectorAll('h2'))
    .find((candidate) => candidate.textContent.trim() === sectionTitle);
  const row = heading?.closest('section')?.querySelector(':scope > .row');
  const card = row?.querySelector(':scope > [class*="col-"]');
  if (!row || !card) {
    return null;
  }

  const rowBox = row.getBoundingClientRect();
  const cardBox = card.getBoundingClientRect();
  return {
    widthRatio: cardBox.width / rowBox.width,
    leftGap: cardBox.left - rowBox.left,
    rightGap: rowBox.right - cardBox.right,
  };
}, title);

const getLabelledButtonAlignment = (page, eventName) => page.evaluate((name) => {
  const card = Array.from(document.querySelectorAll('article[aria-label]'))
    .find((candidate) => candidate.getAttribute('aria-label') === name);
  const buttons = Array.from(card?.querySelectorAll('.product-1x2-grid .product-button--labelled') ?? []);

  return {
    buttonBottoms: buttons.map((button) => button.getBoundingClientRect().bottom),
    buttonHeights: buttons.map((button) => button.getBoundingClientRect().height),
    buttonTops: buttons.map((button) => button.getBoundingClientRect().top),
    valueBottoms: buttons.map((button) => (
      button.querySelector('.product-button__value')?.getBoundingClientRect().bottom
    )),
  };
}, eventName);

const getCorrectScoreGeometry = async (article) => {
  const buttons = article.locator('.product-cs-grid > *');
  return buttons.evaluateAll((elements) => {
    const rows = new Map();
    const sizes = [];
    for (const button of elements) {
      const bounds = button.getBoundingClientRect();
      const top = Math.round(bounds.top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
      sizes.push({ height: bounds.height, width: bounds.width });
    }
    return { rowSizes: [...rows.values()], sizes };
  });
};

const hasIntersectingElements = (page, selector) => page.evaluate((cardSelector) => {
  const boxes = Array.from(document.querySelectorAll(cardSelector)).map((element) => element.getBoundingClientRect());
  const intersects = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  return boxes.some((box, index) => boxes.some((other, otherIndex) => otherIndex !== index && intersects(box, other)));
}, selector);

const hasDocumentHorizontalOverflow = (page) => page.evaluate(() => (
  document.documentElement.scrollWidth > window.innerWidth
));

// Container-level clipping check: a document-level overflow check alone would miss an element
// whose *own* content overflows its own box (e.g. a market/product card whose internal grid is
// wider than the card itself) while the outer page still happens to fit the viewport. Every
// matched element's own `scrollWidth` must not exceed its `clientWidth` (a 1px tolerance absorbs
// subpixel rounding).
const hasInternalOverflow = (page, selector) => page.evaluate((cardSelector) => (
  Array.from(document.querySelectorAll(cardSelector)).some((element) => element.scrollWidth > element.clientWidth + 1)
), selector);

const buildSiblingPreMatchEvent = (eventId, home, away, time) => ({
  eventId,
  name: `${home} - ${away}`,
  time,
  visibility: 'ONLINE',
  status: 'NO_RESULT',
  home,
  away,
  products: [{
    id: `${eventId}-1x2`,
    type: '1X2',
    name: '1X2',
    odds: [
      { id: 'home', name: home, value: 1.9 },
      { id: 'draw', name: 'Draw', value: 3.1 },
      { id: 'away', name: away, value: 2.2 },
    ],
  }],
});

/** Fixture shared by the responsive event/market layout matrix: one countdown event carrying an
 * OPEN, a SUSPENDED, and a terminal SETTLED market (to exercise terminal-exclusion/suspended-
 * visibility together with layout), plus three plain pre-match siblings (to exercise the 3/2/1
 * column behavior with enough cards to fill a full row at the widest breakpoint). */
const buildResponsiveLayoutState = () => {
  const state = createLiveBettingMockState();
  const kickoffTime = Date.now() + 5 * 60_000;
  const kickoffAt = new Date(kickoffTime).toISOString();
  const quoteValidUntil = new Date(kickoffTime + 60_000).toISOString();
  const laterTime = new Date(kickoffTime + 6 * 60 * 60 * 1000).toISOString();

  state.events = [
    {
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
            status: 'SUSPENDED',
            quoteValidUntil,
            selections: [
              { selectionId: 'yes', side: 'YES', odds: 6.5 },
              { selectionId: 'no', side: 'NO', odds: 1.1 },
            ],
          },
          {
            // Terminal (SETTLED) markets are excluded from the rendered card list entirely.
            marketId: 'half-time-result',
            marketType: 'HALF_TIME_RESULT',
            marketVersion: 1,
            quoteVersion: 1,
            status: 'SETTLED',
            quoteValidUntil,
            selections: [
              { selectionId: 'home', side: 'HOME', odds: 2.2 },
            ],
          },
        ],
      },
    },
    buildSiblingPreMatchEvent('sibling-1', 'North Christopherborough United', 'Eastwick', laterTime),
    buildSiblingPreMatchEvent('sibling-2', 'Westfall', 'Southmoor', laterTime),
    buildSiblingPreMatchEvent('sibling-3', 'Ridgeport', 'Lakeview', laterTime),
  ];

  return state;
};

const buildCorrectScoreEvent = (eventId, home, away, time) => ({
  eventId,
  name: `${home} - ${away}`,
  time,
  visibility: 'ONLINE',
  status: 'NO_RESULT',
  home,
  away,
  products: [
    {
      id: `${eventId}-1x2`,
      type: '1X2',
      name: '1X2',
      odds: [
        { id: `${eventId}-home`, name: home, value: 1.9 },
        { id: `${eventId}-draw`, name: 'Draw', value: 3.1 },
        { id: `${eventId}-away`, name: away, value: 2.2 },
      ],
    },
    {
      id: `${eventId}-correct-score`,
      type: 'CS',
      name: 'Correct Score',
      odds: CORRECT_SCORE_OPTIONS.map(([name, value], index) => ({
        id: `${eventId}-cs-${index}`,
        name,
        value: Number(value),
      })),
    },
  ],
});

/** Fixture for one sparse or three dense pre-match Correct Score boards. */
const buildCorrectScoreLayoutState = (eventCount = 1) => {
  const state = createLiveBettingMockState();
  const laterTime = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const events = [
    buildCorrectScoreEvent('correct-score-1', 'Millhaven', 'Oakbridge', laterTime),
    buildCorrectScoreEvent('correct-score-2', 'Northpoint', 'Westhaven', laterTime),
    buildCorrectScoreEvent('correct-score-3', 'Southfield', 'Eastmoor', laterTime),
  ];
  state.events = events.slice(0, eventCount);

  return state;
};

test('live betting main page flow is deterministic without a backend', async ({ page }) => {
  const state = createLiveBettingMockState();
  const liveFeed = await installFakeEventSource(page);
  // A legacy bet whose stored `oddsName`/`winningSelection` is a raw internal live-selection
  // identifier (rather than an already human-readable label) -- exercises the My Bets defensive
  // normalization (`formatLegacyLiveSelectionLabel`) end-to-end.
  const legacyRawIdentifier = 'live-1:NEXT_CORNER:1:HOME';
  state.bets.push({
    _id: 'bet-legacy-live-identifier',
    slipId: 'legacy-live-identifier-1',
    status: 'WIN',
    wager: 4,
    timestamp: '2030-01-01T09:00:00.000Z',
    betKind: BET_KIND.LIVE,
    rows: [{
      _id: 'row-legacy-live-identifier',
      eventId: 'live-1',
      eventName: 'Raptors - Sharks',
      oddsId: 'legacy-oid',
      oddsValue: 1.8,
      oddsName: legacyRawIdentifier,
      productName: '',
      marketType: 'NEXT_CORNER',
      marketId: 'market-corner',
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: 'home',
      side: 'HOME',
      timestamp: '2030-01-01T09:00:00.000Z',
      eventTime: '2030-01-01T12:00:00.000Z',
      betKind: BET_KIND.LIVE,
      status: 'WIN',
      winningSelection: legacyRawIdentifier,
    }],
  });
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
  // The fixture's Kickoff Team and Goal in First Minute markets are SETTLED (terminal): they are
  // excluded from the rendered card list entirely, leaving the 5 still-active markets.
  await expect(liveArticle.getByText('5 markets')).toBeVisible();
  await expect(liveArticle.locator('.event-market-card')).toHaveCount(5);
  await expect(liveArticle.getByText('Next Corner', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Next Yellow Card', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Next Red Card', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Next Penalty', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Half Time Result', { exact: true })).toBeVisible();
  await expect(liveArticle.getByText('Kickoff Team', { exact: true })).toHaveCount(0);
  await expect(liveArticle.getByText('Goal in First Minute', { exact: true })).toHaveCount(0);
  await expect(preMatchArticle.getByRole('button', { name: state.fixtures.preMatchSelectionLabel })).toBeVisible();
  // Each section contains one card, so both use the bounded sparse-section width.
  await expect(liveArticle.locator('..')).toHaveClass(/col-xl-8/);
  await expect(preMatchArticle.locator('..')).toHaveClass(/col-xl-8/);
  const liveBounds = await liveArticle.boundingBox();
  const preMatchBounds = await preMatchArticle.boundingBox();
  const marketCardBoxes = await liveArticle.locator('.event-market-card').evaluateAll((cards) => (
    cards.map((card) => card.getBoundingClientRect()).map(({ x, y, width, height }) => ({ x, y, width, height }))
  ));
  const boxesIntersect = (a, b) => (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
  const hasIntersectingMarketCards = marketCardBoxes.some((box, index) => (
    marketCardBoxes.some((other, otherIndex) => otherIndex !== index && boxesIntersect(box, other))
  ));
  // Both cards now share the same responsive column width, so their rendered widths should be
  // close (no more full-width-vs-narrow-column mismatch).
  expect(Math.abs(liveBounds.width - preMatchBounds.width)).toBeLessThan(4);
  expect(hasIntersectingMarketCards).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

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
  const legacyIdentifierCard = main.locator('.my-bets-card').filter({ hasText: 'Won · Winner' }).first();

  await expect(declinedCard).toContainText('Live');
  await expect(declinedCard).toContainText('Void · Manual void');
  await expect(preMatchHistoryCard).toContainText('Pre-match');
  // The raw stored identifier is never rendered verbatim -- it is normalized into a readable
  // "<market>: <side>" label derived from the row's own structured live fields.
  await expect(legacyIdentifierCard).toContainText('Next Corner: Raptors');
  await expect(legacyIdentifierCard).toContainText('Won · Winner: Next Corner: Raptors');
  await expect(page.getByText(legacyRawIdentifier, { exact: false })).toHaveCount(0);
  await expect.poll(async () => (await liveFeed.getMetrics()).open).toBe(0);
  await expect.poll(async () => (await liveFeed.getMetrics()).closed).toBe(2);

  expect(state.unhandledRequests).toEqual([]);
  expect(diagnostics.pageErrors).toEqual([]);
  expect(diagnostics.apiFailures).toEqual([]);
});

for (const uiVariant of UI_VARIANTS) {
  for (const theme of THEMES) {
    for (const viewport of REPRESENTATIVE_VIEWPORTS) {
      test(`event/market layout stays responsive (${viewport.expectedColumns}-column), aligned, and unclipped (ui=${uiVariant}, theme=${theme}, ${viewport.label})`, async ({ page }) => {
        const state = buildResponsiveLayoutState();
        const liveFeed = await installFakeEventSource(page);
        await installAppApiMocks(page, state);

        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`/?ui=${uiVariant}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
        await liveFeed.waitForSource();
        await liveFeed.openAll();

        const countdownArticle = page.getByRole('article', { name: 'South Henriton - Pfefferberg' });
        const marketCards = countdownArticle.locator('.event-market-card');

        await expect(page.getByRole('timer')).toBeVisible();
        await expect(countdownArticle.locator('..')).toHaveClass(/col-12/);
        await expect(countdownArticle.locator('..')).toHaveClass(/col-xl-8/);
        await expect(countdownArticle.locator('..')).not.toHaveClass(/col-xl-4/);
        // The SETTLED market is terminal and excluded entirely; only the two still-active markets remain.
        await expect(marketCards).toHaveCount(2);
        const kickoffTeamButton = page.getByRole('button', { name: 'Select Kickoff Team: South Henriton at 1.85' });
        const suspendedButton = page.getByRole('button', { name: 'Select Goal in First Minute: Yes at 6.5' });
        await expect(kickoffTeamButton).toBeEnabled();
        await expect(suspendedButton).toBeDisabled();
        await expect(countdownArticle.getByText('Temporarily suspended')).toBeVisible();
        await expect(countdownArticle.getByText('Half Time Result', { exact: true })).toHaveCount(0);

        await expect.poll(() => getPreMatchColumnCount(page)).toBe(viewport.expectedColumns);

        const liveSectionMetrics = await getSectionCardMetrics(page, 'Live now');
        expect(liveSectionMetrics).not.toBeNull();
        if (viewport.width >= 1200) {
          expect(liveSectionMetrics.widthRatio).toBeGreaterThan(0.62);
          expect(liveSectionMetrics.widthRatio).toBeLessThan(0.7);
          expect(Math.abs(liveSectionMetrics.leftGap - liveSectionMetrics.rightGap)).toBeLessThan(2);
        } else {
          expect(liveSectionMetrics.widthRatio).toBeGreaterThan(0.92);
        }

        const labelledButtonAlignment = await getLabelledButtonAlignment(
          page,
          'North Christopherborough United - Eastwick',
        );
        expect(labelledButtonAlignment.buttonTops).toHaveLength(3);
        expect(Math.max(...labelledButtonAlignment.buttonTops) - Math.min(...labelledButtonAlignment.buttonTops))
          .toBeLessThan(1);
        expect(Math.max(...labelledButtonAlignment.buttonBottoms) - Math.min(...labelledButtonAlignment.buttonBottoms))
          .toBeLessThan(1);
        expect(labelledButtonAlignment.buttonHeights.every((height) => height >= 44)).toBe(true);
        expect(Math.max(...labelledButtonAlignment.valueBottoms) - Math.min(...labelledButtonAlignment.valueBottoms))
          .toBeLessThan(1);

        expect(await hasIntersectingElements(page, '.event-card')).toBe(false);
        expect(await hasIntersectingElements(page, '.event-market-card')).toBe(false);
        expect(await hasDocumentHorizontalOverflow(page)).toBe(false);
        expect(await hasInternalOverflow(page, '.event-card')).toBe(false);
        expect(await hasInternalOverflow(page, '.event-market-grid')).toBe(false);
        expect(await hasInternalOverflow(page, '.product-block--1x2')).toBe(false);

        // Native button semantics remain intact after the layout-only correction.
        await kickoffTeamButton.focus();
        await expect(kickoffTeamButton).toBeFocused();
        await expect(suspendedButton).not.toBeFocused();
      });
    }
  }
}

test('two-card live and pre-match sections fill balanced rows and stack on mobile', async ({ page }) => {
  const state = buildResponsiveLayoutState();
  const secondCountdown = JSON.parse(JSON.stringify(state.events[0]));
  secondCountdown.eventId = 'countdown-2';
  secondCountdown.name = 'Northbridge - Southport';
  secondCountdown.home = 'Northbridge';
  secondCountdown.away = 'Southport';
  state.events = [
    state.events[0],
    secondCountdown,
    state.events[1],
    state.events[2],
  ];
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/?ui=v3&theme=dark', { waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();

  for (const title of ['Live now', 'Pre-match']) {
    const cardMetrics = await page.evaluate((sectionTitle) => {
      const heading = Array.from(document.querySelectorAll('h2'))
        .find((candidate) => candidate.textContent.trim() === sectionTitle);
      const row = heading?.closest('section')?.querySelector(':scope > .row');
      const cards = Array.from(row?.querySelectorAll(':scope > [class*="col-"]') ?? []);
      return cards.map((card) => {
        const bounds = card.getBoundingClientRect();
        return {
          className: card.className,
          top: bounds.top,
          widthRatio: bounds.width / row.getBoundingClientRect().width,
        };
      });
    }, title);
    expect(cardMetrics).toHaveLength(2);
    expect(cardMetrics.every(({ className }) => className.includes('col-md-6'))).toBe(true);
    expect(cardMetrics.every(({ widthRatio }) => widthRatio > 0.48 && widthRatio < 0.52)).toBe(true);
    expect(Math.abs(cardMetrics[0].top - cardMetrics[1].top)).toBeLessThan(2);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  for (const title of ['Live now', 'Pre-match']) {
    const cardMetrics = await page.evaluate((sectionTitle) => {
      const heading = Array.from(document.querySelectorAll('h2'))
        .find((candidate) => candidate.textContent.trim() === sectionTitle);
      const row = heading?.closest('section')?.querySelector(':scope > .row');
      const cards = Array.from(row?.querySelectorAll(':scope > [class*="col-"]') ?? []);
      return cards.map((card) => {
        const bounds = card.getBoundingClientRect();
        return {
          top: bounds.top,
          widthRatio: bounds.width / row.getBoundingClientRect().width,
        };
      });
    }, title);
    expect(cardMetrics).toHaveLength(2);
    expect(cardMetrics.every(({ widthRatio }) => widthRatio > 0.92)).toBe(true);
    expect(Math.abs(cardMetrics[0].top - cardMetrics[1].top)).toBeGreaterThan(2);
  }
});

for (const uiVariant of UI_VARIANTS) {
  for (const theme of THEMES) {
    for (const viewport of REPRESENTATIVE_VIEWPORTS) {
      test(`pre-match Correct Score board stays balanced and unclipped (ui=${uiVariant}, theme=${theme}, ${viewport.label})`, async ({ page }) => {
        const state = buildCorrectScoreLayoutState();
        const liveFeed = await installFakeEventSource(page);
        await installAppApiMocks(page, state);

        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(`/?ui=${uiVariant}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
        await liveFeed.waitForSource();
        await liveFeed.openAll();

        const article = page.getByRole('article', { name: 'Millhaven - Oakbridge' });

        await expect(article).toBeVisible();
        for (const [score, price] of CORRECT_SCORE_OPTIONS) {
          const button = article.getByRole('button', { name: `Select Correct Score ${score} at ${price}` });
          await expect(button).toBeVisible();
          await expect(button).toContainText(score);
          await expect(button).toContainText(price);
        }

        const correctScoreGeometry = await getCorrectScoreGeometry(article);
        expect(correctScoreGeometry.rowSizes).toEqual([5, 5]);
        expect(correctScoreGeometry.sizes.every(
          ({ height, width }) => height >= 44 && width >= 44
        )).toBe(true);

        expect(await hasIntersectingElements(page, '.product-cs-grid > *')).toBe(false);
        expect(await hasDocumentHorizontalOverflow(page)).toBe(false);
        expect(await hasInternalOverflow(page, '.event-card')).toBe(false);
        expect(await hasInternalOverflow(page, '.product-cs-grid')).toBe(false);
        expect(await hasInternalOverflow(page, '.product-block--1x2')).toBe(false);
      });
    }
  }
}

for (const uiVariant of UI_VARIANTS) {
  test(`dense Correct Score cards preserve touch targets with container reflow (ui=${uiVariant})`, async ({ page }) => {
    const state = buildCorrectScoreLayoutState(3);
    const liveFeed = await installFakeEventSource(page);
    await installAppApiMocks(page, state);

    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.goto(`/?ui=${uiVariant}&theme=dark`, { waitUntil: 'domcontentloaded' });
    await liveFeed.waitForSource();
    await liveFeed.openAll();

    await expect.poll(() => getPreMatchColumnCount(page)).toBe(3);
    const article = page.getByRole('article', { name: 'Millhaven - Oakbridge' });
    const geometry = await getCorrectScoreGeometry(article);
    expect(geometry.rowSizes).toEqual([2, 2, 2, 2, 2]);
    expect(geometry.sizes.every(
      ({ height, width }) => height >= 44 && width >= 44
    )).toBe(true);
    expect(await hasInternalOverflow(page, '.product-cs-grid')).toBe(false);
    expect(await hasDocumentHorizontalOverflow(page)).toBe(false);
  });
}

test('Correct Score controls stay touch-safe at a narrow mobile width', async ({ page }) => {
  const state = buildCorrectScoreLayoutState();
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);

  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/?ui=v3&theme=light', { waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();

  const article = page.getByRole('article', { name: 'Millhaven - Oakbridge' });
  const geometry = await getCorrectScoreGeometry(article);
  expect(geometry.rowSizes.every((rowSize) => rowSize === 2 || rowSize === 5)).toBe(true);
  expect(geometry.rowSizes.reduce((sum, rowSize) => sum + rowSize, 0)).toBe(10);
  expect(geometry.sizes.every(
    ({ height, width }) => height >= 44 && width >= 44
  )).toBe(true);
  expect(await hasInternalOverflow(page, '.product-cs-grid')).toBe(false);
  expect(await hasDocumentHorizontalOverflow(page)).toBe(false);
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

test('a recently finished event groups under "Recently finished" (not "Live now") with its scheduled kickoff time, across representative widths', async ({ page }) => {
  const state = createLiveBettingMockState();
  const liveFeed = await installFakeEventSource(page);
  const kickoffAt = '2030-06-01T15:00:00.000Z';

  state.events = [{
    eventId: 'finished-1',
    name: 'Riverton - Fairhaven',
    time: kickoffAt,
    visibility: 'ONLINE',
    status: 'NO_RESULT',
    home: 'Riverton',
    away: 'Fairhaven',
    products: [],
    live: {
      phase: 'FULL_TIME',
      kickoffAt,
      occurredAt: '2030-06-01T16:48:00.000Z',
      homeScore: 2,
      awayScore: 1,
      bettingStatus: 'SUSPENDED',
      incidentHistory: [],
      currentMarkets: [],
    },
  }];
  await installAppApiMocks(page, state);

  for (const viewport of [{ width: 1600, height: 1000 }, { width: 768, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/?ui=v2', { waitUntil: 'domcontentloaded' });
    await liveFeed.waitForSource();
    await liveFeed.openAll();

    await expect(page.getByRole('heading', { name: 'Live now' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Recently finished' })).toBeVisible();
    const finishedArticle = page.getByRole('article', { name: 'Riverton - Fairhaven' });
    await expect(finishedArticle).toBeVisible();
    await expect(finishedArticle.getByText('FULL-TIME')).toBeVisible();
    await expect(finishedArticle.locator('time')).toHaveAttribute('datetime', kickoffAt);
    await expect(finishedArticle.locator('..')).toHaveClass(/col-xl-8/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
