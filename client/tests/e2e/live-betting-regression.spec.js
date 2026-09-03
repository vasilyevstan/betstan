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

// Dense sections retain the Bootstrap 1/2/3-column breakpoints. A single live/countdown/finished
// surface uses the full event stage so its regions can compact horizontally.
const REPRESENTATIVE_VIEWPORTS = [
  {
    label: '1600px',
    width: 1600,
    height: 1000,
    expectedColumns: 3,
    expectedCorrectScoreRows: [5, 5],
  },
  {
    label: '768px',
    width: 768,
    height: 1000,
    expectedColumns: 2,
    expectedCorrectScoreRows: [5, 5],
  },
  {
    label: '390px',
    width: 390,
    height: 844,
    expectedColumns: 1,
    expectedCorrectScoreRows: [2, 2, 2, 2, 2],
  },
];
const UI_VARIANTS = ['v1', 'v2', 'v3'];
const THEMES = ['dark', 'light'];

const getTokenContrastMetrics = (locator, {
  backgroundToken,
  foregroundToken,
  surfaceSelector,
}) => locator.evaluate((element, options) => {
  const parseColor = (value) => {
    const normalized = value.trim();
    if (normalized.startsWith('#')) {
      const hex = normalized.slice(1);
      const expanded = hex.length === 3
        ? hex.split('').map((digit) => `${digit}${digit}`).join('')
        : hex;
      return [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16));
    }

    const components = normalized.match(/[\d.]+/g);
    return components?.slice(0, 3).map(Number) ?? [];
  };
  const luminance = (rgb) => {
    const channels = rgb.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  };
  const contrast = (foreground, background) => {
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
      / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  };

  const style = getComputedStyle(element);
  const surface = options.surfaceSelector
    ? element.closest(options.surfaceSelector)
    : element;
  const surfaceStyle = getComputedStyle(surface);
  const actualForeground = parseColor(style.color);
  const tokenForeground = parseColor(style.getPropertyValue(options.foregroundToken));
  const tokenBackground = parseColor(
    surfaceStyle.getPropertyValue(options.backgroundToken)
  );
  const bounds = element.getBoundingClientRect();

  return {
    contrast: contrast(tokenForeground, tokenBackground),
    height: bounds.height,
    usesForegroundToken: actualForeground.every(
      (channel, index) => channel === tokenForeground[index]
    ),
    width: bounds.width,
  };
}, { backgroundToken, foregroundToken, surfaceSelector });

// Ten distinct, plausible score/price pairs backing the Correct Score fixture below, shared
// between the fixture builder and the test assertions so they can never drift apart.
const CORRECT_SCORE_OPTIONS = [
  ['0 - 0', '11.08'], ['0 - 1', '8.74'], ['0 - 2', '16.27'], ['1 - 0', '10'],
  ['1 - 1', '7.3'], ['1 - 2', '10.65'], ['2 - 0', '19.23'], ['2 - 1', '14.04'],
  ['2 - 2', '20.49'], ['3 - 1', '23.33'],
];

const buildPreMatchProducts = (eventId, home, away) => [
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
    buttonWidths: buttons.map((button) => button.getBoundingClientRect().width),
    valueBottoms: buttons.map((button) => (
      button.querySelector('.product-button__value')?.getBoundingClientRect().bottom
    )),
  };
}, eventName);

const getPreMatchRowBaselines = (page) => page.evaluate(() => {
  const heading = Array.from(document.querySelectorAll('h2'))
    .find((candidate) => candidate.textContent.trim() === 'Pre-match');
  const cards = Array.from(
    heading?.closest('section')?.querySelectorAll(':scope > .row > [class*="col-"] article') ?? [],
  );
  if (cards.length === 0) {
    return null;
  }
  const firstTop = cards[0].getBoundingClientRect().top;
  const firstRow = cards.filter(
    (card) => Math.abs(card.getBoundingClientRect().top - firstTop) < 2,
  );
  const topFor = (card, selector) => card.querySelector(selector)?.getBoundingClientRect().top;

  return {
    correctScoreTitleTops: firstRow.map((card) => topFor(card, '.product-block--cs .product-block__title')),
    oddsValueTops: firstRow.map((card) => topFor(card, '.product-block--1x2 .product-button__value')),
    oneXTwoTitleTops: firstRow.map((card) => topFor(card, '.product-block--1x2 .product-block__title')),
  };
});

