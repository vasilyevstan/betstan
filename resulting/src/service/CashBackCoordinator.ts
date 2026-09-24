import { randomBytes } from "crypto";
import { isDeepStrictEqual } from "util";
import {
  APublisher, BetKind, BetStatus, CashBackFinancialSnapshot, CashBackOperationIdentity,
  CashBackQuote, CashBackQuoteEvidence, CashBackReceipt, CashBackSelectionQuote,
  CashBackSourceReply, CashBackSourceRequest, CashBackSourceReserveRequest,
  CashBackSourceSnapshot, CashBackSourceSnapshotRequest, CashBackUnavailableReason,
  IAmqpConnection, ICashBackOutcomeEvent, ICashBackRequestEvent,
  ICashBackSourceReplyEvent, ICashBackSourceRequestEvent, QueueNames, ResultingStatus,
} from "@betstan/common";
import { Bet, BetArchive } from "../model/Bet";
import { CashBackOperation, CashBackOperationRecord, CashBackPending } from "../model/CashBackOperation";
import FinalScoreLedger from "../model/FinalScoreLedger";
import LiveSettlementLedger from "../model/LiveSettlementLedger";
import {
  CashBackBet, cashBackAtOrAfterDeadline, cashBackBeforeDeadline, cashBackHash,
  mongoDecisionTime, publicBetStatus, rejectionReceiptExpression,
} from "./cashBackState";
import {
  CashBackUnavailable, combinedOdds, originalStakeMinor, priceCashBack, validateFinancialSnapshot,
} from "./cashBackPricing";
import { archiveBet } from "./resulting";

class SourcePublisher extends APublisher<ICashBackSourceRequestEvent> {
  queue = QueueNames.CASH_BACK_SOURCE_REQUEST;
  serviceName = "resulting_cash_back_source";
}
class OutcomePublisher extends APublisher<ICashBackOutcomeEvent> {
  queue = QueueNames.CASH_BACK_OUTCOME;
  serviceName = "resulting_cash_back_outcome";
}

export interface CashBackPublishers {
  source: Pick<SourcePublisher, "initConfirmChannel" | "publishWithConfirm">;
  outcome: Pick<OutcomePublisher, "initConfirmChannel" | "publishWithConfirm">;
}

type Operation = ReturnType<typeof CashBackOperation.hydrate>;
interface CanonicalBet { model: typeof Bet; bet: CashBackBet }

const findCanonicalBet = async (slipId: string): Promise<CanonicalBet | undefined> => {
  const archived = await BetArchive.findOne({ slipId });
  if (archived) return { model: BetArchive, bet: archived };
  const active = await Bet.findOne({ slipId });
  if (active) return { model: Bet, bet: active };
  return undefined;
};

const now = async (): Promise<Date> => {
  const reply = await Bet.db.db.command({ hello: 1 });
  if (!(reply.localTime instanceof Date)) throw new Error("Resulting Mongo domain time unavailable");
  return reply.localTime;
};

const financialSnapshot = (bet: CashBackBet): CashBackFinancialSnapshot => {
  const stored = bet.cashBackFinancial;
  if (!stored) throw new CashBackUnavailable(
    bet.cashBackUnavailableReason === "LEGACY_PRECISION_UNSUPPORTED"
      ? "LEGACY_PRECISION_UNSUPPORTED" : "AUTHORITY_UNAVAILABLE"
  );
  const financial: CashBackFinancialSnapshot = {
    revision: stored.revision, status: stored.status,
    originalStakeMinor: stored.originalStakeMinor, remainingStakeMinor: stored.remainingStakeMinor,
    cumulativeClosedStakeMinor: stored.cumulativeClosedStakeMinor,
    cumulativeReturnMinor: stored.cumulativeReturnMinor,
  };
  validateFinancialSnapshot(financial);
  if (
    financial.originalStakeMinor !== originalStakeMinor(bet.wager)
    || financial.status !== publicBetStatus(bet.status)
  ) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
  if (financial.revision >= Number.MAX_SAFE_INTEGER) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
  return financial;
};

