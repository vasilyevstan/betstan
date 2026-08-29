const BET_KIND = Object.freeze({
  PRE_MATCH: 'PRE_MATCH',
  LIVE: 'LIVE',
});

const MARKET_LABELS = Object.freeze({
  NEXT_YELLOW_CARD: 'Next Yellow Card',
  NEXT_RED_CARD: 'Next Red Card',
  NEXT_CORNER: 'Next Corner',
  NEXT_PENALTY: 'Next Penalty',
  HALF_TIME_RESULT: 'Half Time Result',
  KICKOFF_TEAM: 'Kickoff Team',
  FIRST_MINUTE_GOAL: 'Goal in First Minute',
});

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const getSelectionName = (side, event) => {
  if (side === 'HOME') {
    return event.home;
  }
  if (side === 'AWAY') {
    return event.away;
  }
  if (side === 'DRAW') {
    return 'Draw';
  }
  return 'None';
};

const buildLiveMarkets = ({ cornerHomeOdds, cornerAwayOdds, cornerQuoteVersion }) => ([
  {
    marketId: 'market-corner',
    marketType: 'NEXT_CORNER',
    marketVersion: 1,
    quoteVersion: cornerQuoteVersion,
    status: 'OPEN',
    quoteValidUntil: '2030-01-01T13:00:00.000Z',
    selections: [
      { selectionId: 'home', side: 'HOME', odds: cornerHomeOdds },
      { selectionId: 'away', side: 'AWAY', odds: cornerAwayOdds },
    ],
  },
  {
    marketId: 'market-yellow',
    marketType: 'NEXT_YELLOW_CARD',
    marketVersion: 1,
    quoteVersion: cornerQuoteVersion + 1,
    status: 'OPEN',
    quoteValidUntil: '2030-01-01T13:00:00.000Z',
    selections: [
      { selectionId: 'home', side: 'HOME', odds: 3.4 },
      { selectionId: 'away', side: 'AWAY', odds: 2.7 },
    ],
  },
  {
    marketId: 'market-red',
    marketType: 'NEXT_RED_CARD',
    marketVersion: 1,
    quoteVersion: cornerQuoteVersion + 2,
    status: 'OPEN',
    quoteValidUntil: '2030-01-01T13:00:00.000Z',
    selections: [
      { selectionId: 'home', side: 'HOME', odds: 6.5 },
      { selectionId: 'away', side: 'AWAY', odds: 6.8 },
    ],
  },
  {
    marketId: 'market-penalty',
    marketType: 'NEXT_PENALTY',
    marketVersion: 1,
    quoteVersion: cornerQuoteVersion + 3,
    status: 'OPEN',
    quoteValidUntil: '2030-01-01T13:00:00.000Z',
    selections: [
      { selectionId: 'home', side: 'HOME', odds: 5.1 },
      { selectionId: 'away', side: 'AWAY', odds: 5.6 },
    ],
  },
  {
    marketId: 'market-half-time',
    marketType: 'HALF_TIME_RESULT',
    marketVersion: 1,
    quoteVersion: cornerQuoteVersion + 4,
    status: 'OPEN',
    quoteValidUntil: '2030-01-01T13:00:00.000Z',
    selections: [
      { selectionId: 'home', side: 'HOME', odds: 2.2 },
      { selectionId: 'draw', side: 'DRAW', odds: 1.9 },
      { selectionId: 'away', side: 'AWAY', odds: 2.8 },
    ],
  },
  {
    marketId: 'market-kickoff-team',
    marketType: 'KICKOFF_TEAM',
    marketVersion: 1,
    quoteVersion: cornerQuoteVersion + 5,
    status: 'SETTLED',
    quoteValidUntil: '2030-01-01T12:00:00.000Z',
    selections: [
      { selectionId: 'home', side: 'HOME', odds: 1.85 },
      { selectionId: 'away', side: 'AWAY', odds: 2.05 },
    ],
  },
  {
    marketId: 'market-first-minute-goal',
    marketType: 'FIRST_MINUTE_GOAL',
    marketVersion: 1,
    quoteVersion: cornerQuoteVersion + 6,
    status: 'SETTLED',
    quoteValidUntil: '2030-01-01T12:01:00.000Z',
    selections: [
      { selectionId: 'yes', side: 'YES', odds: 6.5 },
      { selectionId: 'no', side: 'NO', odds: 1.1 },
    ],
  },
]);

