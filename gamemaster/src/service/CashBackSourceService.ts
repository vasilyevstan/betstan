import { createHash } from "crypto";
import { isDeepStrictEqual } from "util";
import {
  BetKind, BettingStatus, CashBackSelectionIdentity, CashBackSelectionQuote,
  CashBackSourceDenialReason, CashBackSourceEvidence, CashBackSourceReleaseRequest,
  CashBackSourceReply, CashBackSourceRequest, CashBackSourceReserveRequest,
  EventPhase, EventStatus, ILiveEventUpdateEvent, LiveMarketStatus,
} from "@betstan/common";
import { Event } from "../model/Event";
import { EventArchive } from "../model/EventArchive";
import { GamemasterCashBackHold } from "../model/liveStateFields";

interface SourceRecord {
  eventId: string;
  time: Date;
  status: EventStatus;
  phase?: EventPhase;
  liveSequence?: number;
  liveConfirmedReplayCursor?: number;
  cashBackGeneration?: number;
  cashBackAuthorityRevision?: number;
  cashBackAuthorityAt?: Date;
  cashBackHold?: GamemasterCashBackHold;
  cashBackArchived?: boolean;
  cashBackAuthoritySnapshot?: ILiveEventUpdateEvent["data"];
  pendingAuthority: boolean;
  observedAt: Date;
}

const counter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const time = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operationParts = (request: CashBackSourceRequest): readonly unknown[] => [
  request.operation.clientOperationId, request.operation.operationId,
  request.operation.fingerprint, request.operation.userId, request.operation.slipId,
  request.operation.betKind, request.participant.owner, request.participant.eventId,
];

const deny = (
  request: CashBackSourceRequest, reason: CashBackSourceDenialReason, observedAt: Date
): CashBackSourceReply => {
  console.warn("gamemaster_cash_back_denied", {
    requestId: request.requestId, eventId: request.participant.eventId, reason,
  });
  return { outcome: "DENIED", request, reason, observedAt: observedAt.toISOString() };
};

const databaseTime = async (): Promise<Date> => {
  const response = await Event.db.db.command({ hello: 1 });
  if (!(response.localTime instanceof Date)) throw new Error("Gamemaster Mongo domain time is unavailable");
  return response.localTime;
};

const readSource = async (eventId: string): Promise<SourceRecord | undefined> => {
  const [record] = await Event.aggregate<SourceRecord>([
    { $match: { eventId } },
    // Pricing must never read the private seed, timeline or future transitions.
    { $project: {
      eventId: 1, time: 1, status: 1, phase: 1,
      liveSequence: 1, liveConfirmedReplayCursor: 1,
      cashBackGeneration: 1, cashBackAuthorityRevision: 1, cashBackAuthorityAt: 1,
      cashBackHold: 1, cashBackArchived: 1, cashBackAuthoritySnapshot: 1,
      observedAt: "$$NOW",
      pendingAuthority: { $or: [
        { $ne: [{ $ifNull: ["$cashBackAuthorityIntent", null] }, null] },
        { $ne: [{ $ifNull: ["$pendingResult", null] }, null] },
        { $ne: [{ $ifNull: ["$resultPublishedAt", null] }, null] },
        { $ne: [{ $ifNull: ["$simulationFailure.quarantinedAt", null] }, null] },
      ] },
    } },
  ]);
  return record;
};

