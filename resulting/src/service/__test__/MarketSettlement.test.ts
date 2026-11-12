import { IMarketSettledEvent, MarketBet, MAX_MARKET_PLACEMENT_BYTES, messengerWrapper, ResultingStatus } from "@betstan/common";
import { Bet, BetArchive } from "../../model/Bet";
import { ManualMarketLedger } from "../../model/ManualMarketLedger";
import SettleSlipPublisher from "../../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../event/publisher/SettleSlipRowPublisher";
import PlaceBetListener from "../../event/listener/PlaceBetListener";
import RetryRecord from "../../model/RetryRecord";
import { RetryWorker } from "../retry";
import * as resultingService from "../resulting";
import {
  createFinalScoreEvent, createMessage, createModerationEvent, createPlaceBetEvent, createPreMatchRow, setupPublisherSpies,
} from "../../test/resultingTestUtils";
import { applyModerationResult, processFinalScore, processManualMarketResult, upsertPlaceBet } from "../resulting";

const manualQuote = (): MarketBet => ({
  schemaVersion: 1, kind: "SINGLE", eventId: "event-a", quoteId: "quote-a", odds: 2,
  issuedAt: "2025-01-01T00:00:00.000Z", expiresAt: "2025-01-01T00:00:30.000Z",
  selections: [{
    origin: "TEMPLATE", marketId: "market-a", outcomeKey: "a", rulesRevision: 1, quoteRevision: 2,
    templateId: "template-a", templateVersion: 1, marketName: "1X2", label: "Nominee A",
    terms: "Operator declares the winner", settlementMode: "MANUAL", pricingMethod: "OPERATOR",
  }],
});
const manualResult = (result: "SETTLED" | "VOID" = "SETTLED"): IMarketSettledEvent => ({
  data: {
    decision: {
      schemaVersion: 1, decisionId: "decision-a", eventId: "event-a", marketId: "market-a",
      rulesRevision: 1, reviewedRevision: 2, decidedAt: "2025-01-01T01:00:00.000Z",
      result, winningOutcomeKeys: result === "VOID" ? [] : ["a"],
    },
    template: {
      id: "template-a", version: 1, publishedAt: "2024-01-01T00:00:00.000Z",
      definition: {
        schemaVersion: 1, name: "1X2", terms: "Operator declares the winner",
        settlementMode: "MANUAL", outcomeMode: "EXCLUSIVE", coverage: "COMPLETE", parameters: [],
        outcomes: [{ key: "a", label: "Nominee A" }, { key: "b", label: "Nominee B" }],
      },
    },
  },
});
const publishers = () => ({
  settleSlipPublisher: new SettleSlipPublisher(messengerWrapper.connection),
  settleSlipRowPublisher: new SettleSlipRowPublisher(messengerWrapper.connection),
});
const placement = (quote = manualQuote()) => createPlaceBetEvent({
  rows: [{ ...createPreMatchRow({
    eventId: quote.eventId, oddsValue: quote.odds, oddsName: "Nominee A", productName: "1X2",
  }), marketBet: quote }],
});

beforeAll(async () => { await ManualMarketLedger.init(); });
setupPublisherSpies();
afterEach(() => { jest.restoreAllMocks(); });

it("recovers a near-budget Builder accumulator from durable storage after an initial processing failure", async () => {
  const buildQuote = (eventId: string, terms: string): MarketBet => ({
    ...manualQuote(), eventId, quoteId: `quote-${eventId}`, kind: "BUILDER", modelId: `model-${eventId}`,
    selections: Array.from({ length: 10 }, (_, index) => ({
      ...manualQuote().selections[0], marketId: `market-${index}`, terms,
      settlementMode: "FINAL_SCORE", pricingMethod: "SCORE_MODEL",
      rule: { kind: "ALL", rules: Array.from({ length: 127 }, () => ({
        kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: 0.5,
      })) },
    })),
  });
  const first = buildQuote("event-a", "\u754c".repeat(2000));
  const second = buildQuote("event-b", "");
  const event = createPlaceBetEvent({
    rows: [first, second].map(quote => ({
      ...createPreMatchRow({ eventId: quote.eventId, oddsValue: quote.odds }), marketBet: quote,
    })),
  });
  const allowance = Math.floor((MAX_MARKET_PLACEMENT_BYTES - Buffer.byteLength(JSON.stringify(event.data))) / 30);
  expect(allowance).toBeGreaterThan(0);
  expect(allowance).toBeLessThan(2000);
  second.selections.forEach(selection => { selection.terms = "\u754c".repeat(allowance); });
  const actual = jest.requireActual<typeof import("@betstan/common")>("@betstan/common");
  actual.assertMarketPlacementBudget(event.data);
  expect(Buffer.byteLength(JSON.stringify(event.data))).toBeGreaterThan(MAX_MARKET_PLACEMENT_BYTES - 30);
  const fail = jest.spyOn(resultingService, "upsertPlaceBet").mockRejectedValueOnce(new Error("storage temporarily unavailable"));
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();
  await listener.onMessage(event, createMessage());
  fail.mockRestore();
  expect(await Bet.countDocuments()).toBe(0);
  const parked = await RetryRecord.findOne({ kind: "PLACE_BET" });
  expect(parked?.status).toBe("PENDING");
  expect(parked?.payload).toEqual(event);
  expect(listener.ack).toHaveBeenCalledTimes(1);
  await RetryRecord.updateOne({ _id: parked!._id }, { $set: { nextAttemptAt: new Date(0) } });
  const restarted = new RetryWorker(messengerWrapper.connection);
  await restarted.init();
  try {
    expect(await restarted.runOnce()).toBe(1);
    const saved = await Bet.findOne({ slipId: event.data.slipId });
    expect(saved?.rows.map(row => row.marketBet)).toEqual([first, second]);
    expect(await restarted.runOnce()).toBe(0);
    expect(await Bet.countDocuments()).toBe(1);
  } finally { await restarted.stop(); }
});