const assertEligible = (bet: CashBackBet | null, operation: CashBackOperationIdentity): CashBackBet => {
  if (
    !bet || bet.userId !== operation.userId || bet.betKind !== operation.betKind
    || bet.status !== ResultingStatus.BET_APPROVED
  ) throw new CashBackUnavailable("BET_NOT_CONFIRMED");
  financialSnapshot(bet);
  if (!bet.cashBackOriginalManifest || bet.cashBackAnySelectionResolved === undefined) {
    throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
  }
  if (
    bet.cashBackAnySelectionResolved
    || bet.rows.length !== bet.cashBackOriginalManifest.selections.length
    || bet.rows.some(row => row.result !== ResultingStatus.ROW_NO_RESULT || row.pendingRemoval)
  ) throw new CashBackUnavailable("SELECTION_RESOLVED");
  return bet;
};

const reference = (operation: CashBackOperationIdentity) => ({
  operationId: operation.operationId, clientOperationId: operation.clientOperationId,
  slipId: operation.slipId, betKind: operation.betKind,
});

const reserveRequests = (op: Operation): CashBackSourceReserveRequest[] => {
  if (!op.quote || !op.evidence) throw new Error("Confirmation lacks its stored quote");
  const quote = op.quote;
  const evidence = op.evidence;
  return evidence.sources.map(snapshot => ({
    action: "RESERVE",
    requestId: cashBackHash([op.operationId, "RESERVE", snapshot.evidence.eventId, snapshot.evidence.owner]),
    operation: op.operation,
    participant: { owner: snapshot.evidence.owner, eventId: snapshot.evidence.eventId },
    requestedAt: quote.issuedAt,
    expected: snapshot,
    quote: {
      quoteId: quote.quoteId, quoteFingerprint: evidence.quoteFingerprint,
      expectedRevision: quote.financial.revision,
      originalManifestFingerprint: evidence.originalManifest.fingerprint,
    },
    grantedGeneration: snapshot.baseGeneration + 1,
    deadline: quote.expiresAt,
  }));
};

export class CashBackCoordinator {
  private readonly publishers: CashBackPublishers;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly activeOperations = new Map<string, Promise<void>>();

  constructor(connection: IAmqpConnection, publishers?: CashBackPublishers) {
    this.publishers = publishers ?? {
      source: new SourcePublisher(connection), outcome: new OutcomePublisher(connection),
    };
  }

  async init(): Promise<void> {
    await CashBackOperation.init();
    await Promise.all([
      this.publishers.source.initConfirmChannel(), this.publishers.outcome.initConfirmChannel(),
    ]);
  }

