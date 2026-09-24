import request from "supertest";
import express from "express";
import cookieSession from "cookie-session";
import jwt from "jsonwebtoken";
import {
  BetKind, BetStatus, BettingStatus, CashBackAcceptedReceipt, CashBackQuote,
  CashBackQuoteEvidence, CashBackRejectedReceipt, EventPhase, EventStatus, EventVisibility, ICashBackOutcomeEvent, ISettleSlipEvent,
  messengerWrapper, ModerationStatus, ResultingStatus, SlipRowStatus,
} from "@betstan/common";
import { app } from "../../app";
import { CashBack } from "../CashBack";
import { Bet } from "../../model/Bet";
import { CashBackOperation } from "../../model/CashBackOperation";
import { CashBackFacade, getCashBackFacade } from "../../service/CashBackFacade";
import * as cashBackFacadeModule from "../../service/CashBackFacade";
import { applyCashBackFinancial, cashBackReceiptHash } from "../../service/cashBackFinancial";
import { applyBetEventWithRetry, applyModerationResult, applySettleSlip, applySettleSlipRow } from "../../service/betHistory";

const owner = JSON.stringify({ id: "owner", timestamp: new Date().toISOString() });
const other = JSON.stringify({ id: "other", timestamp: new Date().toISOString() });
const prefix = "/api/bet/slip/cash-back";
const actualCommon = jest.requireActual<typeof import("@betstan/common")>("@betstan/common");
const authenticatedApp = express();
authenticatedApp.use(express.json());
authenticatedApp.use(cookieSession({ signed: false, secure: false }));
authenticatedApp.use(actualCommon.currentUser);
authenticatedApp.use(CashBack);

const sessionCookie = (payload: Record<string, unknown>, validSignature = true): string => {
  const key = process.env.JWT_KEY;
  if (!key) throw new Error("Missing synthetic test signing key");
  const token = jwt.sign(payload, validSignature ? key : "cash-back-invalid-test-signature");
  return `session=${Buffer.from(JSON.stringify({ jwt: token })).toString("base64")}`;
};

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

it.each<[string, number, boolean]>([
  ["fresh normal", 0, false],
  ["fresh legacy without exp or role", 0, true],
  ["legacy exactly twelve hours old", -12 * 60 * 60 * 1000, true],
  ["timestamp at the five-minute clock-skew boundary", 5 * 60 * 1000, false],
])("accepts a %s signed session through real Common middleware on all four routes", async (_name, offset, legacy) => {
  await createBet();
  const prepared = await createQuote();
  const nowMs = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    const cookie = sessionCookie({
      id: "owner", email: "owner@example.test", timestamp: new Date(nowMs + offset).toISOString(),
      ...(!legacy ? { role: "USER", exp: Math.floor(nowMs / 1000) + 12 * 60 * 60 } : {}),
    });
    await request(authenticatedApp).post(`${prefix}/quote`).set("Cookie", cookie).send({
      action: "QUOTE", clientOperationId: "partial", portion: { mode: "PARTIAL", stakeMinor: 4000 },
    }).expect(200);
    await request(authenticatedApp).post(`${prefix}/accept`).set("Cookie", cookie).send({
      action: "CONFIRM", clientOperationId: "partial", quoteId: prepared.quote.quoteId,
    }).expect(202);
    await request(authenticatedApp).get(`${prefix}/operations/${prepared.operation.operationId}`)
      .set("Cookie", cookie).expect(202);
    await request(authenticatedApp).get(`${prefix}/history`).set("Cookie", cookie).expect(200);
    expect((await CashBackOperation.findOne({ operationId: prepared.operation.operationId }))?.state)
      .toBe("CONFIRM_PENDING");
  } finally {
    clock.mockRestore();
  }
});

