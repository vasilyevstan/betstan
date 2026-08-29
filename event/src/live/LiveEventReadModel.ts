import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  ILiveEventUpdateEvent,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  TeamSide,
} from "@betstan/common";
import { Event } from "../model/Event";
import { getPublicEventConfig } from "./config";

export interface PublicEventProductOdd {
  id: string;
  name: string;
  value: number;
}

export interface PublicEventProduct {
  id: string;
  type: string;
  name: string;
  odds: PublicEventProductOdd[];
}

export interface PublicLiveIncident {
  id?: string;
  relatedIncidentId?: string;
  type: LiveIncidentType;
  side?: TeamSide;
  occurredAt?: string;
  minute?: number;
  addedTime?: number;
}

export interface PublicLiveMarketSelection {
  selectionId: string;
  side: TeamSide;
  odds: number;
}

export interface PublicLiveMarket {
  marketId: string;
  marketType: LiveMarketType;
  marketVersion: number;
  quoteVersion: number;
  quoteValidUntil?: string;
  status: LiveMarketStatus;
  selections: PublicLiveMarketSelection[];
}

export interface PublicLiveSnapshot {
  sequence: number;
  minute: number;
  addedTime?: number;
  phase: EventPhase;
  homeScore: number;
  awayScore: number;
  bettingStatus: BettingStatus;
  incidentHistory: PublicLiveIncident[];
  currentMarkets: PublicLiveMarket[];
}

export interface PublicEventSnapshot {
  _id?: string;
  id: string;
  eventId: string;
  name: string;
  time: string;
  status: EventStatus;
  visibility: EventVisibility;
  products: PublicEventProduct[];
  home?: string;
  away?: string;
  live?: PublicLiveSnapshot;
}

type UnknownRecord = Record<string, unknown>;
type LiveUpdateIncident = NonNullable<ILiveEventUpdateEvent["data"]["incident"]>;
type LiveEventUpdateData = ILiveEventUpdateEvent["data"] & {
  incidents?: LiveUpdateIncident[];
};

const FALLBACK_EVENT_STATUS = EventStatus.NO_RESULT;
const FALLBACK_EVENT_VISIBILITY = EventVisibility.ONLINE;

const asString = (value: unknown): string | undefined => {
  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    (typeof value === "object" && value !== null && "toString" in value)
  ) {
    return String(value);
  }

  return undefined;
};

const toIsoString = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return undefined;
};

const deepFreeze = <T>(value: T): T => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const nestedValue of Object.values(value as UnknownRecord)) {
    if (nestedValue && typeof nestedValue === "object") {
      deepFreeze(nestedValue);
    }
  }

  return value;
};

const cloneProductOdds = (odds: PublicEventProductOdd[]): PublicEventProductOdd[] =>
  odds.map((odd) => ({
    id: odd.id,
    name: odd.name,
    value: odd.value,
  }));

const cloneProducts = (products: PublicEventProduct[]): PublicEventProduct[] =>
  products.map((product) => ({
    id: product.id,
    type: product.type,
    name: product.name,
    odds: cloneProductOdds(product.odds),
  }));

const cloneIncidentHistory = (
  incidents: PublicLiveIncident[]
): PublicLiveIncident[] =>
  incidents.map((incident) => ({
    ...(incident.id ? { id: incident.id } : {}),
    ...(incident.relatedIncidentId
      ? { relatedIncidentId: incident.relatedIncidentId }
      : {}),
    type: incident.type,
    ...(incident.side ? { side: incident.side } : {}),
    ...(incident.occurredAt ? { occurredAt: incident.occurredAt } : {}),
    ...(incident.minute !== undefined ? { minute: incident.minute } : {}),
    ...(incident.addedTime !== undefined
      ? { addedTime: incident.addedTime }
      : {}),
  }));

const cloneMarketSelections = (
  selections: PublicLiveMarketSelection[]
): PublicLiveMarketSelection[] =>
  selections.map((selection) => ({
    selectionId: selection.selectionId,
    side: selection.side,
    odds: selection.odds,
  }));

