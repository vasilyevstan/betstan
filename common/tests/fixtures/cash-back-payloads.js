// @ts-check
// Shared by tsc fixtures and native node:test; synthetic identities only.
const common = require("../../build");

/** @type {import("../../src").CashBackOperationIdentity} */
const operation = {
  clientOperationId: "client-partial",
  operationId: "operation-partial",
  fingerprint: "operation-fingerprint",
  userId: "user-example",
  slipId: "slip-example",
  betKind: common.BetKind.LIVE,
};

/** @type {import("../../src").CashBackFinancialSnapshot & {status: import("../../src").BetStatus.CONFIRMED}} */
const initialFinancial = {
  revision: 4,
  status: common.BetStatus.CONFIRMED,
  originalStakeMinor: 10000,
  remainingStakeMinor: 10000,
  cumulativeClosedStakeMinor: 0,
  cumulativeReturnMinor: 0,
};

/** @type {import("../../src").CashBackAcceptedSelection} */
const selection = {
  slipRowId: "row-example",
  eventId: "event-example",
  productId: "product-example",
  oddsId: "odds-example",
  betKind: common.BetKind.LIVE,
  marketId: "market-score",
  marketType: common.LiveMarketType.SECOND_HALF_SCORE,
  marketVersion: 2,
  selectionId: "score-2-1",
  acceptedOdds: "3",
};

/** @type {import("../../src").CashBackSelectionQuote} */
const selectionQuote = {
  slipRowId: selection.slipRowId,
  eventId: selection.eventId,
  productId: selection.productId,
  oddsId: selection.oddsId,
  betKind: common.BetKind.LIVE,
  marketId: selection.marketId,
  marketType: selection.marketType,
  marketVersion: selection.marketVersion,
  selectionId: selection.selectionId,
  quoteVersion: 9,
  marketStatus: common.LiveMarketStatus.OPEN,
  odds: "6",
  quoteFingerprint: "market-quote-fingerprint",
  quoteValidUntil: "2026-09-23T12:00:06.000Z",
};

/** @type {Extract<import("../../src").CashBackQuote, {mode: "PARTIAL"}>} */
const partialQuote = {
  operation: {
    clientOperationId: operation.clientOperationId,
    operationId: operation.operationId,
    slipId: operation.slipId,
    betKind: operation.betKind,
  },
  quoteId: "quote-partial",
  policyVersion: "cash-back-v1",
  issuer: "RESULTING",
  issuedAt: "2026-09-23T12:00:00.000Z",
  expiresAt: selectionQuote.quoteValidUntil,
  financial: initialFinancial,
  mode: "PARTIAL",
  closedStakeMinor: 4000,
  remainingStakeMinorAfter: 6000,
  returnMinor: 2000,
  acceptedCombinedOdds: "3",
  currentCombinedOdds: "6",
};

/** @type {Extract<import("../../src").CashBackAcceptedReceipt, {mode: "PARTIAL"}>} */
const partialReceipt = {
  outcome: "ACCEPTED",
  mode: "PARTIAL",
  decisionId: "decision-partial",
  decisionTime: "2026-09-23T12:00:02.000Z",
  quote: partialQuote,
  financial: {
    ...initialFinancial,
    revision: 5,
    remainingStakeMinor: 6000,
    cumulativeClosedStakeMinor: 4000,
    cumulativeReturnMinor: 2000,
  },
};

/** @type {import("../../src").CashBackOperationIdentity} */
const fullOperation = {
  ...operation,
  clientOperationId: "client-full",
  operationId: "operation-full",
  fingerprint: "operation-full-fingerprint",
};

/** @type {Extract<import("../../src").CashBackQuote, {mode: "FULL"}>} */
const fullQuote = {
  ...partialQuote,
  operation: {
    ...partialQuote.operation,
    clientOperationId: fullOperation.clientOperationId,
    operationId: fullOperation.operationId,
  },
  quoteId: "quote-full",
  issuedAt: "2026-09-23T12:00:03.000Z",
  financial: partialReceipt.financial,
  mode: "FULL",
  closedStakeMinor: 6000,
  remainingStakeMinorAfter: 0,
  returnMinor: 3000,
};

/** @type {Extract<import("../../src").CashBackAcceptedReceipt, {mode: "FULL"}>} */
const fullReceipt = {
  outcome: "ACCEPTED",
  mode: "FULL",
  decisionId: "decision-full",
  decisionTime: "2026-09-23T12:00:04.000Z",
  quote: fullQuote,
  financial: {
    revision: 6,
    status: common.BetStatus.CASH_BACK,
    originalStakeMinor: 10000,
    remainingStakeMinor: 0,
    cumulativeClosedStakeMinor: 10000,
    cumulativeReturnMinor: 5000,
  },
};

