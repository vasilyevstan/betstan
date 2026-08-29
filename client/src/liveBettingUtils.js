export const BET_KIND = Object.freeze({
  PRE_MATCH: 'PRE_MATCH',
  LIVE: 'LIVE',
});

export const LIVE_MARKET_STATUS = Object.freeze({
  OPEN: 'OPEN',
  SUSPENDED: 'SUSPENDED',
  SETTLED: 'SETTLED',
  CLOSED: 'CLOSED',
});

export const BET_STATUS = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  DECLINED: 'DECLINED',
  WIN: 'WIN',
  LOSS: 'LOSS',
  VOID: 'VOID',
});

export const SLIP_ROW_STATUS = Object.freeze({
  NOT_SETTLED: 'NOT_SETTLED',
  WIN: 'WIN',
  LOSS: 'LOSS',
  VOID: 'VOID',
});

/**
 * Live-slip-only markets that the server may open ahead of actual kickoff,
 * during the T-10 pre-kickoff countdown window. They are ordinary entries in
 * `event.live.currentMarkets`/quote-selection payloads (same market/selection
 * shape and `/api/event/odds` live routing as any other live market); only
 * their `marketType` and eligibility window are special. Keeping these IDs as
 * named constants documents the exact contract the client depends on.
 */
export const COUNTDOWN_LIVE_MARKET_TYPE = Object.freeze({
  KICKOFF_TEAM: 'KICKOFF_TEAM',
  FIRST_MINUTE_GOAL: 'FIRST_MINUTE_GOAL',
});

const COUNTDOWN_LIVE_MARKET_TYPES = new Set(Object.values(COUNTDOWN_LIVE_MARKET_TYPE));

/** Selections for a yes/no countdown market (e.g. first-minute goal) are identified by `selectionId` since `TeamSide` has no yes/no value. */
const YES_NO_SELECTION_LABELS = Object.freeze({
  yes: 'Yes',
  no: 'No',
});

/** Inclusive lead time before scheduled kickoff during which an event surfaces in the live area with a countdown. */
export const COUNTDOWN_WINDOW_MS = 10 * 60 * 1000;

const EVENT_PHASE_LABELS = Object.freeze({
  PRE_MATCH: 'Pre-match',
  FIRST_HALF: 'First half',
  FIRST_HALF_STOPPAGE: 'First-half added time',
  HALF_TIME: 'Half-time',
  SECOND_HALF: 'Second half',
  SECOND_HALF_STOPPAGE: 'Second-half added time',
  FULL_TIME: 'Full-time',
});

const LIVE_MARKET_LABELS = Object.freeze({
  NEXT_YELLOW_CARD: 'Next Yellow Card',
  NEXT_RED_CARD: 'Next Red Card',
  NEXT_CORNER: 'Next Corner',
  NEXT_PENALTY: 'Next Penalty',
  HALF_TIME_RESULT: 'Half Time Result',
  KICKOFF_TEAM: 'Kickoff Team',
  FIRST_MINUTE_GOAL: 'Goal in First Minute',
});

const DECLINE_REASON_LABELS = Object.freeze({
  MIXED_BET_KINDS: 'Mixed bet kinds',
  EVENT_STARTED: 'Event already started',
  EVENT_NOT_LIVE: 'Event is not live',
  MARKET_SUSPENDED: 'Market suspended',
  MARKET_CLOSED: 'Market closed',
  STALE_QUOTE: 'Quote changed',
  INVALID_SELECTION: 'Selection no longer exists',
  EVENT_RESULTED: 'Event already resulted',
});

const SETTLEMENT_REASON_LABELS = Object.freeze({
  INCIDENT: 'Settled by incident',
  HALF_TIME: 'Settled at half-time',
  FULL_TIME_NONE: 'No deciding outcome at full-time',
  MANUAL_VOID: 'Manual void',
  ACCUMULATOR_SETTLED: 'Accumulator settled',
});

