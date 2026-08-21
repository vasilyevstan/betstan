import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  BetStatus,
  IPlaceBetEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  LiveMarketType,
  LiveSettlementReason,
  ModerationDeclineReason,
  ResultingStatus,
  messengerWrapper,
  SlipRowStatus,
  TeamSide,
} from "@betstan/common";
import PlaceBetListener from "../PlaceBetListener";
import { Bet } from "../../../model/Bet";
import { BetPlacementConflict } from "../../../model/BetPlacementConflict";
import {
  buildCanonicalPlacedBetPayload,
  buildCanonicalPlacedBetPayloadFromBet,
} from "../../../service/betHistory";
import {
  PendingBetUpdate,
  PendingBetUpdateStatus,
} from "../../../model/PendingBetUpdate";
import SettleSlipListener from "../SettleSlipListener";
import SettleSlipRowListener from "../SettleSlipRowListener";

const createDeferred = () => {
  let resolve!: () => void;

  return {
    promise: new Promise<void>((innerResolve) => {
      resolve = innerResolve;
    }),
    resolve,
  };
};

const buildMessage = (): ConsumeMessage => ({
  content: Buffer.alloc(5),
  fields: {
    consumerTag: "",
    deliveryTag: 0,
    redelivered: false,
    exchange: "",
    routingKey: "",
  },
  properties: {
    contentType: undefined,
    contentEncoding: undefined,
    headers: {},
    deliveryMode: undefined,
    priority: undefined,
    correlationId: undefined,
    replyTo: undefined,
    expiration: undefined,
    messageId: undefined,
    timestamp: undefined,
    type: undefined,
    userId: undefined,
    appId: undefined,
    clusterId: undefined,
  },
});

const buildEvent = (
  overrides: Partial<Omit<IPlaceBetEvent, "data">> & {
    data?: Partial<Omit<IPlaceBetEvent["data"], "rows">> & {
      rows?: Array<Partial<IPlaceBetEvent["data"]["rows"][number]>>;
    };
  } = {}
): IPlaceBetEvent => {
  const defaultRow = {
    eventId: new mongoose.Types.ObjectId().toHexString(),
    eventName: "Team A - Team B",
    oddsId: new mongoose.Types.ObjectId().toHexString(),
    oddsValue: 1.5,
    oddsName: "Team A",
    productName: "1X2",
    productId: new mongoose.Types.ObjectId().toHexString(),
    timestamp: new Date().toISOString(),
    id: new mongoose.Types.ObjectId().toHexString(),
  };

  return {
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    data: {
      userId:
        overrides.data?.userId ?? new mongoose.Types.ObjectId().toHexString(),
      userName: overrides.data?.userName ?? "testuser",
      slipId:
        overrides.data?.slipId ?? new mongoose.Types.ObjectId().toHexString(),
      wager: overrides.data?.wager ?? 10,
      betKind: overrides.data?.betKind,
      rows: (overrides.data?.rows?.map((row) => ({
          ...defaultRow,
          ...row,
        })) ?? [defaultRow]) as IPlaceBetEvent["data"]["rows"],
    },
  };
};

const immutableSnapshotOf = (bet: any) => ({
  betKind: bet.betKind,
  rows: bet.rows.map((row: any) => ({
    betKind: row.betKind,
    eventId: row.eventId,
    eventName: row.eventName,
    id: row.id,
    marketId: row.marketId,
    marketType: row.marketType,
    marketVersion: row.marketVersion,
    oddsId: row.oddsId,
    oddsName: row.oddsName,
    oddsValue: row.oddsValue,
    productId: row.productId,
    productName: row.productName,
    quoteValidUntil: row.quoteValidUntil,
    quoteVersion: row.quoteVersion,
    selectedAt: row.selectedAt,
    selectionId: row.selectionId,
    side: row.side,
    timestamp: row.timestamp,
  })),
  slipId: bet.slipId,
  timestamp: bet.timestamp,
  userId: bet.userId,
  userName: bet.userName,
  wager: bet.wager,
});

