import {
  COUNTDOWN_LIVE_MARKET_TYPE,
  COUNTDOWN_WINDOW_MS,
  formatCountdownDuration,
  getMarketAvailabilityLabel,
  getMarketSelectionLabel,
  getScheduledKickoffTime,
  isCountdownMarketType,
  isFinishedLiveEvent,
  isInCountdownWindow,
  isLiveMarketSelectable,
  LIVE_MARKET_STATUS,
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
