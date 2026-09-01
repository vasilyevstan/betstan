import {
  buildFinishedMatchTimeline,
  COUNTDOWN_LIVE_MARKET_TYPE,
  COUNTDOWN_WINDOW_MS,
  formatCountdownDuration,
  formatLegacyLiveSelectionLabel,
  formatRowOutcome,
  getMarketAvailabilityLabel,
  getMarketSelectionLabel,
  getScheduledKickoffTime,
  isCountdownMarketType,
  isFinishedLiveEvent,
  isInCountdownWindow,
  isLiveMarketSelectable,
  isTerminalMarketStatus,
  LIVE_MARKET_STATUS,
  mergeAuthoritativeEventList,
  SLIP_ROW_STATUS,
  shouldReplaceEventFromAuthoritativeSource,
} from './liveBettingUtils';

const KICKOFF_ISO = '2030-06-01T15:00:00.000Z';
const KICKOFF_TIME = Date.parse(KICKOFF_ISO);

const buildScheduledEvent = (overrides = {}) => ({
  eventId: 'event-1',
  name: 'Team A - Team B',
  time: KICKOFF_ISO,
  status: 'NO_RESULT',
  home: 'Team A',
  away: 'Team B',
  ...overrides,
});

const buildMarket = (overrides = {}) => ({
  marketId: 'market-1',
  marketType: COUNTDOWN_LIVE_MARKET_TYPE.KICKOFF_TEAM,
  marketVersion: 1,
  quoteVersion: 1,
  status: LIVE_MARKET_STATUS.OPEN,
  quoteValidUntil: new Date(KICKOFF_TIME + 60_000).toISOString(),
  selections: [
    { selectionId: 'home', side: 'HOME', odds: 1.9 },
    { selectionId: 'away', side: 'AWAY', odds: 1.9 },
  ],
  ...overrides,
});

describe('countdown window boundaries', () => {
  it('is not in the countdown window before T-10 (T-10 minus one minute)', () => {
    const event = buildScheduledEvent();
    const oneMinuteBeforeWindow = KICKOFF_TIME - COUNTDOWN_WINDOW_MS - 60_000;

    expect(isInCountdownWindow(event, oneMinuteBeforeWindow)).toBe(false);
  });

  it('enters the countdown window at exactly T-10 (inclusive)', () => {
    const event = buildScheduledEvent();
    const exactlyTenMinutesBefore = KICKOFF_TIME - COUNTDOWN_WINDOW_MS;

    expect(isInCountdownWindow(event, exactlyTenMinutesBefore)).toBe(true);
  });

  it('remains in the countdown window between T-10 and kickoff', () => {
    const event = buildScheduledEvent();

    expect(isInCountdownWindow(event, KICKOFF_TIME - 60_000)).toBe(true);
  });

  it('stays in the countdown window past scheduled kickoff until the server marks the event live', () => {
    const event = buildScheduledEvent();

    expect(isInCountdownWindow(event, KICKOFF_TIME + 30_000)).toBe(true);
  });

  it('is never in the countdown window once the server marks the event live', () => {
    const event = buildScheduledEvent({ live: { phase: 'FIRST_HALF' } });

    expect(isInCountdownWindow(event, KICKOFF_TIME)).toBe(false);
  });

  it('is never in the countdown window for a finished event', () => {
    const event = buildScheduledEvent({ live: { phase: 'FULL_TIME' } });

    expect(isInCountdownWindow(event, KICKOFF_TIME)).toBe(false);
    expect(isFinishedLiveEvent(event)).toBe(true);
  });

  it('is never in the countdown window for a resulted event', () => {
    const event = buildScheduledEvent({ status: 'RESULTED' });

    expect(isInCountdownWindow(event, KICKOFF_TIME - 60_000)).toBe(false);
  });

  it('is not in the countdown window when the kickoff time is missing/malformed', () => {
    expect(isInCountdownWindow(buildScheduledEvent({ time: undefined }), KICKOFF_TIME)).toBe(false);
    expect(isInCountdownWindow(buildScheduledEvent({ time: 'not-a-date' }), KICKOFF_TIME)).toBe(false);
  });

  it('prefers live.kickoffAt over the scheduled time when present', () => {
    const liveKickoff = new Date(KICKOFF_TIME + 5 * 60_000).toISOString();
    const event = buildScheduledEvent({ live: undefined });
    event.live = { kickoffAt: liveKickoff };

    expect(getScheduledKickoffTime(event)).toBe(Date.parse(liveKickoff));
  });
});