it("saves live kind and market metadata when a PlaceBet event is received", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent({
    data: {
      betKind: BetKind.LIVE,
      rows: [
        {
          betKind: BetKind.LIVE,
          eventTime: "2026-08-20T16:00:00.000Z",
          marketId: "event-one:NEXT_CORNER",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 2,
          quoteVersion: 3,
          selectionId: "event-one:NEXT_CORNER:2:HOME",
          side: TeamSide.HOME,
          selectedAt: "2026-08-20T17:00:00.000Z",
          quoteValidUntil: "2026-08-20T17:00:30.000Z",
          productName: "Next corner",
          oddsName: "Home",
        },
      ],
    },
  });
  await listener.onMessage(event, buildMessage());

  const bets = await Bet.find({});
  expect(bets.length).toEqual(1);
  expect(bets[0].slipId).toEqual(event.data.slipId);
  expect(bets[0].status).toEqual(BetStatus.PENDING);
  expect(bets[0].betKind).toEqual(BetKind.LIVE);
  expect(bets[0].rows.length).toEqual(1);
  expect(bets[0].rows[0].status).toEqual(SlipRowStatus.NOT_SETTLED);
  expect(bets[0].rows[0].betKind).toEqual(BetKind.LIVE);
  expect(bets[0].rows[0].marketId).toEqual("event-one:NEXT_CORNER");
  expect(bets[0].rows[0].marketType).toEqual(LiveMarketType.NEXT_CORNER);
  expect(bets[0].rows[0].marketVersion).toEqual(2);
  expect(bets[0].rows[0].quoteVersion).toEqual(3);
  expect(bets[0].rows[0].selectionId).toEqual(
    "event-one:NEXT_CORNER:2:HOME"
  );
  expect(bets[0].rows[0].side).toEqual(TeamSide.HOME);
  expect(bets[0].rows[0].productName).toEqual("Next corner");
  expect(bets[0].rows[0].oddsName).toEqual("Home");
});

it("upserts duplicate place events by slip ID without resetting terminal state", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent({
    data: {
      betKind: BetKind.LIVE,
      rows: [
        {
          betKind: BetKind.LIVE,
          marketId: "event-two:NEXT_RED_CARD",
          marketType: LiveMarketType.NEXT_RED_CARD,
          productName: "Next red card",
          oddsName: "Away",
        },
      ],
    },
  });
  await listener.onMessage(event, buildMessage());

  const storedBet = await Bet.findOne({ slipId: event.data.slipId });
  storedBet!.status = BetStatus.WIN;
  storedBet!.rows[0].status = SlipRowStatus.WIN;
  storedBet!.rows[0].winningSelection = "Away";
  await storedBet!.save();

  await listener.onMessage(event, buildMessage());

  const bets = await Bet.find({ slipId: event.data.slipId });
  expect(bets).toHaveLength(1);
  expect(bets[0].status).toEqual(BetStatus.WIN);
  expect(bets[0].rows[0].status).toEqual(SlipRowStatus.WIN);
  expect(bets[0].rows[0].winningSelection).toEqual("Away");
});

it("keeps the first placement immutable when the first event omits bet kind", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const firstEvent = buildEvent({
    data: {
      betKind: undefined,
      rows: [
        {
          id: rowId,
          betKind: undefined,
          oddsName: "Home",
          productName: "1X2",
        },
      ],
      slipId,
    },
  });
  const duplicateEvent = buildEvent({
    data: {
      betKind: BetKind.PRE_MATCH,
      rows: [
        {
          ...firstEvent.data.rows[0],
          betKind: BetKind.PRE_MATCH,
        },
      ],
      slipId,
      userId: firstEvent.data.userId,
      userName: firstEvent.data.userName,
      wager: firstEvent.data.wager,
    },
    timestamp: firstEvent.timestamp,
  });

  await listener.onMessage(firstEvent, buildMessage());
  await listener.onMessage(duplicateEvent, buildMessage());

  const bet = await Bet.findOne({ slipId });
  expect(bet!.betKind).toEqual(BetKind.PRE_MATCH);
  expect(bet!.rows[0].betKind).toEqual(BetKind.PRE_MATCH);
  expect(await BetPlacementConflict.countDocuments({ slipId })).toEqual(0);
});