const cloneMarkets = (markets: PublicLiveMarket[]): PublicLiveMarket[] =>
  markets.map((market) => ({
    marketId: market.marketId,
    marketType: market.marketType,
    marketVersion: market.marketVersion,
    quoteVersion: market.quoteVersion,
    ...(market.quoteValidUntil
      ? { quoteValidUntil: market.quoteValidUntil }
      : {}),
    status: market.status,
    selections: cloneMarketSelections(market.selections),
  }));

const normalizeProducts = (products: unknown): PublicEventProduct[] => {
  if (!Array.isArray(products)) {
    return [];
  }

  return products
    .map((product) => {
      const productRecord =
        product && typeof product === "object" ? (product as UnknownRecord) : {};

      return {
        id: asString(productRecord.id) ?? "",
        type: asString(productRecord.type) ?? "",
        name: asString(productRecord.name) ?? "",
        odds: Array.isArray(productRecord.odds)
          ? productRecord.odds.map((odd) => {
              const oddRecord =
                odd && typeof odd === "object" ? (odd as UnknownRecord) : {};
              return {
                id: asString(oddRecord.id) ?? "",
                name: asString(oddRecord.name) ?? "",
                value:
                  typeof oddRecord.value === "number"
                    ? oddRecord.value
                    : Number(oddRecord.value),
              };
            })
          : [],
      };
    })
    .filter((product) => product.id && product.name);
};

const normalizeLiveIncident = (
  incident: unknown
): PublicLiveIncident | undefined => {
  if (!incident || typeof incident !== "object") {
    return undefined;
  }

  const incidentRecord = incident as UnknownRecord;

  return {
    id: asString(incidentRecord.id),
    relatedIncidentId: asString(incidentRecord.relatedIncidentId),
    type: incidentRecord.type as LiveIncidentType,
    side: incidentRecord.side as TeamSide | undefined,
    occurredAt: toIsoString(incidentRecord.occurredAt),
    minute:
      typeof incidentRecord.minute === "number"
        ? incidentRecord.minute
        : undefined,
    addedTime:
      typeof incidentRecord.addedTime === "number"
        ? incidentRecord.addedTime
        : undefined,
  };
};

const normalizeLiveSelection = (
  selection: unknown
): PublicLiveMarketSelection | undefined => {
  if (!selection || typeof selection !== "object") {
    return undefined;
  }

  const selectionRecord = selection as UnknownRecord;
  const selectionId = asString(selectionRecord.selectionId);
  if (!selectionId || typeof selectionRecord.odds !== "number") {
    return undefined;
  }

  return {
    selectionId,
    side: selectionRecord.side as TeamSide,
    odds: selectionRecord.odds,
  };
};

const normalizeLiveMarket = (
  market: unknown
): PublicLiveMarket | undefined => {
  if (!market || typeof market !== "object") {
    return undefined;
  }

  const marketRecord = market as UnknownRecord;
  const marketId = asString(marketRecord.marketId);
  const marketVersion =
    typeof marketRecord.marketVersion === "number"
      ? marketRecord.marketVersion
      : undefined;
  const quoteVersion =
    typeof marketRecord.quoteVersion === "number"
      ? marketRecord.quoteVersion
      : undefined;

  if (!marketId || marketVersion === undefined || quoteVersion === undefined) {
    return undefined;
  }

  return {
    marketId,
    marketType: marketRecord.marketType as LiveMarketType,
    marketVersion,
    quoteVersion,
    quoteValidUntil: toIsoString(marketRecord.quoteValidUntil),
    status: marketRecord.status as LiveMarketStatus,
    selections: Array.isArray(marketRecord.selections)
      ? marketRecord.selections
          .map(normalizeLiveSelection)
          .filter(
            (selection): selection is PublicLiveMarketSelection =>
              selection !== undefined
          )
      : [],
  };
};

