import request from "supertest";
import {
  BetKind, BetStatus, BettingStatus, CashBackAcceptedReceipt, CashBackQuote,
  CashBackQuoteEvidence, EventPhase, EventStatus, EventVisibility, ICashBackOutcomeEvent,
  messengerWrapper, ModerationStatus, ResultingStatus, SlipRowStatus,
} from "@betstan/common";
import { app } from "../../app";
import { Bet } from "../../model/Bet";
import { CashBackOperation } from "../../model/CashBackOperation";
import { CashBackFacade, getCashBackFacade } from "../../service/CashBackFacade";
import { cashBackReceiptHash } from "../../service/cashBackFinancial";
import { applyBetEventWithRetry, applyModerationResult, applySettleSlip, applySettleSlipRow } from "../../service/betHistory";

const owner = JSON.stringify({ id: "owner" });
const other = JSON.stringify({ id: "other" });
const prefix = "/api/bet/slip/cash-back";

beforeAll(async () => { await CashBackOperation.init(); });

const createBet = async () => Bet.create({
  userId: "owner", userName: "Owner", slipId: "slip", status: BetStatus.CONFIRMED,
  wager: 100, timestamp: new Date().toISOString(), betKind: BetKind.PRE_MATCH,
  rows: [{
    id: "row", eventId: "event", eventName: "A - B", productId: "product",
    productName: "1X2", oddsId: "home", oddsName: "A", oddsValue: 3,
    timestamp: new Date().toISOString(), status: SlipRowStatus.NOT_SETTLED,
  }],
});

const createQuote = async (clientOperationId = "partial", full = false) => {
  const response = await request(app).post(`${prefix}/quote`).set("currentUser", owner)
    .send({
      action: "QUOTE", clientOperationId,
      portion: full ? { mode: "FULL" } : { mode: "PARTIAL", stakeMinor: 4000 },
    }).expect(202);
  const operation = await CashBackOperation.findOne({ operationId: response.body.operationId });
  if (!operation) throw new Error("Missing durable operation");
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 7000).toISOString();
  const financial = {
    revision: 1, status: BetStatus.CONFIRMED as const, originalStakeMinor: 10000,
    remainingStakeMinor: 10000, cumulativeClosedStakeMinor: 0, cumulativeReturnMinor: 0,
  };
  const common = {
    operation: {
      operationId: operation.operationId, clientOperationId, slipId: "slip", betKind: BetKind.PRE_MATCH,
    },
    quoteId: `quote-${clientOperationId}`, policyVersion: "cash-back-v1", issuer: "RESULTING" as const,
    issuedAt: issuedAt.toISOString(), expiresAt, financial,
    acceptedCombinedOdds: "3", currentCombinedOdds: "3",
  };
  const quote: CashBackQuote = full
    ? { ...common, mode: "FULL", closedStakeMinor: 10000, remainingStakeMinorAfter: 0, returnMinor: 10000 }
    : { ...common, mode: "PARTIAL", closedStakeMinor: 4000, remainingStakeMinorAfter: 6000, returnMinor: 4000 };
  const selection = {
    betKind: BetKind.PRE_MATCH as const, slipRowId: "row", eventId: "event",
    productId: "product", oddsId: "home",
  };
  const source = {
    eventId: "event", authorityFingerprint: "private-authority-proof",
    occurredAt: issuedAt.toISOString(), kickoffAt: new Date(Date.now() + 60_000).toISOString(), cutoffAt: null,
  };
  const evidence: CashBackQuoteEvidence = {
    quoteFingerprint: "private-quote-proof", anySelectionResolved: false,
    originalManifest: { fingerprint: "private-manifest", selections: [{ ...selection, acceptedOdds: "3" }] },
    currentQuotes: [{ ...selection, odds: "3", quoteFingerprint: "current", quoteValidUntil: expiresAt }],
    sources: [
      { baseGeneration: 0, observedAt: issuedAt.toISOString(), evidence: {
        ...source, owner: "BACKOFFICE",
        lifecycle: { status: EventStatus.NO_RESULT, visibility: EventVisibility.ONLINE },
        quoteEvidence: { kind: "LIFECYCLE_ONLY" },
      } },
      { baseGeneration: 0, observedAt: issuedAt.toISOString(), evidence: {
        ...source, owner: "GAMEMASTER",
        lifecycle: { status: EventStatus.NO_RESULT, phase: EventPhase.PRE_MATCH, bettingStatus: BettingStatus.OPEN, sequence: 0 },
        quoteEvidence: { kind: "PRE_MATCH_STATIC" },
      } },
    ],
  };
  const facade = getCashBackFacade(messengerWrapper.connection);
  await facade.receiveOutcome({ outcome: "QUOTED", operation: operation.operation, quote, evidence });
  return { operation, quote, facade };
};