const buildEvidence = (
  record: SourceRecord,
  request: Exclude<CashBackSourceRequest, CashBackSourceReleaseRequest>
): CashBackSourceEvidence | CashBackSourceDenialReason => {
  if (record.cashBackArchived) return "ARCHIVED";
  if (record.status !== EventStatus.NO_RESULT || record.phase === EventPhase.FULL_TIME) return "RESOLVED";
  if (record.pendingAuthority) return "AUTHORITY_CHANGE_PENDING";
  const phase = record.phase;
  if (
    !counter(record.cashBackGeneration) || !counter(record.cashBackAuthorityRevision)
    || !phase || !Object.values(EventPhase).includes(phase)
    || !(record.time instanceof Date) || !Number.isFinite(record.time.getTime())
    || !(record.cashBackAuthorityAt instanceof Date)
    || !Number.isFinite(record.cashBackAuthorityAt.getTime())
  ) return "UNKNOWN_AUTHORITY";
  if (
    record.cashBackGeneration > Number.MAX_SAFE_INTEGER - 2
    || record.cashBackAuthorityRevision >= Number.MAX_SAFE_INTEGER
  ) return "GENERATION_EXHAUSTED";
  const kickoffAt = record.time.toISOString();
  let cutoffAt: string | null = kickoffAt;
  let quoteEvidence: Extract<CashBackSourceEvidence, { owner: "GAMEMASTER" }>["quoteEvidence"];
  if (request.operation.betKind === BetKind.PRE_MATCH) {
    if (phase !== EventPhase.PRE_MATCH || record.observedAt.getTime() >= record.time.getTime()) {
      return "DEADLINE_REACHED";
    }
    quoteEvidence = { kind: "PRE_MATCH_STATIC" };
  } else {
    const snapshot = record.cashBackAuthoritySnapshot;
    if (
      !snapshot || snapshot.eventId !== record.eventId || snapshot.phase !== phase
      || snapshot.sequence !== record.liveSequence
      || snapshot.sequence !== record.liveConfirmedReplayCursor
      || snapshot.bettingStatus !== BettingStatus.OPEN
      || !Array.isArray(snapshot.markets)
    ) return "UNKNOWN_AUTHORITY";
    const selections: readonly CashBackSelectionIdentity[] =
      request.action === "SNAPSHOT"
        ? request.selections
        : request.expected.evidence.owner === "GAMEMASTER"
          && request.expected.evidence.quoteEvidence.kind === "LIVE"
          ? request.expected.evidence.quoteEvidence.quotes : [];
    if (!Array.isArray(selections) || selections.length === 0) return "PROTOCOL_ERROR";
    const quotes: Extract<CashBackSelectionQuote, { betKind: BetKind.LIVE }>[] = [];
    for (const selection of selections) {
      if (selection.betKind !== BetKind.LIVE || selection.eventId !== record.eventId) return "PROTOCOL_ERROR";
      const market = snapshot.markets.find(candidate =>
        candidate.marketId === selection.marketId && candidate.marketVersion === selection.marketVersion
      );
      if (!market) return "UNKNOWN_AUTHORITY";
      if (market.status === LiveMarketStatus.SETTLED) return "RESOLVED";
      if (market.status === LiveMarketStatus.SUSPENDED) return "SUSPENDED";
      if (market.status === LiveMarketStatus.CLOSED) return "QUOTE_CHANGED";
      if (market.status !== LiveMarketStatus.OPEN) return "UNKNOWN_AUTHORITY";
      if (market.marketType !== selection.marketType) return "QUOTE_CHANGED";
      const selected = market.selections.filter(candidate => candidate.selectionId === selection.selectionId);
      if (
        selected.length !== 1 || !Number.isFinite(selected[0].odds) || selected[0].odds < 1
        || !/^[1-9][0-9]*(?:\.[0-9]+)?$/.test(String(selected[0].odds))
        || !counter(market.quoteVersion) || market.quoteVersion < 1
        || !time(market.quoteValidUntil)
      ) return "UNKNOWN_AUTHORITY";
      if (record.observedAt.getTime() >= Date.parse(market.quoteValidUntil)) return "DEADLINE_REACHED";
      const quote: Extract<CashBackSelectionQuote, { betKind: BetKind.LIVE }> = {
        betKind: BetKind.LIVE, slipRowId: selection.slipRowId,
        eventId: selection.eventId, productId: selection.productId, oddsId: selection.oddsId,
        marketId: market.marketId, marketType: market.marketType,
        marketVersion: market.marketVersion, selectionId: selected[0].selectionId,
        quoteVersion: market.quoteVersion, marketStatus: LiveMarketStatus.OPEN,
        odds: String(selected[0].odds), quoteValidUntil: market.quoteValidUntil,
        quoteFingerprint: digest([
          market.marketId, market.marketVersion, selected[0].selectionId,
          market.quoteVersion, selected[0].odds, market.quoteValidUntil,
        ]),
      };
      quotes.push(quote);
    }
    const [first, ...rest] = quotes;
    if (!first) return "PROTOCOL_ERROR";
    quoteEvidence = { kind: "LIVE", quotes: [first, ...rest] };
    cutoffAt = new Date(Math.min(...quotes.map(quote => Date.parse(quote.quoteValidUntil)))).toISOString();
  }
  return {
    owner: "GAMEMASTER", eventId: record.eventId,
    authorityFingerprint: digest([
      record.eventId, record.cashBackAuthorityRevision, phase,
      record.liveSequence ?? 0, kickoffAt, quoteEvidence,
    ]),
    occurredAt: record.cashBackAuthorityAt.toISOString(),
    kickoffAt, cutoffAt,
    lifecycle: {
      status: EventStatus.NO_RESULT, phase,
      bettingStatus: BettingStatus.OPEN, sequence: record.liveSequence ?? 0,
    },
    quoteEvidence,
  };
};