const normalizeStoredLiveSnapshot = (
  liveState: unknown,
  maxIncidents: number,
  maxMarkets: number
): PublicLiveSnapshot | undefined => {
  if (!liveState || typeof liveState !== "object") {
    return undefined;
  }

  const liveRecord = liveState as UnknownRecord;
  if (typeof liveRecord.sequence !== "number") {
    return undefined;
  }

  return {
    sequence: liveRecord.sequence,
    minute: typeof liveRecord.minute === "number" ? liveRecord.minute : 0,
    addedTime:
      typeof liveRecord.addedTime === "number" ? liveRecord.addedTime : undefined,
    phase: liveRecord.phase as EventPhase,
    homeScore:
      typeof liveRecord.homeScore === "number" ? liveRecord.homeScore : 0,
    awayScore:
      typeof liveRecord.awayScore === "number" ? liveRecord.awayScore : 0,
    bettingStatus: liveRecord.bettingStatus as BettingStatus,
    incidentHistory: Array.isArray(liveRecord.incidentHistory)
      ? liveRecord.incidentHistory
          .map(normalizeLiveIncident)
          .filter(
            (incident): incident is PublicLiveIncident => incident !== undefined
          )
          .slice(-maxIncidents)
      : [],
    currentMarkets: Array.isArray(liveRecord.currentMarkets)
      ? liveRecord.currentMarkets
          .map(normalizeLiveMarket)
          .filter((market): market is PublicLiveMarket => market !== undefined)
          .slice(0, maxMarkets)
      : [],
  };
};

const buildEventName = (data: LiveEventUpdateData): string | undefined => {
  if (data.eventName && data.eventName.trim()) {
    return data.eventName.trim();
  }

  if (data.home && data.away) {
    return `${data.home} - ${data.away}`;
  }

  return undefined;
};

const buildIncomingIncident = (
  incident: ILiveEventUpdateEvent["data"]["incident"]
): PublicLiveIncident | undefined => {
  if (!incident) {
    return undefined;
  }

  return normalizeLiveIncident(incident);
};

const buildIncidentIdentity = (incident: PublicLiveIncident): string =>
  [
    incident.id ?? "",
    incident.relatedIncidentId ?? "",
    incident.type ?? "",
    incident.side ?? "",
    incident.occurredAt ?? "",
    incident.minute ?? "",
    incident.addedTime ?? "",
  ].join("|");

const dedupeIncidentHistory = (
  incidents: PublicLiveIncident[],
  maxIncidents: number
): PublicLiveIncident[] => {
  const seen = new Set<string>();
  const deduped: PublicLiveIncident[] = [];

  for (const incident of incidents) {
    const identity = buildIncidentIdentity(incident);
    if (seen.has(identity)) {
      continue;
    }

    seen.add(identity);
    deduped.push(incident);
  }

  return deduped.slice(-maxIncidents);
};

const buildIncomingIncidentHistory = (
  data: LiveEventUpdateData,
  maxIncidents: number,
  seedHistory: PublicLiveIncident[] = []
): PublicLiveIncident[] => {
  if (Array.isArray(data.incidents)) {
    return dedupeIncidentHistory(
      data.incidents
        .map(normalizeLiveIncident)
        .filter(
          (incident): incident is PublicLiveIncident => incident !== undefined
        ),
      maxIncidents
    );
  }

  const incident = buildIncomingIncident(data.incident);
  return incident
    ? dedupeIncidentHistory([...seedHistory, incident], maxIncidents)
    : dedupeIncidentHistory(seedHistory, maxIncidents);
};

const buildIncomingMarkets = (
  markets: ILiveEventUpdateEvent["data"]["markets"],
  maxMarkets: number
): PublicLiveMarket[] =>
  markets
    .map(normalizeLiveMarket)
    .filter((market): market is PublicLiveMarket => market !== undefined)
    .slice(0, maxMarkets);

