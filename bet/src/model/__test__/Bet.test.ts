import mongoose from "mongoose";
import { BetKind, BetStatus, SlipRowStatus } from "@betstan/common";
import {
  LiveMarketType,
  LiveSettlementReason,
  TeamSide,
} from "../../compat/LiveContract";
import { Bet } from "../Bet";

const buildBet = (overrides: Record<string, unknown> = {}) =>
  new Bet({
    status: BetStatus.PENDING,
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "user@example.com",
    slipId: new mongoose.Types.ObjectId().toHexString(),
    wager: 10,
    timestamp: new Date().toISOString(),
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.NOT_SETTLED,
        timestamp: new Date().toISOString(),
        id: new mongoose.Types.ObjectId().toHexString(),
      },
    ],
    ...overrides,
  });

it("normalizes missing serialized bet kind and row defaults", () => {
  const serialized = buildBet().toJSON();

  expect(serialized.betKind).toEqual(BetKind.PRE_MATCH);
  expect(serialized.rows[0].betKind).toEqual(BetKind.PRE_MATCH);
  expect(serialized.rows[0].winningSelection).toEqual("");
});

it("preserves explicitly populated serialized values", () => {
  const bet = buildBet({
    betKind: BetKind.LIVE,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Live Event",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 2.2,
        oddsName: "Away",
        productName: "Next corner",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.WIN,
        timestamp: new Date().toISOString(),
        winningSelection: "Away",
        id: new mongoose.Types.ObjectId().toHexString(),
        betKind: BetKind.LIVE,
      },
    ],
  });

  const serialized = bet.toObject();

  expect(serialized.betKind).toEqual(BetKind.LIVE);
  expect(serialized.rows[0].betKind).toEqual(BetKind.LIVE);
  expect(serialized.rows[0].winningSelection).toEqual("Away");
});

it("persists additive live market, side, and settlement values", async () => {
  const bet = buildBet({
    betKind: BetKind.LIVE,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Live Event",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 2.2,
        oddsName: "Yes",
        productName: "Kickoff team",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.WIN,
        timestamp: new Date().toISOString(),
        winningSelection: "Yes",
        id: new mongoose.Types.ObjectId().toHexString(),
        betKind: BetKind.LIVE,
        marketId: "kickoff-market",
        marketType: LiveMarketType.KICKOFF_TEAM,
        marketVersion: 1,
        quoteVersion: 1,
        selectionId: "kickoff-yes",
        side: TeamSide.YES,
        winningSide: TeamSide.YES,
        settlementReason: LiveSettlementReason.KICK_OFF,
        settlementSequence: 1,
      },
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Live Event",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.8,
        oddsName: "No",
        productName: "First-minute goal",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.WIN,
        timestamp: new Date().toISOString(),
        winningSelection: "No",
        id: new mongoose.Types.ObjectId().toHexString(),
        betKind: BetKind.LIVE,
        marketId: "first-minute-market",
        marketType: LiveMarketType.FIRST_MINUTE_GOAL,
        marketVersion: 1,
        quoteVersion: 1,
        selectionId: "first-minute-no",
        side: TeamSide.NO,
        winningSide: TeamSide.NO,
        settlementReason: LiveSettlementReason.FIRST_MINUTE_GOAL,
        settlementSequence: 2,
      },
    ],
  });

  await bet.save();
  const persisted = await Bet.findById(bet._id).lean();

  expect(persisted?.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        marketType: "KICKOFF_TEAM",
        side: "YES",
        settlementReason: "KICK_OFF",
      }),
      expect.objectContaining({
        marketType: "FIRST_MINUTE_GOAL",
        side: "NO",
        settlementReason: "FIRST_MINUTE_GOAL",
      }),
    ])
  );
});