export const handleCashBackSourceRequest = async (
  request: CashBackSourceRequest
): Promise<CashBackSourceReply> => {
  if (
    !request || !request.operation || !request.participant
    || request.participant.owner !== "GAMEMASTER"
    || !Object.values(BetKind).includes(request.operation.betKind)
    || !time(request.requestedAt)
    || ![
      request.requestId, request.participant.eventId, request.operation.operationId,
      request.operation.clientOperationId, request.operation.fingerprint,
      request.operation.userId, request.operation.slipId,
    ].every(value => typeof value === "string" && value.length > 0 && value.length <= 256)
    || !["SNAPSHOT", "RESERVE", "RELEASE"].includes(request.action)
  ) throw new Error("Invalid Gamemaster cash-back source request");
  const eventId = request.participant.eventId;
  if (request.action !== "RELEASE" && await EventArchive.exists({ eventId })) {
    return deny(request, "ARCHIVED", await databaseTime());
  }
  await Event.updateOne(
    {
      eventId, status: EventStatus.NO_RESULT,
      cashBackGeneration: { $exists: false }, cashBackHold: { $exists: false },
    },
    [{ $set: {
      cashBackGeneration: 0,
      cashBackAuthorityRevision: { $ifNull: ["$cashBackAuthorityRevision", 0] },
      cashBackAuthorityAt: { $ifNull: ["$cashBackAuthorityAt", "$$NOW"] },
      __v: { $ifNull: ["$__v", 0] },
    } }]
  );
  const record = await readSource(eventId);
  if (!record) return deny(request, "MISSING", await databaseTime());
  if (request.action === "RELEASE") return release(request, record);
  if (record.cashBackHold) {
    const grant = record.cashBackHold.grant;
    if (
      record.cashBackGeneration !== grant.grantedGeneration
      || grant.grantedGeneration !== grant.request.expected.baseGeneration + 1
    ) return deny(request, "PROTOCOL_ERROR", record.observedAt);
    if (request.action === "RESERVE" && isDeepStrictEqual(record.cashBackHold.grant.request, request)) {
      return record.cashBackHold.grant;
    }
    return deny(request, "CONTENDED", record.observedAt);
  }
  if (request.action === "RESERVE" && (
    !request.expected || !request.expected.evidence || !request.quote
    || !counter(request.expected.baseGeneration)
    || request.expected.baseGeneration > Number.MAX_SAFE_INTEGER - 2
    || request.grantedGeneration !== request.expected.baseGeneration + 1
    || !counter(request.quote.expectedRevision) || !time(request.deadline)
    || ![request.quote.quoteId, request.quote.quoteFingerprint, request.quote.originalManifestFingerprint]
      .every(value => typeof value === "string" && value.length > 0)
  )) return deny(request, "PROTOCOL_ERROR", record.observedAt);
  const evidence = buildEvidence(record, request);
  if (typeof evidence === "string") return deny(request, evidence, record.observedAt);
  if (request.action === "SNAPSHOT") {
    if (
      !Array.isArray(request.selections) || request.selections.length === 0
      || request.selections.some(selection =>
        selection.eventId !== eventId || selection.betKind !== request.operation.betKind
      )
    ) return deny(request, "PROTOCOL_ERROR", record.observedAt);
    return {
      outcome: "SNAPSHOT", request,
      snapshot: {
        baseGeneration: record.cashBackGeneration!,
        observedAt: record.observedAt.toISOString(), evidence,
      },
    };
  }
  if (record.cashBackGeneration !== request.expected.baseGeneration) {
    return deny(request, "GENERATION_CONFLICT", record.observedAt);
  }
  if (!isDeepStrictEqual(request.expected.evidence, evidence)) {
    return deny(request, "AUTHORITY_CHANGED", record.observedAt);
  }
  const deadline = Math.min(
    Date.parse(request.deadline), evidence.cutoffAt ? Date.parse(evidence.cutoffAt) : Infinity
  );
  const prepared = await Event.findOneAndUpdate(
    {
      eventId, cashBackGeneration: request.expected.baseGeneration,
      cashBackAuthorityRevision: record.cashBackAuthorityRevision,
      cashBackHold: { $exists: false }, cashBackAuthorityIntent: { $exists: false },
      cashBackArchived: { $ne: true }, pendingResult: null, resultPublishedAt: null,
      status: EventStatus.NO_RESULT,
      $expr: { $lt: ["$$NOW", new Date(deadline)] },
    },
    [{ $set: {
      cashBackGeneration: request.grantedGeneration,
      cashBackHold: {
        requestFingerprint: { $literal: digest(request) },
        grant: {
          outcome: "GRANTED", request: { $literal: request },
          grantedGeneration: request.grantedGeneration,
          decisionTime: {
            $dateToString: { date: "$$NOW", format: "%Y-%m-%dT%H:%M:%S.%LZ", timezone: "UTC" },
          },
          evidence: { $literal: evidence },
        },
      },
    } }],
    { new: true }
  ).select("+cashBackHold");
  if (prepared?.cashBackHold) return prepared.cashBackHold.grant;
  const current = await readSource(eventId);
  if (current?.cashBackHold && isDeepStrictEqual(current.cashBackHold.grant.request, request)) {
    return current.cashBackHold.grant;
  }
  return deny(
    request,
    current && current.observedAt.getTime() >= deadline ? "DEADLINE_REACHED" : "AUTHORITY_CHANGED",
    current?.observedAt ?? await databaseTime()
  );
};