const buildLiveUpdateFilter = (eventId: string, sequence: number) => ({
  eventId,
  $or: [
    { "live.sequence": { $exists: false } },
    { "live.sequence": { $lt: sequence } },
  ],
});

const buildLiveUpdateOperations = (
  event: ILiveEventUpdateEvent
): UnknownRecord => {
  const { maxIncidents, maxMarkets } = getPublicEventConfig();
  const data = event.data as LiveEventUpdateData;
  const kickoffAt = toIsoString(data.kickoffAt) ?? data.kickoffAt;
  const occurredAt = toIsoString(data.occurredAt) ?? data.occurredAt;
  const kickoffDate = new Date(kickoffAt);
  const eventName = buildEventName(data);
  const normalizedMarkets = buildIncomingMarkets(data.markets, maxMarkets);
  const normalizedIncidentHistory = buildIncomingIncidentHistory(
    data,
    maxIncidents
  );
  const normalizedIncident =
    Array.isArray(data.incidents) ? undefined : buildIncomingIncident(data.incident);

  const setOperations: UnknownRecord = {
    "live.sequence": data.sequence,
    "live.occurredAt": occurredAt,
    "live.kickoffAt": kickoffAt,
    "live.minute": data.minute,
    "live.phase": data.phase,
    "live.homeScore": data.homeScore,
    "live.awayScore": data.awayScore,
    "live.bettingStatus": data.bettingStatus,
    "live.currentMarkets": normalizedMarkets,
  };

  if (!Number.isNaN(kickoffDate.getTime())) {
    setOperations.time = kickoffDate;
  }
  if (eventName) {
    setOperations.name = eventName;
  }
  if (data.home) {
    setOperations.home = data.home;
  }
  if (data.away) {
    setOperations.away = data.away;
  }
  if (data.addedTime !== undefined) {
    setOperations["live.addedTime"] = data.addedTime;
  }

  const unsetOperations: UnknownRecord = {};
  if (data.addedTime === undefined) {
    unsetOperations["live.addedTime"] = 1;
  }

  if (Array.isArray(data.incidents)) {
    setOperations["live.incidentHistory"] = normalizedIncidentHistory;
  }

  const setOnInsertOperations: UnknownRecord = {
    eventId: data.eventId,
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.OFFLINE,
    visibilityInitialized: false,
    eventMetadataInitialized: false,
    products: [],
    source: "EXTERNAL",
    newEventPublishedAt: null,
    newEventPublishAttempts: 0,
    newEventPublishClaimedAt: null,
    newEventPublishClaimToken: null,
  };

  if (!eventName) {
    setOnInsertOperations.name = data.eventId;
  }
  if (Number.isNaN(kickoffDate.getTime())) {
    setOnInsertOperations.time = new Date();
  }
  if (!data.home) {
    delete setOnInsertOperations.home;
  }
  if (!data.away) {
    delete setOnInsertOperations.away;
  }

  const updateOperations: UnknownRecord = {
    $set: setOperations,
    $setOnInsert: setOnInsertOperations,
  };

  if (Object.keys(unsetOperations).length > 0) {
    updateOperations.$unset = unsetOperations;
  }

  if (normalizedIncident) {
    updateOperations.$push = {
      "live.incidentHistory": {
        $each: [normalizedIncident],
        $slice: -maxIncidents,
      },
    };
  }

  return updateOperations;
};

export const buildLiveEventId = (eventId: string, sequence: number): string =>
  `${eventId}:${sequence}`;

export const isLivePhase = (phase: EventPhase | undefined): boolean =>
  phase !== undefined &&
  phase !== EventPhase.PRE_MATCH &&
  phase !== EventPhase.FULL_TIME;