const buildLiveEvent = ({
  sequence,
  minute,
  homeScore,
  awayScore,
  incidentHistory,
  cornerHomeOdds,
  cornerAwayOdds,
  cornerQuoteVersion,
}) => ({
  eventId: 'live-1',
  name: 'Raptors - Sharks',
  time: '2030-01-01T12:00:00.000Z',
  visibility: 'ONLINE',
  status: 'NO_RESULT',
  home: 'Raptors',
  away: 'Sharks',
  products: [],
  live: {
    sequence,
    occurredAt: `2030-01-01T12:${String(minute).padStart(2, '0')}:00.000Z`,
    kickoffAt: '2030-01-01T12:00:00.000Z',
    minute,
    phase: 'FIRST_HALF',
    homeScore,
    awayScore,
    bettingStatus: 'OPEN',
    incidentHistory,
    currentMarkets: buildLiveMarkets({
      cornerHomeOdds,
      cornerAwayOdds,
      cornerQuoteVersion,
    }),
  },
});

const buildPreMatchEvent = () => ({
  eventId: 'prematch-1',
  name: 'Falcons - Owls',
  time: '2030-01-02T12:00:00.000Z',
  visibility: 'ONLINE',
  status: 'NO_RESULT',
  home: 'Falcons',
  away: 'Owls',
  products: [
    {
      id: 'prematch-1x2',
      type: '1X2',
      name: '1X2',
      odds: [
        { id: 'home', name: 'Falcons', value: 1.6 },
        { id: 'draw', name: 'Draw', value: 3.2 },
        { id: 'away', name: 'Owls', value: 4.5 },
      ],
    },
  ],
});

const buildBoard = (slipId, betKind, rows, overrides = {}) => {
  const boardRevision = overrides.boardRevision ?? 1;
  const boardFingerprint = overrides.boardFingerprint
    ?? `${slipId}-fingerprint-${boardRevision}`;

  return {
    _id: slipId,
    betKind,
    status: 'DRAFT',
    timestamp: '2030-01-01T12:05:00.000Z',
    boardRevision,
    boardFingerprint,
    rows,
    ...overrides,
  };
};

const nextBoardIdentity = (board, slipId) => {
  const boardRevision = (board?.boardRevision ?? 0) + 1;

  return {
    boardRevision,
    boardFingerprint: `${slipId}-fingerprint-${boardRevision}`,
  };
};

const buildLiveBet = ({ slipId, status, timestamp, wager, rows, declineReason }) => ({
  _id: `bet-${slipId}`,
  slipId,
  status,
  wager,
  timestamp,
  betKind: BET_KIND.LIVE,
  declineReason,
  rows,
});

const buildPreMatchBet = () => ({
  _id: 'bet-prematch-history-1',
  slipId: 'prematch-history-1',
  status: 'CONFIRMED',
  wager: 5,
  timestamp: '2030-01-01T08:00:00.000Z',
  betKind: BET_KIND.PRE_MATCH,
  rows: [
    {
      _id: 'bet-prematch-history-row-1',
      eventId: 'historic-prematch',
      eventName: 'Historic Derby',
      oddsId: 'historic-draw',
      oddsValue: 3.4,
      oddsName: 'Draw',
      productName: '1X2',
      productId: 'historic-1x2',
      timestamp: '2030-01-01T08:00:00.000Z',
      eventTime: '2030-01-01T18:00:00.000Z',
      betKind: BET_KIND.PRE_MATCH,
      status: 'NOT_SETTLED',
    },
  ],
});

const replaceEvent = (events, nextEvent) => {
  const nextEvents = (events || []).map((event) => (
    event.eventId === nextEvent.eventId ? nextEvent : event
  ));
  return nextEvents.some((event) => event.eventId === nextEvent.eventId)
    ? nextEvents
    : [...nextEvents, nextEvent];
};

