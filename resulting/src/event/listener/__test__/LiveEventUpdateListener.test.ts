import {
  BetKind,
  EventPhase,
  LiveMarketType,
  LiveSettlementReason,
  ModerationStatus,
  ResultingStatus,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import LiveEventUpdateListener from "../LiveEventUpdateListener";
import ModerationResultListener from "../ModerationResultListener";
import PlaceBetListener from "../PlaceBetListener";
import { Bet, BetArchive } from "../../../model/Bet";
import LiveSettlementLedger from "../../../model/LiveSettlementLedger";
import PendingModerationResult from "../../../model/PendingModerationResult";
import SettleSlipPublisher from "../../publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../publisher/SettleSlipRowPublisher";
import {
  createBet,
  createLiveMarketSnapshot,
  createLiveRow,
  createLiveSettlement,
  createLiveUpdateEvent,
  createMessage,
  createModerationEvent,
  createPlaceBetEvent,
  createPreMatchRow,
  setupPublisherSpies,
} from "../../../test/resultingTestUtils";

setupPublisherSpies();

const createLiveListener = async () => {
  const listener = new LiveEventUpdateListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

const createModerationListener = async () => {
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

const createPlaceListener = async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

const settlementEventForRow = (
  row: any,
  overrides: Partial<ReturnType<typeof createLiveSettlement>> = {}
) => {
  const settlement = createLiveSettlement({
    eventId: row.eventId,
    marketId: row.marketId,
    marketType: row.marketType,
    marketVersion: row.marketVersion,
    winningSide: row.side,
    winningSelection: row.selectionId,
    settlementSequence: 7,
    ...overrides,
  });

  return createLiveUpdateEvent({
    eventId: row.eventId,
    sequence: settlement.settlementSequence,
    occurredAt: "2026-08-20T17:00:00.000Z",
    phase:
      row.marketType === LiveMarketType.HALF_TIME_RESULT
        ? EventPhase.HALF_TIME
        : EventPhase.SECOND_HALF,
    homeScore: overrides.winningSide === TeamSide.DRAW ? 1 : 2,
    awayScore: overrides.winningSide === TeamSide.AWAY ? 3 : 1,
    markets: [
      createLiveMarketSnapshot({
        eventId: row.eventId,
        marketId: row.marketId,
        marketType: row.marketType,
        marketVersion:
          settlement.settlementReason === LiveSettlementReason.INCIDENT
            ? (row.marketVersion ?? 1) + 1
            : row.marketVersion,
      }),
    ],
    settlements: [settlement],
  });
};

const nextMarketCases = [
  LiveMarketType.NEXT_YELLOW_CARD,
  LiveMarketType.NEXT_RED_CARD,
  LiveMarketType.NEXT_CORNER,
  LiveMarketType.NEXT_PENALTY,
].flatMap((marketType) => [
  {
    marketType,
    winningSide: TeamSide.HOME,
    settlementReason: LiveSettlementReason.INCIDENT,
  },
  {
    marketType,
    winningSide: TeamSide.AWAY,
    settlementReason: LiveSettlementReason.INCIDENT,
  },
  {
    marketType,
    winningSide: TeamSide.NONE,
    settlementReason: LiveSettlementReason.FULL_TIME_NONE,
  },
]);

it.each(nextMarketCases)(
  "$marketType settles LIVE rows for $winningSide",
  async ({ marketType, winningSide, settlementReason }) => {
    const row = createLiveRow({ marketType, side: winningSide });
    const bet = await createBet({
      betKind: BetKind.LIVE,
      rows: [row],
      status: ResultingStatus.BET_APPROVED,
    });
    const listener = await createLiveListener();

    await listener.onMessage(
      settlementEventForRow(row, {
        winningSide,
        winningSelection: row.selectionId,
        settlementReason,
      }),
      createMessage()
    );

    const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });

    expect(archivedBet).not.toBeNull();
    expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
    expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
    expect(archivedBet!.rows[0].winningSide).toEqual(winningSide);
    expect(archivedBet!.rows[0].settlementReason).toEqual(settlementReason);
    expect(await LiveSettlementLedger.countDocuments({
      marketId: row.marketId,
      marketVersion: row.marketVersion,
    })).toEqual(1);
  }
);

it.each([TeamSide.HOME, TeamSide.DRAW, TeamSide.AWAY])(
  "HALF_TIME_RESULT settles %s rows explicitly at half-time",
  async (winningSide) => {
    const row = createLiveRow({
      marketType: LiveMarketType.HALF_TIME_RESULT,
      side: winningSide,
    });
    const bet = await createBet({
      betKind: BetKind.LIVE,
      rows: [row],
      status: ResultingStatus.BET_APPROVED,
    });
    const listener = await createLiveListener();

    await listener.onMessage(
      settlementEventForRow(row, {
        winningSide,
        settlementReason: LiveSettlementReason.HALF_TIME,
        winningSelection: row.selectionId,
      }),
      createMessage()
    );

    const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
    expect(archivedBet).not.toBeNull();
    expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
    expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
    expect(archivedBet!.rows[0].winningSide).toEqual(winningSide);
    expect(archivedBet!.rows[0].settlementReason).toEqual(
      LiveSettlementReason.HALF_TIME
    );
  }
);

it("settles repeated market versions independently", async () => {
  const eventId = "repeat-event";
  const marketId = `${eventId}:${LiveMarketType.NEXT_CORNER}`;
  const versionOneRow = createLiveRow({
    eventId,
    marketId,
    marketType: LiveMarketType.NEXT_CORNER,
    marketVersion: 1,
    side: TeamSide.HOME,
    selectionId: `${marketId}:1:${TeamSide.HOME}`,
  });
  const versionTwoRow = createLiveRow({
    eventId,
    marketId,
    marketType: LiveMarketType.NEXT_CORNER,
    marketVersion: 2,
    side: TeamSide.AWAY,
    selectionId: `${marketId}:2:${TeamSide.AWAY}`,
  });
  const firstBet = await createBet({
    betKind: BetKind.LIVE,
    rows: [versionOneRow],
    status: ResultingStatus.BET_APPROVED,
  });
  const secondBet = await createBet({
    betKind: BetKind.LIVE,
    rows: [versionTwoRow],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await createLiveListener();

  await listener.onMessage(
    settlementEventForRow(versionOneRow, {
      winningSide: TeamSide.HOME,
      winningSelection: versionOneRow.selectionId,
      settlementSequence: 1,
    }),
    createMessage()
  );

  expect(await BetArchive.countDocuments({ slipId: firstBet.slipId })).toEqual(1);
  expect((await Bet.findOne({ slipId: secondBet.slipId }))!.status).toEqual(
    ResultingStatus.BET_APPROVED
  );

  await listener.onMessage(
    settlementEventForRow(versionTwoRow, {
      winningSide: TeamSide.AWAY,
      winningSelection: versionTwoRow.selectionId,
      settlementSequence: 2,
    }),
    createMessage()
  );

  expect(await BetArchive.countDocuments({ slipId: secondBet.slipId })).toEqual(1);
  expect(
    await LiveSettlementLedger.countDocuments({
      marketId,
      marketVersion: { $in: [1, 2] },
    })
  ).toEqual(2);
});

it("manual void removes the row and the remaining rows still decide the slip", async () => {
  const voidedRow = createLiveRow({
    marketType: LiveMarketType.NEXT_RED_CARD,
    side: TeamSide.HOME,
  });
  const winningRow = createLiveRow({
    marketType: LiveMarketType.NEXT_CORNER,
    side: TeamSide.AWAY,
  });
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [voidedRow, winningRow],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await createLiveListener();

  await listener.onMessage(
    settlementEventForRow(voidedRow, {
      settlementReason: LiveSettlementReason.MANUAL_VOID,
      winningSide: TeamSide.NONE,
      winningSelection: voidedRow.selectionId,
    }),
    createMessage()
  );

  const activeBet = await Bet.findOne({ slipId: bet.slipId });
  expect(activeBet).not.toBeNull();
  expect(activeBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(activeBet!.rows).toHaveLength(1);
  expect(activeBet!.rows[0].id).toEqual(winningRow.id);

  await listener.onMessage(
    settlementEventForRow(winningRow, {
      winningSide: TeamSide.AWAY,
      winningSelection: winningRow.selectionId,
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(archivedBet!.rows).toHaveLength(1);
  expect(archivedBet!.rows[0].id).toEqual(winningRow.id);
});

it("voids the parent slip when all rows are manually voided", async () => {
  const firstRow = createLiveRow({ marketType: LiveMarketType.NEXT_PENALTY });
  const secondRow = createLiveRow({
    marketType: LiveMarketType.HALF_TIME_RESULT,
    side: TeamSide.DRAW,
  });
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [firstRow, secondRow],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await createLiveListener();

  await listener.onMessage(
    settlementEventForRow(firstRow, {
      settlementReason: LiveSettlementReason.MANUAL_VOID,
      winningSide: TeamSide.NONE,
      winningSelection: firstRow.selectionId,
    }),
    createMessage()
  );
  await listener.onMessage(
    settlementEventForRow(secondRow, {
      settlementReason: LiveSettlementReason.MANUAL_VOID,
      winningSide: TeamSide.NONE,
      winningSelection: secondRow.selectionId,
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_VOID);
  expect(archivedBet!.rows).toHaveLength(0);
});

it("replays stored settlements when approval arrives after a restart", async () => {
  const row = createLiveRow({
    marketType: LiveMarketType.NEXT_YELLOW_CARD,
    side: TeamSide.HOME,
  });
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [row],
    status: ResultingStatus.BET_PENDING,
  });
  const liveListener = await createLiveListener();

  await liveListener.onMessage(
    settlementEventForRow(row, {
      winningSide: TeamSide.HOME,
      winningSelection: row.selectionId,
      settlementSequence: 13,
    }),
    createMessage()
  );

  expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();
  expect(await LiveSettlementLedger.countDocuments({ marketId: row.marketId })).toEqual(
    1
  );

  const moderationListener = await createModerationListener();
  await moderationListener.onMessage(
    createModerationEvent(bet.slipId, ModerationStatus.APPROVED, {
      betKind: BetKind.LIVE,
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
});

it("first live loss immediately voids the remaining unsettled rows", async () => {
  const losingRow = createLiveRow({
    marketType: LiveMarketType.NEXT_CORNER,
    side: TeamSide.HOME,
  });
  const pendingRow = createLiveRow({
    marketType: LiveMarketType.NEXT_PENALTY,
    side: TeamSide.AWAY,
  });
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [losingRow, pendingRow],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await createLiveListener();

  await listener.onMessage(
    settlementEventForRow(losingRow, {
      winningSide: TeamSide.AWAY,
      winningSelection: `${losingRow.marketId}:${losingRow.marketVersion}:${TeamSide.AWAY}`,
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_LOSS);
  expect(archivedBet!.rows.find((row: any) => row.id === losingRow.id)!.result).toEqual(
    ResultingStatus.ROW_LOSS
  );
  expect(archivedBet!.rows.find((row: any) => row.id === pendingRow.id)!.result).toEqual(
    ResultingStatus.ROW_VOID
  );
});

it("settles multi-row live accumulators once every remaining row wins", async () => {
  const firstRow = createLiveRow({
    marketType: LiveMarketType.NEXT_RED_CARD,
    side: TeamSide.HOME,
  });
  const secondRow = createLiveRow({
    marketType: LiveMarketType.HALF_TIME_RESULT,
    side: TeamSide.DRAW,
  });
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [firstRow, secondRow],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await createLiveListener();

  await listener.onMessage(
    settlementEventForRow(firstRow, {
      winningSide: TeamSide.HOME,
      winningSelection: firstRow.selectionId,
      settlementSequence: 1,
    }),
    createMessage()
  );

  const activeBet = await Bet.findOne({ slipId: bet.slipId });
  expect(activeBet).not.toBeNull();
  expect(activeBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(activeBet!.rows.find((row: any) => row.id === firstRow.id)!.result).toEqual(
    ResultingStatus.ROW_WIN
  );

  await listener.onMessage(
    settlementEventForRow(secondRow, {
      winningSide: TeamSide.DRAW,
      winningSelection: secondRow.selectionId,
      settlementReason: LiveSettlementReason.HALF_TIME,
      settlementSequence: 2,
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
});

it("deduplicates duplicate live settlement deliveries under concurrency", async () => {
  const row = createLiveRow({
    marketType: LiveMarketType.NEXT_PENALTY,
    side: TeamSide.HOME,
  });
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [row],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await createLiveListener();
  const update = settlementEventForRow(row, {
    winningSide: TeamSide.HOME,
    winningSelection: row.selectionId,
  });

  await Promise.all([
    listener.onMessage(update, createMessage()),
    listener.onMessage(update, createMessage()),
  ]);

  expect(await BetArchive.countDocuments({ slipId: bet.slipId })).toEqual(1);
  expect(await LiveSettlementLedger.countDocuments({
    marketId: row.marketId,
    marketVersion: row.marketVersion,
  })).toEqual(1);
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it.each([
  ["place", "approve", "settle"],
  ["settle", "place", "approve"],
  ["approve", "settle", "place"],
])(
  "ordering permutation %j converges to the same settled result",
  async (first: string, second: string, third: string) => {
    const order = [first, second, third];
    const row = createLiveRow({
      marketType: LiveMarketType.NEXT_CORNER,
      side: TeamSide.HOME,
    });
    const slipId = `ordered-${order.join("-")}`;
    const placeBetEvent = createPlaceBetEvent({
      slipId,
      betKind: BetKind.LIVE,
      rows: [row],
    });
    const approvalEvent = createModerationEvent(
      slipId,
      ModerationStatus.APPROVED,
      { betKind: BetKind.LIVE }
    );
    const update = settlementEventForRow(row, {
      winningSide: TeamSide.HOME,
      winningSelection: row.selectionId,
      settlementSequence: 5,
    });
    const listeners = {
      place: await createPlaceListener(),
      approve: await createModerationListener(),
      settle: await createLiveListener(),
    };
    const operations: Record<string, () => Promise<void>> = {
      place: async () => {
        await listeners.place.onMessage(placeBetEvent, createMessage());
      },
      approve: async () => {
        await listeners.approve.onMessage(approvalEvent, createMessage());
      },
      settle: async () => {
        await listeners.settle.onMessage(update, createMessage());
      },
    };

    for (const step of order) {
      await operations[step]();
    }

    const archivedBet = await BetArchive.findOne({ slipId });
    expect(archivedBet).not.toBeNull();
    expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
    expect(await PendingModerationResult.findOne({ slipId })).toBeNull();
  }
);

it("processes only LIVE rows even if a pre-match row carries matching market identifiers", async () => {
  const liveRow = createLiveRow({
    marketType: LiveMarketType.NEXT_RED_CARD,
    side: TeamSide.HOME,
  });
  const preMatchRow = createPreMatchRow({
    eventId: liveRow.eventId,
    marketId: liveRow.marketId,
    marketType: liveRow.marketType,
    marketVersion: liveRow.marketVersion,
    selectionId: liveRow.selectionId,
    side: liveRow.side,
    betKind: BetKind.PRE_MATCH,
  });
  const bet = await createBet({
    betKind: BetKind.PRE_MATCH,
    rows: [preMatchRow],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await createLiveListener();

  await listener.onMessage(
    settlementEventForRow(liveRow, {
      winningSide: TeamSide.HOME,
      winningSelection: liveRow.selectionId,
    }),
    createMessage()
  );

  const activeBet = await Bet.findOne({ slipId: bet.slipId });
  expect(activeBet).not.toBeNull();
  expect(activeBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(activeBet!.rows[0].result).toEqual(ResultingStatus.ROW_NO_RESULT);
  expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();
});