export const createPublicEventSnapshot = (
  eventDocument: UnknownRecord
): PublicEventSnapshot => {
  const eventId =
    asString(eventDocument.eventId) ??
    asString(eventDocument.id) ??
    asString(eventDocument._id) ??
    "";
  const { maxIncidents, maxMarkets } = getPublicEventConfig();
  const snapshot: PublicEventSnapshot = {
    id: eventId,
    eventId,
    name: asString(eventDocument.name) ?? "",
    time: toIsoString(eventDocument.time) ?? "",
    status: (eventDocument.status as EventStatus) ?? FALLBACK_EVENT_STATUS,
    visibility:
      (eventDocument.visibility as EventVisibility) ?? FALLBACK_EVENT_VISIBILITY,
    products: normalizeProducts(eventDocument.products),
  };

  const legacyId = asString(eventDocument._id);
  if (legacyId) {
    snapshot._id = legacyId;
  }
  const home = asString(eventDocument.home);
  if (home) {
    snapshot.home = home;
  }
  const away = asString(eventDocument.away);
  if (away) {
    snapshot.away = away;
  }

  const liveSnapshot = normalizeStoredLiveSnapshot(
    eventDocument.live,
    maxIncidents,
    maxMarkets
  );
  if (liveSnapshot) {
    snapshot.live = liveSnapshot;
  } else {
    delete snapshot.live;
  }

  return deepFreeze(snapshot);
};

export const sanitizePublicEventSnapshot = (
  eventDocument: unknown
): PublicEventSnapshot =>
  createPublicEventSnapshot(
    (eventDocument && typeof eventDocument === "object"
      ? eventDocument
      : {}) as UnknownRecord
  );

export const createPublicEventSnapshotFromLiveUpdate = (
  event: ILiveEventUpdateEvent,
  seedSnapshot?: PublicEventSnapshot
): PublicEventSnapshot => {
  const seedSequence = seedSnapshot?.live?.sequence;
  if (seedSequence !== undefined && seedSequence >= event.data.sequence) {
    return seedSnapshot as PublicEventSnapshot;
  }

  const { maxIncidents, maxMarkets } = getPublicEventConfig();
  const data = event.data as LiveEventUpdateData;
  const kickoffAt =
    toIsoString(data.kickoffAt) ??
    seedSnapshot?.time ??
    new Date().toISOString();
  const eventName = buildEventName(data) ?? seedSnapshot?.name ?? data.eventId;
  const incidentHistory = buildIncomingIncidentHistory(
    data,
    maxIncidents,
    [...(seedSnapshot?.live?.incidentHistory ?? [])]
  );

  const liveSnapshot: PublicLiveSnapshot = {
    sequence: data.sequence,
    minute: data.minute,
    phase: data.phase,
    homeScore: data.homeScore,
    awayScore: data.awayScore,
    bettingStatus: data.bettingStatus,
    incidentHistory: incidentHistory.slice(-maxIncidents),
    currentMarkets: buildIncomingMarkets(data.markets, maxMarkets),
  };

  if (data.addedTime !== undefined) {
    liveSnapshot.addedTime = data.addedTime;
  }

  const snapshot: PublicEventSnapshot = {
    ...(seedSnapshot?._id ? { _id: seedSnapshot._id } : {}),
    id: data.eventId,
    eventId: data.eventId,
    name: eventName,
    time: kickoffAt,
    status: seedSnapshot?.status ?? EventStatus.NO_RESULT,
    visibility: seedSnapshot?.visibility ?? EventVisibility.OFFLINE,
    products: cloneProducts(seedSnapshot?.products ?? []),
    live: liveSnapshot,
  };

  const home = data.home ?? seedSnapshot?.home;
  if (home) {
    snapshot.home = home;
  }
  const away = data.away ?? seedSnapshot?.away;
  if (away) {
    snapshot.away = away;
  }

  return sanitizePublicEventSnapshot(snapshot);
};

export const getStoredPublicEventSnapshot = async (
  eventId: string
): Promise<PublicEventSnapshot | undefined> => {
  const storedEvent = await Event.findOne({ eventId }).lean();
  return storedEvent
    ? createPublicEventSnapshot(storedEvent as unknown as UnknownRecord)
    : undefined;
};