// Alternative to full closure: normal settlement of the partial's remainder.
/** @type {import("../../src").ISettleSlipEvent} */
const settlement = {
  data: {
    slipId: operation.slipId,
    result: common.ResultingStatus.BET_WIN,
    betKind: common.BetKind.LIVE,
    cashBack: {
      settlementId: "settlement-example",
      occurredAt: "2026-09-23T12:00:08.000Z",
      financial: {
        ...partialReceipt.financial,
        revision: 6,
        status: common.BetStatus.WIN,
      },
      settlementBasisStakeMinor: 6000,
    },
  },
};

/** @type {import("../../src").CashBackRejectedReceipt} */
const rejectedReceipt = {
  outcome: "REJECTED",
  decisionId: "decision-rejected",
  decisionTime: "2026-09-23T12:00:08.000Z",
  operation: fullQuote.operation,
  quoteId: fullQuote.quoteId,
  expectedRevision: 5,
  reason: "SELECTION_RESOLVED",
  financial: settlement.data.cashBack.financial,
};

/** @type {import("../../src").CashBackSourceSnapshot} */
const backofficeSnapshot = {
  baseGeneration: 20,
  observedAt: "2026-09-23T12:00:00.000Z",
  evidence: {
    owner: "BACKOFFICE",
    eventId: selection.eventId,
    authorityFingerprint: "backoffice-authority",
    occurredAt: "2026-09-23T11:00:00.000Z",
    kickoffAt: "2026-09-23T11:00:00.000Z",
    cutoffAt: null,
    lifecycle: {
      status: common.EventStatus.NO_RESULT,
      visibility: common.EventVisibility.ONLINE,
    },
    quoteEvidence: { kind: "LIFECYCLE_ONLY" },
  },
};

/** @type {import("../../src").CashBackSourceSnapshot} */
const gamemasterSnapshot = {
  baseGeneration: 10,
  observedAt: "2026-09-23T12:00:00.000Z",
  evidence: {
    owner: "GAMEMASTER",
    eventId: selection.eventId,
    authorityFingerprint: "gamemaster-authority",
    occurredAt: "2026-09-23T12:00:00.000Z",
    kickoffAt: "2026-09-23T11:00:00.000Z",
    cutoffAt: selectionQuote.quoteValidUntil,
    lifecycle: {
      status: common.EventStatus.NO_RESULT,
      phase: common.EventPhase.SECOND_HALF,
      bettingStatus: common.BettingStatus.OPEN,
      sequence: 30,
    },
    quoteEvidence: { kind: "LIVE", quotes: [selectionQuote] },
  },
};

/** @type {import("../../src").CashBackQuoteEvidence} */
const quoteEvidence = {
  quoteFingerprint: "quote-partial-fingerprint",
  originalManifest: {
    fingerprint: "original-manifest-fingerprint",
    selections: [selection],
  },
  anySelectionResolved: false,
  currentQuotes: [selectionQuote],
  sources: [backofficeSnapshot, gamemasterSnapshot],
};

/** @type {import("../../src").CashBackSourceSnapshotRequest} */
const snapshotRequest = {
  action: "SNAPSHOT",
  requestId: "snapshot-request",
  operation,
  participant: { owner: "GAMEMASTER", eventId: selection.eventId },
  requestedAt: "2026-09-23T12:00:00.000Z",
  selections: [{
    slipRowId: selection.slipRowId,
    eventId: selection.eventId,
    productId: selection.productId,
    oddsId: selection.oddsId,
    betKind: common.BetKind.LIVE,
    marketId: selection.marketId,
    marketType: selection.marketType,
    marketVersion: selection.marketVersion,
    selectionId: selection.selectionId,
  }],
};

/** @type {import("../../src").CashBackSourceReserveRequest} */
const reserveRequest = {
  action: "RESERVE",
  requestId: "reserve-request",
  operation,
  participant: snapshotRequest.participant,
  requestedAt: "2026-09-23T12:00:01.000Z",
  expected: gamemasterSnapshot,
  quote: {
    quoteId: partialQuote.quoteId,
    quoteFingerprint: quoteEvidence.quoteFingerprint,
    expectedRevision: partialQuote.financial.revision,
    originalManifestFingerprint: quoteEvidence.originalManifest.fingerprint,
  },
  grantedGeneration: 11,
  deadline: partialQuote.expiresAt,
};

/** @type {import("../../src").CashBackTerminalDecision} */
const terminalDecision = {
  issuer: "RESULTING",
  decisionId: partialReceipt.decisionId,
  receiptFingerprint: "receipt-partial-fingerprint",
  outcome: "ACCEPTED",
  quoteId: partialQuote.quoteId,
  quoteFingerprint: quoteEvidence.quoteFingerprint,
  expectedRevision: partialQuote.financial.revision,
  revision: partialReceipt.financial.revision,
  decisionTime: partialReceipt.decisionTime,
};

