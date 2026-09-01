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
import {
  LiveIncidentType as CompatibleLiveIncidentType,
  TeamSide as CompatibleTeamSide,
} from "../compat/LiveContract";
import { ProductType } from "../data/product/ProductType";
import { Event } from "../model/Event";
import {
  buildHasOfflineIntentExpression,
  buildHasUnresolvedVisibilityAuthorityExpression,
} from "../model/visibilityAuthorityExpressions";
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
  incidentHistoryComplete?: boolean;
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
  incidentsComplete?: boolean;
};

const FALLBACK_EVENT_STATUS = EventStatus.NO_RESULT;
const FALLBACK_EVENT_VISIBILITY = EventVisibility.ONLINE;
const FULL_TIME_INCIDENT_HISTORY_FLOOR = 128;
const NUMERIC_SCORELINE_PATTERN = /^(\d+)\s*-\s*(\d+)$/;
const VALID_INCIDENT_TYPES = new Set<string>(
  Object.values(CompatibleLiveIncidentType)
);
const VALID_INCIDENT_SIDES = new Set<string>(
  Object.values(CompatibleTeamSide)
);

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

const parseNumericScoreline = (
  name: string
): { homeGoals: number; awayGoals: number } | undefined => {
  const match = name.match(NUMERIC_SCORELINE_PATTERN);
  if (!match) {
    return undefined;
  }

  return {
    homeGoals: Number(match[1]),
    awayGoals: Number(match[2]),
  };
};

const sortPublicProductOdds = (
  productType: string,
  odds: PublicEventProductOdd[]
): PublicEventProductOdd[] => {
  if (productType !== ProductType.CORRECT_SCORE) {
    return odds;
  }

  const parsedScorelines = odds.map((odd) => parseNumericScoreline(odd.name));
  if (parsedScorelines.some((parsed) => parsed === undefined)) {
    return odds;
  }

  return odds
    .map((odd, index) => ({
      odd,
      scoreline: parsedScorelines[index]!,
    }))
    .sort((left, right) => {
      const homeComparison =
        left.scoreline.homeGoals - right.scoreline.homeGoals;
      return homeComparison !== 0
        ? homeComparison
        : left.scoreline.awayGoals - right.scoreline.awayGoals;
    })
    .map(({ odd }) => odd);
};

const cloneProductOdds = (
  productType: string,
  odds: PublicEventProductOdd[]
): PublicEventProductOdd[] =>
  sortPublicProductOdds(
    productType,
    odds.map((odd) => ({
      id: odd.id,
      name: odd.name,
      value: odd.value,
    }))
  );