const getCompactLiveGeometry = (page) => page.evaluate(() => {
  const liveHeading = Array.from(document.querySelectorAll('h2'))
    .find((candidate) => candidate.textContent.trim() === 'Live now');
  const preMatchHeading = Array.from(document.querySelectorAll('h2'))
    .find((candidate) => candidate.textContent.trim() === 'Pre-match');
  const liveCard = liveHeading?.closest('section')?.querySelector('article');
  const liveBody = liveCard?.querySelector('.event-card__live-body');
  const preMatchCards = Array.from(
    preMatchHeading?.closest('section')?.querySelectorAll(':scope > .row > [class*="col-"] article') ?? [],
  );
  if (!liveCard || !liveBody || preMatchCards.length === 0) {
    return null;
  }

  const firstPreMatchTop = preMatchCards[0].getBoundingClientRect().top;
  const firstPreMatchRow = preMatchCards.filter(
    (card) => Math.abs(card.getBoundingClientRect().top - firstPreMatchTop) < 2,
  );
  const regions = Array.from(liveBody.children).map((region) => {
    const bounds = region.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
    };
  });
  const marketCards = Array.from(liveCard.querySelectorAll('.event-market-card'));
  const marketBounds = marketCards.map((card) => card.getBoundingClientRect());
  const firstMarketTop = marketBounds[0]?.top;
  const firstMarketRow = marketBounds.filter((bounds) => Math.abs(bounds.top - firstMarketTop) < 2);
  const statuses = Array.from(liveCard.querySelectorAll('.event-market-status')).map((status) => {
    const style = getComputedStyle(status);
    return {
      overflowWrap: style.overflowWrap,
      overflows: status.scrollWidth > status.clientWidth + 1,
      wordBreak: style.wordBreak,
    };
  });

  return {
    hasParallelRegions: regions.some((region, index) => regions
      .slice(index + 1)
      .some((other) => (
        Math.abs(region.left - other.left) > 2
        && Math.max(region.top, other.top) < Math.min(region.bottom, other.bottom)
      ))),
    liveHeight: liveCard.getBoundingClientRect().height,
    marketFirstRowCount: firstMarketRow.length,
    marketFirstRowHeightSpread: firstMarketRow.length > 0
      ? Math.max(...firstMarketRow.map((bounds) => bounds.height))
        - Math.min(...firstMarketRow.map((bounds) => bounds.height))
      : 0,
    preMatchRowHeight: Math.max(
      ...firstPreMatchRow.map((card) => card.getBoundingClientRect().height),
    ),
    regions,
    visualRegionOrderMatchesDom: regions
      .map((region, index) => ({ ...region, index }))
      .sort((first, second) => (
        Math.abs(first.top - second.top) >= 2
          ? first.top - second.top
          : first.left - second.left
      ))
      .every((region, visualIndex) => region.index === visualIndex),
    statuses,
  };
});

const getCorrectScoreGeometry = async (article) => {
  const buttons = article.locator('.product-cs-grid > *');
  return buttons.evaluateAll((elements) => {
    const rows = new Map();
    const sizes = [];
    for (const button of elements) {
      const bounds = button.getBoundingClientRect();
      const valueBounds = button.querySelector('.product-button__value')?.getBoundingClientRect();
      const top = Math.round(bounds.top);
      rows.set(top, (rows.get(top) ?? 0) + 1);
      sizes.push({
        height: bounds.height,
        valueFits: Boolean(
          valueBounds
          && valueBounds.left >= bounds.left
          && valueBounds.right <= bounds.right
        ),
        width: bounds.width,
      });
    }
    return { rowSizes: [...rows.values()], sizes };
  });
};