const getPathname = (url) => new URL(url).pathname;

const getRequestBody = (route) => {
  try {
    return route.request().postDataJSON();
  } catch (error) {
    return null;
  }
};

const fulfillJson = (route, body, status = 200) => route.fulfill({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const createShellMockState = ({ loginError = null, signupError = null } = {}) => {
  const state = {
    currentUser: null,
    events: [],
    boards: {
      [BET_KIND.PRE_MATCH]: null,
      [BET_KIND.LIVE]: null,
    },
    bets: [],
    stats: [],
    auth: {
      loginError,
      signupError,
    },
    submissions: [],
    requestCounts: {},
    requests: [],
    unhandledRequests: [],
    requestCount: (key) => state.requestCounts[key] || 0,
  };

  return state;
};

const createLiveBettingMockState = () => {
  const preMatchEvent = buildPreMatchEvent();
  const sequence1 = buildLiveEvent({
    sequence: 1,
    minute: 12,
    homeScore: 1,
    awayScore: 0,
    cornerHomeOdds: 1.8,
    cornerAwayOdds: 2.4,
    cornerQuoteVersion: 1,
    incidentHistory: [
      { type: 'GOAL', side: 'HOME', minute: 8 },
      { type: 'YELLOW_CARD', side: 'AWAY', minute: 11 },
    ],
  });
  const sequence2 = buildLiveEvent({
    sequence: 2,
    minute: 18,
    homeScore: 1,
    awayScore: 1,
    cornerHomeOdds: 1.92,
    cornerAwayOdds: 2.25,
    cornerQuoteVersion: 2,
    incidentHistory: [
      { type: 'GOAL', side: 'HOME', minute: 8 },
      { type: 'GOAL', side: 'AWAY', minute: 18 },
    ],
  });
  const sequence2Ignored = buildLiveEvent({
    sequence: 2,
    minute: 19,
    homeScore: 6,
    awayScore: 0,
    cornerHomeOdds: 7.5,
    cornerAwayOdds: 9.9,
    cornerQuoteVersion: 22,
    incidentHistory: [
      { type: 'RED_CARD', side: 'HOME', minute: 19 },
    ],
  });
  const sequence1Ignored = buildLiveEvent({
    sequence: 1,
    minute: 10,
    homeScore: 0,
    awayScore: 0,
    cornerHomeOdds: 8.1,
    cornerAwayOdds: 8.8,
    cornerQuoteVersion: 11,
    incidentHistory: [
      { type: 'PENALTY_AWARDED', side: 'AWAY', minute: 10 },
    ],
  });
  const sequence3 = buildLiveEvent({
    sequence: 3,
    minute: 22,
    homeScore: 1,
    awayScore: 1,
    cornerHomeOdds: 2.05,
    cornerAwayOdds: 2.35,
    cornerQuoteVersion: 3,
    incidentHistory: [
      { type: 'GOAL', side: 'HOME', minute: 8 },
      { type: 'GOAL', side: 'AWAY', minute: 18 },
      { type: 'CORNER', side: 'AWAY', minute: 20 },
    ],
  });

  const state = createShellMockState();
  state.currentUser = {
    id: 'bettor-1',
    email: 'playwright@example.com',
  };
  state.events = [preMatchEvent, sequence1];
  state.stats = [
    { userKey: 'leader-1', displayName: 'Top Player', betCount: 4, wagerTotal: 120 },
  ];
  state.bets = [buildPreMatchBet()];
  state.fixtures = {
    liveEventName: sequence1.name,
    preMatchEventName: preMatchEvent.name,
    preMatchSelectionLabel: 'Select 1X2 Draw at 3.2',
    liveInitialSelectionLabel: 'Select Next Corner: Raptors at 1.8',
    liveUpdatedHomeSelectionLabel: 'Select Next Corner: Raptors at 1.92',
    liveUpdatedAwaySelectionLabel: 'Select Next Corner: Sharks at 2.25',
    liveReplacementSelectionLabel: 'Select Next Corner: Sharks at 2.35',
  };
  state.snapshots = {
    sequence2,
    sequence2Ignored,
    sequence1Ignored,
    sequence3,
  };
  state.requestCount = (key) => state.requestCounts[key] || 0;
  state.getLastSubmission = () => state.submissions[state.submissions.length - 1] || null;

  let liveRowCounter = 1;
  let preMatchRowCounter = 1;
  let resubmittedLiveTimestamp = '2030-01-01T12:40:00.000Z';
  let lastLiveSubmission = null;

  const getLiveEvent = () => state.events.find((event) => event.eventId === 'live-1');

  const buildPreMatchRow = (event, product, odds) => ({
    _id: `prematch-row-${preMatchRowCounter++}`,
    eventId: event.eventId,
    eventName: event.name,
    oddsId: odds.id,
    oddsValue: odds.value,
    oddsName: odds.name,
    productName: product.name,
    productId: product.id,
    timestamp: event.time,
    eventTime: event.time,
    betKind: BET_KIND.PRE_MATCH,
  });

  const buildLiveRow = (event, market, selection, rowId = `live-row-${liveRowCounter++}`) => ({
    _id: rowId,
    eventId: event.eventId,
    eventName: event.name,
    oddsId: `${market.marketId}:${selection.selectionId}`,
    oddsValue: selection.odds,
    oddsName: getSelectionName(selection.side, event),
    productName: MARKET_LABELS[market.marketType] || market.marketType,
    productId: market.marketId,
    timestamp: event.time,
    eventTime: event.live?.kickoffAt ?? event.time,
    betKind: BET_KIND.LIVE,
    marketId: market.marketId,
    marketType: market.marketType,
    marketVersion: market.marketVersion,
    quoteVersion: market.quoteVersion,
    selectionId: selection.selectionId,
    side: selection.side,
    selectedAt: event.live?.occurredAt,
    quoteValidUntil: market.quoteValidUntil,
  });

  const upsertBet = (nextBet) => {
    state.bets = [
      nextBet,
      ...state.bets.filter((bet) => bet.slipId !== nextBet.slipId),
    ];
  };

  state.applyLiveSnapshot = (nextEvent) => {
    state.events = replaceEvent(state.events, deepClone(nextEvent));
  };

  state.selectSelection = (payload) => {
    if (payload.marketId) {
      const event = getLiveEvent();
      const market = event?.live?.currentMarkets?.find((candidate) => candidate.marketId === payload.marketId);
      const selection = market?.selections?.find((candidate) => candidate.selectionId === payload.selectionId);

      if (!event || !market || !selection) {
        return;
      }

      const existingBoard = state.boards[BET_KIND.LIVE];
      const nextRow = buildLiveRow(event, market, selection, existingBoard?.rows?.[0]?._id || undefined);
      const currentRows = existingBoard?.rows || [];
      const rowsWithoutSameMarket = currentRows.filter((row) => !(
        row.betKind === BET_KIND.LIVE
        && row.marketId === nextRow.marketId
        && row.marketVersion === nextRow.marketVersion
      ));
      const hasSameMarket = rowsWithoutSameMarket.length !== currentRows.length;
      const hasDuplicateOdds = currentRows.some((row) => row.oddsId === nextRow.oddsId);
      const rows = hasSameMarket
        ? [...rowsWithoutSameMarket, nextRow]
        : hasDuplicateOdds
          ? currentRows
          : [...currentRows, nextRow];
      const slipId = existingBoard?._id || 'live-draft-1';

      state.boards[BET_KIND.LIVE] = buildBoard(
        slipId,
        BET_KIND.LIVE,
        rows,
        {
          ...nextBoardIdentity(existingBoard, slipId),
          ...(existingBoard?.sourceSlipId ? {
            sourceSlipId: existingBoard.sourceSlipId,
            declineReason: existingBoard.declineReason,
          } : {}),
        },
      );
      return;
    }

    const event = state.events.find((candidate) => candidate.eventId === payload.eventId);
    const product = event?.products?.find((candidate) => candidate.id === payload.productId);
    const odds = product?.odds?.find((candidate) => candidate.id === payload.oddsId);

    if (!event || !product || !odds) {
      return;
    }

    const existingBoard = state.boards[BET_KIND.PRE_MATCH];
    const currentRows = existingBoard?.rows || [];
    if (currentRows.some((row) => row.oddsId === odds.id)) {
      return;
    }

    const slipId = existingBoard?._id || 'prematch-draft-1';
    state.boards[BET_KIND.PRE_MATCH] = buildBoard(
      slipId,
      BET_KIND.PRE_MATCH,
      [...currentRows, buildPreMatchRow(event, product, odds)],
      nextBoardIdentity(existingBoard, slipId),
    );
  };

  state.submitBoard = ({
    betKind,
    slipId,
    wager,
    placementAttemptId,
    expectedBoardRevision,
    expectedBoardFingerprint,
  }) => {
    const board = state.boards[betKind];
    if (!board || board._id !== slipId) {
      return { status: 400, body: { message: 'slip does not exist' } };
    }
    if (
      !placementAttemptId
      || expectedBoardRevision !== board.boardRevision
      || expectedBoardFingerprint !== board.boardFingerprint
    ) {
      return { status: 409, body: { message: 'board confirmation mismatch' } };
    }

    const cleanedBoard = buildBoard(
      board._id,
      betKind,
      board.rows.map((row) => {
        const nextRow = { ...row };
        delete nextRow.moderation;
        return nextRow;
      }),
      {
        status: 'SUBMITTED',
        submittedAt: '2030-01-01T12:30:00.000Z',
        sourceSlipId: board.sourceSlipId,
        boardRevision: board.boardRevision,
        boardFingerprint: board.boardFingerprint,
      },
    );
    delete cleanedBoard.declineReason;

    state.boards[betKind] = cleanedBoard;
    state.submissions.push({
      betKind,
      slipId,
      wager: Number(wager),
      placementAttemptId,
      expectedBoardRevision,
      expectedBoardFingerprint,
      rows: deepClone(cleanedBoard.rows),
    });

    if (betKind === BET_KIND.LIVE) {
      lastLiveSubmission = {
        slipId,
        wager: Number(wager),
        rows: deepClone(cleanedBoard.rows),
      };
      upsertBet(buildLiveBet({
        slipId,
        status: 'PENDING',
        wager: Number(wager),
        timestamp: resubmittedLiveTimestamp,
        rows: cleanedBoard.rows.map((row) => ({ ...row, status: 'NOT_SETTLED' })),
      }));
      resubmittedLiveTimestamp = '2030-01-01T12:42:00.000Z';
    }

    return { status: 200, body: deepClone(cleanedBoard) };
  };

  state.deleteRow = ({ betKind, slipRowId }) => {
    const board = state.boards[betKind];
    if (!board) {
      return;
    }

    const nextRows = (board.rows || []).filter((row) => row._id !== slipRowId);
    state.boards[betKind] = nextRows.length === 0
      ? null
      : buildBoard(board._id, betKind, nextRows, {
        status: board.status,
        sourceSlipId: board.sourceSlipId,
        declineReason: board.declineReason,
        ...nextBoardIdentity(board, board._id),
      });
  };

  state.cleanBoard = ({ betKind }) => {
    state.boards[betKind] = null;
  };

  state.applyModerationDecline = () => {
    if (!lastLiveSubmission) {
      return;
    }

    state.applyLiveSnapshot(sequence3);

    const currentMarket = sequence3.live.currentMarkets.find((market) => market.marketId === 'market-corner');
    const currentSelection = currentMarket.selections.find((selection) => selection.selectionId === 'away');
    const previousRow = lastLiveSubmission.rows[0];
    const replacementRowId = 'live-row-2';

    state.boards[BET_KIND.LIVE] = buildBoard(
      'live-draft-2',
      BET_KIND.LIVE,
      [
        {
          ...previousRow,
          _id: replacementRowId,
          quoteVersion: 2,
          oddsValue: 2.25,
          oddsName: 'Sharks',
          moderation: {
            rowId: replacementRowId,
            declineReason: 'STALE_QUOTE',
            marketId: currentMarket.marketId,
            quoteVersion: currentMarket.quoteVersion,
            currentOdds: currentSelection.odds,
            marketStatus: currentMarket.status,
            selectionId: currentSelection.selectionId,
          },
        },
      ],
      {
        sourceSlipId: lastLiveSubmission.slipId,
        declineReason: 'STALE_QUOTE',
        timestamp: '2030-01-01T12:35:00.000Z',
      },
    );

    upsertBet(buildLiveBet({
      slipId: lastLiveSubmission.slipId,
      status: 'DECLINED',
      wager: lastLiveSubmission.wager,
      timestamp: '2030-01-01T12:35:00.000Z',
      declineReason: 'STALE_QUOTE',
      rows: lastLiveSubmission.rows.map((row) => ({
        ...row,
        status: 'VOID',
        declineReason: 'STALE_QUOTE',
        settlementReason: 'MANUAL_VOID',
      })),
    }));
  };

  return state;
};

const installAppApiMocks = async (page, state) => {
  await page.route('**/api/**', async (route) => {
    const pathname = getPathname(route.request().url());
    const method = route.request().method();
    const key = `${method} ${pathname}`;
    const body = getRequestBody(route);

    state.requestCounts[key] = (state.requestCounts[key] || 0) + 1;
    state.requests.push({ key, body: body ? deepClone(body) : null });

    if (key === 'GET /api/auth/currentuser') {
      await fulfillJson(route, { currentUser: state.currentUser });
      return;
    }

    if (key === 'GET /api/event') {
      await fulfillJson(route, deepClone(state.events));
      return;
    }

    if (key === 'GET /api/event/stream') {
      await route.fulfill({
        status: 204,
        contentType: 'text/plain',
        body: '',
      });
      return;
    }

    if (key === 'GET /api/slip/boards') {
      await fulfillJson(route, deepClone(state.boards));
      return;
    }

    if (key === 'GET /api/bet') {
      await fulfillJson(route, deepClone(state.bets));
      return;
    }

    if (key === 'GET /api/bet/stats' || key === 'GET /api/bet/stats/v2') {
      await fulfillJson(route, deepClone(state.stats));
      return;
    }

    if (key === 'POST /api/event/odds') {
      state.selectSelection(body || {});
      await fulfillJson(route, {});
      return;
    }

    if (key === 'POST /api/slip/bet') {
      const response = state.submitBoard(body || {});
      await fulfillJson(route, response?.body || {}, response?.status || 200);
      return;
    }

    if (key === 'POST /api/slip/row') {
      state.deleteRow(body || {});
      await fulfillJson(route, {});
      return;
    }

    if (key === 'POST /api/slip/row/clean') {
      state.cleanBoard(body || {});
      await fulfillJson(route, {});
      return;
    }

    if (key === 'POST /api/auth/new') {
      if (state.auth.signupError) {
        await fulfillJson(route, { errors: [{ message: state.auth.signupError }] }, 400);
        return;
      }

      await fulfillJson(route, { currentUser: state.currentUser });
      return;
    }

    if (key === 'POST /api/auth/login') {
      if (state.auth.loginError) {
        await fulfillJson(route, { errors: [{ message: state.auth.loginError }] }, 400);
        return;
      }

      await fulfillJson(route, { currentUser: state.currentUser });
      return;
    }

    if (key === 'POST /api/auth/logout') {
      state.currentUser = null;
      await fulfillJson(route, {});
      return;
    }

    if (key === 'GET /api/backoffice') {
      await fulfillJson(route, {});
      return;
    }

    if (key === 'POST /api/backoffice/result' || key === 'POST /api/backoffice/event_visibility' || key === 'POST /api/backoffice/new_event') {
      await fulfillJson(route, {});
      return;
    }

    state.unhandledRequests.push(key);
    await fulfillJson(route, {});
  });
};

module.exports = {
  BET_KIND,
  createLiveBettingMockState,
  createShellMockState,
  installAppApiMocks,
};