it.each([
  {
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    rowStatus: SlipRowStatus.NOT_SETTLED,
    status: BetStatus.CONFIRMED,
  },
  {
    declineReason: ModerationDeclineReason.EVENT_STARTED,
    rowStatus: SlipRowStatus.NOT_SETTLED,
    status: BetStatus.DECLINED,
  },
  {
    declineReason: undefined,
    rowStatus: SlipRowStatus.WIN,
    status: BetStatus.WIN,
  },
  {
    declineReason: undefined,
    rowStatus: SlipRowStatus.LOSS,
    status: BetStatus.LOSS,
  },
  {
    declineReason: undefined,
    rowStatus: SlipRowStatus.VOID,
    status: BetStatus.VOID,
  },
])(
  "does not let duplicate placement reset status %s",
  async ({ declineReason, rowStatus, status }) => {
    const listener = new PlaceBetListener(messengerWrapper.connection);
    await listener.init();

    const event = buildEvent({
      data: {
        betKind: BetKind.LIVE,
        rows: [
          {
            betKind: BetKind.LIVE,
            marketId: "event-five:NEXT_CORNER",
            marketType: LiveMarketType.NEXT_CORNER,
            oddsName: "Away",
            productName: "Next corner",
          },
        ],
      },
    });

    await listener.onMessage(event, buildMessage());

    const storedBet = await Bet.findOne({ slipId: event.data.slipId });
    storedBet!.status = status;
    storedBet!.declineReason = declineReason;
    storedBet!.rows[0].status = rowStatus;
    storedBet!.rows[0].winningSelection =
      rowStatus === SlipRowStatus.NOT_SETTLED ? "" : "Away";
    await storedBet!.save();

    const immutableBeforeDuplicate = immutableSnapshotOf(storedBet!);

    await listener.onMessage(event, buildMessage());

    const updatedBet = await Bet.findOne({ slipId: event.data.slipId });
    expect(updatedBet!.status).toEqual(status);
    expect(updatedBet!.declineReason).toEqual(declineReason);
    expect(updatedBet!.rows[0].status).toEqual(rowStatus);
    expect(updatedBet!.rows[0].winningSelection).toEqual(
      rowStatus === SlipRowStatus.NOT_SETTLED ? "" : "Away"
    );
    expect(immutableSnapshotOf(updatedBet!)).toEqual(immutableBeforeDuplicate);
    expect(await BetPlacementConflict.countDocuments({ slipId: event.data.slipId })).toEqual(0);
  }
);