it.each<[string, (nowMs: number) => Record<string, unknown>, boolean]>([
  ["legacy thirteen hours old", nowMs => ({ timestamp: new Date(nowMs - 13 * 60 * 60 * 1000).toISOString() }), true],
  ["legacy one millisecond beyond twelve hours", nowMs => ({ timestamp: new Date(nowMs - 12 * 60 * 60 * 1000 - 1).toISOString() }), true],
  ["timestamp one millisecond beyond allowed future skew", nowMs => ({ timestamp: new Date(nowMs + 5 * 60 * 1000 + 1).toISOString() }), true],
  ["missing timestamp", () => ({}), true],
  ["invalid timestamp", () => ({ timestamp: "not-a-time" }), true],
  ["null timestamp", () => ({ timestamp: null }), true],
  ["numeric timestamp", nowMs => ({ timestamp: nowMs }), true],
  ["array timestamp", nowMs => ({ timestamp: [new Date(nowMs).toISOString()] }), true],
  ["expired exp despite fresh timestamp", nowMs => ({
    timestamp: new Date(nowMs).toISOString(), exp: Math.floor(nowMs / 1000) - 1,
  }), true],
  ["invalid signature despite fresh timestamp", nowMs => ({ timestamp: new Date(nowMs).toISOString() }), false],
])("rejects a %s before the facade on all four routes through real Common middleware", async (_name, claims, validSignature) => {
  const nowMs = Date.now();
  const clock = jest.spyOn(Date, "now").mockReturnValue(nowMs);
  const facade = jest.spyOn(cashBackFacadeModule, "getCashBackFacade");
  try {
    const cookie = sessionCookie({ id: "owner", email: "owner@example.test", ...claims(nowMs) }, validSignature);
    const responses = await Promise.all([
      request(authenticatedApp).post(`${prefix}/quote`).set("Cookie", cookie)
        .send({ action: "QUOTE", clientOperationId: "untrusted", portion: { mode: "FULL" } }),
      request(authenticatedApp).post(`${prefix}/accept`).set("Cookie", cookie)
        .send({ action: "CONFIRM", clientOperationId: "untrusted", quoteId: "untrusted-quote" }),
      request(authenticatedApp).get(`${prefix}/operations/untrusted-operation`).set("Cookie", cookie),
      request(authenticatedApp).get(`${prefix}/history`).set("Cookie", cookie),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ errors: [{ code: "AUTHENTICATION_REQUIRED", message: "Authentication required" }] });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    expect(facade).not.toHaveBeenCalled();
    expect(await CashBackOperation.countDocuments()).toBe(0);
  } finally {
    facade.mockRestore();
    clock.mockRestore();
  }
});

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