describe('isLiveMarketSelectable for countdown-only markets', () => {
  it('allows selection of a countdown market inside the T-10 window when authoritative fields are open', () => {
    const event = buildScheduledEvent({ live: { bettingStatus: 'OPEN' } });
    const market = buildMarket();

    expect(isLiveMarketSelectable(event, market, KICKOFF_TIME - 60_000)).toBe(true);
  });

  it('does not allow a countdown market before T-10, even with open authoritative fields', () => {
    const event = buildScheduledEvent({ live: { bettingStatus: 'OPEN' } });
    const market = buildMarket();

    expect(isLiveMarketSelectable(event, market, KICKOFF_TIME - COUNTDOWN_WINDOW_MS - 60_000)).toBe(false);
  });

  it('never allows a non-countdown market type before the event is live, even inside T-10', () => {
    const event = buildScheduledEvent({ live: { bettingStatus: 'OPEN' } });
    const market = buildMarket({ marketType: 'NEXT_CORNER' });

    expect(isLiveMarketSelectable(event, market, KICKOFF_TIME - 60_000)).toBe(false);
  });

  it('closes a countdown market at server cutoff even though the client clock is still pre-kickoff', () => {
    const event = buildScheduledEvent({ live: { bettingStatus: 'OPEN' } });
    const closedMarket = buildMarket({ status: LIVE_MARKET_STATUS.CLOSED });
    const staleMarket = buildMarket({ quoteValidUntil: new Date(KICKOFF_TIME - 5 * 60_000).toISOString() });

    // "now" is still well before scheduled kickoff by client clock; only the authoritative
    // market fields close the market, proving the cutoff is server-driven, not client-time-driven.
    const now = KICKOFF_TIME - 4 * 60_000;
    expect(isLiveMarketSelectable(event, closedMarket, now)).toBe(false);
    expect(isLiveMarketSelectable(event, staleMarket, now)).toBe(false);
  });

  it('closes a countdown market when event-level betting status is not OPEN', () => {
    const event = buildScheduledEvent({ live: { bettingStatus: 'SUSPENDED' } });
    const market = buildMarket();

    expect(isLiveMarketSelectable(event, market, KICKOFF_TIME - 60_000)).toBe(false);
  });

  it('remains backward compatible for ordinary in-play live markets outside the countdown window', () => {
    const event = buildScheduledEvent({ live: { phase: 'FIRST_HALF', bettingStatus: 'OPEN' } });
    const now = KICKOFF_TIME + 10 * 60_000;
    const market = buildMarket({ marketType: 'NEXT_CORNER', quoteValidUntil: new Date(now + 60_000).toISOString() });

    expect(isLiveMarketSelectable(event, market, now)).toBe(true);
  });

  it('is backward compatible when the event has no live block at all', () => {
    const event = buildScheduledEvent({ live: undefined });
    const market = buildMarket();

    expect(isLiveMarketSelectable(event, market, KICKOFF_TIME - 60_000)).toBe(false);
  });
});