it.each([
  BetStatus.CONFIRMED,
  BetStatus.DECLINED,
  BetStatus.WIN,
  BetStatus.VOID,
])(
  "does not let a conflicting late duplicate reset terminal state %s",
  async (status) => {
    const listener = new PlaceBetListener(messengerWrapper.connection);
    await listener.init();

    const slipId = new mongoose.Types.ObjectId().toHexString();
    const rowId = new mongoose.Types.ObjectId().toHexString();
    const firstEvent = buildEvent({
      data: {
        betKind: BetKind.LIVE,
        rows: [
          {
            betKind: BetKind.LIVE,
            id: rowId,
            marketId: "event-nine:NEXT_CORNER",
            marketType: LiveMarketType.NEXT_CORNER,
            oddsName: "Home",
            oddsValue: 1.5,
            productName: "Next corner",
          },
        ],
        slipId,
      },
    });
    const conflictingEvent = buildEvent({
      data: {
        betKind: BetKind.LIVE,
        rows: [
          {
            betKind: BetKind.LIVE,
            id: rowId,
            marketId: "event-nine:NEXT_CORNER",
            marketType: LiveMarketType.NEXT_CORNER,
            oddsName: "Away",
            oddsValue: 2.5,
            productName: "Changed selection",
          },
        ],
        slipId,
        userId: new mongoose.Types.ObjectId().toHexString(),
        userName: "conflicting-user",
        wager: 30,
      },
      timestamp: firstEvent.timestamp,
    });

    await listener.onMessage(firstEvent, buildMessage());

    const storedBet = await Bet.findOne({ slipId });
    storedBet!.status = status;
    storedBet!.rows[0].status =
      status === BetStatus.WIN
        ? SlipRowStatus.WIN
        : status === BetStatus.VOID
        ? SlipRowStatus.VOID
        : SlipRowStatus.NOT_SETTLED;
    storedBet!.rows[0].winningSelection =
      status === BetStatus.WIN || status === BetStatus.VOID ? "Home" : "";
    storedBet!.declineReason =
      status === BetStatus.DECLINED
        ? ModerationDeclineReason.STALE_QUOTE
        : undefined;
    await storedBet!.save();

    const immutableBeforeDuplicate = immutableSnapshotOf(storedBet!);

    await listener.onMessage(conflictingEvent, buildMessage());

    const bet = await Bet.findOne({ slipId });
    expect(bet!.status).toEqual(status);
    expect(bet!.declineReason).toEqual(
      status === BetStatus.DECLINED
        ? ModerationDeclineReason.STALE_QUOTE
        : undefined
    );
    expect(bet!.rows[0].status).toEqual(
      status === BetStatus.WIN
        ? SlipRowStatus.WIN
        : status === BetStatus.VOID
        ? SlipRowStatus.VOID
        : SlipRowStatus.NOT_SETTLED
    );
    expect(immutableSnapshotOf(bet!)).toEqual(immutableBeforeDuplicate);
    expect(await BetPlacementConflict.countDocuments({ slipId })).toEqual(1);
  }
);

it("replays parked live settlement updates when the place event arrives later", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();

  const settleSlipRowListener = new SettleSlipRowListener(
    messengerWrapper.connection
  );
  await settleSlipRowListener.init();

  const settleSlipListener = new SettleSlipListener(messengerWrapper.connection);
  await settleSlipListener.init();

  const settleRowEvent: ISettleSlipRowEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      slipRowId: rowId,
      result: ResultingStatus.ROW_VOID,
      betKind: BetKind.LIVE,
      marketId: "event-three:NEXT_CORNER",
      marketType: LiveMarketType.NEXT_CORNER,
      marketVersion: 3,
      settlementReason: LiveSettlementReason.MANUAL_VOID,
      settlementSequence: 4,
      winningSide: TeamSide.NONE,
    },
  };

  const settleSlipEvent: ISettleSlipEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      result: ResultingStatus.BET_VOID,
      betKind: BetKind.LIVE,
    },
  };

  await settleSlipRowListener.onMessage(settleRowEvent, buildMessage());
  await settleSlipListener.onMessage(settleSlipEvent, buildMessage());

  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(2);

  const placeListener = new PlaceBetListener(messengerWrapper.connection);
  await placeListener.init();

  const placeEvent = buildEvent({
    data: {
      slipId,
      betKind: BetKind.LIVE,
      rows: [
        {
          id: rowId,
          betKind: BetKind.LIVE,
          marketId: "event-three:NEXT_CORNER",
          marketType: LiveMarketType.NEXT_CORNER,
          productName: "Next corner",
          oddsName: "Home",
        },
      ],
    },
  });

  await placeListener.onMessage(placeEvent, buildMessage());

  const bet = await Bet.findOne({ slipId });
  expect(bet!.status).toEqual(BetStatus.VOID);
  expect(bet!.betKind).toEqual(BetKind.LIVE);
  expect(bet!.rows[0].status).toEqual(SlipRowStatus.VOID);
  expect(bet!.rows[0].marketId).toEqual("event-three:NEXT_CORNER");
  expect(bet!.rows[0].marketType).toEqual(LiveMarketType.NEXT_CORNER);
  expect(bet!.rows[0].settlementReason).toEqual(
    LiveSettlementReason.MANUAL_VOID
  );
  expect(bet!.rows[0].settlementSequence).toEqual(4);
  expect(bet!.rows[0].winningSide).toEqual(TeamSide.NONE);
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);
});