// Constructible from the durable obligation and winner, WITHOUT any grant reply.
/** @type {import("../../src").CashBackSourceReleaseRequest} */
const releaseRequest = {
  action: "RELEASE",
  requestId: "release-request",
  operation,
  participant: reserveRequest.participant,
  requestedAt: "2026-09-23T12:00:03.000Z",
  reserveRequestId: reserveRequest.requestId,
  baseGeneration: reserveRequest.expected.baseGeneration,
  grantedGeneration: reserveRequest.grantedGeneration,
  decision: terminalDecision,
};

// Alternative terminal winner: expiry can cancel an obligation with no grant ACK.
/** @type {import("../../src").CashBackSourceReleaseRequest} */
const cancellationRequest = {
  ...releaseRequest,
  requestId: "cancel-request",
  requestedAt: "2026-09-23T12:00:06.000Z",
  decision: {
    ...terminalDecision,
    decisionId: "decision-expired",
    receiptFingerprint: "receipt-expired-fingerprint",
    outcome: "REJECTED",
    decisionTime: "2026-09-23T12:00:06.000Z",
  },
};

/** @type {Extract<import("../../src").CashBackSourceReply, {outcome: "GRANTED"}>} */
const grant = {
  outcome: "GRANTED",
  request: reserveRequest,
  grantedGeneration: 11,
  decisionTime: "2026-09-23T12:00:01.000Z",
  evidence: gamemasterSnapshot.evidence,
};

/** @type {Extract<import("../../src").CashBackSourceReply, {outcome: "FENCED"}>} */
const fenced = {
  outcome: "FENCED",
  request: releaseRequest,
  fenceGeneration: 12,
  observedGeneration: 15,
  observedAt: "2026-09-23T12:00:09.000Z",
};

/** @type {import("../../src").ICashBackRequestEvent[]} */
const requests = [
  { data: {
    action: "QUOTE", operation, requestedAt: partialQuote.issuedAt,
    portion: { mode: "PARTIAL", stakeMinor: 4000 },
  } },
  { data: {
    action: "QUOTE", operation: fullOperation, requestedAt: fullQuote.issuedAt,
    portion: { mode: "FULL" },
  } },
  { data: {
    action: "CONFIRM", operation, requestedAt: reserveRequest.requestedAt,
    quoteId: partialQuote.quoteId,
  } },
];

/** @type {import("../../src").ICashBackOutcomeEvent[]} */
const outcomes = [
  { data: { outcome: "QUOTED", operation, quote: partialQuote, evidence: quoteEvidence } },
  { data: {
    outcome: "UNAVAILABLE", operation, reason: "AUTHORITY_UNAVAILABLE",
    occurredAt: partialQuote.issuedAt,
  } },
  { data: {
    outcome: "ACCEPTED", operation, receipt: partialReceipt,
    receiptFingerprint: terminalDecision.receiptFingerprint,
  } },
  { data: {
    outcome: "ACCEPTED", operation: fullOperation, receipt: fullReceipt,
    receiptFingerprint: "receipt-full-fingerprint",
  } },
  { data: {
    outcome: "REJECTED", operation: fullOperation, receipt: rejectedReceipt,
    receiptFingerprint: "receipt-rejected-fingerprint",
  } },
];

/** @type {import("../../src").ICashBackSourceRequestEvent[]} */
const sourceRequests = [
  { data: snapshotRequest },
  { data: reserveRequest },
  { data: releaseRequest },
  { data: cancellationRequest },
  { data: {
    ...reserveRequest,
    requestId: "backoffice-reserve",
    participant: { owner: "BACKOFFICE", eventId: selection.eventId },
    expected: backofficeSnapshot,
    grantedGeneration: 21,
  } },
];

/** @type {import("../../src").ICashBackSourceReplyEvent[]} */
const sourceReplies = [
  { data: { outcome: "SNAPSHOT", request: snapshotRequest, snapshot: gamemasterSnapshot } },
  { data: grant },
  { data: {
    outcome: "RELEASED", request: releaseRequest, fenceGeneration: 12,
    decisionTime: "2026-09-23T12:00:03.000Z",
  } },
  { data: fenced },
  { data: {
    outcome: "FENCED", request: cancellationRequest, fenceGeneration: 12,
    observedGeneration: 12, observedAt: "2026-09-23T12:00:06.000Z",
  } },
  { data: {
    outcome: "DENIED", request: reserveRequest, reason: "AUTHORITY_CHANGE_PENDING",
    observedAt: "2026-09-23T12:00:01.000Z",
  } },
];

module.exports = {
  operation, initialFinancial, selection, selectionQuote, partialQuote, partialReceipt,
  fullQuote, fullReceipt, settlement, rejectedReceipt, quoteEvidence,
  snapshotRequest, reserveRequest, releaseRequest, cancellationRequest, grant, fenced,
  requests, outcomes, sourceRequests, sourceReplies,
};