const accept = async (full = false) => {
  const prepared = await createQuote(full ? "full" : "partial", full);
  await request(app).post(`${prefix}/accept`).set("currentUser", owner)
    .send({ action: "CONFIRM", clientOperationId: prepared.operation.operation.clientOperationId, quoteId: prepared.quote.quoteId })
    .expect(202);
  const quote = prepared.quote;
  const receipt: CashBackAcceptedReceipt = quote.mode === "FULL" ? {
    outcome: "ACCEPTED", mode: "FULL", quote, decisionId: "decision", decisionTime: new Date().toISOString(),
    financial: {
      ...quote.financial, revision: 2, status: BetStatus.CASH_BACK, remainingStakeMinor: 0,
      cumulativeClosedStakeMinor: 10000, cumulativeReturnMinor: 10000,
    },
  } : {
    outcome: "ACCEPTED", mode: "PARTIAL", quote, decisionId: "decision", decisionTime: new Date().toISOString(),
    financial: {
      ...quote.financial, revision: 2, status: BetStatus.CONFIRMED, remainingStakeMinor: 6000,
      cumulativeClosedStakeMinor: 4000, cumulativeReturnMinor: 4000,
    },
  };
  const outcome: ICashBackOutcomeEvent["data"] = {
    outcome: "ACCEPTED", operation: prepared.operation.operation, receipt,
    receiptFingerprint: cashBackReceiptHash(receipt),
  };
  return { ...prepared, receipt, outcome };
};

it("requires authentication and isolates every operation and history by owner", async () => {
  await createBet();
  await request(app).post(`${prefix}/quote`).send({}).expect(401);
  await request(app).post(`${prefix}/quote`).set("currentUser", other)
    .send({ action: "QUOTE", clientOperationId: "one", portion: { mode: "FULL" } }).expect(404);
  const prepared = await createQuote();
  await request(app).get(`${prefix}/operations/${prepared.operation.operationId}`).set("currentUser", other).expect(404);
  await request(app).get(`${prefix}/history`).set("currentUser", other).expect(404);
});

it("registers pending durably, preserves exact retries, and rejects changed canonical content", async () => {
  await createBet();
  const body = { action: "QUOTE", clientOperationId: "stable", portion: { mode: "PARTIAL", stakeMinor: 4000 } };
  const responses = await Promise.all([
    request(app).post(`${prefix}/quote`).set("currentUser", owner).send(body),
    request(app).post(`${prefix}/quote`).set("currentUser", owner).send(body),
  ]);
  expect(responses.map(response => response.status)).toEqual([202, 202]);
  expect(responses[0].body.operationId).toBe(responses[1].body.operationId);
  expect(await CashBackOperation.countDocuments()).toBe(1);
  await request(app).post(`${prefix}/quote`).set("currentUser", owner)
    .send({ ...body, portion: { mode: "FULL" } }).expect(409);
  await request(app).post(`${prefix}/quote`).set("currentUser", owner)
    .send({ action: "QUOTE", clientOperationId: "invalid", portion: {} }).expect(400);
});

