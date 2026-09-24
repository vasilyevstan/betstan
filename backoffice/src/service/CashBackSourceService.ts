import { createHash } from "crypto";
import { isDeepStrictEqual } from "util";
import {
  BetKind,
  CashBackSourceDenialReason,
  CashBackSourceEvidence,
  CashBackSourceReleaseRequest,
  CashBackSourceReply,
  CashBackSourceRequest,
  CashBackSourceReserveRequest,
  EventStatus,
  EventVisibility,
} from "@betstan/common";
import { Types } from "mongoose";
import { BackofficeCashBackHold, Event } from "../model/Event";

export const cashBackAuthorityWritable = {
  cashBackHold: { $exists: false },
  $expr: {
    $lt: [
      { $ifNull: ["$cashBackAuthorityRevision", 0] },
      Number.MAX_SAFE_INTEGER,
    ],
  },
};

interface SourceRecord {
  _id: Types.ObjectId;
  eventId: string;
  time: string;
  status: EventStatus;
  visibility: EventVisibility;
  cashBackGeneration?: number;
  cashBackAuthorityRevision?: number;
  cashBackAuthorityAt?: Date;
  cashBackHold?: BackofficeCashBackHold;
  newEventPublicationPending?: boolean;
  resultPublicationPending?: boolean;
  visibilityPublicationPending?: boolean;
  observedAt: Date;
}