const getCountdownProductsGeometry = async (article) => (
  article.locator('.event-card__countdown-products').evaluate((container) => {
    const containerBounds = container.getBoundingClientRect();
    const header = container.querySelector(':scope > .event-card__section-header');
    const headerBounds = header?.getBoundingClientRect();
    const badgesBounds = header?.querySelector('.event-card__badges')?.getBoundingClientRect();
    const titleBounds = header?.querySelector('.event-card__section-title')?.getBoundingClientRect();
    const productBounds = Array.from(container.querySelectorAll(':scope > .product-block'))
      .map((product) => product.getBoundingClientRect());
    const productLeft = Math.min(...productBounds.map((bounds) => bounds.left));
    const productRight = Math.max(...productBounds.map((bounds) => bounds.right));

    return {
      headerSpansProductDeck: Boolean(
        headerBounds
        && Math.abs(headerBounds.left - containerBounds.left) < 1
        && Math.abs(headerBounds.right - containerBounds.right) < 1
        && headerBounds.left <= productLeft + 1
        && headerBounds.right >= productRight - 1
      ),
      headerItemsShareRow: Boolean(
        badgesBounds
        && titleBounds
        && badgesBounds.top < titleBounds.bottom
        && titleBounds.top < badgesBounds.bottom
      ),
    };
  })
);

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
  products: buildPreMatchProducts(eventId, home, away),
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
      products: buildPreMatchProducts(
        'countdown-1',
        'South Henriton',
        'Pfefferberg',
      ),
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
  products: buildPreMatchProducts(eventId, home, away),
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
  // A single live card uses the full event stage; the sparse pre-match card remains bounded.
  await expect(liveArticle.locator('..')).not.toHaveClass(/col-xl-8/);
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
  expect(liveBounds.width).toBeGreaterThan(preMatchBounds.width * 1.4);
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
    test(`anonymous visitors can visibly discover Backoffice in ${uiVariant} ${theme}`, async ({ page }) => {
      const state = createLiveBettingMockState();
      state.currentUser = null;
      const liveFeed = await installFakeEventSource(page);
      await installAppApiMocks(page, state);

      await page.goto(`/?ui=${uiVariant}&theme=${theme}`, { waitUntil: 'domcontentloaded' });
      await liveFeed.waitForSource();
      await liveFeed.openAll();

      const backofficeLink = page.getByRole('link', { name: 'Backoffice' });
      const backofficeLabel = backofficeLink.locator(
        uiVariant === 'v2' ? '.nav-picture-button__label' : '.nav-icon-link__label'
      );
      await expect(backofficeLink).toBeVisible();
      await expect(backofficeLink).toContainText('Backoffice');
      const navigationMetrics = await getTokenContrastMetrics(backofficeLabel, {
        backgroundToken: '--surface-soft',
        foregroundToken: '--text-main',
        surfaceSelector: 'a',
      });
      expect(navigationMetrics.usesForegroundToken).toBe(true);
      expect(navigationMetrics.contrast).toBeGreaterThanOrEqual(4.5);
      expect(navigationMetrics.width).toBeGreaterThan(40);
      expect(navigationMetrics.height).toBeGreaterThan(8);

      await backofficeLink.click();
      await expect(page).toHaveURL(
        new RegExp(`/backoffice\\?ui=${uiVariant}&theme=${theme}$`)
      );
      await expect(page.getByRole('heading', { name: 'Backoffice' })).toBeVisible();
      await expect(page.getByText(
        'Log in with an administrator account to use Backoffice.'
      )).toBeVisible();
      const loginLink = page.locator('main').getByRole('link', { name: 'Log in' });
      await expect(loginLink).toBeVisible();
      const loginMetrics = await getTokenContrastMetrics(loginLink, {
        backgroundToken: '--accent',
        foregroundToken: '--accent-contrast',
      });
      expect(loginMetrics.usesForegroundToken).toBe(true);
      expect(loginMetrics.contrast).toBeGreaterThanOrEqual(4.5);
      expect(loginMetrics.height).toBeGreaterThanOrEqual(44);
      expect(state.requestCounts['GET /api/backoffice'] ?? 0).toBe(0);
    });
  }

  test(`administrators can visibly discover Backoffice in ${uiVariant}`, async ({ page }) => {
    const state = createLiveBettingMockState();
    state.currentUser.role = 'ADMIN';
    const liveFeed = await installFakeEventSource(page);
    await installAppApiMocks(page, state);

    await page.goto(`/?ui=${uiVariant}&theme=dark`, { waitUntil: 'domcontentloaded' });
    await liveFeed.waitForSource();
    await liveFeed.openAll();

    const backofficeLink = page.getByRole('link', { name: 'Backoffice' });
    await expect(backofficeLink).toBeVisible();
    await expect(backofficeLink).toContainText('Backoffice');
    await backofficeLink.click();
    await expect(page).toHaveURL(new RegExp(`/backoffice\\?ui=${uiVariant}&theme=dark$`));
    await expect(page.getByText('Create new event')).toBeVisible();
    expect(state.requestCounts['GET /api/backoffice']).toBe(1);
  });
}

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
        await expect(countdownArticle.locator('..')).not.toHaveClass(/col-xl-8/);
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
        expect(liveSectionMetrics.widthRatio).toBeGreaterThan(0.95);
        expect(Math.abs(liveSectionMetrics.leftGap - liveSectionMetrics.rightGap)).toBeLessThan(2);

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

        const semanticLabels = await countdownArticle
          .locator('.product-block--1x2 .product-button__label')
          .allTextContents();
        expect(semanticLabels).toEqual(['1', 'X', '2']);
        await expect(countdownArticle.getByRole('button', {
          name: 'Select 1X2 1: South Henriton in South Henriton - Pfefferberg at 1.9',
        })).toBeVisible();

        const countdownCorrectScoreGeometry = await getCorrectScoreGeometry(countdownArticle);
        expect(countdownCorrectScoreGeometry.rowSizes).toEqual(
          viewport.width >= 768 ? [5, 5] : [2, 2, 2, 2, 2],
        );
        expect(countdownCorrectScoreGeometry.sizes.every(
          ({ height, width }) => height >= 44 && width >= 44,
        )).toBe(true);
        expect(countdownCorrectScoreGeometry.sizes.every(({ valueFits }) => valueFits)).toBe(true);

        const countdownProductsGeometry = await getCountdownProductsGeometry(countdownArticle);
        expect(countdownProductsGeometry.headerSpansProductDeck).toBe(true);
        expect(countdownProductsGeometry.headerItemsShareRow).toBe(true);

        const baselines = await getPreMatchRowBaselines(page);
        expect(baselines).not.toBeNull();
        for (const values of Object.values(baselines)) {
          expect(values.every(Number.isFinite)).toBe(true);
          expect(Math.max(...values) - Math.min(...values)).toBeLessThan(2);
        }

        const compactGeometry = await getCompactLiveGeometry(page);
        expect(compactGeometry).not.toBeNull();
        if (viewport.width >= 768) {
          expect(compactGeometry.liveHeight)
            .toBeLessThanOrEqual(compactGeometry.preMatchRowHeight + 8);
          expect(compactGeometry.regions.length).toBe(3);
          expect(compactGeometry.hasParallelRegions).toBe(true);
          expect(compactGeometry.visualRegionOrderMatchesDom).toBe(true);
        }
        if (viewport.width >= 1200) {
          expect(compactGeometry.marketFirstRowCount).toBe(2);
          expect(compactGeometry.marketFirstRowHeightSpread).toBeLessThan(2);
        }
        expect(compactGeometry.statuses.every(({ overflows }) => !overflows)).toBe(true);
        expect(compactGeometry.statuses.every(
          ({ overflowWrap, wordBreak }) => overflowWrap === 'normal' && wordBreak === 'normal',
        )).toBe(true);

        expect(await hasIntersectingElements(page, '.event-card')).toBe(false);
        expect(await hasIntersectingElements(page, '.event-market-card')).toBe(false);
        expect(await hasDocumentHorizontalOverflow(page)).toBe(false);
        expect(await hasInternalOverflow(page, '.event-card')).toBe(false);
        expect(await hasInternalOverflow(page, '.event-market-grid')).toBe(false);
        expect(await hasInternalOverflow(page, '.product-block--1x2')).toBe(false);
        expect(await hasInternalOverflow(
          page,
          '.event-card--countdown .product-cs-grid',
        )).toBe(false);
        expect(await hasIntersectingElements(
          page,
          '.event-card--countdown .product-cs-grid > *',
        )).toBe(false);

        // Native button semantics remain intact after the layout-only correction.
        await kickoffTeamButton.focus();
        await expect(kickoffTeamButton).toBeFocused();
        await expect(suspendedButton).not.toBeFocused();
      });
    }
  }
}