  async start(): Promise<void> {
    await this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce().catch(error => console.error("resulting_cash_back_recovery_failed", error));
    }, 500);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.sweep().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async sweep(): Promise<void> {
    const operations = await CashBackOperation.find({
      $or: [{ stage: { $in: ["SNAPSHOTS", "CONFIRMING"] } }, { outcomePending: true }],
    }).sort({ createdAt: 1, operationId: 1 }).limit(100);
    for (const operation of operations) {
      try {
        await this.advance(operation.operationId);
      } catch (error) {
        console.error("resulting_cash_back_operation_pending", {
          operationId: operation.operationId, error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    for (const model of [Bet, BetArchive]) {
      const pending = await model.find({ cashBackPending: { $exists: true } }).limit(100);
      for (const bet of pending) {
        if (bet.cashBackPending) {
          try {
            await this.advance(bet.cashBackPending.operation.operationId);
          } catch (error) {
            console.error("resulting_cash_back_slot_pending", {
              operationId: bet.cashBackPending.operation.operationId,
              error: error instanceof Error ? error.name : "unknown",
            });
          }
        }
      }
    }
    const unarchived = await Bet.find({
      status: ResultingStatus.BET_CASH_BACK, cashBackPending: { $exists: false },
      terminalPublicationState: "PUBLISHED",
    }).limit(100);
    for (const bet of unarchived) await archiveBet(bet);
  }

  async receiveRequest(data: ICashBackRequestEvent["data"]): Promise<void> {
    if (
      !data?.operation || !["QUOTE", "CONFIRM"].includes(data.action)
      || !Object.values(BetKind).includes(data.operation.betKind)
      || !Number.isFinite(Date.parse(data.requestedAt))
      || ![
        data.operation.operationId, data.operation.clientOperationId, data.operation.fingerprint,
        data.operation.userId, data.operation.slipId,
      ].every(value => typeof value === "string" && value.length > 0 && value.length <= 256)
    ) throw new Error("Invalid cash-back request envelope");
    let op = await CashBackOperation.findOne({ operationId: data.operation.operationId });
    if (data.action === "QUOTE") {
      if (!data.portion || !["FULL", "PARTIAL"].includes(data.portion.mode)) {
        throw new Error("Invalid cash-back portion");
      }
      if (!op) {
        const createdAt = await now();
        try {
          await CashBackOperation.updateOne(
            { operationId: data.operation.operationId },
            { $setOnInsert: {
              operationId: data.operation.operationId, operation: data.operation, request: data,
              stage: "SNAPSHOTS", snapshotRequests: [], snapshotReplies: [], createdAt,
              confirmRequested: false, outcomePending: false,
            } },
            { upsert: true }
          );
        } catch (error) {
          if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error;
        }
        op = await CashBackOperation.findOne({ operationId: data.operation.operationId });
      }
      if (!op || !isDeepStrictEqual(op.operation, data.operation)
        || !isDeepStrictEqual(op.request.portion, data.portion)) {
        throw new Error("Cash-back operation identity conflict");
      }
    } else {
      if (!op || !isDeepStrictEqual(op.operation, data.operation) || op.quote?.quoteId !== data.quoteId) {
        throw new Error("Cash-back confirmation does not match its stored quote");
      }
      if (op.stage === "QUOTED") {
        await CashBackOperation.updateOne(
          { operationId: op.operationId, stage: "QUOTED", "quote.quoteId": data.quoteId },
          { $set: { confirmRequested: true, stage: "CONFIRMING" } }
        );
      }
    }
    await CashBackOperation.updateOne(
      { operationId: data.operation.operationId, outcome: { $exists: true } },
      { $set: { outcomePending: true } }
    );
    await this.advance(data.operation.operationId);
  }

  async receiveSourceReply(data: CashBackSourceReply): Promise<void> {
    const request = data.request;
    const op = await CashBackOperation.findOne({ operationId: request.operation.operationId });
    if (!op || !isDeepStrictEqual(op.operation, request.operation)) {
      console.warn("resulting_cash_back_unknown_source_reply");
      return;
    }
    if (request.action === "SNAPSHOT") {
      const expected = op.snapshotRequests.find(item => item.requestId === request.requestId);
      if (!expected || !isDeepStrictEqual(expected, request)) throw new Error("Snapshot reply binding mismatch");
      if (data.outcome !== "SNAPSHOT" && data.outcome !== "DENIED") throw new Error("Invalid snapshot outcome");
      if (data.outcome === "SNAPSHOT" && (
        data.snapshot.evidence.owner !== request.participant.owner
        || data.snapshot.evidence.eventId !== request.participant.eventId
        || !Number.isSafeInteger(data.snapshot.baseGeneration) || data.snapshot.baseGeneration < 0
        || data.snapshot.baseGeneration > Number.MAX_SAFE_INTEGER - 2
        || ![
          data.snapshot.observedAt, data.snapshot.evidence.occurredAt, data.snapshot.evidence.kickoffAt,
          ...(data.snapshot.evidence.cutoffAt ? [data.snapshot.evidence.cutoffAt] : []),
        ].every(value => typeof value === "string" && Number.isFinite(Date.parse(value)))
      )) throw new Error("Invalid source snapshot evidence");
      await CashBackOperation.updateOne(
        {
          operationId: op.operationId, stage: "SNAPSHOTS",
          "snapshotReplies.request.requestId": { $ne: request.requestId },
        },
        { $push: { snapshotReplies: data } }
      );
    } else {
      const root = await findCanonicalBet(op.operation.slipId);
      const pending = root?.bet.cashBackPending;
      if (!root || !pending || pending.operation.operationId !== op.operationId) {
        if (op.stage === "TERMINAL") return;
        throw new Error("Source reply lacks its canonical Bet slot");
      }
      if (request.action === "RESERVE") {
        const obligation = pending.obligations.find(item => item.request.requestId === request.requestId);
        if (!obligation || !isDeepStrictEqual(obligation.request, request)) throw new Error("Grant request binding mismatch");
        if (data.outcome === "GRANTED") {
          if (
            data.grantedGeneration !== request.grantedGeneration
            || !isDeepStrictEqual(data.evidence, request.expected.evidence)
            || !Number.isFinite(Date.parse(data.decisionTime))
            || Date.parse(data.decisionTime) < Date.parse(request.expected.observedAt)
            || Date.parse(data.decisionTime) < Date.parse(request.requestedAt)
            || Date.parse(data.decisionTime) >= Date.parse(request.deadline)
          ) throw new Error("Invalid source grant evidence");
          await root.model.updateOne(
            {
              _id: root.bet._id, "cashBackPending.state": "UNDECIDED",
              "cashBackPending.operation.operationId": op.operationId,
            },
            { $set: { "cashBackPending.obligations.$[target].grant": data }, $inc: { __v: 1 } },
            { arrayFilters: [{ "target.request.requestId": request.requestId, "target.grant": { $exists: false } }] }
          );
        } else if (data.outcome === "DENIED") {
          await this.reject(root, data.reason === "DEADLINE_REACHED"
            ? (await now()).getTime() >= Date.parse(pending.quote.expiresAt) ? "QUOTE_EXPIRED" : "QUOTE_CHANGED"
            : data.reason === "QUOTE_CHANGED" || data.reason === "AUTHORITY_CHANGED" ? "QUOTE_CHANGED"
              : data.reason === "RESOLVED" || data.reason === "ARCHIVED" ? "SELECTION_RESOLVED"
                : data.reason === "SUSPENDED" ? "MARKET_UNAVAILABLE"
                  : data.reason === "MISSING" || data.reason === "UNKNOWN_AUTHORITY" ? "AUTHORITY_UNAVAILABLE"
              : "RESERVATION_DENIED");
        } else throw new Error("Invalid reservation outcome");
      } else {
        const obligation = pending.obligations.find(item => item.releaseRequest?.requestId === request.requestId);
        if (!obligation || !isDeepStrictEqual(obligation.releaseRequest, request)) throw new Error("Release reply binding mismatch");
        if (data.outcome === "RELEASED" || data.outcome === "FENCED") {
          const domainTime = data.outcome === "FENCED" ? data.observedAt : data.decisionTime;
          if (
            !Number.isSafeInteger(data.fenceGeneration)
            || data.fenceGeneration !== request.baseGeneration + 2
            || typeof domainTime !== "string" || !Number.isFinite(Date.parse(domainTime))
            || new Date(domainTime).toISOString() !== domainTime
            || (data.outcome === "FENCED" && (
              !Number.isSafeInteger(data.observedGeneration) || data.observedGeneration < data.fenceGeneration
            ))
          ) throw new Error("Invalid source cancellation fence");
          await root.model.updateOne(
            { _id: root.bet._id, "cashBackPending.operation.operationId": op.operationId },
            { $set: { "cashBackPending.obligations.$[target].released": true }, $inc: { __v: 1 } },
            { arrayFilters: [{ "target.request.requestId": request.reserveRequestId }] }
          );
        } else if (data.outcome === "DENIED") {
          console.warn("resulting_cash_back_release_pending", { operationId: op.operationId, reason: data.reason });
        } else throw new Error("Invalid release outcome");
      }
    }
    await this.advance(op.operationId);
  }

  async advance(operationId: string): Promise<void> {
    const active = this.activeOperations.get(operationId);
    if (active) return active;
    const work = this.advanceOnce(operationId).finally(() => {
      if (this.activeOperations.get(operationId) === work) this.activeOperations.delete(operationId);
    });
    this.activeOperations.set(operationId, work);
    return work;
  }

  private async advanceOnce(operationId: string): Promise<void> {
    let op = await CashBackOperation.findOne({ operationId });
    if (!op) throw new Error("Cash-back durable operation is missing");
    if (op.stage === "SNAPSHOTS") await this.prepareQuote(op);
    op = await CashBackOperation.findOne({ operationId });
    if (!op) throw new Error("Cash-back operation disappeared");
    if (op.stage === "CONFIRMING") await this.confirm(op);
    const root = await findCanonicalBet(op.operation.slipId);
    if (root?.bet.cashBackPending?.operation.operationId === op.operationId
      && root.bet.cashBackPending.state !== "UNDECIDED") {
      await this.drain(root);
    }
    op = await CashBackOperation.findOne({ operationId });
    if (op?.outcomePending && op.outcome) {
      await this.publishers.outcome.publishWithConfirm({ data: op.outcome });
      await CashBackOperation.updateOne(
        { operationId, outcomePending: true, "outcome.outcome": op.outcome.outcome },
        { $set: { outcomePending: false } }
      );
    }
  }

  private async unavailable(op: Operation, reason: CashBackUnavailableReason): Promise<void> {
    const occurredAt = (await now()).toISOString();
    await CashBackOperation.updateOne(
      { operationId: op.operationId, stage: op.stage },
      { $set: {
        stage: "UNAVAILABLE", outcomePending: true,
        outcome: { operation: op.operation, outcome: "UNAVAILABLE", reason, occurredAt },
      } }
    );
  }

  private async prepareQuote(op: Operation): Promise<void> {
    try {
      if (await BetArchive.exists({ slipId: op.operation.slipId })) {
        throw new CashBackUnavailable("BET_NOT_CONFIRMED");
      }
      const bet = assertEligible(await Bet.findOne({ slipId: op.operation.slipId }), op.operation);
      const manifest = bet.cashBackOriginalManifest!;
      if (op.snapshotRequests.length === 0) {
        const requestedAt = (await now()).toISOString();
        const eventIds = [...new Set(manifest.selections.map(selection => selection.eventId))].sort();
        const requests: CashBackSourceSnapshotRequest[] = [];
        for (const eventId of eventIds) {
          const [first, ...rest] = manifest.selections.filter(selection => selection.eventId === eventId);
          if (!first) throw new Error("Missing original event selections");
          for (const owner of ["BACKOFFICE", "GAMEMASTER"] as const) requests.push({
            action: "SNAPSHOT", requestId: cashBackHash([op.operationId, "SNAPSHOT", eventId, owner]),
            operation: op.operation, participant: { owner, eventId }, requestedAt,
            selections: [first, ...rest],
          });
        }
        await CashBackOperation.updateOne(
          { operationId: op.operationId, stage: "SNAPSHOTS", snapshotRequests: { $size: 0 } },
          { $set: { snapshotRequests: requests } }
        );
        const refreshed = await CashBackOperation.findOne({ operationId: op.operationId });
        if (!refreshed) throw new Error("Snapshot obligations disappeared");
        op = refreshed;
      }
      const denied = op.snapshotReplies.find(reply => reply.outcome === "DENIED");
      if (denied?.outcome === "DENIED") {
        throw new CashBackUnavailable(denied.reason === "RESOLVED" ? "SELECTION_RESOLVED"
          : denied.reason === "DEADLINE_REACHED" && op.operation.betKind === BetKind.PRE_MATCH ? "PRE_MATCH_CUTOFF"
            : denied.reason === "SUSPENDED" || denied.reason === "QUOTE_CHANGED" ? "MARKET_UNAVAILABLE"
              : "AUTHORITY_UNAVAILABLE");
      }
      const sources: CashBackSourceSnapshot[] = [];
      for (const request of op.snapshotRequests) {
        const reply = op.snapshotReplies.find(item => item.request.requestId === request.requestId);
        if (!reply) {
          await this.publishers.source.publishWithConfirm({ data: request });
          return;
        }
        if (reply.outcome !== "SNAPSHOT") throw new Error("Unexpected snapshot response");
        sources.push(reply.snapshot);
      }
      const currentQuotes: CashBackSelectionQuote[] = manifest.selections.map(selection => {
        if (selection.betKind === BetKind.PRE_MATCH) {
          const cutoff = Math.min(...sources.filter(source => source.evidence.eventId === selection.eventId)
            .map(source => Date.parse(source.evidence.kickoffAt)));
          return {
            betKind: BetKind.PRE_MATCH, slipRowId: selection.slipRowId, eventId: selection.eventId,
            productId: selection.productId, oddsId: selection.oddsId, odds: selection.acceptedOdds,
            quoteValidUntil: new Date(cutoff).toISOString(),
            quoteFingerprint: cashBackHash([selection, cutoff]),
          };
        }
        const source = sources.find(item => item.evidence.owner === "GAMEMASTER"
          && item.evidence.eventId === selection.eventId)?.evidence;
        if (!source || source.owner !== "GAMEMASTER" || source.quoteEvidence.kind !== "LIVE") {
          throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
        }
        const quotes = source.quoteEvidence.quotes.filter(quote =>
          quote.slipRowId === selection.slipRowId && quote.eventId === selection.eventId
          && quote.marketId === selection.marketId && quote.marketVersion === selection.marketVersion
          && quote.selectionId === selection.selectionId && quote.oddsId === selection.oddsId
          && quote.productId === selection.productId && quote.marketType === selection.marketType
        );
        if (quotes.length !== 1) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
        return quotes[0];
      });
      const [firstQuote, ...otherQuotes] = currentQuotes;
      const [firstSource, ...otherSources] = sources;
      if (!firstQuote || !firstSource) throw new CashBackUnavailable("AUTHORITY_UNAVAILABLE");
      const issuedAt = await now();
      const expiresAt = new Date(Math.min(
        issuedAt.getTime() + 7_000,
        ...currentQuotes.map(quote => Date.parse(quote.quoteValidUntil)),
        ...sources.map(source => source.evidence.cutoffAt ? Date.parse(source.evidence.cutoffAt) : Infinity)
      ));
      if (!(expiresAt.getTime() > issuedAt.getTime())) throw new CashBackUnavailable("QUOTE_EXPIRED");
      const financial = financialSnapshot(bet);
      if (financial.status !== BetStatus.CONFIRMED) throw new CashBackUnavailable("BET_NOT_CONFIRMED");
      const acceptedCombinedOdds = combinedOdds(manifest.selections.map(selection => selection.acceptedOdds));
      const currentCombinedOdds = combinedOdds(currentQuotes.map(quote => quote.odds));
      const amounts = priceCashBack(financial, op.request.portion, acceptedCombinedOdds, currentCombinedOdds);
      const common = {
        operation: reference(op.operation), quoteId: randomBytes(32).toString("hex"),
        policyVersion: "cash-back-v1", issuer: "RESULTING" as const,
        issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(),
        financial: { ...financial, status: BetStatus.CONFIRMED as const },
        ...amounts, acceptedCombinedOdds, currentCombinedOdds,
      };
      const quote: CashBackQuote = op.request.portion.mode === "FULL"
        ? { ...common, mode: "FULL", remainingStakeMinorAfter: 0 }
        : { ...common, mode: "PARTIAL" };
      const evidence: CashBackQuoteEvidence = {
        originalManifest: { fingerprint: manifest.fingerprint, selections: manifest.selections },
        anySelectionResolved: false,
        currentQuotes: [firstQuote, ...otherQuotes], sources: [firstSource, ...otherSources],
        quoteFingerprint: cashBackHash([quote, manifest.fingerprint, currentQuotes, sources]),
      };
      await CashBackOperation.updateOne(
        { operationId: op.operationId, stage: "SNAPSHOTS" },
        { $set: {
          stage: "QUOTED", quote, evidence, outcomePending: true,
          outcome: { operation: op.operation, outcome: "QUOTED", quote, evidence },
        } }
      );
    } catch (error) {
      if (!(error instanceof CashBackUnavailable)) throw error;
      await this.unavailable(op, error.reason);
    }
  }

  private async confirm(op: Operation): Promise<void> {
    let root = await findCanonicalBet(op.operation.slipId);
    if (!root) throw new Error("Missing active and archived Bet is not rejection authority");
    if (
      root.bet.userId !== op.operation.userId || root.bet.betKind !== op.operation.betKind
      || !op.quote || !op.evidence
    ) throw new Error("Confirmation ownership or quote binding mismatch");
    if (root.bet.cashBackArchiving) return;
    if (root.bet.cashBackPending?.operation.operationId !== op.operationId) {
      if (root.bet.cashBackPending) {
        // No second operation acquires holds. Once this slot drains, its
        // decision has advanced the revision and this proposal is rejected.
        return;
      }
      const financial = financialSnapshot(root.bet);
      const pending: CashBackPending = {
        state: "UNDECIDED", operation: op.operation, quote: op.quote, evidence: op.evidence,
        obligations: reserveRequests(op).map(request => ({ request, released: false })),
        historyPersisted: false, outcomePublished: false,
      };
      await root.model.updateOne(
        {
          _id: root.bet._id, cashBackPending: { $exists: false }, cashBackArchiving: { $ne: true },
          "cashBackFinancial.revision": financial.revision,
        },
        { $set: { cashBackPending: pending }, $inc: { __v: 1 } }
      );
      root = await findCanonicalBet(op.operation.slipId);
    }
    if (!root || root.bet.cashBackPending?.operation.operationId !== op.operationId) return;
    const pending = root.bet.cashBackPending;
    if (pending.state !== "UNDECIDED") return;
    const financial = financialSnapshot(root.bet);
    if (!isDeepStrictEqual(financial, pending.quote.financial)) return this.reject(root, "STALE_REVISION");
    if (root.model === BetArchive || root.bet.status !== ResultingStatus.BET_APPROVED) return this.reject(root, "BET_NOT_CONFIRMED");
    if (root.bet.cashBackAnySelectionResolved) return this.reject(root, "SELECTION_RESOLVED");
    if ((await now()).getTime() >= Date.parse(pending.quote.expiresAt)) return this.reject(root, "QUOTE_EXPIRED");
    for (const obligation of pending.obligations) {
      if (!obligation.grant) {
        await this.publishers.source.publishWithConfirm({ data: obligation.request });
        return;
      }
    }
    const selections = pending.evidence.originalManifest.selections;
    const liveKeys = selections.filter(selection => selection.betKind === BetKind.LIVE)
      .map(selection => ({ eventId: selection.eventId, marketId: selection.marketId, marketVersion: selection.marketVersion }));
    if (
      await FinalScoreLedger.exists({ eventId: { $in: [...new Set(selections.map(selection => selection.eventId))] } })
      || (liveKeys.length > 0 && await LiveSettlementLedger.exists({ $or: liveKeys }))
    ) return this.reject(root, "SELECTION_RESOLVED");
    const quote = pending.quote;
    const nextFinancial: CashBackFinancialSnapshot = {
      ...financial, revision: financial.revision + 1,
      status: quote.mode === "FULL" ? BetStatus.CASH_BACK : BetStatus.CONFIRMED,
      remainingStakeMinor: quote.remainingStakeMinorAfter,
      cumulativeClosedStakeMinor: financial.cumulativeClosedStakeMinor + quote.closedStakeMinor,
      cumulativeReturnMinor: financial.cumulativeReturnMinor + quote.returnMinor,
    };
    validateFinancialSnapshot(nextFinancial);
    const result = await root.model.updateOne(
      {
        _id: root.bet._id, status: ResultingStatus.BET_APPROVED,
        "cashBackFinancial.revision": quote.financial.revision,
        "cashBackFinancial.originalStakeMinor": quote.financial.originalStakeMinor,
        "cashBackFinancial.remainingStakeMinor": quote.financial.remainingStakeMinor,
        "cashBackFinancial.cumulativeClosedStakeMinor": quote.financial.cumulativeClosedStakeMinor,
        "cashBackFinancial.cumulativeReturnMinor": quote.financial.cumulativeReturnMinor,
        cashBackAnySelectionResolved: false,
        "cashBackOriginalManifest.fingerprint": pending.evidence.originalManifest.fingerprint,
        "cashBackPending.state": "UNDECIDED",
        "cashBackPending.operation.operationId": op.operationId,
        "cashBackPending.operation.fingerprint": op.operation.fingerprint,
        rows: { $not: { $elemMatch: { result: { $ne: ResultingStatus.ROW_NO_RESULT } } } },
        $expr: cashBackBeforeDeadline,
      },
      [{ $set: {
        status: quote.mode === "FULL" ? ResultingStatus.BET_CASH_BACK : ResultingStatus.BET_APPROVED,
        cashBackFinancial: { $literal: nextFinancial },
        "cashBackPending.state": "ACCEPTED",
        "cashBackPending.receipt": {
          outcome: "ACCEPTED", mode: quote.mode,
          decisionId: cashBackHash([op.operationId, op.operation.fingerprint, "decision"]),
          decisionTime: mongoDecisionTime, quote: { $literal: quote },
          financial: { $literal: nextFinancial },
        },
        __v: { $add: [{ $ifNull: ["$__v", 0] }, 1] },
      } }]
    );
    if (result.modifiedCount === 0) {
      const winner = await findCanonicalBet(op.operation.slipId);
      if (
        winner?.bet.cashBackPending?.state === "UNDECIDED"
        && winner.bet.cashBackPending.operation.operationId === op.operationId
        && winner.bet.cashBackPending.operation.fingerprint === op.operation.fingerprint
      ) {
        await this.reject(winner, (await now()).getTime() >= Date.parse(quote.expiresAt) ? "QUOTE_EXPIRED" : "STALE_REVISION");
      }
    }
  }

  private async reject(root: CanonicalBet, reason: CashBackUnavailableReason): Promise<void> {
    const pending = root.bet.cashBackPending;
    if (!pending || pending.state !== "UNDECIDED") return;
    const financial = financialSnapshot(root.bet);
    const after = { ...financial, revision: financial.revision + 1 };
    await root.model.updateOne(
      {
        _id: root.bet._id, "cashBackFinancial.revision": financial.revision,
        "cashBackPending.state": "UNDECIDED",
        "cashBackPending.operation.operationId": pending.operation.operationId,
        "cashBackPending.operation.fingerprint": pending.operation.fingerprint,
        ...(reason === "QUOTE_EXPIRED" ? { $expr: cashBackAtOrAfterDeadline } : {}),
      },
      [{ $set: {
        cashBackFinancial: { $literal: after },
        "cashBackPending.state": "REJECTED",
        "cashBackPending.receipt": rejectionReceiptExpression(root.bet, after, reason),
        __v: { $add: [{ $ifNull: ["$__v", 0] }, 1] },
      } }]
    );
  }

  private async drain(root: CanonicalBet): Promise<void> {
    const pending = root.bet.cashBackPending;
    const receipt = pending?.receipt;
    if (!pending || pending.state === "UNDECIDED" || !receipt) throw new Error("Terminal slot lacks its canonical receipt");
    const receiptFingerprint = cashBackHash(receipt);
    const operationId = pending.operation.operationId;
    const outcome: ICashBackOutcomeEvent["data"] = receipt.outcome === "ACCEPTED"
      ? { outcome: "ACCEPTED", operation: pending.operation, receipt, receiptFingerprint }
      : { outcome: "REJECTED", operation: pending.operation, receipt, receiptFingerprint };
    const stored = await CashBackOperation.findOne({ operationId });
    if (!stored) throw new Error("Canonical cash-back receipt has no durable operation record");
    if (stored.stage === "TERMINAL" && !isDeepStrictEqual(stored.outcome, outcome)) {
      throw new Error("Cash-back immutable receipt conflict");
    }
    await CashBackOperation.updateOne(
      { operationId },
      { $set: {
        stage: "TERMINAL", outcome,
        ...(!pending.outcomePublished ? { outcomePending: true } : {}),
      } }
    );
    await root.model.updateOne(
      { _id: root.bet._id, "cashBackPending.operation.operationId": operationId },
      { $set: { "cashBackPending.historyPersisted": true, "cashBackPending.receiptFingerprint": receiptFingerprint } }
    );
    if (!pending.outcomePublished) {
      await this.publishers.outcome.publishWithConfirm({ data: outcome });
      await root.model.updateOne(
        { _id: root.bet._id, "cashBackPending.operation.operationId": operationId },
        { $set: { "cashBackPending.outcomePublished": true } }
      );
      await CashBackOperation.updateOne({ operationId, stage: "TERMINAL" }, { $set: { outcomePending: false } });
    }
    for (const obligation of pending.obligations) {
      if (obligation.released) continue;
      const request = obligation.releaseRequest ?? {
        action: "RELEASE" as const,
        requestId: cashBackHash([operationId, "RELEASE", obligation.request.requestId]),
        operation: pending.operation, participant: obligation.request.participant,
        requestedAt: receipt.decisionTime, reserveRequestId: obligation.request.requestId,
        baseGeneration: obligation.request.expected.baseGeneration,
        grantedGeneration: obligation.request.grantedGeneration,
        decision: {
          issuer: "RESULTING" as const, decisionId: receipt.decisionId, receiptFingerprint,
          outcome: receipt.outcome, quoteId: pending.quote.quoteId,
          quoteFingerprint: pending.evidence.quoteFingerprint,
          expectedRevision: pending.quote.financial.revision,
          revision: receipt.financial.revision, decisionTime: receipt.decisionTime,
        },
      };
      await root.model.updateOne(
        { _id: root.bet._id, "cashBackPending.operation.operationId": operationId },
        { $set: { "cashBackPending.obligations.$[target].releaseRequest": request } },
        { arrayFilters: [{ "target.request.requestId": obligation.request.requestId, "target.releaseRequest": { $exists: false } }] }
      );
      await this.publishers.source.publishWithConfirm({ data: request });
    }
    const cleared = await root.model.findOneAndUpdate(
      {
        _id: root.bet._id, "cashBackPending.operation.operationId": operationId,
        "cashBackPending.historyPersisted": true, "cashBackPending.outcomePublished": true,
        "cashBackPending.obligations": { $not: { $elemMatch: { released: { $ne: true } } } },
      },
      {
        $unset: { cashBackPending: 1 }, $inc: { __v: 1 },
        ...(root.bet.status === ResultingStatus.BET_CASH_BACK
          ? { $set: { terminalPublicationState: "PUBLISHED" } } : {}),
      },
      { new: true }
    );
    if (cleared?.status === ResultingStatus.BET_CASH_BACK && root.model === Bet) await archiveBet(cleared);
  }
}

let coordinator: CashBackCoordinator | undefined;
export const getCashBackCoordinator = (connection: IAmqpConnection): CashBackCoordinator =>
  coordinator ?? (coordinator = new CashBackCoordinator(connection));
