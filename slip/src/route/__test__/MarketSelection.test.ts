import request from "supertest";
import axios from "axios";
import { BetKind, MarketBet, messengerWrapper, parseMarketBet } from "@betstan/common";
import { Types } from "mongoose";
import { app } from "../../app";
import {
  Slip, SLIP_DRAFT_UNIQUE_INDEX_KEYS, SLIP_DRAFT_UNIQUE_INDEX_NAME, SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
} from "../../model/Slip";
import { PlainSlipRow, toPublishedSubmittedEventData, upsertDraftSlipRow } from "../../model/slipSupport";
import { SlipSubmissionWorker, submitDraftSlipAtomically } from "../../service/SlipSubmissionWorker";
import PlaceBetEventPublisher from "../../event/publisher/PlaceBetEventPublisher";

const marketBet = (): MarketBet => {
  const now = Date.now();
  return {
  schemaVersion: 1, kind: "SINGLE", eventId: "event-a", quoteId: "quote-a",
  issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString(), odds: 2,
  selections: [{
    origin: "TEMPLATE", marketId: "manual-a", outcomeKey: "a", rulesRevision: 1, quoteRevision: 2,
    templateId: "template-a", templateVersion: 1, marketName: "$rows", label: "$$ROOT",
    terms: "Operator declares the winner", settlementMode: "MANUAL", pricingMethod: "OPERATOR",
  }],
  };
};
const row = (quote?: MarketBet, eventId = "event-a"): PlainSlipRow => ({
  _id: new Types.ObjectId(), eventId, eventName: "Home - Away", oddsId: quote ? "market-odds" : "legacy-odds",
  oddsValue: 2, oddsName: quote ? "$$ROOT" : "Home", productName: quote ? "Custom market" : "1X2",
  productId: quote ? "manual-a" : "standard", timestamp: "2030-01-01T12:00:00.000Z",
  eventTime: "2030-01-01T12:00:00.000Z", betKind: BetKind.PRE_MATCH,
  ...(quote ? { marketBet: quote } : {}),
});
const empty = { expectedBoardRevision: null, expectedBoardFingerprint: null, replaceEventSelections: false };
const previousFlag = process.env.EXTENSIBLE_MARKETS_ENABLED;
const previousEventUrl = process.env.EVENT_SERVICE_URL;

beforeAll(async () => {
  await Slip.collection.createIndex(SLIP_DRAFT_UNIQUE_INDEX_KEYS, {
    name: SLIP_DRAFT_UNIQUE_INDEX_NAME, unique: true, partialFilterExpression: SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previousFlag === undefined) delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  else process.env.EXTENSIBLE_MARKETS_ENABLED = previousFlag;
  if (previousEventUrl === undefined) delete process.env.EVENT_SERVICE_URL;
  else process.env.EVENT_SERVICE_URL = previousEventUrl;
});

it("preserves literal frozen metadata through draft, atomic submission and the durable wire payload", async () => {
  const quote = marketBet();
  expect((await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, row(quote), empty)).accepted).toBe(true);
  const draft = await Slip.findOne({ userId: "user-a" }).lean();
  expect(draft?.rows[0].marketBet).toEqual(quote);
  expect(draft?.rows[0].oddsName).toBe("$$ROOT");
  const submitted = await submitDraftSlipAtomically({
    slipId: draft!._id.toString(), userId: "user-a", userName: "Player", placementAttemptId: "attempt",
    wager: 10, betKind: BetKind.PRE_MATCH, expectedBoardRevision: draft!.boardRevision,
    expectedBoardFingerprint: draft!.boardFingerprint,
  });
  expect(submitted?.submittedEvent?.rows[0].marketBet).toEqual(quote);
  expect(toPublishedSubmittedEventData(submitted!.submittedEvent!).rows[0].marketBet).toEqual(quote);
});

it("requires explicit replacement and exact board identity before removing same-match legacy rows", async () => {
  await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, row());
  const draft = await Slip.findOne({ userId: "user-a" }).lean();
  const confirmation = {
    expectedBoardRevision: draft!.boardRevision, expectedBoardFingerprint: draft!.boardFingerprint,
    replaceEventSelections: false,
  };
  const next = row(marketBet());
  expect((await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, next, confirmation)).accepted).toBe(false);
  expect((await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, next, {
    ...confirmation, expectedBoardFingerprint: "stale", replaceEventSelections: true,
  })).accepted).toBe(false);
  expect((await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, next, {
    ...confirmation, replaceEventSelections: true,
  })).accepted).toBe(true);
  const updated = await Slip.findOne({ userId: "user-a" }).lean();
  expect(updated?.rows).toHaveLength(1);
  expect(updated?.rows[0].marketBet?.quoteId).toBe("quote-a");
  expect((await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, row())).accepted).toBe(false);
});