test('countdown product controls stay balanced through live-card layout transitions', async ({ page }) => {
  const state = buildResponsiveLayoutState();
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);

  await page.setViewportSize({ width: 720, height: 1000 });
  await page.goto('/?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();

  const countdownArticle = page.getByRole('article', { name: 'South Henriton - Pfefferberg' });
  for (const width of [720, 736, 968, 984, 1000]) {
    await page.setViewportSize({ width, height: 1000 });

    const correctScoreGeometry = await getCorrectScoreGeometry(countdownArticle);
    expect(new Set(correctScoreGeometry.rowSizes).size, `${width}px balanced rows`).toBe(1);
    expect([2, 5], `${width}px supported row width`).toContain(
      correctScoreGeometry.rowSizes[0],
    );
    expect(correctScoreGeometry.sizes.every(
      ({ height, width: controlWidth }) => height >= 44 && controlWidth >= 44,
    ), `${width}px touch targets`).toBe(true);
    expect(
      correctScoreGeometry.sizes.every(({ valueFits }) => valueFits),
      `${width}px price bounds`,
    ).toBe(true);

    const productGeometry = await getCountdownProductsGeometry(countdownArticle);
    expect(productGeometry.headerSpansProductDeck, `${width}px shared heading`).toBe(true);
    expect(productGeometry.headerItemsShareRow, `${width}px compact heading row`).toBe(true);
    expect(await hasInternalOverflow(
      page,
      '.event-card--countdown .product-cs-grid',
    ), `${width}px internal overflow`).toBe(false);
    expect(await hasIntersectingElements(
      page,
      '.event-card--countdown .product-cs-grid > *',
    ), `${width}px control collisions`).toBe(false);

    if (width >= 768) {
      const compactGeometry = await getCompactLiveGeometry(page);
      expect(
        compactGeometry.liveHeight,
        `${width}px comparative height`,
      ).toBeLessThanOrEqual(compactGeometry.preMatchRowHeight + 8);
    }
  }
});

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
          height: bounds.height,
          top: bounds.top,
          widthRatio: bounds.width / row.getBoundingClientRect().width,
        };
      });
    }, title);
    expect(cardMetrics).toHaveLength(2);
    expect(cardMetrics.every(({ className }) => className.includes('col-md-6'))).toBe(true);
    expect(cardMetrics.every(({ widthRatio }) => widthRatio > 0.48 && widthRatio < 0.52)).toBe(true);
    expect(Math.abs(cardMetrics[0].top - cardMetrics[1].top)).toBeLessThan(2);
    expect(Math.abs(cardMetrics[0].height - cardMetrics[1].height)).toBeLessThan(2);
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