const digest = (parts: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const validTime = (value: unknown): value is string =>
  typeof value === "string"
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

const validCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const operationParts = (request: CashBackSourceRequest): readonly unknown[] => {
  const operation = request.operation;
  return [
    operation.clientOperationId, operation.operationId, operation.fingerprint,
    operation.userId, operation.slipId, operation.betKind,
    request.participant.owner, request.participant.eventId,
  ];
};

const reserveFingerprint = (request: CashBackSourceReserveRequest): string =>
  digest([
    ...operationParts(request), request.action, request.requestId, request.requestedAt,
    request.expected, request.quote, request.grantedGeneration, request.deadline,
  ]);

const sourceEvidence = (record: SourceRecord, betKind: BetKind): CashBackSourceEvidence => ({
  owner: "BACKOFFICE",
  eventId: record.eventId,
  authorityFingerprint: digest([
    record.eventId, record.time, record.status, record.visibility,
    record.cashBackAuthorityRevision, record.cashBackAuthorityAt!.toISOString(),
  ]),
  occurredAt: record.cashBackAuthorityAt!.toISOString(),
  kickoffAt: new Date(record.time).toISOString(),
  cutoffAt: betKind === BetKind.PRE_MATCH ? new Date(record.time).toISOString() : null,
  lifecycle: { status: EventStatus.NO_RESULT, visibility: record.visibility },
  quoteEvidence: { kind: "LIFECYCLE_ONLY" },
});

const eligible = (record: SourceRecord): CashBackSourceDenialReason | undefined => {
  if (record.status !== EventStatus.NO_RESULT) return "RESOLVED";
  if (
    !validCounter(record.cashBackGeneration)
    || !validCounter(record.cashBackAuthorityRevision)
    || !(record.cashBackAuthorityAt instanceof Date)
    || !Number.isFinite(record.cashBackAuthorityAt.getTime())
    || !Number.isFinite(Date.parse(record.time))
    || !Object.values(EventVisibility).includes(record.visibility)
  ) return "UNKNOWN_AUTHORITY";
  if (
    record.cashBackGeneration > Number.MAX_SAFE_INTEGER - 2
    || record.cashBackAuthorityRevision >= Number.MAX_SAFE_INTEGER
  ) return "GENERATION_EXHAUSTED";
  if (
    record.newEventPublicationPending
    || record.resultPublicationPending
    || record.visibilityPublicationPending
  ) return "AUTHORITY_CHANGE_PENDING";
  return undefined;
};

const deny = (
  request: CashBackSourceRequest,
  reason: CashBackSourceDenialReason,
  observedAt: Date
): CashBackSourceReply => {
  console.warn("backoffice_cash_back_denied", {
    requestId: request.requestId, eventId: request.participant.eventId, reason,
  });
  return { outcome: "DENIED", request, reason, observedAt: observedAt.toISOString() };
};

const readSource = async (eventId: string): Promise<SourceRecord | undefined> => {
  const [record] = await Event.aggregate<SourceRecord>([
    { $match: { eventId } },
    { $addFields: { observedAt: "$$NOW" } },
  ]);
  return record;
};

const missingSourceTime = async (): Promise<Date> => {
  const response = await Event.db.db.command({ hello: 1 });
  if (!(response.localTime instanceof Date)) {
    throw new Error("Backoffice Mongo domain time is unavailable");
  }
  return response.localTime;
};

const validateRequest = (request: CashBackSourceRequest): void => {
  if (
    !request || !request.operation || !request.participant
    || request.participant.owner !== "BACKOFFICE"
    || !validTime(request.requestedAt)
    || !Object.values(BetKind).includes(request.operation.betKind)
    || ![
      request.requestId, request.participant.eventId, request.operation.userId,
      request.operation.slipId, request.operation.clientOperationId,
      request.operation.operationId, request.operation.fingerprint,
    ].every(value => typeof value === "string" && value.length > 0 && value.length <= 256)
    || !["SNAPSHOT", "RESERVE", "RELEASE"].includes(request.action)
  ) {
    throw new Error("Invalid Backoffice cash-back source request");
  }
};

export const handleCashBackSourceRequest = async (
  request: CashBackSourceRequest
): Promise<CashBackSourceReply> => {
  validateRequest(request);
  const eventId = request.participant.eventId;
  // Only a pristine, existing aggregate may initialize its fence; never upsert.
  await Event.updateOne(
    {
      eventId, status: EventStatus.NO_RESULT,
      cashBackGeneration: { $exists: false }, cashBackHold: { $exists: false },
    },
    [{
      $set: {
        cashBackGeneration: 0,
        cashBackAuthorityRevision: { $ifNull: ["$cashBackAuthorityRevision", 0] },
        cashBackAuthorityAt: { $ifNull: ["$cashBackAuthorityAt", "$$NOW"] },
        __v: { $ifNull: ["$__v", 0] },
      },
    }]
  );
  const record = await readSource(eventId);
  if (!record) return deny(request, "MISSING", await missingSourceTime());
  if (request.action === "RELEASE") return release(request, record);

  if (request.action === "RESERVE" && record.cashBackHold) {
    const grant = record.cashBackHold.grant;
    if (
      record.cashBackGeneration !== grant.grantedGeneration
      || grant.grantedGeneration !== grant.request.expected.baseGeneration + 1
    ) return deny(request, "PROTOCOL_ERROR", record.observedAt);
    if (isDeepStrictEqual(record.cashBackHold.grant.request, request)) {
      return record.cashBackHold.grant;
    }
    return deny(request, "CONTENDED", record.observedAt);
  }
  const reason = eligible(record);
  if (reason) return deny(request, reason, record.observedAt);
  if (record.cashBackHold) return deny(request, "CONTENDED", record.observedAt);
  const evidence = sourceEvidence(record, request.operation.betKind);
  if (request.action === "SNAPSHOT") {
    if (
      !Array.isArray(request.selections) || request.selections.length === 0
      || request.selections.some(selection =>
        selection.eventId !== eventId || selection.betKind !== request.operation.betKind
      )
    ) return deny(request, "PROTOCOL_ERROR", record.observedAt);
    if (
      request.operation.betKind === BetKind.PRE_MATCH
      && record.observedAt.getTime() >= Date.parse(evidence.kickoffAt)
    ) return deny(request, "DEADLINE_REACHED", record.observedAt);
    return {
      outcome: "SNAPSHOT", request,
      snapshot: {
        baseGeneration: record.cashBackGeneration!,
        observedAt: record.observedAt.toISOString(), evidence,
      },
    };
  }
  if (
    !request.expected || !request.quote
    || !validCounter(request.expected.baseGeneration)
    || request.expected.baseGeneration > Number.MAX_SAFE_INTEGER - 2
    || request.grantedGeneration !== request.expected.baseGeneration + 1
    || !validCounter(request.quote.expectedRevision)
    || !validTime(request.deadline)
    || ![request.quote.quoteId, request.quote.quoteFingerprint, request.quote.originalManifestFingerprint]
      .every(value => typeof value === "string" && value.length > 0)
  ) return deny(request, "PROTOCOL_ERROR", record.observedAt);
  if (record.cashBackGeneration !== request.expected.baseGeneration) {
    return deny(request, "GENERATION_CONFLICT", record.observedAt);
  }
  if (!isDeepStrictEqual(request.expected.evidence, evidence)) {
    return deny(request, "AUTHORITY_CHANGED", record.observedAt);
  }
  const deadline = Math.min(
    Date.parse(request.deadline),
    request.operation.betKind === BetKind.PRE_MATCH
      ? Date.parse(evidence.kickoffAt) : Infinity
  );
  const updated = await Event.findOneAndUpdate(
    {
      eventId,
      cashBackGeneration: request.expected.baseGeneration,
      cashBackAuthorityRevision: record.cashBackAuthorityRevision,
      cashBackHold: { $exists: false },
      status: EventStatus.NO_RESULT,
      newEventPublicationPending: { $ne: true },
      resultPublicationPending: { $ne: true },
      visibilityPublicationPending: { $ne: true },
      $expr: { $lt: ["$$NOW", new Date(deadline)] },
    },
    [{
      $set: {
        cashBackGeneration: request.grantedGeneration,
        cashBackHold: {
          requestFingerprint: { $literal: reserveFingerprint(request) },
          grant: {
            outcome: "GRANTED",
            request: { $literal: request },
            grantedGeneration: request.grantedGeneration,
            decisionTime: {
              $dateToString: { date: "$$NOW", format: "%Y-%m-%dT%H:%M:%S.%LZ", timezone: "UTC" },
            },
            evidence: { $literal: evidence },
          },
        },
      },
    }],
    { new: true }
  ).select("+cashBackHold");
  if (updated?.cashBackHold) return updated.cashBackHold.grant;
  const latest = await readSource(eventId);
  if (latest?.cashBackHold && isDeepStrictEqual(latest.cashBackHold.grant.request, request)) {
    return latest.cashBackHold.grant;
  }
  return deny(
    request,
    latest && latest.observedAt.getTime() >= deadline ? "DEADLINE_REACHED" : "AUTHORITY_CHANGED",
    latest?.observedAt ?? await missingSourceTime()
  );
};

const release = async (
  request: CashBackSourceReleaseRequest,
  record: SourceRecord
): Promise<CashBackSourceReply> => {
  const decision = request.decision;
  if (
    !validCounter(request.baseGeneration)
    || request.baseGeneration > Number.MAX_SAFE_INTEGER - 2
    || request.grantedGeneration !== request.baseGeneration + 1
    || !decision || decision.issuer !== "RESULTING"
    || !["ACCEPTED", "REJECTED"].includes(decision.outcome)
    || !validTime(decision.decisionTime)
    || !validCounter(decision.expectedRevision)
    || !validCounter(decision.revision)
    || decision.revision <= decision.expectedRevision
    || ![
      request.reserveRequestId, decision.decisionId, decision.receiptFingerprint,
      decision.quoteId, decision.quoteFingerprint,
    ].every(value => typeof value === "string" && value.length > 0)
  ) return deny(request, "INVALID_DECISION", record.observedAt);
  if (!validCounter(record.cashBackGeneration)) {
    return deny(request, "PROTOCOL_ERROR", record.observedAt);
  }
  const fenceGeneration = request.baseGeneration + 2;
  if (record.cashBackGeneration >= fenceGeneration) {
    if (record.cashBackHold?.grant.request.operation.operationId === request.operation.operationId) {
      return deny(request, "PROTOCOL_ERROR", record.observedAt);
    }
    return {
      outcome: "FENCED", request, fenceGeneration,
      observedGeneration: record.cashBackGeneration,
      observedAt: record.observedAt.toISOString(),
    };
  }
  const heldRequest = record.cashBackHold?.grant.request;
  const matchingHold = heldRequest
    && record.cashBackGeneration === request.grantedGeneration
    && record.cashBackHold!.grant.grantedGeneration === request.grantedGeneration
    && heldRequest.grantedGeneration === request.grantedGeneration
    && heldRequest.expected.baseGeneration === request.baseGeneration
    && heldRequest.requestId === request.reserveRequestId
    && isDeepStrictEqual(operationParts(heldRequest), operationParts(request))
    && heldRequest.quote.quoteId === decision.quoteId
    && heldRequest.quote.quoteFingerprint === decision.quoteFingerprint
    && heldRequest.quote.expectedRevision === decision.expectedRevision;
  if (
    !matchingHold
    && !(record.cashBackGeneration === request.baseGeneration && !record.cashBackHold)
  ) return deny(request, "GENERATION_CONFLICT", record.observedAt);
  const updated = await Event.findOneAndUpdate(
    {
      eventId: request.participant.eventId,
      cashBackGeneration: record.cashBackGeneration,
      ...(matchingHold
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
    const latest = await readSource(request.participant.eventId);
    if (!latest) return deny(request, "MISSING", await missingSourceTime());
    if (latest.cashBackGeneration! >= fenceGeneration && !latest.cashBackHold) {
      return {
        outcome: "FENCED", request, fenceGeneration,
        observedGeneration: latest.cashBackGeneration!,
        observedAt: latest.observedAt.toISOString(),
      };
    }
    return deny(request, "GENERATION_CONFLICT", latest.observedAt);
  }
  const observedAt = updated.cashBackFenceAt;
  if (!(observedAt instanceof Date)) {
    throw new Error("Backoffice cash-back fence lacks its persisted decision time");
  }
  return matchingHold
    ? { outcome: "RELEASED", request, fenceGeneration, decisionTime: observedAt.toISOString() }
    : {
        outcome: "FENCED", request, fenceGeneration,
        observedGeneration: fenceGeneration, observedAt: observedAt.toISOString(),
      };
};
