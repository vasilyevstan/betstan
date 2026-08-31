const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const LIVE_MARKETS = [
  'NEXT_YELLOW_CARD',
  'NEXT_RED_CARD',
  'NEXT_CORNER',
  'NEXT_PENALTY',
  'HALF_TIME_RESULT',
];
const COUNTDOWN_MARKETS = [
  { marketType: 'KICKOFF_TEAM', label: 'Kickoff Team' },
  { marketType: 'FIRST_MINUTE_GOAL', label: 'Goal in First Minute' },
];
const ALL_LIVE_MARKET_TYPES = [
  ...LIVE_MARKETS,
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
const EXPECTED_LIVE_SETTLEMENT_ROWS = 2;
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
  marketIndex,
  page,
}) => {
  const marketType = LIVE_MARKETS[marketIndex];
  const marketId = `${fixture.eventId}:${marketType}`;
  const marketCard = page
    .getByRole('article', { name: fixture.name })
    .locator('.event-market-card')
    .nth(marketIndex);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
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

  const unauthorized = await page.request.post('/api/backoffice/new_event', {
    data: { home: 'Unauthorized', away: 'Mutation' },
  });
  expect(unauthorized.status()).toBe(401);

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

  const suffix = String(runId).slice(-10);
  const fixtures = [
    {
      home: `E2E-${suffix}-Alpha`,
      away: `E2E-${suffix}-Bravo`,
      kickoffDelaySeconds: LIVE_FIXTURE_KICKOFF_DELAY_SECONDS,
      visibility: 'OFFLINE',
    },
    {
      home: `E2E-${suffix}-Charlie`,
      away: `E2E-${suffix}-Delta`,
      kickoffDelaySeconds: LIVE_FIXTURE_KICKOFF_DELAY_SECONDS,
      visibility: 'OFFLINE',
    },
    {
      home: `E2E-${suffix}-Future`,
      away: `E2E-${suffix}-Reserve`,
      kickoffDelaySeconds: 30 * 60,
      visibility: 'OFFLINE',
    },
  ];

  for (const fixture of fixtures) {
    const response = await page.request.post('/api/backoffice/new_event', {
      data: fixture,
    });
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    fixture.eventId = body.event.eventId;
    fixture.name = body.event.name;
  }

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

  const publicContext = await browser.newContext({
    baseURL: process.env.E2E_BASE_URL,
  });
  const publicBackoffice = await publicContext.request.get('/api/backoffice');
  expect(publicBackoffice.status()).toBe(401);
  const publicBackofficeBody = await publicBackoffice.text();
  for (const fixture of fixtures) {
    expect(publicBackofficeBody).not.toContain(fixture.name);
  }
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
  for (const fixture of fixtures) {
    await expect(
      publicPage.getByRole('article', { name: fixture.name }),
    ).toHaveCount(0);
  }
  await publicContext.close();

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

  const futureFixture = fixtures[2];
  const futureArticle = page.getByRole('article', { name: futureFixture.name });
  await expect(futureArticle.getByText('1X2', { exact: true })).toBeVisible();
  await expect(
    futureArticle.getByText('Correct Score', { exact: true }),
  ).toBeVisible();
  await futureArticle.getByRole('button', { name: /^Select 1X2 .* at / }).first().click();

  const preMatchBoard = board(page, 'PRE_MATCH');
  await expect(preMatchBoard).toContainText(futureFixture.name);
  await page.getByLabel('Wager for PRE-MATCH SLIP').fill('10');

  await expect(page.getByRole('heading', { name: 'Live now' })).toBeVisible({
    timeout: 100000,
  });
  for (const fixture of fixtures.slice(0, 2)) {
    const article = page.getByRole('article', { name: fixture.name });
    await expect(article).toBeVisible({ timeout: 100000 });
    await expect(article.locator('.event-market-card')).toHaveCount(
      LIVE_MARKETS.length,
    );
    for (const marketName of [
      'Next Yellow Card',
      'Next Red Card',
      'Next Corner',
      'Next Penalty',
      'Half Time Result',
    ]) {
      await expect(article.getByText(marketName, { exact: true })).toBeVisible();
    }
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

  for (const fixture of fixtures.slice(0, 2)) {
    for (let marketIndex = 0; marketIndex < LIVE_MARKETS.length; marketIndex += 1) {
      await selectLiveMarket({
        fixture,
        marketIndex,
        page,
      });
    }
  }

  const selectedBoards = await (
    await page.request.get('/api/slip/boards')
  ).json();
  expect(selectedBoards.LIVE.rows).toHaveLength(LIVE_MARKETS.length * 2);

  // A confirmed duplicate selection schedules a refresh after all ten rows exist.
  await selectLiveMarket({
    fixture: fixtures[1],
    marketIndex: LIVE_MARKETS.length - 1,
    page,
  });
  const liveBoard = board(page, 'LIVE');
  await expect(liveBoard.locator('.slip-row-card')).toHaveCount(
    LIVE_MARKETS.length * 2,
    { timeout: 15000 },
  );
  await expect(liveBoard).toContainText(fixtures[0].name);
  await expect(liveBoard).toContainText(fixtures[1].name);
  await expect(preMatchBoard).toContainText(futureFixture.name);

  await liveBoard.getByRole('button', { name: 'CLEAN' }).click();
  await expect(liveBoard.locator('.slip-row-card')).toHaveCount(0);
  const declinedLiveSlipIds = [];
  let liveSlipId;
  let acceptedLiveBet;

  for (
    let placementAttempt = 1;
    placementAttempt <= MAX_LIVE_PLACEMENT_ATTEMPTS;
    placementAttempt += 1
  ) {
    for (const fixture of fixtures.slice(0, 2)) {
      await selectLiveMarket({
        fixture,
        marketIndex: 0,
        page,
      });
    }

    // Reselect the last row so the UI refresh follows both confirmed writes.
    await selectLiveMarket({
      fixture: fixtures[1],
      marketIndex: 0,
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

    if (submittedLiveBet.status !== 'DECLINED') {
      acceptedLiveBet = submittedLiveBet;
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
    expect(
      kickoffSnapshot.live.currentMarkets.map((market) => market.marketType).sort(),
    ).toEqual([...ALL_LIVE_MARKET_TYPES].sort());

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
      incidentTypes: [...incidentTypes].sort(),
    };
  });

  const settledBets = await (await page.request.get('/api/bet')).json();
  const liveBet = findBySlipId(settledBets, liveSlipId);
  expect(TERMINAL_BET_STATUSES).toContain(liveBet.status);
  expect(liveBet.betKind).toBe('LIVE');
  expect(liveBet.rows).toHaveLength(EXPECTED_LIVE_SETTLEMENT_ROWS);
  expect(
    liveBet.rows.every((row) => (
      row.betKind === 'LIVE' && row.status !== 'NOT_SETTLED'
    )),
  ).toBe(true);

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

  const manualResult = await page.request.post('/api/backoffice/result', {
    data: {
      eventId: futureFixture.eventId,
      homeResult: 1,
      awayResult: 0,
    },
  });
  expect(manualResult.ok()).toBeTruthy();
  await expect.poll(async () => {
    const bets = await (await page.request.get('/api/bet')).json();
    return findBySlipId(bets, preMatchSlipId)?.status;
  }, {
    timeout: 30000,
    intervals: [500, 1000, 2000],
  }).toBe('WIN');

  await page.getByTitle('My bets').click();
  const liveHistory = page.locator('.my-bets-card').filter({
    hasText: fixtures[0].name,
  });
  await expect(liveHistory).toContainText('Live');
  await expect(liveHistory).toContainText(liveBet.status);
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
    liveSlipId,
    declinedLiveSlipIds,
    liveBetStatus: liveBet.status,
    liveRowStatuses: liveBet.rows.map((row) => row.status),
    preMatchSlipId,
    preMatchBetStatus: 'WIN',
    pageErrors: pageErrors.length,
    consoleErrors: consoleErrors.length,
    apiFailures: apiFailures.length,
  }, null, 2)}\n`);
});
