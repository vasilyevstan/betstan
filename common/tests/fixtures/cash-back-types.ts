import type { ConsumeMessage } from "amqplib";
import {
  AListener,
  APublisher,
  BetKind,
  BetStatus,
  CashBackAcceptedReceipt,
  CashBackConfirmRequest,
  CashBackFinancialSnapshot,
  CashBackOriginalManifest,
  CashBackPortionRequest,
  CashBackQuote,
  CashBackQuoteEvidence,
  CashBackQuoteRequest,
  CashBackRejectedReceipt,
  CashBackSelectionIdentity,
  CashBackSelectionQuote,
  CashBackSourceReleaseRequest,
  CashBackSourceReply,
  CashBackSourceRequest,
  CashBackTerminalDecision,
  ICashBackOutcomeEvent,
  ICashBackRequestEvent,
  ICashBackSourceReplyEvent,
  ICashBackSourceRequestEvent,
  ISettleSlipEvent,
  LiveMarketStatus,
  QueueNames,
} from "../../build";
import * as fixtures from "./cash-back-payloads";

// New envelopes use the existing structural AMQP API, not another RPC framework.
class RequestPublisher extends APublisher<ICashBackRequestEvent> {
  queue = QueueNames.CASH_BACK_REQUEST;
  serviceName = "bet";
}
class OutcomePublisher extends APublisher<ICashBackOutcomeEvent> {
  queue = QueueNames.CASH_BACK_OUTCOME;
  serviceName = "resulting";
}
class SourcePublisher extends APublisher<ICashBackSourceRequestEvent> {
  queue = QueueNames.CASH_BACK_SOURCE_REQUEST;
  serviceName = "resulting";
}
class SourceListener extends AListener<ICashBackSourceReplyEvent> {
  queue = QueueNames.CASH_BACK_SOURCE_REPLY;
  serviceName = "resulting-cash-back-source";
  onMessage(_event: ICashBackSourceReplyEvent, _message: ConsumeMessage): void {}
}

const fullRequest: CashBackQuoteRequest = {
  action: "QUOTE", clientOperationId: "full-request", portion: { mode: "FULL" },
};
const partialRequest: CashBackQuoteRequest = {
  action: "QUOTE", clientOperationId: "partial-request",
  portion: { mode: "PARTIAL", stakeMinor: 1 },
};
const confirmRequest: CashBackConfirmRequest = {
  action: "CONFIRM", clientOperationId: "partial-request", quoteId: "quote-id",
};

// Pre-match identity keeps the exact legacy product/odds IDs, not a fabricated live market.
const prematchIdentity: CashBackSelectionIdentity = {
  betKind: BetKind.PRE_MATCH, slipRowId: "row-pre", eventId: "event-pre",
  productId: "product-pre", oddsId: "odds-pre",
};
const prematchQuote: CashBackSelectionQuote = {
  ...prematchIdentity, odds: "1.5", quoteFingerprint: "prematch-price-identity",
  quoteValidUntil: "2026-09-23T13:00:00.000Z",
};

// Actual old producer and historical document shapes remain sufficient.
const legacySettlement: ISettleSlipEvent = {
  data: { slipId: "historical-slip", result: "legacy-result" },
};
const currentSettlement: ISettleSlipEvent = fixtures.settlement;
const lostAckRelease: CashBackSourceReleaseRequest = fixtures.releaseRequest;

// @ts-expect-error Missing mode must not coerce to a destructive FULL default.
const missingMode: CashBackPortionRequest = {};
// @ts-expect-error PARTIAL must carry its exact integer-minor-unit amount.
const missingStake: CashBackPortionRequest = { mode: "PARTIAL" };
// @ts-expect-error FULL cannot silently reinterpret a supplied partial amount.
const fullWithAmount: CashBackPortionRequest = { mode: "FULL", stakeMinor: 1 };
// @ts-expect-error CONFIRM must name the exact quote.
const missingQuote: CashBackConfirmRequest = { action: "CONFIRM", clientOperationId: "op" };
// @ts-expect-error Confirming cannot submit a replacement portion.
const adjustedConfirm: CashBackConfirmRequest = { ...confirmRequest, portion: { mode: "PARTIAL", stakeMinor: 2 } };
// @ts-expect-error A quote request is not a confirmation.
const quoteAsConfirm: CashBackConfirmRequest = fullRequest;
// @ts-expect-error The authenticated owner is not public request input.
const assertedOwner: CashBackQuoteRequest = { ...fullRequest, userId: "other-user" };
// @ts-expect-error Internal source proofs are not fields in the public offer.
const exposedProof: CashBackQuote = { ...fixtures.partialQuote, evidence: fixtures.quoteEvidence };
// @ts-expect-error Private simulation state never belongs to public quotes.
const exposedSeed: CashBackQuote = { ...fixtures.partialQuote, liveSeed: "private" };
// @ts-expect-error Unknown/partial original manifests cannot be an empty success proof.
const emptyManifest: CashBackOriginalManifest = { fingerprint: "empty", selections: [] };
// @ts-expect-error A removed or otherwise resolved original leg disables the offer.
const resolvedProof: CashBackQuoteEvidence = { ...fixtures.quoteEvidence, anySelectionResolved: true };