describe('getMarketSelectionLabel', () => {
  it('labels kickoff-team selections using the existing HOME/AWAY side convention', () => {
    const event = buildScheduledEvent();
    const market = buildMarket();

    expect(getMarketSelectionLabel(market, market.selections[0], event)).toBe('Team A');
    expect(getMarketSelectionLabel(market, market.selections[1], event)).toBe('Team B');
  });

  it('labels first-minute-goal selections as Yes/No using the required TeamSide.YES/NO field', () => {
    const event = buildScheduledEvent();
    const market = buildMarket({
      marketType: COUNTDOWN_LIVE_MARKET_TYPE.FIRST_MINUTE_GOAL,
      selections: [
        { selectionId: 'yes', side: 'YES', odds: 4.5 },
        { selectionId: 'no', side: 'NO', odds: 1.2 },
      ],
    });

    expect(getMarketSelectionLabel(market, market.selections[0], event)).toBe('Yes');
    expect(getMarketSelectionLabel(market, market.selections[1], event)).toBe('No');
  });

  it('falls back to a selectionId-based yes/no label if `side` is ever missing or unrecognized', () => {
    const event = buildScheduledEvent();
    const market = buildMarket({ marketType: COUNTDOWN_LIVE_MARKET_TYPE.FIRST_MINUTE_GOAL });

    expect(getMarketSelectionLabel(market, { selectionId: 'yes', side: undefined, odds: 4.5 }, event)).toBe('Yes');
    expect(getMarketSelectionLabel(market, { selectionId: 'no', side: undefined, odds: 1.2 }, event)).toBe('No');
  });

  it('prefers an explicit server-supplied label when present', () => {
    const event = buildScheduledEvent();
    const market = buildMarket({ marketType: COUNTDOWN_LIVE_MARKET_TYPE.FIRST_MINUTE_GOAL });

    expect(getMarketSelectionLabel(market, { selectionId: 'yes', side: 'YES', label: 'Definitely' }, event)).toBe('Definitely');
  });
});

describe('getMarketAvailabilityLabel for countdown markets', () => {
  it('reports the market as Open during the countdown window when authoritative fields allow it', () => {
    const event = buildScheduledEvent({ live: { bettingStatus: 'OPEN' } });
    const market = buildMarket();

    expect(getMarketAvailabilityLabel(event, market, KICKOFF_TIME - 60_000)).toBe('Open');
  });

  it('reports a countdown-specific message before T-10', () => {
    const event = buildScheduledEvent({ live: { bettingStatus: 'OPEN' } });
    const market = buildMarket();

    expect(getMarketAvailabilityLabel(event, market, KICKOFF_TIME - COUNTDOWN_WINDOW_MS - 60_000))
      .toBe('Opens during the kickoff countdown');
  });

  it('falls back to the existing in-play-only message for non-countdown markets pre-kickoff', () => {
    const event = buildScheduledEvent();
    const market = buildMarket({ marketType: 'NEXT_CORNER' });

    expect(getMarketAvailabilityLabel(event, market, KICKOFF_TIME - 60_000)).toBe('Live markets open in-play only');
  });

  it('reports an actually unknown, non-terminal status (e.g. SETTLEMENT_PENDING) as "Temporarily unavailable", never as the contradictory "Open"', () => {
    const event = buildScheduledEvent({ live: { bettingStatus: 'OPEN' } });
    const market = buildMarket({ status: 'SETTLEMENT_PENDING' });

    expect(getMarketAvailabilityLabel(event, market, KICKOFF_TIME - 60_000)).toBe('Temporarily unavailable');
  });
});

describe('isCountdownMarketType', () => {
  it('recognizes only the two documented countdown market type constants', () => {
    expect(isCountdownMarketType(COUNTDOWN_LIVE_MARKET_TYPE.KICKOFF_TEAM)).toBe(true);
    expect(isCountdownMarketType(COUNTDOWN_LIVE_MARKET_TYPE.FIRST_MINUTE_GOAL)).toBe(true);
    expect(isCountdownMarketType('NEXT_CORNER')).toBe(false);
    expect(isCountdownMarketType(undefined)).toBe(false);
  });
});

describe('formatCountdownDuration', () => {
  it('formats whole minutes and seconds as mm:ss', () => {
    expect(formatCountdownDuration(10 * 60 * 1000)).toBe('10:00');
    expect(formatCountdownDuration(65_000)).toBe('01:05');
  });

  it('clamps negative or non-finite input to 00:00', () => {
    expect(formatCountdownDuration(-5_000)).toBe('00:00');
    expect(formatCountdownDuration(undefined)).toBe('00:00');
    expect(formatCountdownDuration(Number.NaN)).toBe('00:00');
  });
});