it("replays mixed custom and ordinary snapshots without converting an absent manifest to BSON null", async () => {
  const quote = marketBet();
  await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, row(quote), empty);
  await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, row(undefined, "another-event"));
  const draft = await Slip.findOne({ userId: "user-a" }).lean();
  await submitDraftSlipAtomically({
    slipId: draft!._id.toString(), userId: "user-a", userName: "$$ROOT", placementAttemptId: "mixed-attempt",
    wager: 10, betKind: BetKind.PRE_MATCH, expectedBoardRevision: draft!.boardRevision,
    expectedBoardFingerprint: draft!.boardFingerprint,
  });
  const saved = await Slip.findById(draft!._id).lean();
  expect(saved?.submittedEvent?.userName).toBe("$$ROOT");
  expect(saved?.submittedEvent?.rows[0].marketBet).toEqual(quote);
  expect(Object.prototype.hasOwnProperty.call(saved?.submittedEvent?.rows[1], "marketBet")).toBe(false);
  const wire = toPublishedSubmittedEventData(saved!.submittedEvent!);
  const send = jest.mocked(PlaceBetEventPublisher.prototype.publishWithConfirm);
  send.mockRejectedValueOnce(new Error("broker unavailable")).mockResolvedValueOnce(undefined);
  const worker = new SlipSubmissionWorker(messengerWrapper.connection);
  const restarted = new SlipSubmissionWorker(messengerWrapper.connection);
  try {
    await worker.init();
    expect((await worker.publishSlipNow(draft!._id.toString())).outcome).toBe("rescheduled");
    await worker.stop();
    await Slip.updateOne({ _id: draft!._id }, { $set: { "publication.nextAttemptAt": new Date(0).toISOString() } });
    await restarted.init();
    expect((await restarted.publishSlipNow(draft!._id.toString())).outcome).toBe("published");
    expect(send).toHaveBeenNthCalledWith(1, { data: wire });
    expect(send).toHaveBeenNthCalledWith(2, { data: wire });
    expect((await Slip.findById(draft!._id))?.publication?.state).toBe("PUBLISHED");
  } finally { await Promise.all([worker.stop(), restarted.stop()]); }
});

it("keeps oversized different-match Builders editable instead of accepting an unreplayable placement", async () => {
  const quote = parseMarketBet({
    ...marketBet(), kind: "BUILDER", modelId: "model-a",
    selections: Array.from({ length: 10 }, (_, index) => ({
      ...marketBet().selections[0], marketId: `market-${index}`, settlementMode: "FINAL_SCORE",
      pricingMethod: "SCORE_MODEL", terms: "\u754c".repeat(2000),
      rule: { kind: "ALL", rules: Array.from({ length: 127 }, () => ({
        kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: 0.5,
      })) },
    })),
  });
  await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, row(quote), empty);
  let draft = await Slip.findOne({ userId: "user-a" }).lean();
  await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH,
    { ...row({ ...quote, eventId: "event-b", quoteId: "quote-b" }, "event-b"), oddsId: "market-odds-b" }, {
      expectedBoardRevision: draft!.boardRevision, expectedBoardFingerprint: draft!.boardFingerprint,
      replaceEventSelections: false,
    });
  draft = await Slip.findOne({ userId: "user-a" }).lean();
  expect(draft?.rows).toHaveLength(2);
  const response = await request(app).post("/api/slip/bet")
    .set("currentuser", JSON.stringify({ id: "user-a", email: "player@example.invalid" }))
    .send({
      slipId: draft!._id.toString(), wager: 10, betKind: BetKind.PRE_MATCH, placementAttemptId: "attempt-budget",
      expectedBoardRevision: draft!.boardRevision, expectedBoardFingerprint: draft!.boardFingerprint,
    }).expect(409);
  expect(response.body.message).toMatch(/durable processing size limit/);
  const unchanged = await Slip.findById(draft!._id).lean();
  expect(unchanged?.status).toBe("DRAFT");
  expect(unchanged?.rows).toHaveLength(2);
  expect(unchanged?.submittedEvent).toBeUndefined();
  expect(unchanged?.boardFingerprint).toBe(draft!.boardFingerprint);
});

it("does not allow a racing ordinary selection to coexist with a new same-match exposure", async () => {
  await upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, row(undefined, "another-event"));
  const draft = await Slip.findOne({ userId: "user-a" }).lean();
  const ordinary = { ...row(), oddsId: "home-win" };
  await Promise.all([
    upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, row(marketBet()), {
      expectedBoardRevision: draft!.boardRevision, expectedBoardFingerprint: draft!.boardFingerprint,
      replaceEventSelections: false,
    }),
    upsertDraftSlipRow("user-a", BetKind.PRE_MATCH, ordinary),
  ]);
  const updated = await Slip.findOne({ userId: "user-a" }).lean();
  expect(updated?.rows.filter(item => item.eventId === "event-a")).toHaveLength(1);
  expect(updated?.rows.filter(item => item.eventId === "another-event")).toHaveLength(1);
});

it("loads authoritative prices for the authenticated owner instead of accepting browser manifests", async () => {
  process.env.EXTENSIBLE_MARKETS_ENABLED = "true";
  process.env.EVENT_SERVICE_URL = "http://event.invalid";
  const quote = marketBet();
  const sourceRow = row(quote);
  const { _id: _rowId, timestamp: _timestamp, ...data } = sourceRow;
  jest.spyOn(axios, "get").mockResolvedValue({ data: {
    ...data, userId: "user-a", selectedAt: quote.issuedAt, quoteValidUntil: quote.expiresAt,
  } });
  const body = { quoteId: quote.quoteId, ...empty };
  await request(app).post("/api/slip/market-selection").send(body).expect(401);
  await request(app).post("/api/slip/market-selection").set("currentuser", JSON.stringify({ id: "user-a" }))
    .send({ ...body, odds: 100 }).expect(400);
  await request(app).post("/api/slip/market-selection").set("currentuser", JSON.stringify({ id: "user-a" }))
    .send(body).expect(200);
  const saved = await Slip.findOne({ userId: "user-a" }).lean();
  expect(saved?.rows[0].marketBet).toEqual(quote);
  expect(saved?.rows[0].oddsValue).toBe(quote.odds);
});