const compareEventTimes = (left: PublicEventSnapshot, right: PublicEventSnapshot) =>
  Date.parse(left.time) - Date.parse(right.time);

export const listPublicEvents = async (
  now: Date = new Date(),
  visibleOfflineEventIds: string[] = []
): Promise<PublicEventSnapshot[]> => {
  const { historyMinutes, horizonMinutes } = getPublicEventConfig();
  const lowerBound = new Date(now.getTime() - historyMinutes * 60 * 1000);
  const upperBound = new Date(now.getTime() + horizonMinutes * 60 * 1000);

  const visibilityFilter =
    visibleOfflineEventIds.length > 0
      ? {
          $or: [
            { visibility: { $ne: EventVisibility.OFFLINE } },
            { eventId: { $in: visibleOfflineEventIds } },
          ],
        }
      : { visibility: { $ne: EventVisibility.OFFLINE } };
  // The single currently-retained finished (FULL_TIME) event's *only*
  // eligibility rule is the `liveRetiredAt` tombstone stamped by the next
  // event's own accepted T-10 PRE_MATCH handoff (see `applyLiveEventUpdate`)
  // -- never the generic kickoff-`time` history bound above, which would
  // otherwise silently drop it once its scheduled kickoff falls outside
  // `historyMinutes` even though nothing has retired it yet. Retention
  // guarantees at most one ONLINE, untombstoned FULL_TIME event exists at
  // any moment, so this clause stays inherently bounded to that single row
  // and a retired card (tombstoned, flipped OFFLINE) can never leak back
  // in through it.
  const retainedFinishedFilter = {
    visibility: EventVisibility.ONLINE,
    "live.phase": EventPhase.FULL_TIME,
    liveRetiredAt: null,
  };

  const events = await Event.find({
    $or: [
      { time: { $gte: lowerBound, $lte: upperBound }, ...visibilityFilter },
      retainedFinishedFilter,
    ],
  }).lean();

  return events
    .map((eventDocument) =>
      createPublicEventSnapshot(eventDocument as unknown as UnknownRecord)
    )
    .sort((left, right) => {
      const leftLive = isLivePhase(left.live?.phase);
      const rightLive = isLivePhase(right.live?.phase);

      if (leftLive !== rightLive) {
        return leftLive ? -1 : 1;
      }

      const timeComparison = compareEventTimes(left, right);
      if (timeComparison !== 0) {
        return timeComparison;
      }

      return left.eventId.localeCompare(right.eventId);
    });
};