describe('shouldReplaceEventFromAuthoritativeSource', () => {
  const buildEvent = (overrides = {}) => ({
    eventId: 'event-1',
    visibility: 'ONLINE',
    status: 'NO_RESULT',
    live: { sequence: 3, phase: 'FIRST_HALF' },
    ...overrides,
  });

  it('always accepts a strictly newer sequence, and rejects a strictly older one', () => {
    const current = buildEvent({ live: { sequence: 3, phase: 'FIRST_HALF' } });
    expect(shouldReplaceEventFromAuthoritativeSource(
      current,
      buildEvent({ live: { sequence: 4, phase: 'FIRST_HALF' } }),
    )).toBe(true);
    expect(shouldReplaceEventFromAuthoritativeSource(
      current,
      buildEvent({ live: { sequence: 2, phase: 'FIRST_HALF' } }),
    )).toBe(false);
  });

  it('accepts an equal-sequence repair from the premature RESULTED/OFFLINE race signature to a healthy state', () => {
    const stale = buildEvent({ visibility: 'OFFLINE', status: 'RESULTED' });
    const settled = buildEvent({ visibility: 'ONLINE', status: 'NO_RESULT' });
    expect(shouldReplaceEventFromAuthoritativeSource(stale, settled)).toBe(true);
  });

  it('rejects an equal-sequence regression from a healthy state back into the premature RESULTED/OFFLINE race signature', () => {
    // A slower, earlier-issued REST response reflecting an older,
    // pre-recovery read must never overwrite an already-settled healthy
    // cached snapshot just because it resolves later.
    const settled = buildEvent({ visibility: 'ONLINE', status: 'NO_RESULT' });
    const stale = buildEvent({ visibility: 'OFFLINE', status: 'RESULTED' });
    expect(shouldReplaceEventFromAuthoritativeSource(settled, stale)).toBe(false);
  });

  it('always accepts an equal-sequence read reflecting the legitimate FULL_TIME terminal state, regardless of direction', () => {
    const online = buildEvent({
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      live: { sequence: 5, phase: 'FULL_TIME' },
    });
    const retired = buildEvent({
      visibility: 'OFFLINE',
      status: 'RESULTED',
      live: { sequence: 5, phase: 'FULL_TIME' },
    });
    // e.g. an acceptance-scoped view of an already-retired retained event.
    expect(shouldReplaceEventFromAuthoritativeSource(online, retired)).toBe(true);
    expect(shouldReplaceEventFromAuthoritativeSource(retired, online)).toBe(true);
  });

  it('accepts an equal-sequence read that does not change the race-state direction (no-op refresh)', () => {
    const stale = buildEvent({ visibility: 'OFFLINE', status: 'RESULTED' });
    const alsoStale = buildEvent({ visibility: 'OFFLINE', status: 'RESULTED', home: 'Renamed' });
    const healthy = buildEvent({ visibility: 'ONLINE', status: 'NO_RESULT' });
    const alsoHealthy = buildEvent({ visibility: 'ONLINE', status: 'NO_RESULT', home: 'Renamed' });
    expect(shouldReplaceEventFromAuthoritativeSource(stale, alsoStale)).toBe(true);
    expect(shouldReplaceEventFromAuthoritativeSource(healthy, alsoHealthy)).toBe(true);
  });

  it('is backward compatible with the existing null/undefined-current and null-sequence edge cases', () => {
    const next = buildEvent();
    expect(shouldReplaceEventFromAuthoritativeSource(null, next)).toBe(true);
    expect(shouldReplaceEventFromAuthoritativeSource(undefined, next)).toBe(true);
    expect(shouldReplaceEventFromAuthoritativeSource(buildEvent({ live: undefined }), next)).toBe(true);
    expect(shouldReplaceEventFromAuthoritativeSource(next, buildEvent({ live: undefined }))).toBe(false);
  });
});