it("does not silently accept a changed quote and never exposes internal source proofs", async () => {
  await createBet();
  const prepared = await createQuote();
  await request(app).post(`${prefix}/accept`).set("currentUser", owner)
    .send({ action: "CONFIRM", clientOperationId: "partial", quoteId: "different" }).expect(409);
  const response = await request(app).get(`${prefix}/operations/${prepared.operation.operationId}`)
    .set("currentUser", owner).expect(200);
  expect(response.body.state).toBe("QUOTED");
  expect(JSON.stringify(response.body)).not.toContain("private-");
  expect(JSON.stringify(response.body)).not.toContain(prepared.operation.operation.fingerprint);
  expect(response.headers["cache-control"]).toBe("no-store");
});

it("keeps broker failure pending and retries the exact immutable request", async () => {
  await createBet();
  await request(app).post(`${prefix}/quote`).set("currentUser", owner)
    .send({ action: "QUOTE", clientOperationId: "retry", portion: { mode: "FULL" } }).expect(202);
  const publish = jest.fn().mockRejectedValueOnce(new Error("broker unavailable")).mockResolvedValue(undefined);
  const facade = new CashBackFacade(messengerWrapper.connection, {
    initConfirmChannel: async () => {}, publishWithConfirm: publish,
  });
  await facade.runOnce();
  expect((await CashBackOperation.findOne())?.state).toBe("QUOTE_PENDING");
  await facade.runOnce();
  expect(publish.mock.calls[0][0]).toEqual(publish.mock.calls[1][0]);
});

it("appends a late partial receipt after newer settlement without rewinding scalar state", async () => {
  await createBet();
  const prepared = await accept();
  await applyBetEventWithRetry("slip", applySettleSlip, {
    data: {
      slipId: "slip", result: ResultingStatus.BET_WIN,
      cashBack: {
        settlementId: "settlement", occurredAt: new Date().toISOString(), settlementBasisStakeMinor: 6000,
        financial: { ...prepared.receipt.financial, revision: 3, status: BetStatus.WIN },
      },
    },
  });
  await prepared.facade.receiveOutcome(prepared.outcome);
  await prepared.facade.receiveOutcome(prepared.outcome);
  const bet = await Bet.findOne({ slipId: "slip" });
  expect(bet?.status).toBe(BetStatus.WIN);
  expect(bet?.wager).toBe(100);
  expect(bet?.cashBackFinancial).toMatchObject({ revision: 3, cumulativeClosedStakeMinor: 4000, remainingStakeMinor: 6000 });
  const history = await request(app).get(`${prefix}/history`).set("currentUser", owner).expect(200);
  expect(history.body.items).toHaveLength(1);
  expect(history.body.items[0].decisionId).toBe("decision");
  expect(history.body).not.toHaveProperty("complete");
});

it("freezes full status and row winner metadata against moderation and all settlement paths", async () => {
  await createBet();
  const prepared = await accept(true);
  await prepared.facade.receiveOutcome(prepared.outcome);
  await applyBetEventWithRetry("slip", applyModerationResult, {
    data: { slipId: "slip", result: ModerationStatus.DECLINED },
  });
  await applyBetEventWithRetry("slip", applySettleSlip, {
    data: { slipId: "slip", result: ResultingStatus.BET_WIN },
  });
  await applyBetEventWithRetry("slip", applySettleSlipRow, {
    data: { slipId: "slip", slipRowId: "row", result: ResultingStatus.ROW_WIN, winningSelection: "later" },
  });
  const bet = await Bet.findOne({ slipId: "slip" });
  expect(bet?.status).toBe(BetStatus.CASH_BACK);
  expect(bet?.rows[0]).toMatchObject({ id: "row", oddsValue: 3, winningSelection: "", status: SlipRowStatus.NOT_SETTLED });
  expect(bet?.cashBackFinancial?.remainingStakeMinor).toBe(0);
  await request(app).post(`${prefix}/accept`).set("currentUser", owner)
    .send({ action: "CONFIRM", clientOperationId: "full", quoteId: prepared.quote.quoteId }).expect(200);
});