const release = async (
  request: CashBackSourceReleaseRequest, record: SourceRecord
): Promise<CashBackSourceReply> => {
  const decision = request.decision;
  if (
    !counter(request.baseGeneration) || request.baseGeneration > Number.MAX_SAFE_INTEGER - 2
    || request.grantedGeneration !== request.baseGeneration + 1
    || !decision || decision.issuer !== "RESULTING"
    || !["ACCEPTED", "REJECTED"].includes(decision.outcome)
    || !time(decision.decisionTime) || !counter(decision.expectedRevision)
    || !counter(decision.revision) || decision.revision <= decision.expectedRevision
    || ![
      request.reserveRequestId, decision.decisionId, decision.receiptFingerprint,
      decision.quoteId, decision.quoteFingerprint,
    ].every(value => typeof value === "string" && value.length > 0)
  ) return deny(request, "INVALID_DECISION", record.observedAt);
  if (!counter(record.cashBackGeneration)) return deny(request, "PROTOCOL_ERROR", record.observedAt);
  const fenceGeneration = request.baseGeneration + 2;
  if (record.cashBackGeneration >= fenceGeneration) {
    if (record.cashBackHold?.grant.request.operation.operationId === request.operation.operationId) {
      return deny(request, "PROTOCOL_ERROR", record.observedAt);
    }
    return {
      outcome: "FENCED", request, fenceGeneration,
      observedGeneration: record.cashBackGeneration, observedAt: record.observedAt.toISOString(),
    };
  }
  const held = record.cashBackHold?.grant.request;
  const matching = held && record.cashBackGeneration === request.grantedGeneration
    && record.cashBackHold!.grant.grantedGeneration === request.grantedGeneration
    && held.grantedGeneration === request.grantedGeneration
    && held.expected.baseGeneration === request.baseGeneration
    && held.requestId === request.reserveRequestId
    && isDeepStrictEqual(operationParts(held), operationParts(request))
    && held.quote.quoteId === decision.quoteId
    && held.quote.quoteFingerprint === decision.quoteFingerprint
    && held.quote.expectedRevision === decision.expectedRevision;
  if (!matching && !(record.cashBackGeneration === request.baseGeneration && !record.cashBackHold)) {
    return deny(request, "GENERATION_CONFLICT", record.observedAt);
  }
  const updated = await Event.findOneAndUpdate(
    {
      eventId: request.participant.eventId, cashBackGeneration: record.cashBackGeneration,
      ...(matching
        ? { "cashBackHold.requestFingerprint": record.cashBackHold!.requestFingerprint }
        : { cashBackHold: { $exists: false } }),
    },
    [
      { $set: { cashBackGeneration: fenceGeneration, cashBackFenceAt: "$$NOW" } },
      { $unset: "cashBackHold" },
    ],
    { new: true }
  ).select("+cashBackFenceAt");
  if (!updated) {
    const current = await readSource(request.participant.eventId);
    if (current && counter(current.cashBackGeneration) && current.cashBackGeneration >= fenceGeneration) {
      return {
        outcome: "FENCED", request, fenceGeneration,
        observedGeneration: current.cashBackGeneration,
        observedAt: current.observedAt.toISOString(),
      };
    }
    return deny(request, "GENERATION_CONFLICT", current?.observedAt ?? await databaseTime());
  }
  if (!(updated.cashBackFenceAt instanceof Date)) throw new Error("Gamemaster fence lacks persisted decision time");
  return matching
    ? {
        outcome: "RELEASED", request, fenceGeneration,
        decisionTime: updated.cashBackFenceAt.toISOString(),
      }
    : {
        outcome: "FENCED", request, fenceGeneration, observedGeneration: fenceGeneration,
        observedAt: updated.cashBackFenceAt.toISOString(),
      };
};