it("keeps a manual market pending after the final score even when its label resembles 1X2", async () => {
  const pub = publishers();
  const input = placement();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  await processFinalScore(createFinalScoreEvent({ eventId: "event-a", homeScore: 2, awayScore: 0 }), pub);
  const pending = await Bet.findOne({ slipId: input.data.slipId });
  expect(pending?.status).toBe(ResultingStatus.BET_APPROVED);
  expect(pending?.rows[0].result).toBe(ResultingStatus.ROW_NO_RESULT);
  expect(pending?.cashBackUnavailableReason).toBe("MARKET_BET_UNSUPPORTED");
  expect(pending?.cashBackFinancial).toBeUndefined();
  await processManualMarketResult(manualResult(), pub);
  expect((await BetArchive.findOne({ slipId: input.data.slipId }))?.status).toBe(ResultingStatus.BET_WIN);
});

it("replays an early manual result after placement and moderation without publishing twice", async () => {
  const pub = publishers();
  const input = placement();
  await processManualMarketResult(manualResult(), pub);
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  await processManualMarketResult(manualResult(), pub);
  await upsertPlaceBet(input, pub);
  const archived = await BetArchive.findOne({ slipId: input.data.slipId });
  expect(archived?.status).toBe(ResultingStatus.BET_WIN);
  expect(archived?.rows[0].marketBet).toEqual(input.data.rows[0].marketBet);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("retains a voided custom exposure and its original odds instead of deleting its history", async () => {
  const pub = publishers();
  const input = placement();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  await processManualMarketResult(manualResult("VOID"), pub);
  const archived = await BetArchive.findOne({ slipId: input.data.slipId });
  expect(archived?.status).toBe(ResultingStatus.BET_VOID);
  expect(archived?.rows).toHaveLength(1);
  expect(archived?.rows[0].result).toBe(ResultingStatus.ROW_VOID);
  expect(archived?.rows[0].oddsValue).toBe(2);
  expect(archived?.rows[0].marketBet).toEqual(input.data.rows[0].marketBet);
});

it("settles a Builder as one frozen exposure from the first authoritative final score", async () => {
  const pub = publishers();
  const base = manualQuote();
  const quote: MarketBet = {
    ...base, kind: "BUILDER", modelId: "model-a", odds: 3.75,
    selections: [
      { ...base.selections[0], settlementMode: "FINAL_SCORE", pricingMethod: "SCORE_MODEL",
        rule: { kind: "COMPARE", metric: "GOAL_DIFFERENCE", comparison: "GT", value: 0 } },
      { ...base.selections[0], marketId: "total-goals", outcomeKey: "over",
        settlementMode: "FINAL_SCORE", pricingMethod: "SCORE_MODEL",
        rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: 2.5 } },
    ],
  };
  await processFinalScore(createFinalScoreEvent({ eventId: "event-a", homeScore: 3, awayScore: 1 }), pub);
  const input = placement(quote);
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  await processFinalScore(createFinalScoreEvent({ eventId: "event-a", homeScore: 0, awayScore: 0 }), pub);
  const archived = await BetArchive.findOne({ slipId: input.data.slipId });
  expect(archived?.status).toBe(ResultingStatus.BET_WIN);
  expect(archived?.rows).toHaveLength(1);
  expect(archived?.rows[0].oddsValue).toBe(3.75);
});

it("preserves the manual ledger after a failed settlement publication and rejects conflicting decisions", async () => {
  const pub = publishers();
  const input = placement();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  jest.mocked(SettleSlipRowPublisher.prototype.publishWithConfirm).mockRejectedValueOnce(new Error("broker unavailable"));
  await expect(processManualMarketResult(manualResult(), pub)).rejects.toThrow("broker unavailable");
  expect(await ManualMarketLedger.countDocuments()).toBe(1);
  await processManualMarketResult(manualResult(), pub);
  const conflict = manualResult();
  conflict.data.decision.decisionId = "decision-b";
  conflict.data.decision.winningOutcomeKeys = ["b"];
  await expect(processManualMarketResult(conflict, pub)).rejects.toThrow("Conflicting immutable");
  expect((await BetArchive.findOne({ slipId: input.data.slipId }))?.status).toBe(ResultingStatus.BET_WIN);
});