test('malformed legacy 1X2 data keeps a balanced, identity-safe fallback board', async ({ page }) => {
  const state = buildResponsiveLayoutState();
  const event = state.events[1];
  const product = event.products.find(({ type }) => type === '1X2');
  product.odds[1].id = product.odds[0].id;
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
  await liveFeed.waitForSource();
  await liveFeed.openAll();

  const article = page.getByRole('article', { name: event.name });
  await expect(article.getByRole('button', {
    name: `Select 1X2 ${event.home} at 1.9`,
  })).toBeVisible();
  await expect(article.getByRole('button', {
    name: 'Select 1X2 Draw at 3.1',
  })).toBeVisible();
  await expect(article.getByRole('button', {
    name: `Select 1X2 ${event.away} at 2.2`,
  })).toBeVisible();
  await expect(article.locator('.product-1x2-grid > div')).toHaveCount(3);

  const alignment = await getLabelledButtonAlignment(page, event.name);
  expect(Math.max(...alignment.buttonWidths) - Math.min(...alignment.buttonWidths))
    .toBeLessThan(2);
  expect(Math.max(...alignment.valueBottoms) - Math.min(...alignment.valueBottoms))
    .toBeLessThan(2);
  expect(alignment.buttonHeights.every((height) => height >= 44)).toBe(true);
});