describe('mergeAuthoritativeEventList terminal history', () => {
  const buildFinishedEvent = ({
    complete = false,
    history = [],
    sequence = 5,
    status = 'RESULTED',
    visibility = 'ONLINE',
  } = {}) => ({
    eventId: 'finished-event',
    name: 'Falcons - Owls',
    status,
    visibility,
    live: {
      sequence,
      phase: 'FULL_TIME',
      incidentHistory: history,
      incidentHistoryComplete: complete,
    },
  });

  it('accepts authoritative metadata without shrinking verified same-sequence history', () => {
    const currentHistory = [
      { id: 'kickoff', type: 'KICK_OFF' },
      { id: 'goal', type: 'GOAL', minute: 12 },
      { id: 'full-time', type: 'FULL_TIME' },
    ];
    const current = buildFinishedEvent({ complete: true, history: currentHistory });
    const next = buildFinishedEvent({
      complete: false,
      history: [{ id: 'full-time', type: 'FULL_TIME' }],
      visibility: 'OFFLINE',
    });

    const [merged] = mergeAuthoritativeEventList([current], [next]);

    expect(merged.visibility).toBe('OFFLINE');
    expect(merged.live.incidentHistory).toEqual(currentHistory);
    expect(merged.live.incidentHistoryComplete).toBe(true);
    expect(merged).not.toBe(next);
    expect(current.live.incidentHistory).toEqual(currentHistory);
  });

  it('prefers a newly verified complete history over a longer unverified history', () => {
    const current = buildFinishedEvent({
      history: [
        { id: 'legacy-1', type: 'GOAL' },
        { id: 'legacy-2', type: 'GOAL' },
        { id: 'legacy-3', type: 'GOAL' },
      ],
    });
    const verifiedHistory = [
      { id: 'kickoff', type: 'KICK_OFF' },
      { id: 'full-time', type: 'FULL_TIME' },
    ];
    const next = buildFinishedEvent({ complete: true, history: verifiedHistory });

    expect(mergeAuthoritativeEventList([current], [next])[0].live).toMatchObject({
      incidentHistory: verifiedHistory,
      incidentHistoryComplete: true,
    });
  });

  it('replaces history normally when the authoritative sequence is strictly newer', () => {
    const current = buildFinishedEvent({
      complete: true,
      history: [{ id: 'old', type: 'GOAL' }],
      sequence: 5,
    });
    const next = buildFinishedEvent({
      history: [],
      sequence: 6,
    });

    expect(mergeAuthoritativeEventList([current], [next])[0]).toBe(next);
  });
});

describe('buildFinishedMatchTimeline', () => {
  const event = {
    home: 'Falcons',
    away: 'Owls',
  };

  it('keeps source chronology, includes structural moments, and removes only an exactly linked penalty goal', () => {
    const history = [
      { id: 'kickoff', type: 'KICK_OFF', minute: 0 },
      { id: 'first-minute', type: 'FIRST_MINUTE_ELAPSED', minute: 1 },
      { id: 'goal-1', type: 'GOAL', side: 'HOME', minute: 12 },
      { id: 'half-time', type: 'HALF_TIME', minute: 45 },
      { id: 'penalty-scored', type: 'PENALTY_SCORED', side: 'AWAY', minute: 61 },
      {
        id: 'derived-penalty-goal',
        relatedIncidentId: 'penalty-scored',
        type: 'GOAL',
        side: 'AWAY',
        minute: 61,
      },
      {
        id: 'unrelated-same-minute-goal',
        relatedIncidentId: 'some-other-incident',
        type: 'GOAL',
        side: 'HOME',
        minute: 61,
      },
      { id: 'red-card', type: 'RED_CARD', side: 'AWAY', minute: 75 },
      { id: 'added-time', type: 'ADDED_TIME_ANNOUNCED', minute: 90, addedTime: 4 },
      { id: 'unknown', type: 'FUTURE_TECHNICAL_MARKER', minute: 90 },
      { id: 'full-time', type: 'FULL_TIME', minute: 90, addedTime: 4 },
    ];

    const result = buildFinishedMatchTimeline(history, event);

    expect(result.timeline.map((entry) => entry.label)).toEqual([
      'Kick-off',
      "12' Falcons goal",
      'Half-time',
      "61' Owls penalty scored",
      "61' Falcons goal",
      "75' Owls red card",
      'Added time +4',
      'Full-time',
    ]);
    expect(result.keyMoments.map((entry) => entry.id)).toEqual([
      'goal-1',
      'penalty-scored',
      'unrelated-same-minute-goal',
      'red-card',
    ]);
  });
});

