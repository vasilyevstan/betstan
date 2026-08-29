import { BetKind, ResultingStatus } from "@betstan/common";
import {
  LiveMarketType,
  LiveSettlementReason,
  TeamSide,
} from "../../compat/LiveContract";
import { Bet } from "../Bet";
import LiveSettlementLedger from "../LiveSettlementLedger";

const buildLiveRow = (
  marketType: (typeof LiveMarketType)[keyof typeof LiveMarketType],
  side: (typeof TeamSide)[keyof typeof TeamSide],
  settlementReason:
    (typeof LiveSettlementReason)[keyof typeof LiveSettlementReason]
) => ({
  id: `row-${marketType}`,
  eventId: "event-live-contract",
  eventName: "Home - Away",
  oddsId: `odds-${marketType}`,
  oddsValue: 2,
  oddsName: side,
  productName: marketType,
  productId: `product-${marketType}`,
  timestamp: "2026-08-29T12:00:00.000Z",
  betKind: BetKind.LIVE,
  marketId: `market-${marketType}`,
  marketType,
  marketVersion: 1,
  quoteVersion: 1,
  selectionId: `${marketType}-${side}`,
  side,
  winningSide: side,
  settlementReason,
  settlementSequence: 1,
  result: ResultingStatus.ROW_WIN,
});

it("persists additive live contract values in bets and settlement ledgers", async () => {
  const kickoffRow = buildLiveRow(
    LiveMarketType.KICKOFF_TEAM,
    TeamSide.YES,
    LiveSettlementReason.KICK_OFF
  );
  const firstMinuteRow = buildLiveRow(
    LiveMarketType.FIRST_MINUTE_GOAL,
    TeamSide.NO,
    LiveSettlementReason.FIRST_MINUTE_GOAL
  );

  const bet = await Bet.create({
    userId: "live-contract-user",
    slipId: "live-contract-slip",
    betKind: BetKind.LIVE,
    status: ResultingStatus.BET_WIN,
    wager: 10,
    timestamp: "2026-08-29T12:00:00.000Z",
    rows: [kickoffRow, firstMinuteRow],
  });

  await LiveSettlementLedger.create([
    {
      eventId: kickoffRow.eventId,
      occurredAt: kickoffRow.timestamp,
      marketId: kickoffRow.marketId,
      marketType: kickoffRow.marketType,
      marketVersion: kickoffRow.marketVersion,
      settlementReason: kickoffRow.settlementReason,
      settlementSequence: kickoffRow.settlementSequence,
      winningSide: kickoffRow.winningSide,
    },
    {
      eventId: firstMinuteRow.eventId,
      occurredAt: firstMinuteRow.timestamp,
      marketId: firstMinuteRow.marketId,
      marketType: firstMinuteRow.marketType,
      marketVersion: firstMinuteRow.marketVersion,
      settlementReason: firstMinuteRow.settlementReason,
      settlementSequence: firstMinuteRow.settlementSequence,
      winningSide: firstMinuteRow.winningSide,
    },
  ]);

  const persistedBet = await Bet.findById(bet._id).lean();
  const persistedSettlements = await LiveSettlementLedger.find({})
    .sort({ marketId: 1 })
    .lean();

  expect(persistedBet?.rows).toEqual(
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
  expect(persistedSettlements).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        marketType: "KICKOFF_TEAM",
        winningSide: "YES",
        settlementReason: "KICK_OFF",
      }),
      expect.objectContaining({
        marketType: "FIRST_MINUTE_GOAL",
        winningSide: "NO",
        settlementReason: "FIRST_MINUTE_GOAL",
      }),
    ])
  );
});