const INCIDENT_LABELS = Object.freeze({
  GOAL: 'Goal',
  YELLOW_CARD: 'Yellow card',
  RED_CARD: 'Red card',
  FREE_KICK: 'Notable free kick',
  CORNER: 'Corner',
  PENALTY_AWARDED: 'Penalty awarded',
  PENALTY_SCORED: 'Penalty scored',
  PENALTY_MISSED: 'Penalty missed',
  ADDED_TIME_ANNOUNCED: 'Added time',
});

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');

const compareTime = (left, right) => {
  const leftTime = Date.parse(left?.time ?? '');
  const rightTime = Date.parse(right?.time ?? '');
  const safeLeft = Number.isNaN(leftTime) ? Number.MAX_SAFE_INTEGER : leftTime;
  const safeRight = Number.isNaN(rightTime) ? Number.MAX_SAFE_INTEGER : rightTime;
  return safeLeft - safeRight;
};

export const normalizeBetKind = (betKind) => (
  betKind === BET_KIND.LIVE ? BET_KIND.LIVE : BET_KIND.PRE_MATCH
);

export const getBetKindLabel = (betKind) => (
  normalizeBetKind(betKind) === BET_KIND.LIVE ? 'Live' : 'Pre-match'
);

export const isLivePhase = (phase) => (
  typeof phase === 'string' && phase !== 'PRE_MATCH' && phase !== 'FULL_TIME'
);

export const isLiveEvent = (event) => isLivePhase(event?.live?.phase);

export const getLiveSequence = (event) => (
  typeof event?.live?.sequence === 'number' ? event.live.sequence : null
);

export const isFinishedLiveEvent = (event) => event?.live?.phase === 'FULL_TIME';

export const isCountdownMarketType = (marketType) => COUNTDOWN_LIVE_MARKET_TYPES.has(marketType);

/** Scheduled kickoff falls back to `event.time` so the countdown window works even before any `live` snapshot exists. */
export const getScheduledKickoffTime = (event) => {
  const rawKickoff = event?.live?.kickoffAt ?? event?.time;
  const parsedKickoff = Date.parse(rawKickoff ?? '');
  return Number.isNaN(parsedKickoff) ? null : parsedKickoff;
};

/**
 * True from T-10 (inclusive) up until the server authoritatively marks the event
 * as live (`isLiveEvent`) or resulted/finished. This purely schedules *where* an
 * event is displayed; it must never be used to gate bet placement, which relies
 * on authoritative market/event fields (see `isLiveMarketSelectable`).
 */
export const isInCountdownWindow = (event, now = Date.now()) => {
  if (isLiveEvent(event) || isFinishedLiveEvent(event) || event?.status === 'RESULTED') {
    return false;
  }

  const kickoffTime = getScheduledKickoffTime(event);
  if (kickoffTime === null) {
    return false;
  }

  return now >= kickoffTime - COUNTDOWN_WINDOW_MS;
};

export const sortEvents = (events) => [...(Array.isArray(events) ? events : [])].sort((left, right) => {
  const leftLive = isLiveEvent(left);
  const rightLive = isLiveEvent(right);

  if (leftLive !== rightLive) {
    return leftLive ? -1 : 1;
  }

  const timeDifference = compareTime(left, right);
  if (timeDifference !== 0) {
    return timeDifference;
  }

  return normalizeText(left?.eventId).localeCompare(normalizeText(right?.eventId));
});

export const shouldReplaceEvent = (currentEvent, nextEvent) => {
  if (!currentEvent) {
    return true;
  }

  const currentSequence = getLiveSequence(currentEvent);
  const nextSequence = getLiveSequence(nextEvent);

  if (nextSequence !== null) {
    if (currentSequence === null) {
      return true;
    }

    return nextSequence > currentSequence;
  }

  if (currentSequence !== null) {
    return false;
  }

  return true;
};

/**
 * Authoritative-source counterpart of `shouldReplaceEvent`, used only for
 * merging a fresh REST snapshot (a direct, fully-consistent read of the
 * server's current projection -- see `listPublicEvents`). Server-side
 * recovery (e.g. reversing a premature RESULTED/OFFLINE state once a race
 * is reconciled -- see `applyLiveEventUpdate`) can settle non-sequence
 * metadata (`status`, `visibility`) *after* the SSE broadcast for that same
 * live sequence has already reached the client (the per-pod SSE broadcaster
 * and the durable projection writer are independent listeners with no
 * ordering guarantee between them). `shouldReplaceEvent`'s strict `>` would
 * then permanently ignore every later authoritative REST read at that same
 * sequence, leaving the client stuck on the stale snapshot until the live
 * sequence itself advances. Accepting an *equal* sequence here is safe: an
 * authoritative REST read can never move sequence backwards, so this can
 * only ever repair stale metadata at the same point in the timeline, never
 * regress it.
 */