describe('isTerminalMarketStatus', () => {
  it('treats SETTLED and CLOSED as terminal', () => {
    expect(isTerminalMarketStatus(LIVE_MARKET_STATUS.SETTLED)).toBe(true);
    expect(isTerminalMarketStatus(LIVE_MARKET_STATUS.CLOSED)).toBe(true);
  });

  it('is defensively case-insensitive/trimmed', () => {
    expect(isTerminalMarketStatus('settled')).toBe(true);
    expect(isTerminalMarketStatus(' Closed ')).toBe(true);
  });

  it('does not treat OPEN, SUSPENDED, unknown, or missing statuses as terminal', () => {
    expect(isTerminalMarketStatus(LIVE_MARKET_STATUS.OPEN)).toBe(false);
    expect(isTerminalMarketStatus(LIVE_MARKET_STATUS.SUSPENDED)).toBe(false);
    expect(isTerminalMarketStatus('SOME_FUTURE_STATUS')).toBe(false);
    // An actually unknown, non-terminal status (e.g. a settlement-in-progress state the client
    // has never seen before) must remain non-terminal -- only the two canonical SETTLED/CLOSED
    // values (case-insensitively) are terminal, never a heuristic/prefix/substring match.
    expect(isTerminalMarketStatus('SETTLEMENT_PENDING')).toBe(false);
    expect(isTerminalMarketStatus('settlement_pending')).toBe(false);
    expect(isTerminalMarketStatus(undefined)).toBe(false);
    expect(isTerminalMarketStatus(null)).toBe(false);
  });
});

describe('formatLegacyLiveSelectionLabel', () => {
  it('leaves an already-readable label unchanged for backward compatibility', () => {
    expect(formatLegacyLiveSelectionLabel('Team A', {})).toBe('Team A');
    expect(formatLegacyLiveSelectionLabel('Draw', {})).toBe('Draw');
  });

  it('derives a HOME/AWAY label from a raw stored live-selection identifier using event home/away names', () => {
    const row = {
      eventName: 'Raptors - Sharks',
      marketType: 'NEXT_CORNER',
      side: 'HOME',
      selectionId: 'home',
    };

    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_CORNER:1:HOME', row)).toBe('Next Corner: Raptors');
  });

  it('derives an AWAY label from a raw identifier', () => {
    const row = {
      eventName: 'Raptors - Sharks',
      marketType: 'NEXT_CORNER',
      side: 'AWAY',
      selectionId: 'away',
    };

    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_CORNER:1:AWAY', row)).toBe('Next Corner: Sharks');
  });

  it('derives a Draw label from a raw identifier for a market with a draw side', () => {
    const row = {
      eventName: 'Raptors - Sharks',
      marketType: 'HALF_TIME_RESULT',
      side: 'DRAW',
      selectionId: 'draw',
    };

    expect(formatLegacyLiveSelectionLabel('event-42:HALF_TIME_RESULT:1:DRAW', row)).toBe('Half Time Result: Draw');
  });

  it('normalizes a known market type without a recognizable side into just the market label', () => {
    const row = { eventName: 'Raptors - Sharks', marketType: 'NEXT_PENALTY' };

    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_PENALTY:1:UNKNOWN', row)).toBe('Next Penalty');
  });

  it('derives the full label purely from the raw identifier when the row has no structured fields at all', () => {
    const raw = 'event-42:NEXT_CORNER:1:HOME';
    expect(formatLegacyLiveSelectionLabel(raw, {})).toBe('Next Corner: Home');
    expect(formatLegacyLiveSelectionLabel(raw, undefined)).toBe('Next Corner: Home');
  });

  it('falls back to a side encoded in the raw identifier when the relevant structured side field is absent', () => {
    const row = { eventName: 'Raptors - Sharks', marketType: 'NEXT_CORNER' };

    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_CORNER:1:AWAY', row, 'selected')).toBe('Next Corner: Sharks');
    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_CORNER:1:AWAY', row, 'winning')).toBe('Next Corner: Sharks');
  });

  it('falls back to a market type encoded in the raw identifier when row.marketType is absent', () => {
    const row = { eventName: 'Raptors - Sharks', side: 'HOME' };

    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_CORNER:1:HOME', row)).toBe('Next Corner: Raptors');
  });

  it('for the "selected" perspective (default, used for oddsName), uses the bettor\'s own row.side', () => {
    const row = { eventName: 'Raptors - Sharks', marketType: 'NEXT_CORNER', side: 'HOME', winningSide: 'AWAY' };

    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_CORNER:1:HOME', row, 'selected')).toBe('Next Corner: Raptors');
    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_CORNER:1:HOME', row)).toBe('Next Corner: Raptors');
  });

  it('for the "winning" perspective (used for winningSelection), prefers row.winningSide over the bettor\'s own row.side', () => {
    const row = { eventName: 'Raptors - Sharks', marketType: 'NEXT_CORNER', side: 'HOME', winningSide: 'AWAY' };

    // The raw text itself even encodes "HOME" (the bettor's own historical selection identifier),
    // but the authoritative winner is `row.winningSide` -- never `row.side` -- so the result must
    // still be the away team, not the home team.
    expect(formatLegacyLiveSelectionLabel('event-42:NEXT_CORNER:1:HOME', row, 'winning')).toBe('Next Corner: Sharks');
  });

  it('leaves malformed/unknown non-live values unchanged (no colon, or no recognizable segment)', () => {
    expect(formatLegacyLiveSelectionLabel('Over 2.5', {})).toBe('Over 2.5');
    expect(formatLegacyLiveSelectionLabel('12:30', {})).toBe('12:30');
    expect(formatLegacyLiveSelectionLabel('some:unrelated:value', {})).toBe('some:unrelated:value');
    expect(formatLegacyLiveSelectionLabel(undefined, {})).toBeUndefined();
    expect(formatLegacyLiveSelectionLabel(null, {})).toBeNull();
  });
});

