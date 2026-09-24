import { createHash } from "crypto";
import { isDeepStrictEqual } from "util";
import {
  APublisher, BetKind, BetStatus, CashBackConfirmRequest, CashBackQuoteRequest,
  CashBackFinancialSnapshot, CashBackQuote, CashBackReceipt,
  IAmqpConnection, ICashBackOutcomeEvent, ICashBackRequestEvent, QueueNames,
} from "@betstan/common";
import { Bet } from "../model/Bet";
import { CashBackOperation } from "../model/CashBackOperation";
import { applyCashBackFinancial, cashBackReceiptHash, validateCashBackFinancial } from "./cashBackFinancial";
import { saveBetWithOptimisticRetry } from "./betHistory";

type Operation = ReturnType<typeof CashBackOperation.hydrate>;

export class CashBackHttpError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

class CashBackRequestPublisher extends APublisher<ICashBackRequestEvent> {
  queue = QueueNames.CASH_BACK_REQUEST;
  serviceName = "bet_cash_back_request";
}

const hash = (value: readonly unknown[]): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const databaseTime = async (): Promise<Date> => {
  const response = await Bet.db.db.command({ hello: 1 });
  if (!(response.localTime instanceof Date)) throw new Error("Bet Mongo domain time unavailable");
  return response.localTime;
};

const publicFinancial = (financial: CashBackFinancialSnapshot) => ({
  revision: financial.revision, status: financial.status,
  originalStakeMinor: financial.originalStakeMinor, remainingStakeMinor: financial.remainingStakeMinor,
  cumulativeClosedStakeMinor: financial.cumulativeClosedStakeMinor,
  cumulativeReturnMinor: financial.cumulativeReturnMinor,
});
const publicReference = (operation: CashBackQuote["operation"]) => ({
  operationId: operation.operationId, clientOperationId: operation.clientOperationId,
  slipId: operation.slipId, betKind: operation.betKind,
});
const publicQuote = (quote: CashBackQuote) => ({
  operation: publicReference(quote.operation), quoteId: quote.quoteId,
  mode: quote.mode, policyVersion: quote.policyVersion, issuer: quote.issuer,
  issuedAt: quote.issuedAt, expiresAt: quote.expiresAt,
  financial: publicFinancial(quote.financial), closedStakeMinor: quote.closedStakeMinor,
  remainingStakeMinorAfter: quote.remainingStakeMinorAfter, returnMinor: quote.returnMinor,
  acceptedCombinedOdds: quote.acceptedCombinedOdds, currentCombinedOdds: quote.currentCombinedOdds,
});
const publicReceipt = (receipt: CashBackReceipt) => ({
  outcome: receipt.outcome, decisionId: receipt.decisionId, decisionTime: receipt.decisionTime,
  financial: publicFinancial(receipt.financial),
  ...(receipt.outcome === "ACCEPTED"
    ? { mode: receipt.mode, quote: publicQuote(receipt.quote) }
    : {
        operation: publicReference(receipt.operation), quoteId: receipt.quoteId,
        expectedRevision: receipt.expectedRevision, reason: receipt.reason,
      }),
});

export const cashBackOperationDto = (record: Operation) => ({
  operationId: record.operationId,
  clientOperationId: record.operation.clientOperationId,
  slipId: record.operation.slipId,
  betKind: record.operation.betKind,
  state: record.state,
  ...(record.quote ? { quote: publicQuote(record.quote) } : {}),
  ...(record.receipt ? { receipt: publicReceipt(record.receipt) } : {}),
  ...(record.reason ? { reason: record.reason } : {}),
});

const ownedBet = async (userId: string, slipId: string) => {
  const bet = await Bet.findOne({ userId, slipId });
  if (!bet) throw new CashBackHttpError(404, "BET_NOT_FOUND");
  return bet;
};