export const shouldReplaceEventFromAuthoritativeSource = (currentEvent, nextEvent) => {
  if (!currentEvent) {
    return true;
  }

  const currentSequence = getLiveSequence(currentEvent);
  const nextSequence = getLiveSequence(nextEvent);

  if (nextSequence !== null) {
    if (currentSequence === null) {
      return true;
    }

    return nextSequence >= currentSequence;
  }

  if (currentSequence !== null) {
    return false;
  }

  return true;
};

export const applyLiveSnapshotUpdate = (currentEvents, nextEvent) => {
  const existingEvents = Array.isArray(currentEvents) ? currentEvents : [];
  const eventId = normalizeText(nextEvent?.eventId);

  if (!eventId) {
    return {
      changed: false,
      hasGap: false,
      events: sortEvents(existingEvents),
    };
  }

  const currentIndex = existingEvents.findIndex((candidate) => candidate?.eventId === eventId);
  const currentEvent = currentIndex >= 0 ? existingEvents[currentIndex] : null;
  const currentSequence = getLiveSequence(currentEvent);
  const nextSequence = getLiveSequence(nextEvent);

  const hasGap = (
    currentSequence !== null
    && nextSequence !== null
    && nextSequence > currentSequence + 1
  );

  if (!shouldReplaceEvent(currentEvent, nextEvent)) {
    return {
      changed: false,
      hasGap,
      events: sortEvents(existingEvents),
    };
  }

  const nextEvents = [...existingEvents];
  if (currentIndex >= 0) {
    nextEvents[currentIndex] = nextEvent;
  } else {
    nextEvents.push(nextEvent);
  }

  return {
    changed: true,
    hasGap,
    events: sortEvents(nextEvents),
  };
};

export const mergeAuthoritativeEventList = (currentEvents, nextEvents) => {
  const currentById = new Map((Array.isArray(currentEvents) ? currentEvents : [])
    .filter((event) => normalizeText(event?.eventId))
    .map((event) => [event.eventId, event]));

  const merged = (Array.isArray(nextEvents) ? nextEvents : [])
    .filter((event) => normalizeText(event?.eventId))
    .map((event) => {
      const currentEvent = currentById.get(event.eventId);
      return shouldReplaceEventFromAuthoritativeSource(currentEvent, event)
        ? event
        : currentEvent;
    })
    .filter(Boolean);

  return sortEvents(merged);
};

export const getPreMatchSelectionKey = ({ eventId, productId, oddsId }) => {
  if (!normalizeText(eventId) || !normalizeText(productId) || !normalizeText(oddsId)) {
    return null;
  }

  return `${BET_KIND.PRE_MATCH}:${eventId}:${productId}:${oddsId}`;
};

export const getLiveSelectionKey = ({ eventId, marketId, marketVersion, selectionId }) => {
  if (
    !normalizeText(eventId)
    || !normalizeText(marketId)
    || typeof marketVersion !== 'number'
    || !normalizeText(selectionId)
  ) {
    return null;
  }

  return `${BET_KIND.LIVE}:${eventId}:${marketId}:${marketVersion}:${selectionId}`;
};

export const getSelectionKeyFromSlipRow = (row, fallbackBetKind) => {
  const betKind = normalizeBetKind(row?.betKind ?? fallbackBetKind);

  if (betKind === BET_KIND.LIVE) {
    return getLiveSelectionKey({
      eventId: row?.eventId,
      marketId: row?.marketId,
      marketVersion: row?.marketVersion,
      selectionId: row?.selectionId,
    });
  }

  return getPreMatchSelectionKey({
    eventId: row?.eventId,
    productId: row?.productId,
    oddsId: row?.oddsId,
  });
};