describe('formatRowOutcome winning-selection normalization', () => {
  it('normalizes a raw stored winningSelection identifier for a WIN row', () => {
    const row = {
      status: SLIP_ROW_STATUS.WIN,
      eventName: 'Raptors - Sharks',
      marketType: 'NEXT_CORNER',
      side: 'HOME',
      winningSide: 'HOME',
      selectionId: 'home',
      winningSelection: 'event-42:NEXT_CORNER:1:HOME',
    };

    expect(formatRowOutcome(row)).toBe('Won · Winner: Next Corner: Raptors');
  });

  it('leaves an already-readable winningSelection unchanged for a LOSS row', () => {
    const row = {
      status: SLIP_ROW_STATUS.LOSS,
      winningSelection: 'Sharks',
    };

    expect(formatRowOutcome(row)).toBe('Lost · Winner: Sharks');
  });

  it('regression: reports the actual winning side, not the bettor\'s own selected side, on a LOSS row (selected HOME, winner AWAY)', () => {
    const row = {
      status: SLIP_ROW_STATUS.LOSS,
      eventName: 'Raptors - Sharks',
      marketType: 'NEXT_CORNER',
      side: 'HOME',
      winningSide: 'AWAY',
      selectionId: 'home',
      winningSelection: 'event-42:NEXT_CORNER:1:AWAY',
    };

    expect(formatRowOutcome(row)).toBe('Lost · Winner: Next Corner: Sharks');
  });

  it('regression: falls back to the side encoded in the raw winningSelection identifier when row.winningSide is absent (never using the bettor\'s own row.side)', () => {
    const row = {
      status: SLIP_ROW_STATUS.LOSS,
      eventName: 'Raptors - Sharks',
      marketType: 'NEXT_CORNER',
      side: 'HOME',
      selectionId: 'home',
      // winningSide intentionally omitted: only the raw identifier's own embedded side is
      // available, and it disagrees with the bettor's own `side` (HOME).
      winningSelection: 'event-42:NEXT_CORNER:1:AWAY',
    };

    expect(formatRowOutcome(row)).toBe('Lost · Winner: Next Corner: Sharks');
  });
});