const { selectionId: _selectionId, ...withoutSelectionId } = fixtures.selection;
// @ts-expect-error A live selection cannot fall back to side or array position.
const missingSelectionId: CashBackSelectionIdentity = withoutSelectionId;
const { quoteVersion: _quoteVersion, ...withoutQuoteVersion } = fixtures.selectionQuote;
// @ts-expect-error A live quote requires its exact price-version identity.
const missingQuoteVersion: CashBackSelectionQuote = withoutQuoteVersion;
// @ts-expect-error Event-not-finished alone is insufficient: the exact market must be open.
const settledMarketQuote: CashBackSelectionQuote = { ...fixtures.selectionQuote, marketStatus: LiveMarketStatus.SETTLED };

// @ts-expect-error An offer is not an immutable acceptance receipt.
const offerAsAcceptance: CashBackAcceptedReceipt = fixtures.partialQuote;
// @ts-expect-error Rejection is distinct from acceptance.
const rejectionAsAcceptance: CashBackAcceptedReceipt = fixtures.rejectedReceipt;
// @ts-expect-error Partial closure keeps the parent CONFIRMED, never CASH_BACK.
const terminalPartial: CashBackAcceptedReceipt = { ...fixtures.partialReceipt, financial: { ...fixtures.partialReceipt.financial, status: BetStatus.CASH_BACK } };
// @ts-expect-error Full closure must have zero remaining principal.
const residualFull: CashBackAcceptedReceipt = { ...fixtures.fullReceipt, financial: { ...fixtures.fullReceipt.financial, remainingStakeMinor: 1 } };
const { reason: _reason, ...withoutReason } = fixtures.rejectedReceipt;
// @ts-expect-error Rejection must retain its explicit reason.
const missingReason: CashBackRejectedReceipt = withoutReason;
// @ts-expect-error Immutable receipt time cannot be restamped at publication.
fixtures.partialReceipt.decisionTime = "later";
// @ts-expect-error Immutable snapshots cannot be rewound in-place by a late receipt.
fixtures.partialReceipt.financial.revision = 1;
// @ts-expect-error Terminal outcomes must include a durable receipt, not just a quote.
const pendingAsAccepted: ICashBackOutcomeEvent["data"] = { operation: fixtures.operation, outcome: "ACCEPTED", quote: fixtures.partialQuote };
// @ts-expect-error Transport metadata alone cannot replace immutable ingress time.
const noDomainTime: ICashBackRequestEvent["data"] = { operation: fixtures.operation, action: "CONFIRM", quoteId: "quote" };

const { decision: _decision, ...withoutDecision } = fixtures.releaseRequest;
// @ts-expect-error Timeout/worker lease is not canonical release authority.
const autonomousRelease: CashBackSourceRequest = withoutDecision;
const { grantedGeneration: _grantGeneration, ...withoutGrantGeneration } = fixtures.releaseRequest;
// @ts-expect-error Lost grant ACK still requires predetermined b+1.
const unboundRelease: CashBackSourceReleaseRequest = withoutGrantGeneration;
// @ts-expect-error UNDECIDED cannot authorize source release.
const undecidedRelease: CashBackTerminalDecision = { ...fixtures.releaseRequest.decision, outcome: "UNDECIDED" };
// @ts-expect-error SNAPSHOT is not a reservation grant.
const snapshotAsGrant: CashBackSourceReply = { outcome: "GRANTED", request: fixtures.snapshotRequest, grantedGeneration: 11, decisionTime: "time", evidence: fixtures.grant.evidence };
const { evidence: _evidence, ...withoutGrantEvidence } = fixtures.grant;
// @ts-expect-error A grant must retain the authority evidence actually granted.
const unprovenGrant: CashBackSourceReply = withoutGrantEvidence;
// @ts-expect-error No autonomous hold-expiry field is part of the reserve contract.
const expiringHold: CashBackSourceRequest = { ...fixtures.reserveRequest, leaseExpiresAt: "later" };
// @ts-expect-error FENCED proves this request is fenced, not that another hold was released.
const dishonestFence: CashBackSourceReply = { ...fixtures.fenced, releasedOtherHold: true };
// @ts-expect-error RELEASED must bind the release, not the reserve.
const wrongReleaseBinding: CashBackSourceReply = { outcome: "RELEASED", request: fixtures.reserveRequest, fenceGeneration: 12, decisionTime: "time" };

// @ts-expect-error Safe integer minor units are numeric JSON values, not formatted money.
const formattedMoney: CashBackFinancialSnapshot = { ...fixtures.initialFinancial, remainingStakeMinor: "60.00" };

// All discriminants can be exhausted without a generic success/pending variant.
function sourceOutcome(reply: CashBackSourceReply): string {
  switch (reply.outcome) {
    case "SNAPSHOT": return reply.request.action;
    case "GRANTED": return reply.request.quote.quoteId;
    case "RELEASED": return reply.request.decision.decisionId;
    case "FENCED": return reply.request.reserveRequestId;
    case "DENIED": return reply.reason;
    default: { const unreachable: never = reply; return unreachable; }
  }
}

void [
  RequestPublisher, OutcomePublisher, SourcePublisher, SourceListener,
  fullRequest, partialRequest, confirmRequest, prematchQuote, legacySettlement,
  currentSettlement, lostAckRelease, sourceOutcome,
];
