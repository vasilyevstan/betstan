const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { test, expect } = require('@playwright/test');

const ROTATING_LIVE_MARKETS = [
  { marketType: 'NEXT_YELLOW_CARD', label: 'Next Yellow Card' },
  { marketType: 'NEXT_CORNER', label: 'Next Corner Kick' },
  { marketType: 'NEXT_FREE_KICK', label: 'Next Free Kick' },
  { marketType: 'NEXT_THROW_IN', label: 'Next Throw-In' },
  { marketType: 'NEXT_GOAL_KICK', label: 'Next Goal Kick' },
  { marketType: 'NEXT_PENALTY', label: 'Next Penalty' },
  { marketType: 'NEXT_RED_CARD', label: 'Next Red Card' },
];
const FIXED_IN_MATCH_MARKETS = [
  'HALF_TIME_RESULT',
  'SECOND_HALF_SCORE',
];
const SETTLEMENT_MARKET_TYPE = 'SECOND_HALF_SCORE';
const SETTLEMENT_REASON = 'SECOND_HALF_SCORE';
const PRE_KICKOFF_PLACEMENT_MARKET_TYPE = 'KICKOFF_TEAM';
const COUNTDOWN_MARKETS = [
  { marketType: 'KICKOFF_TEAM', label: 'Kickoff Team' },
  { marketType: 'FIRST_MINUTE_GOAL', label: 'Goal in First Minute' },
];
const ALL_LIVE_MARKET_TYPES = [
  ...ROTATING_LIVE_MARKETS.map(({ marketType }) => marketType),
  ...FIXED_IN_MATCH_MARKETS,
  ...COUNTDOWN_MARKETS.map(({ marketType }) => marketType),
];
const REQUIRED_PER_EVENT_MARKETS = [
  ...ROTATING_LIVE_MARKETS.slice(0, 4).map(({ marketType }) => marketType),
  ...FIXED_IN_MATCH_MARKETS,
  ...COUNTDOWN_MARKETS.map(({ marketType }) => marketType),
];
const STRUCTURAL_INCIDENTS = [
  'KICK_OFF',
  'ADDED_TIME_ANNOUNCED',
  'HALF_TIME',
  'SECOND_HALF_KICK_OFF',
  'FULL_TIME',
];
const TERMINAL_BET_STATUSES = ['WIN', 'LOSS', 'VOID'];
const LIVE_FIXTURE_KICKOFF_DELAY_SECONDS = 90;
const EXPECTED_PRE_KICKOFF_LIVE_ROWS = 2;
const EXPECTED_LIVE_SETTLEMENT_ROWS = 1;
const MAX_LIVE_PLACEMENT_ATTEMPTS = 5;
const RETRYABLE_LIVE_SELECTION_ERRORS = new Set([
  'Live quote is stale',
  'Market version mismatch',
]);

const board = (page, betKind) => page.locator(
  `section[aria-labelledby="slip-board-title-${betKind}"]`,
);

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const findBySlipId = (bets, slipId) => (
  Array.isArray(bets) ? bets.find((bet) => bet.slipId === slipId) : undefined
);

const responseErrorMessage = async (response) => {
  const body = await response.json().catch(() => null);
  return body?.errors?.[0]?.msg
    ?? body?.errors?.[0]?.message
    ?? body?.message
    ?? `HTTP ${response.status()}`;
};

const liveMarketSignature = async (marketCard) => {
  const quoteMetadata = await marketCard.locator('.event-market-meta').textContent();
  const selection = marketCard.getByRole('button').first();
  return `${quoteMetadata}|${await selection.getAttribute('aria-label')}`;
};

const selectLiveMarket = async ({
  fixture,
  marketType,
  page,
}) => {
  const marketId = `${fixture.eventId}:${marketType}`;
  const marketCard = page
    .getByRole('article', { name: fixture.name })
    .locator(`[data-market-type="${marketType}"]`);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await expect(marketCard).toHaveCount(1);
    const selection = marketCard.getByRole('button').first();
    await expect(selection).toBeEnabled({ timeout: 10000 });
    const signature = await liveMarketSignature(marketCard);
    const responsePromise = page.waitForResponse((response) => {
      if (
        new URL(response.url()).pathname !== '/api/event/odds'
        || response.request().method() !== 'POST'
      ) {
        return false;
      }

      const payload = response.request().postDataJSON();
      return payload?.eventId === fixture.eventId
        && payload?.marketId === marketId;
    });

    await selection.click();
    const response = await responsePromise;
    if (response.ok()) {
      const acceptedQuote = response.request().postDataJSON();
      await expect.poll(async () => {
        const boardsResponse = await page.request.get('/api/slip/boards');
        expect(boardsResponse.ok()).toBeTruthy();
        const boards = await boardsResponse.json();
        return boards.LIVE?.rows?.some((row) => (
          row.eventId === fixture.eventId
          && row.marketId === marketId
          && row.marketVersion === acceptedQuote.marketVersion
          && row.quoteVersion === acceptedQuote.quoteVersion
          && row.selectionId === acceptedQuote.selectionId
          && !row.moderation
        )) ?? false;
      }, {
        timeout: 10000,
        intervals: [250, 500, 1000],
      }).toBe(true);
      return acceptedQuote;
    }

    const errorMessage = await responseErrorMessage(response);
    if (!RETRYABLE_LIVE_SELECTION_ERRORS.has(errorMessage) || attempt === 5) {
      throw new Error(
        `Live selection ${fixture.eventId}/${marketType} failed: ${errorMessage}`,
      );
    }

    await expect.poll(
      () => liveMarketSignature(marketCard),
      {
        timeout: 10000,
        intervals: [100, 250, 500],
      },
    ).not.toBe(signature);
  }
};