test('collapsed countdown stays within two-card pre-match row budgets', async ({ page }) => {
  const state = buildResponsiveLayoutState();
  const countdown = state.events[0];
  const preMatchEvents = state.events.slice(1);
  const liveFeed = await installFakeEventSource(page);
  await installAppApiMocks(page, state);

  state.events = [countdown, ...preMatchEvents.slice(0, 2)];
  for (const viewport of [
    { width: 1600, height: 1000 },
    { width: 768, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
    await liveFeed.waitForSource();
    await liveFeed.openAll();

    const geometry = await getCompactLiveGeometry(page);
    expect(geometry).not.toBeNull();
    expect(
      geometry.liveHeight,
      `two-card pre-match row at ${viewport.width}px`,
    ).toBeLessThanOrEqual(geometry.preMatchRowHeight + 8);
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
        expect(await article.locator('.product-cs-grid .product-button__label').allTextContents())
          .toEqual(CORRECT_SCORE_OPTIONS.map(([score]) => score));
        expect(await article.locator('.product-block__title').evaluateAll((titles) => (
          titles.map((title) => getComputedStyle(title).textAlign)
        ))).toEqual(['center', 'center']);

        const correctScoreGeometry = await getCorrectScoreGeometry(article);
        expect(correctScoreGeometry.rowSizes).toEqual(viewport.expectedCorrectScoreRows);
        expect(correctScoreGeometry.sizes.every(
          ({ height, width }) => height >= 44 && width >= 44
        )).toBe(true);
        expect(correctScoreGeometry.sizes.every(({ valueFits }) => valueFits)).toBe(true);

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
    expect(geometry.sizes.every(({ valueFits }) => valueFits)).toBe(true);
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
  expect(geometry.rowSizes).toEqual([2, 2, 2, 2, 2]);
  expect(geometry.sizes.every(
    ({ height, width }) => height >= 44 && width >= 44
  )).toBe(true);
  expect(geometry.sizes.every(({ valueFits }) => valueFits)).toBe(true);
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
      incidentHistoryComplete: true,
      incidentHistory: [
        { id: 'kickoff', type: 'KICK_OFF', minute: 0 },
        { id: 'first-minute', type: 'FIRST_MINUTE_ELAPSED', minute: 1 },
        { id: 'early-goal', type: 'GOAL', side: 'HOME', minute: 17 },
        { id: 'half-time', type: 'HALF_TIME', minute: 45 },
        { id: 'penalty-scored', type: 'PENALTY_SCORED', side: 'AWAY', minute: 63 },
        {
          id: 'penalty-goal',
          relatedIncidentId: 'penalty-scored',
          type: 'GOAL',
          side: 'AWAY',
          minute: 63,
        },
        { id: 'winner', type: 'GOAL', side: 'HOME', minute: 84 },
        { id: 'added-time', type: 'ADDED_TIME_ANNOUNCED', minute: 90, addedTime: 4 },
        { id: 'full-time', type: 'FULL_TIME', minute: 90, addedTime: 4 },
      ],
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
    await expect(finishedArticle.getByText('FULL-TIME', { exact: true })).toBeVisible();
    await expect(finishedArticle.locator('time')).toHaveAttribute('datetime', kickoffAt);
    await expect(finishedArticle.locator('..')).not.toHaveClass(/col-xl-8/);
    const keyMoments = finishedArticle.locator('.event-card__finished-timeline > .event-incidents');
    await expect(keyMoments.getByText("17' Riverton goal")).toBeVisible();
    await expect(keyMoments.getByText("63' Fairhaven penalty scored")).toBeVisible();
    await expect(keyMoments.getByText("84' Riverton goal")).toBeVisible();
    await expect(finishedArticle.getByText('Full timeline (7)')).toBeVisible();
    const details = finishedArticle.locator('details');
    await expect(details).not.toHaveAttribute('open', '');
    await details.locator('summary').click();
    await expect(details).toHaveAttribute('open', '');
    expect(await details.locator('li').allTextContents()).toEqual([
      'Kick-off',
      "17' Riverton goal",
      'Half-time',
      "63' Fairhaven penalty scored",
      "84' Riverton goal",
      'Added time +4',
      'Full-time',
    ]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});
