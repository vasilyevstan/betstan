import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Bet } from "../../model/Bet";
import {
  BetKind,
  BetStatus,
  LiveMarketType,
  ModerationDeclineReason,
  SlipRowStatus,
  TeamSide,
} from "@betstan/common";

const createBet = async (
  userId: string,
  overrides: Record<string, unknown> = {}
) => {
  const bet = new Bet({
    status: BetStatus.CONFIRMED,
    userId,
    userName: "testuser",
    slipId: new mongoose.Types.ObjectId().toHexString(),
    wager: 5,
    timestamp: new Date().toISOString(),
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
        status: SlipRowStatus.NOT_SETTLED,
        id: new mongoose.Types.ObjectId().toHexString(),
      },
    ],
    ...overrides,
  });
  await bet.save();
  return bet;
};

it("returns empty object when user is not authenticated", async () => {
  const response = await request(app).get("/api/bet").send().expect(200);

  expect(response.body).toEqual({});
});

it("returns sorted additive bets for the current user and defaults historical kind", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const olderTimestamp = "2026-08-18T10:00:00.000Z";
  const newerTimestamp = "2026-08-20T10:00:00.000Z";

  const historicalSlipId = new mongoose.Types.ObjectId().toHexString();
  await Bet.collection.insertOne({
    userId,
    userName: "testuser",
    slipId: historicalSlipId,
    status: BetStatus.CONFIRMED,
    wager: 5,
    timestamp: olderTimestamp,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Legacy Event",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: olderTimestamp,
        status: SlipRowStatus.NOT_SETTLED,
        id: new mongoose.Types.ObjectId().toHexString(),
      },
    ],
  });

  const liveBet = await createBet(userId, {
    status: BetStatus.DECLINED,
    timestamp: newerTimestamp,
    betKind: BetKind.LIVE,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Live Event",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 2.4,
        oddsName: "Home",
        productName: "Next corner",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: newerTimestamp,
        status: SlipRowStatus.VOID,
        id: new mongoose.Types.ObjectId().toHexString(),
        betKind: BetKind.LIVE,
        marketId: "event-one:NEXT_CORNER",
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: 2,
        selectionId: "event-one:NEXT_CORNER:2:HOME",
        side: TeamSide.HOME,
      },
    ],
  });

  await createBet(new mongoose.Types.ObjectId().toHexString());

  const response = await request(app)
    .get("/api/bet")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send()
    .expect(200);

  expect(Array.isArray(response.body)).toBe(true);
  expect(response.body.length).toEqual(2);
  expect(response.body[0].slipId).toEqual(liveBet.slipId);
  expect(response.body[1].slipId).toEqual(historicalSlipId);
  expect(response.body[0].userId).toEqual(userId);
  expect(response.body[0]).toEqual(
    expect.objectContaining({
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
      status: BetStatus.DECLINED,
      timestamp: newerTimestamp,
    })
  );
  expect(response.body[0].rows[0]).toEqual(
    expect.objectContaining({
      eventName: "Live Event",
      productName: "Next corner",
      oddsName: "Home",
      marketId: "event-one:NEXT_CORNER",
      marketType: LiveMarketType.NEXT_CORNER,
      selectionId: "event-one:NEXT_CORNER:2:HOME",
      side: TeamSide.HOME,
      status: SlipRowStatus.VOID,
    })
  );
  expect(response.body[1].betKind).toEqual(BetKind.PRE_MATCH);
  expect(response.body[1].rows[0].betKind).toEqual(BetKind.PRE_MATCH);
});