export const applyLiveEventUpdate = async (
  event: ILiveEventUpdateEvent
): Promise<PublicEventSnapshot | null> => {
  const filter = buildLiveUpdateFilter(event.data.eventId, event.data.sequence);
  const updateOperations = buildLiveUpdateOperations(event);

  await Event.updateOne(
    { eventId: event.data.eventId, live: null },
    { $unset: { live: 1 } }
  );

  try {
    await Event.updateOne(filter, updateOperations, { upsert: true });
  } catch (err: any) {
    if (err?.code !== 11000) {
      throw err;
    }

    const retryUpdate = { ...updateOperations };
    delete retryUpdate.$setOnInsert;
    await Event.updateOne(filter, retryUpdate);
  }

  const currentEvent = await Event.findOne({ eventId: event.data.eventId }).lean();
  if (!currentEvent) {
    return null;
  }

  const currentRecord = currentEvent as unknown as UnknownRecord;

  // "Accepted" means this exact call's sequence is the one now stored --
  // i.e. the sequence gate above did not reject it as stale/duplicate.
  // Every side effect below must only run for an accepted update: a
  // delayed/duplicate message keeps the phase it originally carried (e.g.
  // PRE_MATCH) even after being rejected, so gating on `event.data.phase`
  // alone (without also requiring acceptance) would let a late, rejected
  // message for one event still mutate a *different* event's visibility.
  const liveRecord = currentRecord.live as UnknownRecord | undefined;
  const accepted = liveRecord?.sequence === event.data.sequence;

  if (accepted) {
    const wasIntentionallyRetired = Boolean(currentRecord.liveRetiredAt);
    const isRaceResulted = Boolean(currentRecord.liveRaceResultedAt);

    if (
      currentRecord.visibility === EventVisibility.OFFLINE &&
      currentRecord.status === EventStatus.RESULTED &&
      isRaceResulted &&
      !wasIntentionallyRetired
    ) {
      // Provenance-aware resurrection, gated on the explicit
      // `liveRaceResultedAt` marker `EventResultListener` stamps only for
      // the genuine "result arrived before any live projection" race
      // (never for an intentionally OFFLINE admin/acceptance-gated
      // fixture, which is never marked and so can never reach this
      // branch -- it stays OFFLINE and admin-gated regardless of any
      // live update). Since this is a genuine, accepted live update for
      // the same event, and it was never *intentionally* retired by a
      // newer event's PRE_MATCH handoff (no tombstone), restore
      // visibility so the live/eventually-FULL_TIME event is not
      // permanently hidden, consume the marker (reset to null so it can
      // never re-fire or linger stale), and -- unless this very update is
      // already the match's own FULL_TIME conclusion, which is a genuine
      // final result and must be preserved as-is -- reverse the
      // premature `status` back to NO_RESULT so the event is not treated
      // as resulted while it is actually about to be/being live-played.
      // The live pipeline (or its own later `EVENT_RESULT`) sets the real
      // final status when the match genuinely concludes.
      const restoreUpdate: UnknownRecord = {
        visibility: EventVisibility.ONLINE,
        liveRaceResultedAt: null,
      };
      if (event.data.phase !== EventPhase.FULL_TIME) {
        restoreUpdate.status = EventStatus.NO_RESULT;
      }

      await Event.updateOne(
        { eventId: event.data.eventId },
        { $set: restoreUpdate }
      );
      currentRecord.visibility = EventVisibility.ONLINE;
      currentRecord.liveRaceResultedAt = null;
      if (restoreUpdate.status) {
        currentRecord.status = restoreUpdate.status;
      }
    }

    if (event.data.phase === EventPhase.PRE_MATCH) {
      const kickoffAt = toIsoString(event.data.kickoffAt) ?? event.data.kickoffAt;
      const kickoffDate = new Date(kickoffAt);

      if (!Number.isNaN(kickoffDate.getTime())) {
        // A new event's T-10 pre-kickoff snapshot becoming authoritative
        // is the handoff point that retires any previously retained
        // finished live event: `EventResultListener` keeps a completed
        // live-simulated event ONLINE (with its FULL_TIME snapshot) so it
        // survives refresh/reconnect, but retention is bounded to at most
        // one such event at a time, so it must be hidden again the
        // moment the next event's own countdown becomes authoritative.
        // Scoped to events strictly *older* (by scheduled kickoff time)
        // than this one, never "every other event" -- an out-of-order
        // arriving PRE_MATCH for a chronologically older fixture must
        // never retire a genuinely newer retained event. `eventId: { $ne
        // }` guarantees this never retires the event whose own PRE_MATCH
        // snapshot just landed (including on a restart replaying the
        // same snapshot). `liveRetiredAt` is stamped as the permanent
        // tombstone: late/duplicate updates for the retired event must
        // never resurrect it (see the resurrection branch above).
        await Event.updateMany(
          {
            eventId: { $ne: event.data.eventId },
            visibility: EventVisibility.ONLINE,
            "live.phase": EventPhase.FULL_TIME,
            time: { $lt: kickoffDate },
          },
          {
            $set: {
              visibility: EventVisibility.OFFLINE,
              liveRetiredAt: new Date(),
            },
          }
        );
      }
    }
  }

  if (!accepted) {
    return null;
  }

  return createPublicEventSnapshot(currentRecord);
};