test('production live matches, dual slips, and settlement stay coherent', async ({
  browser,
  page,
}) => {
  const username = requiredEnv('LIVE_ACCEPTANCE_USERNAME');
  const password = requiredEnv('LIVE_ACCEPTANCE_PASSWORD');
  const runId = requiredEnv('LIVE_ACCEPTANCE_RUN_ID');
  const evidenceFile = requiredEnv('LIVE_ACCEPTANCE_EVIDENCE_FILE');
  const livePlacementEvidenceFile = path.join(
    path.dirname(evidenceFile),
    'live-placement-attempts.json',
  );
  const livePlacementAttempts = [];
  const persistLivePlacementAttempts = () => {
    fs.mkdirSync(path.dirname(livePlacementEvidenceFile), { recursive: true });
    fs.writeFileSync(
      livePlacementEvidenceFile,
      `${JSON.stringify({ runId, attempts: livePlacementAttempts }, null, 2)}\n`,
    );
  };
  const pageErrors = [];
  const consoleErrors = [];
  const apiFailures = [];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('requestfailed', (request) => {
    const pathname = new URL(request.url()).pathname;
    const expectedStreamDisconnect = (
      request.method() === 'GET' && pathname === '/api/event/stream'
    );
    if (pathname.startsWith('/api/') && !expectedStreamDisconnect) {
      apiFailures.push(`${request.method()} ${pathname}`);
    }
  });

  const suffix = String(runId).slice(-10);
  const fixtures = [
    {
      home: `E2E-${suffix}-Alpha`,
      away: `E2E-${suffix}-Bravo`,
      kickoffDelaySeconds: LIVE_FIXTURE_KICKOFF_DELAY_SECONDS,
      visibility: 'OFFLINE',
      requestId: randomUUID(),
    },
    {
      home: `E2E-${suffix}-Charlie`,
      away: `E2E-${suffix}-Delta`,
      kickoffDelaySeconds: LIVE_FIXTURE_KICKOFF_DELAY_SECONDS,
      visibility: 'OFFLINE',
      requestId: randomUUID(),
    },
    {
      home: `E2E-${suffix}-Future`,
      away: `E2E-${suffix}-Reserve`,
      kickoffDelaySeconds: 30 * 60,
      visibility: 'OFFLINE',
      requestId: randomUUID(),
    },
  ];
  const publicContext = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
  });
  const createFixture = async (fixture) => {
    const response = await publicContext.request.post('/api/backoffice/new_event', {
      data: fixture,
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    fixture.eventId = body.event.eventId;
    fixture.name = body.event.name;
  };
  const futureFixture = fixtures[2];
  await createFixture(futureFixture);

  await page.goto('/login?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Username or email').fill(username);
  const passwordInput = page.getByLabel('Password', { exact: true });
  let loginResponse;
  try {
    await passwordInput.fill(password);
    [loginResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const request = response.request();
        return (
          new URL(response.url()).pathname === '/api/auth/login' &&
          request.method() === 'POST'
        );
      }),
      page.getByRole('button', { name: 'Log in', exact: true }).click(),
    ]);
  } finally {
    if (await passwordInput.isVisible().catch(() => false)) {
      await passwordInput.fill('');
    }
  }
  expect(loginResponse).toBeTruthy();
  expect(loginResponse.ok()).toBeTruthy();
  await expect(page.getByTitle('Backoffice')).toBeVisible();

  const publicPage = await publicContext.newPage();
  const publicEventsLoaded = publicPage.waitForResponse(
    (response) => (
      new URL(response.url()).pathname === '/api/event'
      && response.request().method() === 'GET'
    ),
  );
  await publicPage.goto('/?ui=v2&theme=dark', {
    waitUntil: 'domcontentloaded',
  });
  await publicEventsLoaded;
  await expect(
    publicPage.getByRole('article', { name: futureFixture.name }),
  ).toHaveCount(0);
  const publicBackofficeLink = publicPage.getByTitle('Backoffice');
  await expect(publicBackofficeLink).toBeVisible();
  await expect(publicBackofficeLink).toContainText('Backoffice');
  await publicBackofficeLink.click();
  await expect(publicPage).toHaveURL(/\/backoffice\?ui=v2&theme=dark$/);
  await expect(publicPage.getByRole('heading', { name: 'Backoffice' })).toBeVisible();
  await expect(publicPage.getByText('Create new event')).toBeVisible();
  await expect(
    publicPage.getByRole('heading', { name: futureFixture.name }),
  ).toBeVisible();
  await publicPage.close();

  for (const fixture of fixtures.slice(0, 2)) {
    await createFixture(fixture);
  }
  const idempotentVisibility = await publicContext.request.post(
    '/api/backoffice/event_visibility',
    {
      data: {
        eventId: fixtures[0].eventId,
        visibility: 'OFFLINE',
      },
    },
  );
  expect(idempotentVisibility.ok()).toBeTruthy();
  expect((await idempotentVisibility.json()).visibility).toBe('OFFLINE');

  const acceptanceEventIds = fixtures
    .map((fixture) => fixture.eventId)
    .join(',');
  const acceptanceQuery = `acceptanceEventIds=${acceptanceEventIds}`;
  await expect.poll(async () => {
    const events = await (
      await page.request.get(`/api/event?${acceptanceQuery}`)
    ).json();
    return fixtures.every((fixture) => events.some((event) => (
      event.eventId === fixture.eventId
      && event.visibility === 'OFFLINE'
    )));
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000],
  }).toBe(true);

  const publicBackoffice = await publicContext.request.get('/api/backoffice');
  expect(publicBackoffice.status()).toBe(200);
  const publicBackofficeBody = await publicBackoffice.json();
  expect(Array.isArray(publicBackofficeBody)).toBe(true);
  for (const fixture of fixtures) {
    expect(publicBackofficeBody).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventId: fixture.eventId,
          name: fixture.name,
          visibility: 'OFFLINE',
        }),
      ]),
    );
  }

  await page.goto(
    `/?ui=v2&theme=dark&acceptanceEventIds=${acceptanceEventIds}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.evaluate((eventIds) => {
    const snapshots = [];
    const source = new EventSource(
      `/api/event/stream?acceptanceEventIds=${encodeURIComponent(eventIds)}`,
    );
    source.addEventListener('snapshot', (message) => {
      snapshots.push(JSON.parse(message.data));
    });
    window.__liveAcceptance = { snapshots, source };
  }, acceptanceEventIds);
  await expect.poll(
    () => page.evaluate(() => Boolean(window.__liveAcceptance)),
  ).toBe(true);
  for (const fixture of fixtures) {
    await expect(
      page.getByRole('article', { name: fixture.name }),
    ).toBeVisible({ timeout: 30000 });
  }
  for (const fixture of fixtures.slice(0, 2)) {
    const article = page.getByRole('article', { name: fixture.name });
    await expect(article.locator('.event-market-card')).toHaveCount(
      COUNTDOWN_MARKETS.length,
    );
    for (const { label } of COUNTDOWN_MARKETS) {
      const marketCard = article.locator('.event-market-card').filter({
        hasText: label,
      });
      await expect(marketCard).toBeVisible();
      await expect(marketCard.getByRole('button').first()).toBeEnabled();
    }
  }

  const futureArticle = page.getByRole('article', { name: futureFixture.name });
  await expect(futureArticle.getByText('1X2', { exact: true })).toBeVisible();
  await expect(
    futureArticle.getByText('Correct Score', { exact: true }),
  ).toBeVisible();
  await futureArticle.getByRole('button', { name: /^Select 1X2 .* at / }).first().click();

  const preMatchBoard = board(page, 'PRE_MATCH');
  await expect(preMatchBoard).toContainText(futureFixture.name);
  await page.getByLabel('Wager for PRE-MATCH SLIP').fill('10');

  const liveBoard = board(page, 'LIVE');
  for (const fixture of fixtures.slice(0, 2)) {
    await selectLiveMarket({
      fixture,
      marketType: PRE_KICKOFF_PLACEMENT_MARKET_TYPE,
      page,
    });
  }
  await expect(liveBoard.locator('.slip-row-card')).toHaveCount(
    EXPECTED_PRE_KICKOFF_LIVE_ROWS,
    { timeout: 15000 },
  );
  await expect(liveBoard).toContainText(fixtures[0].name);
  await expect(liveBoard).toContainText(fixtures[1].name);
  await expect(preMatchBoard).toContainText(futureFixture.name);

  await expect.poll(async () => {
    const events = await (
      await page.request.get(`/api/event?${acceptanceQuery}`)
    ).json();
    return fixtures.slice(0, 2).every((fixture) => (
      events.some((event) => (
        event.eventId === fixture.eventId
        && event.live?.phase === 'PRE_MATCH'
      ))
    ));
  }, {
    timeout: 10000,
    intervals: [250, 500, 1000],
  }).toBe(true);

  const preKickoffSelectedBoards = await (
    await page.request.get('/api/slip/boards')
  ).json();
  const preKickoffLiveSlipId = preKickoffSelectedBoards.LIVE._id;
  expect(preKickoffSelectedBoards.LIVE.rows).toHaveLength(
    EXPECTED_PRE_KICKOFF_LIVE_ROWS,
  );
  expect(
    preKickoffSelectedBoards.LIVE.rows.every(
      (row) => row.marketType === PRE_KICKOFF_PLACEMENT_MARKET_TYPE,
    ),
  ).toBe(true);

  await page.getByLabel('Wager for LIVE SLIP').fill('5');
  const preKickoffPlacementResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/api/slip/bet'
    && response.request().method() === 'POST'
  ));
  await liveBoard.getByRole('button', { name: 'BET!' }).click();
  const preKickoffPlacementResponse = await preKickoffPlacementResponsePromise;
  expect(preKickoffPlacementResponse.ok()).toBeTruthy();

  await expect.poll(async () => {
    const bets = await (await page.request.get('/api/bet')).json();
    return findBySlipId(bets, preKickoffLiveSlipId)?.status;
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000],
  }).toMatch(/^(CONFIRMED|WIN|LOSS|VOID)$/);

  const preKickoffPlacedBets = await (
    await page.request.get('/api/bet')
  ).json();
  const preKickoffLiveBetAtPlacement = findBySlipId(
    preKickoffPlacedBets,
    preKickoffLiveSlipId,
  );
  expect(preKickoffLiveBetAtPlacement).toBeDefined();
  expect(preKickoffLiveBetAtPlacement.status).not.toBe('DECLINED');
  expect(preKickoffLiveBetAtPlacement.betKind).toBe('LIVE');
  expect(preKickoffLiveBetAtPlacement.rows).toHaveLength(
    EXPECTED_PRE_KICKOFF_LIVE_ROWS,
  );
  expect(
    preKickoffLiveBetAtPlacement.rows
      .map((row) => row.eventId)
      .sort(),
  ).toEqual(
    fixtures.slice(0, 2).map((fixture) => fixture.eventId).sort(),
  );
  expect(
    preKickoffLiveBetAtPlacement.rows.every(
      (row) => row.marketType === PRE_KICKOFF_PLACEMENT_MARKET_TYPE,
    ),
  ).toBe(true);
  await expect(liveBoard.locator('.slip-row-card')).toHaveCount(0, {
    timeout: 30000,
  });

  await expect(page.getByRole('heading', { name: 'Live now' })).toBeVisible({
    timeout: 100000,
  });
  for (const fixture of fixtures.slice(0, 2)) {
    const article = page.getByRole('article', { name: fixture.name });
    await expect(article).toBeVisible({ timeout: 100000 });
    await expect.poll(
      () => article.locator('.event-market-card').count(),
      { timeout: 100000 },
    ).toBeGreaterThan(0);
    expect(await article.locator('.event-market-card').count())
      .toBeLessThanOrEqual(6);
    await expect(
      article.locator(`[data-market-type="${SETTLEMENT_MARKET_TYPE}"]`),
    ).toBeVisible();
    for (const { label } of COUNTDOWN_MARKETS) {
      await expect(article.getByText(label, { exact: true })).toHaveCount(0);
    }
  }

  const articleLabels = await page.getByRole('article').evaluateAll(
    (articles) => articles.map((article) => article.getAttribute('aria-label')),
  );
  expect(articleLabels.indexOf(fixtures[0].name)).toBeLessThan(
    articleLabels.indexOf(futureFixture.name),
  );
  expect(articleLabels.indexOf(fixtures[1].name)).toBeLessThan(
    articleLabels.indexOf(futureFixture.name),
  );

  await selectLiveMarket({
    fixture: fixtures[0],
    marketType: SETTLEMENT_MARKET_TYPE,
    page,
  });

  const selectedBoards = await (
    await page.request.get('/api/slip/boards')
  ).json();
  expect(selectedBoards.LIVE.rows).toHaveLength(
    EXPECTED_LIVE_SETTLEMENT_ROWS,
  );

  await expect(liveBoard.locator('.slip-row-card')).toHaveCount(
    EXPECTED_LIVE_SETTLEMENT_ROWS,
    { timeout: 15000 },
  );
  await expect(liveBoard).toContainText(fixtures[0].name);
  await expect(preMatchBoard).toContainText(futureFixture.name);

  await liveBoard.getByRole('button', { name: 'CLEAN' }).click();
  await expect(liveBoard.locator('.slip-row-card')).toHaveCount(0);
  const declinedLiveSlipIds = [];
  let liveSlipId;
  let acceptedLiveBet;
  let acceptedLiveQuote;

  // A single moving event clock keeps this in-play acceptance deterministic.
  // The separate pre-kickoff placement above covers the multi-event slip.
  for (
    let placementAttempt = 1;
    placementAttempt <= MAX_LIVE_PLACEMENT_ATTEMPTS;
    placementAttempt += 1
  ) {
    const selectedLiveQuote = await selectLiveMarket({
      fixture: fixtures[0],
      marketType: SETTLEMENT_MARKET_TYPE,
      page,
    });
    await expect(liveBoard.locator('.slip-row-card')).toHaveCount(
      EXPECTED_LIVE_SETTLEMENT_ROWS,
      { timeout: 10000 },
    );

    await page.getByLabel('Wager for LIVE SLIP').fill('5');
    const boardsBeforeLiveSubmit = await (
      await page.request.get('/api/slip/boards')
    ).json();
    liveSlipId = boardsBeforeLiveSubmit.LIVE._id;

    const placementResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/slip/bet'
      && response.request().method() === 'POST'
    ));
    await liveBoard.getByRole('button', { name: 'BET!' }).click();
    const placementResponse = await placementResponsePromise;
    expect(placementResponse.ok()).toBeTruthy();

    await expect.poll(async () => {
      const bets = await (await page.request.get('/api/bet')).json();
      return findBySlipId(bets, liveSlipId)?.status;
    }, {
      timeout: 30000,
      intervals: [500, 1000, 2000],
    }).toMatch(/^(CONFIRMED|WIN|LOSS|VOID|DECLINED)$/);

    const submittedBets = await (await page.request.get('/api/bet')).json();
    const submittedLiveBet = findBySlipId(submittedBets, liveSlipId);
    expect(submittedLiveBet).toBeDefined();
    livePlacementAttempts.push({
      placementAttempt,
      slipId: liveSlipId,
      selectedQuote: {
        eventId: selectedLiveQuote.eventId,
        marketId: selectedLiveQuote.marketId,
        marketVersion: selectedLiveQuote.marketVersion,
        quoteVersion: selectedLiveQuote.quoteVersion,
        quoteValidUntil: selectedLiveQuote.quoteValidUntil,
        selectionId: selectedLiveQuote.selectionId,
        oddsValue: selectedLiveQuote.oddsValue,
      },
      submittedAt: submittedLiveBet.timestamp,
      status: submittedLiveBet.status,
      declineReason: submittedLiveBet.declineReason,
      rows: submittedLiveBet.rows.map((row) => ({
        rowId: row.id,
        marketId: row.marketId,
        marketVersion: row.marketVersion,
        quoteVersion: row.quoteVersion,
        quoteValidUntil: row.quoteValidUntil,
        selectionId: row.selectionId,
        oddsValue: row.oddsValue,
        declineReason: row.declineReason,
        currentOdds: row.currentOdds,
      })),
    });
    persistLivePlacementAttempts();

    if (submittedLiveBet.status !== 'DECLINED') {
      acceptedLiveBet = submittedLiveBet;
      acceptedLiveQuote = selectedLiveQuote;
      break;
    }

    expect(submittedLiveBet.declineReason).toBe('STALE_QUOTE');
    expect(
      submittedLiveBet.rows.some((row) => row.declineReason === 'STALE_QUOTE'),
    ).toBe(true);
    declinedLiveSlipIds.push(liveSlipId);

    await expect.poll(async () => {
      const boards = await (await page.request.get('/api/slip/boards')).json();
      const restoredLiveBoard = boards.LIVE;
      return restoredLiveBoard
        ? `${restoredLiveBoard.status}:${restoredLiveBoard.sourceSlipId}`
        : 'missing';
    }, {
      timeout: 30000,
      intervals: [500, 1000, 2000],
    }).toBe(`DRAFT:${liveSlipId}`);
  }

  expect(acceptedLiveBet).toBeDefined();
  expect(acceptedLiveQuote).toBeDefined();
  expect(liveSlipId).toBeDefined();

  await expect(page.getByLabel('Wager for PRE-MATCH SLIP')).toHaveValue('10');
  await expect(page.getByLabel('Wager for PRE-MATCH SLIP')).toBeEnabled();
  await expect(preMatchBoard.getByRole('button', { name: 'BET!' })).toBeEnabled();

  await expect.poll(async () => {
    const events = await (await page.request.get('/api/backoffice')).json();
    return fixtures.slice(0, 2).every((fixture) => (
      events.some((event) => (
        event.eventId === fixture.eventId
        && event.status === 'RESULTED'
        && Number.isInteger(event.homeResult)
        && Number.isInteger(event.awayResult)
      ))
    ));
  }, {
    timeout: 13 * 60 * 1000,
    intervals: [5000],
  }).toBe(true);

  const backofficeEvents = await (
    await page.request.get('/api/backoffice')
  ).json();
  const snapshots = await page.evaluate(
    () => window.__liveAcceptance.snapshots,
  );
  expect(JSON.stringify(snapshots)).not.toContain('liveSeed');
  expect(JSON.stringify(snapshots)).not.toContain('"seed"');

  const eventEvidence = fixtures.slice(0, 2).map((fixture) => {
    const eventSnapshots = snapshots.filter(
      (snapshot) => snapshot.eventId === fixture.eventId,
    );
    const sequences = eventSnapshots.map((snapshot) => snapshot.live.sequence);
    expect(sequences.length).toBeGreaterThan(5);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect([...sequences].sort((left, right) => left - right)).toEqual(sequences);

    const phases = new Set(
      eventSnapshots.map((snapshot) => snapshot.live.phase),
    );
    for (const phase of [
      'FIRST_HALF',
      'FIRST_HALF_STOPPAGE',
      'HALF_TIME',
      'SECOND_HALF',
      'SECOND_HALF_STOPPAGE',
      'FULL_TIME',
    ]) {
      expect(phases.has(phase)).toBe(true);
    }

    const incidents = new Map();
    for (const snapshot of eventSnapshots) {
      for (const incident of snapshot.live.incidentHistory ?? []) {
        incidents.set(incident.id, incident);
      }
    }
    const incidentTypes = new Set(
      [...incidents.values()].map((incident) => incident.type),
    );
    for (const incidentType of STRUCTURAL_INCIDENTS) {
      expect(incidentTypes.has(incidentType)).toBe(true);
    }

    const kickoffSnapshot = eventSnapshots.find(
      (snapshot) => snapshot.live.phase === 'FIRST_HALF',
    );
    expect(kickoffSnapshot).toBeDefined();
    const kickoffActionableMarkets = kickoffSnapshot.live.currentMarkets.filter(
      (market) => ['OPEN', 'SUSPENDED'].includes(market.status),
    );
    expect(kickoffActionableMarkets.length).toBeLessThanOrEqual(6);
    expect(
      kickoffActionableMarkets.some(
        (market) => market.marketType === SETTLEMENT_MARKET_TYPE,
      ),
    ).toBe(true);
    for (const snapshot of eventSnapshots) {
      expect(
        snapshot.live.currentMarkets.filter(
          (market) => ['OPEN', 'SUSPENDED'].includes(market.status),
        ).length,
      ).toBeLessThanOrEqual(6);
    }
    const eventMarketTypes = new Set(eventSnapshots.flatMap(
      (snapshot) => snapshot.live.currentMarkets.map(
        (market) => market.marketType,
      ),
    ));
    for (const marketType of REQUIRED_PER_EVENT_MARKETS) {
      expect(eventMarketTypes.has(marketType)).toBe(true);
    }
    expect(
      ROTATING_LIVE_MARKETS.filter(
        ({ marketType }) => eventMarketTypes.has(marketType),
      ).length,
    ).toBeGreaterThanOrEqual(6);

    const finalSnapshot = [...eventSnapshots].reverse().find(
      (snapshot) => snapshot.live.phase === 'FULL_TIME',
    );
    expect(finalSnapshot).toBeDefined();
    expect(
      finalSnapshot.live.currentMarkets.every(
        (market) => market.status !== 'OPEN',
      ),
    ).toBe(true);

    const goals = { HOME: 0, AWAY: 0 };
    for (const incident of incidents.values()) {
      if (incident.type === 'GOAL') {
        goals[incident.side] += 1;
      }
    }
    expect(finalSnapshot.live.homeScore).toBe(goals.HOME);
    expect(finalSnapshot.live.awayScore).toBe(goals.AWAY);
    const secondHalfScoreMarket = finalSnapshot.live.currentMarkets.find(
      (market) => market.marketType === SETTLEMENT_MARKET_TYPE,
    );
    const halfTimeSnapshot = eventSnapshots.find(
      (snapshot) => snapshot.live.phase === 'HALF_TIME',
    );
    expect(secondHalfScoreMarket).toBeDefined();
    expect(halfTimeSnapshot).toBeDefined();
    expect(secondHalfScoreMarket.status).toBe('SETTLED');
    expect(secondHalfScoreMarket.selections).toHaveLength(10);
    expect(
      secondHalfScoreMarket.selections.map((selection) => selection.label),
    ).toEqual([
      '0 - 0',
      '1 - 0',
      '0 - 1',
      '1 - 1',
      '2 - 0',
      '0 - 2',
      '2 - 1',
      '1 - 2',
      '2 - 2',
      'Other',
    ]);
    expect(finalSnapshot.live.homeScore).toBeGreaterThanOrEqual(
      halfTimeSnapshot.live.homeScore,
    );
    expect(finalSnapshot.live.awayScore).toBeGreaterThanOrEqual(
      halfTimeSnapshot.live.awayScore,
    );
    const secondHalfHomeScore = (
      finalSnapshot.live.homeScore - halfTimeSnapshot.live.homeScore
    );
    const secondHalfAwayScore = (
      finalSnapshot.live.awayScore - halfTimeSnapshot.live.awayScore
    );
    const secondHalfScoreLabel = `${secondHalfHomeScore} - ${secondHalfAwayScore}`;
    const secondHalfScoreWinningSelection = (
      secondHalfScoreMarket.selections.find(
        (selection) => selection.label === secondHalfScoreLabel,
      )
      ?? secondHalfScoreMarket.selections.find(
        (selection) => selection.label === 'Other',
      )
    )?.selectionId;
    expect(secondHalfScoreWinningSelection).toBeDefined();

    const resultedEvent = backofficeEvents.find(
      (event) => event.eventId === fixture.eventId,
    );
    expect(resultedEvent.homeResult).toBe(finalSnapshot.live.homeScore);
    expect(resultedEvent.awayResult).toBe(finalSnapshot.live.awayScore);

    return {
      eventId: fixture.eventId,
      finalSequence: finalSnapshot.live.sequence,
      homeScore: finalSnapshot.live.homeScore,
      awayScore: finalSnapshot.live.awayScore,
      halfTimeHomeScore: halfTimeSnapshot.live.homeScore,
      halfTimeAwayScore: halfTimeSnapshot.live.awayScore,
      secondHalfScoreWinningSelection,
      incidentTypes: [...incidentTypes].sort(),
      marketTypes: [...new Set(eventSnapshots.flatMap(
        (snapshot) => snapshot.live.currentMarkets.map(
          (market) => market.marketType,
        ),
      ))].sort(),
    };
  });
  const observedIncidentTypes = new Set(
    eventEvidence.flatMap(({ incidentTypes }) => incidentTypes),
  );
  const observedMarketTypes = new Set(
    eventEvidence.flatMap(({ marketTypes }) => marketTypes),
  );
  expect(observedIncidentTypes.has('THROW_IN')).toBe(true);
  expect(observedIncidentTypes.has('GOAL_KICK')).toBe(true);
  expect([...observedMarketTypes].sort()).toEqual(
    [...ALL_LIVE_MARKET_TYPES].sort(),
  );

  const liveEventEvidence = eventEvidence.find(
    ({ eventId }) => eventId === fixtures[0].eventId,
  );
  expect(liveEventEvidence).toBeDefined();
  const expectedLiveBetStatus = (
    acceptedLiveQuote.selectionId
      === liveEventEvidence.secondHalfScoreWinningSelection
  ) ? 'WIN' : 'LOSS';
  await expect.poll(async () => {
    const bets = await (await page.request.get('/api/bet')).json();
    const bet = findBySlipId(bets, liveSlipId);
    const row = bet?.rows?.[0];
    return {
      betStatus: bet?.status,
      rowStatus: row?.status,
      winningSelection: row?.winningSelection,
      settlementReason: row?.settlementReason,
      settlementSequence: row?.settlementSequence,
    };
  }, {
    timeout: 60000,
    intervals: [500, 1000, 2000],
  }).toEqual({
    betStatus: expectedLiveBetStatus,
    rowStatus: expectedLiveBetStatus,
    winningSelection: liveEventEvidence.secondHalfScoreWinningSelection,
    settlementReason: SETTLEMENT_REASON,
    settlementSequence: liveEventEvidence.finalSequence,
  });

  const settledBets = await (await page.request.get('/api/bet')).json();
  const preKickoffLiveBet = findBySlipId(
    settledBets,
    preKickoffLiveSlipId,
  );
  expect(preKickoffLiveBet).toBeDefined();
  expect(TERMINAL_BET_STATUSES).toContain(preKickoffLiveBet.status);
  expect(preKickoffLiveBet.betKind).toBe('LIVE');
  expect(preKickoffLiveBet.rows).toHaveLength(
    EXPECTED_PRE_KICKOFF_LIVE_ROWS,
  );
  expect(
    preKickoffLiveBet.rows.map((row) => row.eventId).sort(),
  ).toEqual(
    fixtures.slice(0, 2).map((fixture) => fixture.eventId).sort(),
  );
  expect(
    preKickoffLiveBet.rows.every((row) => (
      row.betKind === 'LIVE'
      && row.marketType === PRE_KICKOFF_PLACEMENT_MARKET_TYPE
      && row.status !== 'NOT_SETTLED'
    )),
  ).toBe(true);

  const liveBet = findBySlipId(settledBets, liveSlipId);
  expect(liveBet).toBeDefined();
  expect(liveBet.status).toBe(expectedLiveBetStatus);
  expect(liveBet.betKind).toBe('LIVE');
  expect(liveBet.rows).toHaveLength(EXPECTED_LIVE_SETTLEMENT_ROWS);
  const liveRow = liveBet.rows[0];
  expect(liveRow.eventId).toBe(fixtures[0].eventId);
  expect(liveRow.betKind).toBe('LIVE');
  expect(liveRow.marketId).toBe(acceptedLiveQuote.marketId);
  expect(liveRow.marketType).toBe(SETTLEMENT_MARKET_TYPE);
  expect(liveRow.marketVersion).toBe(acceptedLiveQuote.marketVersion);
  expect(liveRow.quoteVersion).toBe(acceptedLiveQuote.quoteVersion);
  expect(liveRow.selectionId).toBe(acceptedLiveQuote.selectionId);
  expect(liveRow.status).toBe(expectedLiveBetStatus);
  expect(liveRow.winningSelection).toBe(
    liveEventEvidence.secondHalfScoreWinningSelection,
  );
  expect(liveRow.settlementReason).toBe(SETTLEMENT_REASON);
  expect(liveRow.settlementSequence).toBe(liveEventEvidence.finalSequence);

  const boardsBeforePreMatchSubmit = await (
    await page.request.get('/api/slip/boards')
  ).json();
  const preMatchSlipId = boardsBeforePreMatchSubmit.PRE_MATCH._id;
  await preMatchBoard.getByRole('button', { name: 'BET!' }).click();
  await expect.poll(async () => {
    const bets = await (await page.request.get('/api/bet')).json();
    return findBySlipId(bets, preMatchSlipId)?.status;
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000],
  }).toBe('CONFIRMED');

  const manualResult = await publicContext.request.post('/api/backoffice/result', {
    data: {
      eventId: futureFixture.eventId,
      homeResult: 1,
      awayResult: 0,
    },
  });
  expect(manualResult.ok()).toBeTruthy();
  await publicContext.close();
  await expect.poll(async () => {
    const bets = await (await page.request.get('/api/bet')).json();
    return findBySlipId(bets, preMatchSlipId)?.status;
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000],
  }).toBe('WIN');

  await page.getByTitle('My bets').click();
  const preKickoffLiveHistory = page.locator('.my-bets-card')
    .filter({ hasText: `Slip ${preKickoffLiveSlipId}` });
  await expect(preKickoffLiveHistory).toContainText('Live');
  await expect(preKickoffLiveHistory).toContainText('Kickoff Team');
  await expect(preKickoffLiveHistory).toContainText(fixtures[0].name);
  await expect(preKickoffLiveHistory).toContainText(fixtures[1].name);
  await expect(preKickoffLiveHistory).toContainText(preKickoffLiveBet.status);
  const inPlayLiveHistory = page.locator('.my-bets-card')
    .filter({ hasText: `Slip ${liveSlipId}` });
  await expect(inPlayLiveHistory).toContainText('Live');
  await expect(inPlayLiveHistory).toContainText('Second Half Score');
  await expect(inPlayLiveHistory).toContainText(fixtures[0].name);
  await expect(inPlayLiveHistory).toContainText(liveBet.status);
  const preMatchHistory = page.locator('.my-bets-card').filter({
    hasText: futureFixture.name,
  });
  await expect(preMatchHistory).toContainText('Pre-match');
  await expect(preMatchHistory).toContainText('WIN');

  await page.evaluate(() => window.__liveAcceptance.source.close());
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  expect(apiFailures).toEqual([]);

  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  fs.writeFileSync(evidenceFile, `${JSON.stringify({
    runId,
    events: eventEvidence,
    preKickoffLiveSlipId,
    preKickoffLiveBetStatus: preKickoffLiveBet.status,
    preKickoffLiveRows: preKickoffLiveBet.rows.map((row) => ({
      eventId: row.eventId,
      marketType: row.marketType,
      status: row.status,
    })),
    liveSlipId,
    declinedLiveSlipIds,
    livePlacementAttempts,
    liveBetStatus: liveBet.status,
    liveRow: {
      eventId: liveRow.eventId,
      marketId: liveRow.marketId,
      marketType: liveRow.marketType,
      marketVersion: liveRow.marketVersion,
      quoteVersion: liveRow.quoteVersion,
      selectionId: liveRow.selectionId,
      winningSelection: liveRow.winningSelection,
      settlementReason: liveRow.settlementReason,
      settlementSequence: liveRow.settlementSequence,
      status: liveRow.status,
    },
    preMatchSlipId,
    preMatchBetStatus: 'WIN',
    pageErrors: pageErrors.length,
    consoleErrors: consoleErrors.length,
    apiFailures: apiFailures.length,
  }, null, 2)}\n`);
});