it.each<[BetStatus, ResultingStatus, BetStatus.WIN | BetStatus.LOSS | BetStatus.VOID, ResultingStatus]>([
  [BetStatus.PENDING, ResultingStatus.BET_PENDING, BetStatus.WIN, ResultingStatus.BET_WIN],
  [BetStatus.CONFIRMED, ResultingStatus.BET_APPROVED, BetStatus.LOSS, ResultingStatus.BET_LOSS],
  [BetStatus.DECLINED, ResultingStatus.BET_DECLINED, BetStatus.VOID, ResultingStatus.BET_VOID],
])("rejects serialized %s cash-back settlements without consuming the terminal revision", async (invalidStatus, invalidResult, status, result) => {
  await createBet();
  const prepared = await accept();
  await prepared.facade.receiveOutcome(prepared.outcome);
  const before = await Bet.findOne({ slipId: "slip" }).lean();
  expect(before).toMatchObject({
    status: BetStatus.CONFIRMED,
    cashBackFinancial: { revision: 2, remainingStakeMinor: 6000, cumulativeClosedStakeMinor: 4000 },
  });
  const settlement: ISettleSlipEvent = {
    data: {
      slipId: "slip", result,
      cashBack: {
        settlementId: "settlement", occurredAt: new Date().toISOString(), settlementBasisStakeMinor: 6000,
        financial: { ...prepared.receipt.financial, revision: 3, status },
      },
    },
  };
  const malformed = JSON.parse(JSON.stringify({
    data: {
      ...settlement.data, result: invalidResult,
      cashBack: {
        ...settlement.data.cashBack,
        financial: { ...prepared.receipt.financial, revision: 3, status: invalidStatus },
      },
    },
  }));
  await expect(applyBetEventWithRetry("slip", applySettleSlip, malformed))
    .rejects.toThrow("Invalid remaining-principal settlement evidence");
  expect(await Bet.findOne({ slipId: "slip" }).lean()).toEqual(before);
  const mismatched = JSON.parse(JSON.stringify({ data: { ...settlement.data, result: invalidResult } }));
  await expect(applyBetEventWithRetry("slip", applySettleSlip, mismatched))
    .rejects.toThrow("Invalid remaining-principal settlement evidence");
  expect(await Bet.findOne({ slipId: "slip" }).lean()).toEqual(before);
  await applyBetEventWithRetry("slip", applySettleSlip, settlement);
  const settled = await Bet.findOne({ slipId: "slip" }).lean();
  expect(settled).toMatchObject({
    status, wager: 100, rows: before?.rows,
    cashBackFinancial: {
      revision: 3, status, originalStakeMinor: 10000, remainingStakeMinor: 6000,
      cumulativeClosedStakeMinor: 4000, cumulativeReturnMinor: 4000,
    },
  });
  await applyBetEventWithRetry("slip", applySettleSlip, settlement);
  expect(await Bet.findOne({ slipId: "slip" }).lean()).toEqual(settled);
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

it.each<[string, string | undefined, string | undefined]>([
  ["matching unknown", "UNKNOWN", "UNKNOWN"],
  ["matching missing", undefined, undefined],
  ["unknown envelope", "UNKNOWN", "REJECTED"],
  ["missing envelope", undefined, "REJECTED"],
  ["unknown receipt", "REJECTED", "UNKNOWN"],
  ["missing receipt", "REJECTED", undefined],
  ["acceptance envelope with rejection receipt", "ACCEPTED", "REJECTED"],
  ["rejection envelope with acceptance receipt", "REJECTED", "ACCEPTED"],
])("rejects %s terminal discriminants before projecting and replaying a canonical rejection", async (_name, envelopeOutcome, receiptOutcome) => {
  await createBet();
  const prepared = await accept();
  const receipt: CashBackRejectedReceipt = {
    outcome: "REJECTED", operation: prepared.quote.operation, quoteId: prepared.quote.quoteId,
    expectedRevision: prepared.quote.financial.revision, decisionId: "rejected-decision",
    decisionTime: new Date().toISOString(), reason: "RESERVATION_DENIED",
    financial: { ...prepared.quote.financial, revision: 2 },
  };
  const outcome: ICashBackOutcomeEvent["data"] = {
    outcome: "REJECTED", operation: prepared.operation.operation, receipt,
    receiptFingerprint: cashBackReceiptHash(receipt),
  };
  const operationBefore = await CashBackOperation.findOne({ operationId: prepared.operation.operationId }).lean();
  const betBefore = await Bet.findOne({ slipId: "slip" }).lean();
  expect(operationBefore).toMatchObject({ state: "CONFIRM_PENDING", projectionPending: false });
  expect(operationBefore?.receipt).toBeUndefined();
  const malformed = JSON.parse(JSON.stringify({
    ...outcome, outcome: envelopeOutcome, receipt: { ...receipt, outcome: receiptOutcome },
  }));
  malformed.receiptFingerprint = cashBackReceiptHash(malformed.receipt);
  await expect(prepared.facade.receiveOutcome(malformed)).rejects.toThrow("Invalid cash-back terminal receipt binding");
  expect(await CashBackOperation.findOne({ operationId: prepared.operation.operationId }).lean()).toEqual(operationBefore);
  expect(await Bet.findOne({ slipId: "slip" }).lean()).toEqual(betBefore);
  await prepared.facade.receiveOutcome(outcome);
  await prepared.facade.receiveOutcome(outcome);
  const response = await request(app).get(`${prefix}/operations/${prepared.operation.operationId}`)
    .set("currentUser", owner).expect(200);
  expect(response.body).toMatchObject({
    state: "REJECTED", receipt: {
      operation: prepared.quote.operation, quoteId: prepared.quote.quoteId,
      expectedRevision: 1, reason: "RESERVATION_DENIED",
    },
  });
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial).toMatchObject({
    revision: 2, remainingStakeMinor: 10000, cumulativeClosedStakeMinor: 0, cumulativeReturnMinor: 0,
  });
  const history = await request(app).get(`${prefix}/history`).set("currentUser", owner).expect(200);
  expect(history.body.items).toEqual([]);
  expect(JSON.stringify(response.body)).not.toContain(outcome.receiptFingerprint);
  await request(app).post(`${prefix}/accept`).set("currentUser", owner)
    .send({ action: "CONFIRM", clientOperationId: "partial", quoteId: prepared.quote.quoteId }).expect(200);
});

it("retains an accepted receipt while placement is missing and repairs its projection on recovery", async () => {
  const original = await createBet();
  const prepared = await accept();
  await Bet.deleteOne({ _id: original._id });
  await prepared.facade.receiveOutcome(prepared.outcome);
  await prepared.facade.runOnce();
  expect(await Bet.countDocuments()).toBe(0);
  expect(await CashBackOperation.findOne({ operationId: prepared.operation.operationId }))
    .toMatchObject({ state: "ACCEPTED", projectionPending: true, receipt: prepared.receipt });
  await Bet.create(original.toObject());
  await prepared.facade.runOnce();
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial).toMatchObject({
    revision: 2, remainingStakeMinor: 6000, cumulativeClosedStakeMinor: 4000,
  });
  expect((await CashBackOperation.findOne({ operationId: prepared.operation.operationId }))?.projectionPending).toBe(false);
  expect((await Bet.findOne({ slipId: "slip" }))?.wager).toBe(100);
});