it("acknowledges simultaneous exact duplicate placements without creating a second bet", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const updateOneBarrier = createDeferred();
  let updateOneCallCount = 0;
  const originalUpdateOne = Bet.collection.updateOne.bind(Bet.collection);
  const updateOneSpy = jest
    .spyOn(Bet.collection, "updateOne")
    .mockImplementation(async (...args: Parameters<typeof originalUpdateOne>) => {
      updateOneCallCount += 1;
      if (updateOneCallCount === 2) {
        updateOneBarrier.resolve();
      }
      await updateOneBarrier.promise;
      return originalUpdateOne(...args);
    });

  const event = buildEvent({
    data: {
      betKind: BetKind.LIVE,
      rows: [
        {
          betKind: BetKind.LIVE,
          marketId: "event-six:NEXT_CORNER",
          marketType: LiveMarketType.NEXT_CORNER,
          oddsName: "Home",
          productName: "Next corner",
        },
      ],
    },
  });

  await Promise.all([
    listener.onMessage(event, buildMessage()),
    listener.onMessage(event, buildMessage()),
  ]);

  const bets = await Bet.find({ slipId: event.data.slipId });
  const storedBet = await Bet.findOne({ slipId: event.data.slipId });
  expect(bets).toHaveLength(1);
  expect(buildCanonicalPlacedBetPayloadFromBet(storedBet!)).toEqual(
    buildCanonicalPlacedBetPayload(event)
  );
  expect(immutableSnapshotOf(bets[0])).toEqual(
    immutableSnapshotOf(await Bet.findOne({ slipId: event.data.slipId }))
  );
  expect(await BetPlacementConflict.countDocuments({ slipId: event.data.slipId })).toEqual(0);

  updateOneSpy.mockRestore();
});

it("keeps the first conflicting placement payload immutable under concurrent duplicate delivery", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const firstRelease = createDeferred();
  const secondRelease = createDeferred();
  const secondCallReached = createDeferred();
  let updateOneCallCount = 0;
  const originalUpdateOne = Bet.collection.updateOne.bind(Bet.collection);
  const updateOneSpy = jest
    .spyOn(Bet.collection, "updateOne")
    .mockImplementation(async (...args: Parameters<typeof originalUpdateOne>) => {
      updateOneCallCount += 1;

      if (updateOneCallCount === 1) {
        await firstRelease.promise;
      } else {
        secondCallReached.resolve();
        await secondRelease.promise;
      }

      return originalUpdateOne(...args);
    });

  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const firstEvent = buildEvent({
    data: {
      betKind: BetKind.LIVE,
      rows: [
        {
          betKind: BetKind.LIVE,
          id: rowId,
          marketId: "event-seven:NEXT_CORNER",
          marketType: LiveMarketType.NEXT_CORNER,
          oddsName: "Home",
          oddsValue: 1.5,
          productName: "Next corner",
        },
      ],
      slipId,
      userName: "first-user",
      wager: 10,
    },
  });
  const conflictingEvent = buildEvent({
    data: {
      betKind: BetKind.LIVE,
      rows: [
        {
          betKind: BetKind.LIVE,
          id: rowId,
          marketId: "event-seven:NEXT_CORNER",
          marketType: LiveMarketType.NEXT_CORNER,
          oddsName: "Away",
          oddsValue: 2.25,
          productName: "Conflicting selection",
        },
      ],
      slipId,
      userId: new mongoose.Types.ObjectId().toHexString(),
      userName: "conflicting-user",
      wager: 25,
    },
    timestamp: firstEvent.timestamp,
  });

  const firstPromise = listener.onMessage(firstEvent, buildMessage());
  const conflictingPromise = listener.onMessage(conflictingEvent, buildMessage());

  await secondCallReached.promise;
  firstRelease.resolve();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const persistedBet = await Bet.findOne({ slipId });
    if (persistedBet?.userName === "first-user") {
      break;
    }
    await Promise.resolve();
  }
  secondRelease.resolve();
  await Promise.all([firstPromise, conflictingPromise]);

  const bets = await Bet.find({ slipId });
  const bet = bets[0];
  expect(bets).toHaveLength(1);
  expect(bet.userName).toEqual("first-user");
  expect(bet.wager).toEqual(10);
  expect(bet.rows[0].oddsName).toEqual("Home");
  expect(bet.rows[0].oddsValue).toEqual(1.5);
  expect(bet.rows[0].productName).toEqual("Next corner");
  expect(await BetPlacementConflict.countDocuments({ slipId })).toEqual(1);

  const conflict = await BetPlacementConflict.findOne({ slipId });
  expect(conflict!.occurrenceCount).toEqual(1);
  expect(conflict!.firstPlacementFingerprint).not.toEqual(
    conflict!.conflictingPlacementFingerprint
  );

  updateOneSpy.mockRestore();
});