export const extractSelectionKeysFromBoards = (boards) => {
  const keys = new Set();

  Object.values(boards ?? {}).forEach((board) => {
    (board?.rows ?? []).forEach((row) => {
      const selectionKey = getSelectionKeyFromSlipRow(row, board?.betKind);
      if (selectionKey) {
        keys.add(selectionKey);
      }
    });
  });

  return keys;
};

export const getPhaseLabel = (phase) => (
  EVENT_PHASE_LABELS[phase] ?? normalizeText(phase).replace(/_/g, ' ').toLowerCase()
);

export const formatMinute = (minute, addedTime) => {
  const safeMinute = Number.isFinite(minute) ? Math.max(0, Math.trunc(minute)) : 0;
  if (Number.isFinite(addedTime) && addedTime > 0) {
    return `${safeMinute}+${Math.trunc(addedTime)}'`;
  }

  return `${safeMinute}'`;
};

/** Formats the remaining milliseconds to kickoff as a clamped `mm:ss` string, never negative. */
export const formatCountdownDuration = (remainingMs) => {
  const safeRemainingMs = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0;
  const totalSeconds = Math.floor(safeRemainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

export const getMatchProgressValue = (liveState) => {
  if (!liveState) {
    return 0;
  }

  const minute = Number.isFinite(liveState.minute) ? liveState.minute : 0;
  const addedTime = Number.isFinite(liveState.addedTime) ? liveState.addedTime : 0;
  const totalMinutes = Math.min(100, Math.max(0, minute + addedTime));

  return Math.round((totalMinutes / 100) * 100);
};

export const getSideLabel = (side, event) => {
  if (side === 'HOME') {
    return normalizeText(event?.home) || 'Home';
  }
  if (side === 'AWAY') {
    return normalizeText(event?.away) || 'Away';
  }
  if (side === 'DRAW') {
    return 'Draw';
  }
  if (side === 'NONE') {
    return 'None';
  }
  // TeamSide.YES/NO back the first-minute-goal countdown market's selections.
  if (side === 'YES') {
    return 'Yes';
  }
  if (side === 'NO') {
    return 'No';
  }
  return '';
};

export const formatIncident = (incident, event) => {
  const type = incident?.type;
  if (!INCIDENT_LABELS[type]) {
    return null;
  }

  if (type === 'ADDED_TIME_ANNOUNCED') {
    const addedTime = Number.isFinite(incident?.addedTime) ? incident.addedTime : null;
    return addedTime === null ? 'Added time announced' : `Added time +${addedTime}`;
  }

  const sideLabel = getSideLabel(incident?.side, event);
  const minute = formatMinute(incident?.minute, incident?.addedTime);
  const label = INCIDENT_LABELS[type];

  return sideLabel ? `${minute} ${sideLabel} ${label.toLowerCase()}` : `${minute} ${label}`;
};

export const formatDeclineReason = (reason) => (
  DECLINE_REASON_LABELS[reason] ?? normalizeText(reason).replace(/_/g, ' ').toLowerCase()
);

export const formatLiveMarketType = (marketType) => (
  LIVE_MARKET_LABELS[marketType] ?? normalizeText(marketType).replace(/_/g, ' ').toLowerCase()
);

export const formatMarketStatus = (status) => (
  status === LIVE_MARKET_STATUS.OPEN ? 'Open' : normalizeText(status).replace(/_/g, ' ').toLowerCase()
);

export const isMarketStale = (market, now = Date.now()) => {
  const expiresAt = normalizeText(market?.quoteValidUntil);
  if (!expiresAt) {
    return true;
  }

  const expirationTime = Date.parse(expiresAt);
  if (Number.isNaN(expirationTime)) {
    return true;
  }

  return expirationTime <= now;
};

/**
 * Authoritative selectability for both in-play live markets and the two
 * countdown-only live-slip markets. The countdown markets reuse the exact
 * same gating fields (`bettingStatus`, `market.status`, `quoteValidUntil`) as
 * any other live market; only their eligibility window differs (T-10 through
 * kickoff instead of in-play). This means the server's `status`/`quoteValidUntil`
 * transition at kickoff is what closes them out, never the client clock alone.
 */
export const isLiveMarketSelectable = (event, market, now = Date.now()) => {
  const isCountdownEligible = isCountdownMarketType(market?.marketType) && isInCountdownWindow(event, now);

  return (
    (isLiveEvent(event) || isCountdownEligible)
    && event?.live?.bettingStatus === 'OPEN'
    && market?.status === LIVE_MARKET_STATUS.OPEN
    && !isMarketStale(market, now)
  );
};

/**
 * Resolves a selection's display label. `ILiveMarketSelection.side` (a
 * `TeamSide`, including the `YES`/`NO` values backing the first-minute-goal
 * countdown market) is the authoritative, required field and is checked
 * first via the shared `getSideLabel` helper used by every other market. An
 * optional server-supplied `label` takes precedence if present, and a
 * `selectionId`-based yes/no fallback covers the unlikely case where `side`
 * is missing or unrecognized.
 */
export const getMarketSelectionLabel = (market, selection, event) => {
  const explicitLabel = normalizeText(selection?.label);
  if (explicitLabel) {
    return explicitLabel;
  }

  const sideLabel = getSideLabel(selection?.side, event);
  if (sideLabel) {
    return sideLabel;
  }

  if (market?.marketType === COUNTDOWN_LIVE_MARKET_TYPE.FIRST_MINUTE_GOAL) {
    const normalizedSelectionId = normalizeText(selection?.selectionId).toLowerCase();
    if (YES_NO_SELECTION_LABELS[normalizedSelectionId]) {
      return YES_NO_SELECTION_LABELS[normalizedSelectionId];
    }
  }

  return '';
};

export const buildLiveMarketButtonLabel = (event, market, selection) => {
  const marketLabel = formatLiveMarketType(market?.marketType);
  const selectionLabel = getMarketSelectionLabel(market, selection, event) || 'Selection';
  return `Select ${marketLabel}: ${selectionLabel} at ${selection?.odds}`;
};

export const formatSettlementReason = (settlementReason) => (
  SETTLEMENT_REASON_LABELS[settlementReason]
  ?? normalizeText(settlementReason).replace(/_/g, ' ').toLowerCase()
);

export const formatRowOutcome = (row) => {
  if (row?.status === SLIP_ROW_STATUS.NOT_SETTLED) {
    return 'Pending result';
  }

  if (row?.status === SLIP_ROW_STATUS.VOID && row?.settlementReason) {
    return `Void · ${formatSettlementReason(row.settlementReason)}`;
  }

  if ((row?.status === SLIP_ROW_STATUS.WIN || row?.status === SLIP_ROW_STATUS.LOSS) && normalizeText(row?.winningSelection)) {
    return `${row.status === SLIP_ROW_STATUS.WIN ? 'Won' : 'Lost'} · Winner: ${row.winningSelection}`;
  }

  if (row?.status === SLIP_ROW_STATUS.WIN) {
    return 'Won';
  }

  if (row?.status === SLIP_ROW_STATUS.LOSS) {
    return 'Lost';
  }

  if (row?.status === SLIP_ROW_STATUS.VOID) {
    return 'Void';
  }

  return normalizeText(row?.status).replace(/_/g, ' ').toLowerCase();
};

export const getMarketAvailabilityLabel = (event, market, now = Date.now()) => {
  const isCountdownMarket = isCountdownMarketType(market?.marketType);
  const isCountdownActive = isCountdownMarket && isInCountdownWindow(event, now);

  if (!isLiveEvent(event) && !isCountdownActive) {
    return isCountdownMarket ? 'Opens during the kickoff countdown' : 'Live markets open in-play only';
  }

  if (event?.live?.bettingStatus !== 'OPEN') {
    return 'Event betting unavailable';
  }

  if (market?.status === LIVE_MARKET_STATUS.SUSPENDED) {
    return 'Temporarily suspended';
  }

  if (market?.status === LIVE_MARKET_STATUS.CLOSED) {
    return 'Closed';
  }

  if (market?.status === LIVE_MARKET_STATUS.SETTLED) {
    return 'Settled';
  }

  if (isMarketStale(market)) {
    return 'Quote expired';
  }

  return 'Open';
};