export class CashBackFacade {
  private readonly publisher: Pick<CashBackRequestPublisher, "initConfirmChannel" | "publishWithConfirm">;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    connection: IAmqpConnection,
    publisher?: Pick<CashBackRequestPublisher, "initConfirmChannel" | "publishWithConfirm">
  ) {
    this.publisher = publisher ?? new CashBackRequestPublisher(connection);
  }

  async init(): Promise<void> {
    await CashBackOperation.init();
    await this.publisher.initConfirmChannel();
  }

  async start(): Promise<void> {
    await this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce().catch(error => console.error("bet_cash_back_recovery_failed", error));
    }, 500);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async quote(userId: string, slipId: string, request: CashBackQuoteRequest): Promise<Operation> {
    const bet = await ownedBet(userId, slipId);
    const betKind = bet.betKind ?? BetKind.PRE_MATCH;
    const operationId = hash(["cash-back", userId, slipId, betKind, request.clientOperationId]);
    const fingerprint = hash([
      operationId, request.portion.mode, request.portion.mode === "PARTIAL" ? request.portion.stakeMinor : null,
    ]);
    let operation = await CashBackOperation.findOne({ operationId });
    if (operation) {
      if (operation.operation.fingerprint !== fingerprint) throw new CashBackHttpError(409, "OPERATION_CONFLICT");
      return operation;
    }
    if (bet.status !== BetStatus.CONFIRMED) throw new CashBackHttpError(409, "BET_NOT_CONFIRMED");
    const createdAt = await databaseTime();
    const identity = {
      operationId, fingerprint, userId, slipId, betKind, clientOperationId: request.clientOperationId,
    };
    try {
      await CashBackOperation.updateOne(
        { operationId },
        { $setOnInsert: {
          operationId, operation: identity, state: "QUOTE_PENDING", createdAt, projectionPending: false,
          quoteRequest: {
            action: "QUOTE", operation: identity, requestedAt: createdAt.toISOString(), portion: request.portion,
          },
        } },
        { upsert: true }
      );
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === 11000)) throw error;
    }
    operation = await CashBackOperation.findOne({ operationId });
    if (!operation || operation.operation.fingerprint !== fingerprint) throw new CashBackHttpError(409, "OPERATION_CONFLICT");
    return operation;
  }

  async confirm(userId: string, slipId: string, request: CashBackConfirmRequest): Promise<Operation> {
    const bet = await ownedBet(userId, slipId);
    const operationId = hash(["cash-back", userId, slipId, bet.betKind ?? BetKind.PRE_MATCH, request.clientOperationId]);
    const operation = await CashBackOperation.findOne({ operationId, "operation.userId": userId, "operation.slipId": slipId });
    if (!operation) throw new CashBackHttpError(404, "OPERATION_NOT_FOUND");
    if (operation.quote?.quoteId !== request.quoteId) throw new CashBackHttpError(409, "QUOTE_CHANGED");
    if (["CONFIRM_PENDING", "ACCEPTED", "REJECTED"].includes(operation.state)) return operation;
    if (operation.state !== "QUOTED") throw new CashBackHttpError(409, "QUOTE_UNAVAILABLE");
    const requestedAt = (await databaseTime()).toISOString();
    await CashBackOperation.updateOne(
      { operationId, state: "QUOTED", "quote.quoteId": request.quoteId },
      { $set: {
        state: "CONFIRM_PENDING",
        confirmRequest: { action: "CONFIRM", operation: operation.operation, requestedAt, quoteId: request.quoteId },
      } }
    );
    const stored = await CashBackOperation.findOne({ operationId });
    if (!stored) throw new Error("Durable cash-back confirmation disappeared");
    return stored;
  }

  async status(userId: string, slipId: string, operationId: string): Promise<Operation> {
    const operation = await CashBackOperation.findOne({
      operationId, "operation.userId": userId, "operation.slipId": slipId,
    });
    if (!operation) throw new CashBackHttpError(404, "OPERATION_NOT_FOUND");
    return operation;
  }

  async history(userId: string, slipId: string, cursor?: string) {
    await ownedBet(userId, slipId);
    let after: { decisionTime: string; operationId: string } | undefined;
    if (cursor) {
      try {
        const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (
          !decoded || typeof decoded !== "object" || !("decisionTime" in decoded) || !("operationId" in decoded)
          || typeof decoded.decisionTime !== "string" || !Number.isFinite(Date.parse(decoded.decisionTime))
          || new Date(decoded.decisionTime).toISOString() !== decoded.decisionTime
          || typeof decoded.operationId !== "string" || !/^[a-f0-9]{64}$/.test(decoded.operationId)
        ) throw new CashBackHttpError(400, "INVALID_CURSOR");
        after = { decisionTime: decoded.decisionTime, operationId: decoded.operationId };
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof CashBackHttpError) throw new CashBackHttpError(400, "INVALID_CURSOR");
        throw error;
      }
    }
    const rows = await CashBackOperation.find({
      "operation.userId": userId, "operation.slipId": slipId, state: "ACCEPTED",
      ...(after ? { $or: [
        { "receipt.decisionTime": { $lt: after.decisionTime } },
        { "receipt.decisionTime": after.decisionTime, operationId: { $lt: after.operationId } },
      ] } : {}),
    }).sort({ "receipt.decisionTime": -1, operationId: -1 }).limit(21);
    const page = rows.slice(0, 20);
    const last = page[page.length - 1];
    return {
      items: page.map(record => {
        if (!record.receipt) throw new Error("Cash-back history lacks its immutable receipt");
        return publicReceipt(record.receipt);
      }),
      nextCursor: rows.length > 20 && last?.receipt
        ? Buffer.from(JSON.stringify({ decisionTime: last.receipt.decisionTime, operationId: last.operationId })).toString("base64url")
        : null,
    };
  }

  async receiveOutcome(data: ICashBackOutcomeEvent["data"]): Promise<void> {
    const operation = await CashBackOperation.findOne({ operationId: data.operation.operationId });
    if (!operation || !isDeepStrictEqual(operation.operation, data.operation)) throw new Error("Cash-back outcome ownership/fingerprint mismatch");
    if (data.outcome === "QUOTED") {
      if (
        data.quote.operation.operationId !== operation.operationId
        || data.quote.operation.slipId !== operation.operation.slipId
        || data.quote.operation.clientOperationId !== operation.operation.clientOperationId
        || data.quote.operation.betKind !== operation.operation.betKind
      ) throw new Error("Cash-back offer identity mismatch");
      const bet = await ownedBet(operation.operation.userId, operation.operation.slipId);
      validateCashBackFinancial(data.quote.financial, bet.wager);
      if (
        data.quote.mode !== operation.quoteRequest.portion.mode
        || data.quote.financial.status !== BetStatus.CONFIRMED
        || !Number.isSafeInteger(data.quote.closedStakeMinor) || data.quote.closedStakeMinor < 1
        || !Number.isSafeInteger(data.quote.returnMinor) || data.quote.returnMinor < 1
        || data.quote.closedStakeMinor + data.quote.remainingStakeMinorAfter !== data.quote.financial.remainingStakeMinor
        || (data.quote.mode === "FULL" && data.quote.remainingStakeMinorAfter !== 0)
        || (data.quote.mode === "PARTIAL" && data.quote.remainingStakeMinorAfter < 1)
        || (operation.quoteRequest.portion.mode === "PARTIAL"
          && data.quote.closedStakeMinor !== operation.quoteRequest.portion.stakeMinor)
        || !Number.isFinite(Date.parse(data.quote.issuedAt))
        || !Number.isFinite(Date.parse(data.quote.expiresAt))
        || Date.parse(data.quote.expiresAt) - Date.parse(data.quote.issuedAt) > 7_000
        || Date.parse(data.quote.expiresAt) <= Date.parse(data.quote.issuedAt)
      ) throw new Error("Invalid stored cash-back offer");
      if (operation.quote && !isDeepStrictEqual(operation.quote, data.quote)) throw new Error("Immutable cash-back quote conflict");
      await CashBackOperation.updateOne(
        { operationId: operation.operationId, state: { $in: ["QUOTE_PENDING", "QUOTED"] } },
        { $set: { state: "QUOTED", quote: data.quote } }
      );
      return;
    }
    if (data.outcome === "UNAVAILABLE") {
      await CashBackOperation.updateOne(
        { operationId: operation.operationId, state: { $in: ["QUOTE_PENDING", "CONFIRM_PENDING"] } },
        { $set: { state: "UNAVAILABLE", reason: data.reason } }
      );
      return;
    }
    const receipt = data.receipt;
    const quote = operation.quote;
    if (
      !quote || !operation.confirmRequest || receipt.outcome !== data.outcome
      || !receipt.decisionId || !data.receiptFingerprint || !Number.isFinite(Date.parse(receipt.decisionTime))
      || data.receiptFingerprint !== cashBackReceiptHash(receipt)
      || receipt.financial.originalStakeMinor !== quote.financial.originalStakeMinor
      || !Number.isSafeInteger(receipt.financial.revision)
      || receipt.financial.revision <= quote.financial.revision
    ) throw new Error("Invalid cash-back terminal receipt binding");
    if (receipt.outcome === "ACCEPTED") {
      if (
        !isDeepStrictEqual(receipt.quote, quote) || receipt.mode !== quote.mode
        || Date.parse(receipt.decisionTime) >= Date.parse(quote.expiresAt)
        || receipt.financial.revision !== quote.financial.revision + 1
        || receipt.financial.remainingStakeMinor !== quote.remainingStakeMinorAfter
        || receipt.financial.cumulativeClosedStakeMinor !== quote.financial.cumulativeClosedStakeMinor + quote.closedStakeMinor
        || receipt.financial.cumulativeReturnMinor !== quote.financial.cumulativeReturnMinor + quote.returnMinor
        || receipt.financial.status !== (quote.mode === "FULL" ? BetStatus.CASH_BACK : BetStatus.CONFIRMED)
      ) throw new Error("Cash-back acceptance differs from its confirmed offer");
    } else if (
      !isDeepStrictEqual(receipt.operation, quote.operation)
      || receipt.quoteId !== quote.quoteId || receipt.expectedRevision !== quote.financial.revision
    ) throw new Error("Cash-back rejection differs from its operation");
    const currentBet = await Bet.findOne({ slipId: operation.operation.slipId });
    if (currentBet) {
      if (currentBet.userId !== operation.operation.userId) throw new Error("Receipt owner differs from placed Bet");
      validateCashBackFinancial(receipt.financial, currentBet.wager);
    }
    if (operation.receipt) {
      if (!isDeepStrictEqual(operation.receipt, data.receipt)
        || operation.receiptFingerprint !== data.receiptFingerprint) {
        throw new Error("Immutable cash-back receipt conflict");
      }
    } else {
      await CashBackOperation.updateOne(
        { operationId: operation.operationId, receipt: { $exists: false } },
        { $set: {
          state: data.outcome, receipt: data.receipt, receiptFingerprint: data.receiptFingerprint,
          projectionPending: true,
        } }
      );
    }
    const stored = await CashBackOperation.findOne({ operationId: operation.operationId });
    if (!stored || !isDeepStrictEqual(stored.receipt, data.receipt)
      || stored.receiptFingerprint !== data.receiptFingerprint) {
      throw new Error("Competing cash-back receipts disagree");
    }
    await this.project(operation.operationId);
  }

  private async project(operationId: string): Promise<void> {
    const operation = await CashBackOperation.findOne({ operationId, projectionPending: true });
    if (!operation?.receipt) return;
    const bet = await Bet.findOne({ slipId: operation.operation.slipId });
    if (!bet) return;
    if (bet.userId !== operation.operation.userId || (bet.betKind ?? BetKind.PRE_MATCH) !== operation.operation.betKind) {
      throw new Error("Cash-back projection does not own its Bet");
    }
    const receipt = operation.receipt;
    await saveBetWithOptimisticRetry(bet, current => applyCashBackFinancial(current, receipt.financial));
    if (!await Bet.exists({
      _id: bet._id, userId: operation.operation.userId,
      "cashBackFinancial.revision": { $gte: receipt.financial.revision },
    })) return;
    await CashBackOperation.updateOne(
      { operationId, receiptFingerprint: operation.receiptFingerprint },
      { $set: { projectionPending: false } }
    );
  }

  async runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.sweep().finally(() => { this.running = undefined; });
    return this.running;
  }

  private async sweep(): Promise<void> {
    const pending = await CashBackOperation.find({
      $or: [{ state: { $in: ["QUOTE_PENDING", "CONFIRM_PENDING"] } }, { projectionPending: true }],
    }).sort({ createdAt: 1, operationId: 1 }).limit(100);
    for (const operation of pending) {
      try {
        if (operation.projectionPending) await this.project(operation.operationId);
        if (operation.state === "QUOTE_PENDING" || operation.state === "CONFIRM_PENDING") {
          const request = operation.state === "QUOTE_PENDING" ? operation.quoteRequest : operation.confirmRequest;
          if (!request) throw new Error("Pending operation has no durable request");
          await this.publisher.publishWithConfirm({ data: request });
        }
      } catch (error) {
        console.error("bet_cash_back_operation_pending", {
          operationId: operation.operationId, error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }
}

let facade: CashBackFacade | undefined;
export const getCashBackFacade = (connection: IAmqpConnection): CashBackFacade =>
  facade ?? (facade = new CashBackFacade(connection));
