import { BetKind, MarketBet, ModerationDeclineReason, ModerationStatus } from "@betstan/common";
import { Bet } from "../../model/Bet";
import { ParkedPlaceBet } from "../../model/ParkedPlaceBet";
import ModerationService from "../ModerationService";
import * as authority from "../MarketQuoteVerifier";
import { createDeferred, createPlaceBetEvent } from "../../event/listener/__test__/helpers";

const event = () => {
  const now = Date.now();
  const quote: MarketBet = {
    schemaVersion: 1, kind: "SINGLE", eventId: "event-a", quoteId: "quote-a", odds: 2,
    issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 29000).toISOString(),
    selections: [{
      origin: "TEMPLATE", marketId: "market-a", outcomeKey: "a", rulesRevision: 1, quoteRevision: 2,
      templateId: "template-a", templateVersion: 1, marketName: "1X2", label: "Nominee A",
      terms: "Operator declares the winner", settlementMode: "MANUAL", pricingMethod: "OPERATOR",
    }],
  };
  return createPlaceBetEvent({
    data: { submittedAt: new Date(now).toISOString(), betKind: BetKind.PRE_MATCH },
    row: { eventId: quote.eventId, oddsValue: quote.odds, marketBet: quote },
  });
};
const setup = () => {
  const publisher = { publishWithConfirm: jest.fn().mockResolvedValue(undefined) };
  return { publisher, service: new ModerationService(publisher) };
};
const previousFlag = process.env.EXTENSIBLE_MARKETS_ENABLED;
beforeAll(async () => { await Bet.init(); });
beforeEach(() => {
  process.env.EXTENSIBLE_MARKETS_ENABLED = "true";
  jest.spyOn(authority, "verifyMarketQuote").mockResolvedValue(true);
});
afterEach(() => {
  jest.restoreAllMocks();
  if (previousFlag === undefined) delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  else process.env.EXTENSIBLE_MARKETS_ENABLED = previousFlag;
});

it("accepts only verified owner-bound snapshots and preserves them across disabled-writer replay", async () => {
  const input = event();
  const { service, publisher } = setup();
  await service.handlePlaceBet(input);
  expect(authority.verifyMarketQuote).toHaveBeenCalledWith(input.data.userId, input.data.rows[0].marketBet);
  const saved = await Bet.findOne({ slipId: input.data.slipId }).lean();
  expect(saved?.status).toBe(ModerationStatus.APPROVED);
  expect(saved?.rows[0].marketBet).toEqual(input.data.rows[0].marketBet);
  delete process.env.EXTENSIBLE_MARKETS_ENABLED;
  await service.handlePlaceBet(input);
  expect(publisher.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("does not overwrite a decided frozen submission with conflicting redelivery", async () => {
  const input = event();
  const { service } = setup();
  await service.handlePlaceBet(input);
  await expect(service.handlePlaceBet({
    ...input, data: { ...input.data, rows: [{ ...input.data.rows[0], oddsValue: 20 }] },
  })).rejects.toThrow("Immutable market submission");
  const saved = await Bet.findOne({ slipId: input.data.slipId }).lean();
  expect(saved?.rows[0].oddsValue).toBe(2);
  expect(saved?.status).toBe(ModerationStatus.APPROVED);
});

it("rejects raw same-match additions instead of treating a custom market named 1X2 as legacy", async () => {
  const input = event();
  const { marketBet: _quote, ...ordinary } = input.data.rows[0];
  input.data.rows.push({ ...ordinary, id: "another-row", oddsId: "another-odds" });
  const { service } = setup();
  await service.handlePlaceBet(input);
  expect((await Bet.findOne({ slipId: input.data.slipId }))?.declineReason)
    .toBe(ModerationDeclineReason.INVALID_SELECTION);
  expect(authority.verifyMarketQuote).not.toHaveBeenCalled();
});

it("parks unavailable authority and declines a retired quote without trusting an event mirror", async () => {
  const input = event();
  const { service } = setup();
  jest.mocked(authority.verifyMarketQuote).mockRejectedValueOnce(new Error("authority unavailable"));
  const outcome = await service.handlePlaceBet(input);
  expect(outcome).toMatchObject({ type: "park", pendingEventIds: ["event-a"] });
  expect(await ParkedPlaceBet.countDocuments({ slipId: input.data.slipId })).toBe(1);
  jest.mocked(authority.verifyMarketQuote).mockResolvedValue(false);
  await service.handlePlaceBet(input);
  expect((await Bet.findOne({ slipId: input.data.slipId }))?.declineReason)
    .toBe(ModerationDeclineReason.STALE_QUOTE);
});

it("does not let a racing later decision replace an already approved market exposure", async () => {
  const input = event();
  const { service, publisher } = setup();
  const first = createDeferred<boolean>();
  const second = createDeferred<boolean>();
  const bothEntered = createDeferred();
  let count = 0;
  jest.mocked(authority.verifyMarketQuote).mockImplementation(() => {
    if (++count === 1) return first.promise;
    bothEntered.resolve();
    return second.promise;
  });
  const earlier = service.handlePlaceBet(input);
  const later = service.handlePlaceBet(input);
  await bothEntered.promise;
  first.resolve(true);
  await Promise.race([earlier, later]);
  second.resolve(false);
  await Promise.all([earlier, later]);
  expect((await Bet.findOne({ slipId: input.data.slipId }))?.status).toBe(ModerationStatus.APPROVED);
  expect(publisher.publishWithConfirm).toHaveBeenCalledTimes(1);
});