it("replays pending updates safely when exact duplicate placements race together", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  const settleSlipRowListener = new SettleSlipRowListener(
    messengerWrapper.connection
  );
  await settleSlipRowListener.init();

  await settleSlipRowListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: {
        slipId,
        slipRowId: rowId,
        result: ResultingStatus.ROW_VOID,
        betKind: BetKind.LIVE,
        marketId: "event-eight:NEXT_CORNER",
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: 3,
        settlementReason: LiveSettlementReason.MANUAL_VOID,
        settlementSequence: 4,
        winningSide: TeamSide.NONE,
      },
    },
    buildMessage()
  );

  const event = buildEvent({
    data: {
      betKind: BetKind.LIVE,
      rows: [
        {
          betKind: BetKind.LIVE,
          id: rowId,
          marketId: "event-eight:NEXT_CORNER",
          marketType: LiveMarketType.NEXT_CORNER,
          oddsName: "Home",
          productName: "Next corner",
        },
      ],
      slipId,
    },
  });

  await Promise.all([
    listener.onMessage(event, buildMessage()),
    listener.onMessage(event, buildMessage()),
  ]);

  const bets = await Bet.find({ slipId });
  expect(bets).toHaveLength(1);
  expect(bets[0].rows[0].status).toEqual(SlipRowStatus.VOID);
  expect(bets[0].status).toEqual(BetStatus.PENDING);
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);
});

it("does not bypass another worker's active lease during immediate replay", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();

  const settleSlipListener = new SettleSlipListener(messengerWrapper.connection);
  await settleSlipListener.init();

  await settleSlipListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: {
        slipId,
        result: ResultingStatus.BET_VOID,
        betKind: BetKind.LIVE,
      },
    },
    buildMessage()
  );

  await PendingBetUpdate.updateOne(
    { slipId },
    {
      $set: {
        leaseOwner: "other-worker",
        leaseUntil: new Date(Date.now() + 60_000),
        status: PendingBetUpdateStatus.PROCESSING,
      },
    }
  );

  const placeListener = new PlaceBetListener(messengerWrapper.connection);
  await placeListener.init();

  await placeListener.onMessage(
    buildEvent({
      data: {
        betKind: BetKind.LIVE,
        rows: [
          {
            betKind: BetKind.LIVE,
            id: rowId,
            marketId: "event-four:NEXT_CORNER",
            marketType: LiveMarketType.NEXT_CORNER,
            oddsName: "Home",
            productName: "Next corner",
          },
        ],
        slipId,
      },
    }),
    buildMessage()
  );

  const bet = await Bet.findOne({ slipId });
  const pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(bet!.status).toEqual(BetStatus.PENDING);
  expect(bet!.rows[0].status).toEqual(SlipRowStatus.NOT_SETTLED);
  expect(pendingUpdate!.status).toEqual(PendingBetUpdateStatus.PROCESSING);
  expect(pendingUpdate!.leaseOwner).toEqual("other-worker");
});

it("acks the message after saving the bet", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent();
  await listener.onMessage(event, buildMessage());

  expect(listener.ack).toHaveBeenCalled();
});
