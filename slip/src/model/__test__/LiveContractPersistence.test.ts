import { BetKind, SlipStatus } from "@betstan/common";
import {
  LiveMarketType,
  TeamSide,
} from "../../compat/LiveContract";
import { Slip } from "../Slip";

const buildLiveRow = (
  marketType: (typeof LiveMarketType)[keyof typeof LiveMarketType],
  side: (typeof TeamSide)[keyof typeof TeamSide]
) => ({
  eventId: `event-${marketType}`,
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
});

it("persists additive live market and side values with the published common package", async () => {
  const slip = await Slip.create({
    userId: "live-contract-user",
    status: SlipStatus.DRAFT,
    betKind: BetKind.LIVE,
    timestamp: "2026-08-29T12:00:00.000Z",
    rows: [
      buildLiveRow(LiveMarketType.KICKOFF_TEAM, TeamSide.YES),
      buildLiveRow(LiveMarketType.FIRST_MINUTE_GOAL, TeamSide.NO),
    ],
  });

  const persisted = await Slip.findById(slip._id).lean();

  expect(persisted?.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        marketType: "KICKOFF_TEAM",
        side: "YES",
      }),
      expect.objectContaining({
        marketType: "FIRST_MINUTE_GOAL",
        side: "NO",
      }),
    ])
  );
});