const cloneProducts = (products: PublicEventProduct[]): PublicEventProduct[] =>
  products.map((product) => ({
    id: product.id,
    type: product.type,
    name: product.name,
    odds: cloneProductOdds(product.type, product.odds),
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
      const type = asString(productRecord.type) ?? "";

      return {
        id: asString(productRecord.id) ?? "",
        type,
        name: asString(productRecord.name) ?? "",
        odds: sortPublicProductOdds(
          type,
          Array.isArray(productRecord.odds)
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
            : []
        ),
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

interface NormalizedIncidentResult {
  incident?: PublicLiveIncident;
  valid: boolean;
}

interface IncidentProjection {
  incidentHistory: PublicLiveIncident[];
  incidentHistoryComplete?: boolean;
}

const isOptionalStringLike = (value: unknown): boolean =>
  value === undefined || value === null || asString(value) !== undefined;

const isOptionalNumber = (value: unknown): boolean =>
  value === undefined || value === null || typeof value === "number";

const isOptionalDateLike = (value: unknown): boolean =>
  value === undefined
  || value === null
  || typeof value === "string"
  || value instanceof Date;

const isOptionalIncidentSide = (value: unknown): boolean =>
  value === undefined
  || value === null
  || (
    typeof value === "string"
    && VALID_INCIDENT_SIDES.has(value)
  );

const normalizeLiveIncidentResult = (
  incident: unknown
): NormalizedIncidentResult => {
  if (!incident || typeof incident !== "object") {
    return { valid: false };
  }

  const incidentRecord = incident as UnknownRecord;
  const normalizedIncident = normalizeLiveIncident(incident);
  const valid =
    normalizedIncident !== undefined
    && typeof incidentRecord.type === "string"
    && VALID_INCIDENT_TYPES.has(incidentRecord.type)
    && isOptionalIncidentSide(incidentRecord.side)
    && isOptionalDateLike(incidentRecord.occurredAt)
    && isOptionalNumber(incidentRecord.minute)
    && isOptionalNumber(incidentRecord.addedTime)
    && isOptionalStringLike(incidentRecord.id)
    && isOptionalStringLike(incidentRecord.relatedIncidentId);

  return normalizedIncident
    ? { incident: normalizedIncident, valid }
    : { valid: false };
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

  const incidentProjection = projectIncidentHistory({
    phase: liveRecord.phase as EventPhase | undefined,
    maxIncidents,
    incidents: Array.isArray(liveRecord.incidentHistory)
      ? liveRecord.incidentHistory
      : undefined,
    incidentsComplete: liveRecord.incidentHistoryComplete === true,
  });

  const snapshot: PublicLiveSnapshot = {
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
    incidentHistory: incidentProjection.incidentHistory,
    currentMarkets: Array.isArray(liveRecord.currentMarkets)
      ? liveRecord.currentMarkets
          .map(normalizeLiveMarket)
          .filter((market): market is PublicLiveMarket => market !== undefined)
          .slice(0, maxMarkets)
      : [],
  };

  if (incidentProjection.incidentHistoryComplete) {
    snapshot.incidentHistoryComplete = true;
  }

  return snapshot;
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

  return normalizeLiveIncidentResult(incident).incident;
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
  incidents: PublicLiveIncident[]
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

  return deduped;
};

const buildIncidentHistoryLimit = (
  phase: EventPhase | undefined,
  maxIncidents: number,
  hasCumulativeHistory: boolean
): number =>
  hasCumulativeHistory && phase === EventPhase.FULL_TIME
    ? Math.max(maxIncidents, FULL_TIME_INCIDENT_HISTORY_FLOOR)
    : maxIncidents;

const projectIncidentHistory = ({
  phase,
  maxIncidents,
  incidents,
  incident,
  seedHistory = [],
  incidentsComplete,
}: {
  phase: EventPhase | undefined;
  maxIncidents: number;
  incidents?: unknown;
  incident?: ILiveEventUpdateEvent["data"]["incident"];
  seedHistory?: PublicLiveIncident[];
  incidentsComplete?: boolean;
}): IncidentProjection => {
  const hasCumulativeHistory = Array.isArray(incidents);
  const limit = buildIncidentHistoryLimit(
    phase,
    maxIncidents,
    hasCumulativeHistory
  );

  if (hasCumulativeHistory) {
    let allIncidentsValid = true;
    const normalizedIncidents = incidents.reduce<PublicLiveIncident[]>(
      (collection, rawIncident) => {
        const normalizedIncident = normalizeLiveIncidentResult(rawIncident);
        allIncidentsValid = allIncidentsValid && normalizedIncident.valid;
        if (normalizedIncident.incident) {
          collection.push(normalizedIncident.incident);
        }

        return collection;
      },
      []
    );
    const dedupedIncidents = dedupeIncidentHistory(normalizedIncidents);
    const incidentHistory = dedupedIncidents.slice(-limit);

    return {
      incidentHistory,
      ...(phase === EventPhase.FULL_TIME
        && incidentsComplete === true
        && allIncidentsValid
        && dedupedIncidents.length <= limit
        ? { incidentHistoryComplete: true }
        : {}),
    };
  }

  const currentIncident = buildIncomingIncident(incident);
  const dedupedHistory = dedupeIncidentHistory(
    currentIncident ? [...seedHistory, currentIncident] : seedHistory
  );

  return {
    incidentHistory: dedupedHistory.slice(-limit),
  };
};

const buildIncomingMarkets = (
  markets: ILiveEventUpdateEvent["data"]["markets"],
  maxMarkets: number
): PublicLiveMarket[] =>
  markets
    .map(normalizeLiveMarket)
    .filter((market): market is PublicLiveMarket => market !== undefined)
    .slice(0, maxMarkets);

const buildLiveUpdateFilter = (eventId: string, sequence: number): UnknownRecord => ({
  eventId,
  $or: [
    { "live.sequence": { $exists: false } },
    { "live.sequence": { $lt: sequence } },
  ],
});

const buildTerminalRaceRecoveryPipeline = (): UnknownRecord[] => [
  {
    $set: {
      visibility: {
        $let: {
          vars: {
            isFullTime: { $eq: ["$live.phase", EventPhase.FULL_TIME] },
            isRetired: {
              $ne: [{ $ifNull: ["$liveRetiredAt", null] }, null],
            },
            hasOfflineIntent: buildHasOfflineIntentExpression(),
            hasUnresolvedVisibilityAuthority:
              buildHasUnresolvedVisibilityAuthorityExpression(),
          },
          in: {
            $cond: [
              { $eq: ["$$isFullTime", false] },
              "$visibility",
              {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$$isRetired", false] },
                      { $eq: ["$$hasOfflineIntent", false] },
                      {
                        $eq: [
                          "$$hasUnresolvedVisibilityAuthority",
                          false,
                        ],
                      },
                    ],
                  },
                  EventVisibility.ONLINE,
                  EventVisibility.OFFLINE,
                ],
              },
            ],
          },
        },
      },
      liveRaceResultedAt: {
        $cond: [
          { $eq: ["$live.phase", EventPhase.FULL_TIME] },
          null,
          "$liveRaceResultedAt",
        ],
      },
    },
  },
];

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
  const incidentProjection = projectIncidentHistory({
    phase: data.phase,
    maxIncidents,
    incidents: data.incidents,
    incident: data.incident,
    incidentsComplete: data.incidentsComplete,
  });
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
  unsetOperations["live.incidentHistoryComplete"] = 1;

  if (Array.isArray(data.incidents)) {
    setOperations["live.incidentHistory"] = incidentProjection.incidentHistory;
    if (incidentProjection.incidentHistoryComplete) {
      setOperations["live.incidentHistoryComplete"] = true;
      delete unsetOperations["live.incidentHistoryComplete"];
    }
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
  const incidentProjection = projectIncidentHistory({
    phase: data.phase,
    maxIncidents,
    incidents: data.incidents,
    incident: data.incident,
    seedHistory: cloneIncidentHistory(seedSnapshot?.live?.incidentHistory ?? []),
    incidentsComplete: data.incidentsComplete,
  });

  const liveSnapshot: PublicLiveSnapshot = {
    sequence: data.sequence,
    minute: data.minute,
    phase: data.phase,
    homeScore: data.homeScore,
    awayScore: data.awayScore,
    bettingStatus: data.bettingStatus,
    incidentHistory: incidentProjection.incidentHistory,
    currentMarkets: buildIncomingMarkets(data.markets, maxMarkets),
  };

  if (data.addedTime !== undefined) {
    liveSnapshot.addedTime = data.addedTime;
  }
  if (incidentProjection.incidentHistoryComplete) {
    liveSnapshot.incidentHistoryComplete = true;
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

  let currentRecord = currentEvent as unknown as UnknownRecord;

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
    const isRaceResulted = Boolean(currentRecord.liveRaceResultedAt);

    if (currentRecord.status === EventStatus.RESULTED && isRaceResulted) {
      // EVENT_RESULT is terminal domain authority even when it wins the
      // queue race. Earlier live snapshots may still fill bounded history,
      // but they cannot reopen or publicly resurrect the event. Only the
      // matching FULL_TIME projection completes the retained-card view.
      if (event.data.phase === EventPhase.FULL_TIME) {
        await Event.updateOne(
          {
            eventId: event.data.eventId,
            status: EventStatus.RESULTED,
            liveRaceResultedAt: { $ne: null },
          },
          buildTerminalRaceRecoveryPipeline()
        );

        const refreshedEvent = await Event.findOne({
          eventId: event.data.eventId,
        }).lean();
        if (refreshedEvent) {
          currentRecord = refreshedEvent as unknown as UnknownRecord;
        }
      } else if (currentRecord.visibility !== EventVisibility.OFFLINE) {
        await Event.updateOne(
          { eventId: event.data.eventId },
          { $set: { visibility: EventVisibility.OFFLINE } }
        );
        currentRecord.visibility = EventVisibility.OFFLINE;
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