it("treats equal financial revisions as exact retries and rejects a conflicting same-revision snapshot", async () => {
  await createBet();
  const prepared = await accept();
  await prepared.facade.receiveOutcome(prepared.outcome);
  const before = await Bet.findOne({ slipId: "slip" });
  await applyBetEventWithRetry("slip", applyCashBackFinancial, prepared.receipt.financial);
  expect((await Bet.findOne({ slipId: "slip" }))?.get("__v")).toBe(before?.get("__v"));
  await expect(applyBetEventWithRetry("slip", applyCashBackFinancial, {
    ...prepared.receipt.financial, remainingStakeMinor: 7000, cumulativeClosedStakeMinor: 3000,
  })).rejects.toThrow("Conflicting cash-back snapshots at the same revision");
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial)
    .toMatchObject({ revision: 2, remainingStakeMinor: 6000, cumulativeClosedStakeMinor: 4000 });
});

it("preserves an unversioned terminal status when a delayed partial receipt supplies its financial evidence", async () => {
  await createBet();
  const prepared = await accept();
  await applyBetEventWithRetry("slip", applySettleSlip, {
    data: { slipId: "slip", result: ResultingStatus.BET_WIN },
  });
  await prepared.facade.receiveOutcome(prepared.outcome);
  expect(await Bet.findOne({ slipId: "slip" })).toMatchObject({
    status: BetStatus.WIN, wager: 100,
    cashBackFinancial: { revision: 2, remainingStakeMinor: 6000, cumulativeClosedStakeMinor: 4000 },
  });
});

it("rejects attempts to reopen full closure or change its frozen return at a higher revision", async () => {
  await createBet();
  const prepared = await accept(true);
  await prepared.facade.receiveOutcome(prepared.outcome);
  await expect(applyBetEventWithRetry("slip", applyCashBackFinancial, {
    ...prepared.receipt.financial, revision: 3, status: BetStatus.CONFIRMED,
  })).rejects.toThrow("Cash-back terminal exposure cannot be reopened");
  await expect(applyBetEventWithRetry("slip", applyCashBackFinancial, {
    ...prepared.receipt.financial, revision: 3, cumulativeReturnMinor: 10001,
  })).rejects.toThrow("Full cash-back financial amounts are immutable");
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial).toMatchObject({
    revision: 2, status: BetStatus.CASH_BACK, remainingStakeMinor: 0, cumulativeReturnMinor: 10000,
  });
});

it("rejects an active financial snapshot newer than an authoritative terminal settlement", async () => {
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
  await expect(applyBetEventWithRetry("slip", applyCashBackFinancial, {
    ...prepared.receipt.financial, revision: 4,
  })).rejects.toThrow("A newer cash-back snapshot conflicts with terminal settlement");
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial).toMatchObject({
    revision: 3, status: BetStatus.WIN, remainingStakeMinor: 6000,
  });
});
