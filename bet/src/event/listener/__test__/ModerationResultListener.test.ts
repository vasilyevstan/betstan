import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  BetStatus,
  IModerationResultEvent,
  IPlaceBetEvent,
  LiveMarketStatus,
  ModerationStatus,
  ModerationDeclineReason,
  messengerWrapper,
  SlipRowStatus,
} from "@betstan/common";
import ModerationResultListener from "../ModerationResultListener";
import PlaceBetListener from "../PlaceBetListener";
import { Bet } from "../../../model/Bet";
import {
  PendingBetUpdate,
  PendingBetUpdateKind,
} from "../../../model/PendingBetUpdate";

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

const createBet = async (slipId: string, rowIds: string[] = [new mongoose.Types.ObjectId().toHexString()]) => {
  const bet = new Bet({
    status: BetStatus.PENDING,
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testuser",
    slipId,
    wager: 10,
    timestamp: new Date().toISOString(),
    betKind: BetKind.LIVE,
    rows: [
      ...rowIds.map((rowId) => ({
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
        status: SlipRowStatus.NOT_SETTLED,
        id: rowId,
        betKind: BetKind.LIVE,
      })),
    ],
  });
  await bet.save();
  return bet;
};

it("sets bet status to CONFIRMED when moderation approves", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId);

  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IModerationResultEvent = {
    timestamp: new Date().toISOString(),
    data: { slipId, result: ModerationStatus.APPROVED },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.CONFIRMED);
});

it("propagates live decline reasons and row metadata when moderation declines", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowIds = [
    new mongoose.Types.ObjectId().toHexString(),
    new mongoose.Types.ObjectId().toHexString(),
  ];
  await createBet(slipId, rowIds);

  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IModerationResultEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
      affectedRows: [
        {
          rowId: rowIds[0],
          declineReason: ModerationDeclineReason.STALE_QUOTE,
          marketId: "event-one:NEXT_CORNER",
          marketVersion: 2,
          quoteVersion: 4,
          currentOdds: 2.1,
          marketStatus: LiveMarketStatus.OPEN,
          selectionId: "event-one:NEXT_CORNER:2:HOME",
        },
        {
          rowId: rowIds[1],
          declineReason: ModerationDeclineReason.MARKET_SUSPENDED,
          marketId: "event-two:NEXT_RED_CARD",
          marketVersion: 1,
          quoteVersion: 3,
          marketStatus: LiveMarketStatus.SUSPENDED,
          selectionId: "event-two:NEXT_RED_CARD:1:AWAY",
        },
      ],
    },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.DECLINED);
  expect(updatedBet!.betKind).toEqual(BetKind.LIVE);
  expect(updatedBet!.declineReason).toEqual(
    ModerationDeclineReason.STALE_QUOTE
  );
  expect(updatedBet!.rows[0].declineReason).toEqual(
    ModerationDeclineReason.STALE_QUOTE
  );
  expect(updatedBet!.rows[0].marketId).toEqual("event-one:NEXT_CORNER");
  expect(updatedBet!.rows[0].marketVersion).toEqual(2);
  expect(updatedBet!.rows[0].quoteVersion).toEqual(4);
  expect(updatedBet!.rows[0].currentOdds).toEqual(2.1);
  expect(updatedBet!.rows[0].marketStatus).toEqual(LiveMarketStatus.OPEN);
  expect(updatedBet!.rows[0].selectionId).toEqual(
    "event-one:NEXT_CORNER:2:HOME"
  );
  expect(updatedBet!.rows[1].declineReason).toEqual(
    ModerationDeclineReason.MARKET_SUSPENDED
  );
  expect(updatedBet!.rows[1].marketStatus).toEqual(
    LiveMarketStatus.SUSPENDED
  );
});

it("parks duplicate moderation updates when the bet is not found", async () => {
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const slipId = new mongoose.Types.ObjectId().toHexString();
  const event: IModerationResultEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
      affectedRows: [
        {
          rowId: new mongoose.Types.ObjectId().toHexString(),
          declineReason: ModerationDeclineReason.STALE_QUOTE,
        },
      ],
    },
  };

  await listener.onMessage(event, buildMessage());
  await listener.onMessage(event, buildMessage());

  expect(listener.ack).toHaveBeenCalledTimes(2);
  expect((listener as unknown as { channel: { nack: jest.Mock } }).channel.nack).not.toHaveBeenCalled();
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(1);

  const pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.kind).toEqual(PendingBetUpdateKind.MODERATION_RESULT);
});

it("replays parked moderation declines after the place event is persisted", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();

  const moderationListener = new ModerationResultListener(
    messengerWrapper.connection
  );
  await moderationListener.init();

  const moderationEvent: IModerationResultEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
      affectedRows: [
        {
          rowId,
          declineReason: ModerationDeclineReason.STALE_QUOTE,
          marketId: "event-one:NEXT_CORNER",
          marketVersion: 2,
        },
      ],
    },
  };

  await moderationListener.onMessage(moderationEvent, buildMessage());
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(1);

  const placeListener = new PlaceBetListener(messengerWrapper.connection);
  await placeListener.init();

  const placeEvent: IPlaceBetEvent = {
    timestamp: new Date().toISOString(),
    data: {
      userId: new mongoose.Types.ObjectId().toHexString(),
      userName: "testuser",
      slipId,
      wager: 10,
      betKind: BetKind.LIVE,
      rows: [
        {
          eventId: new mongoose.Types.ObjectId().toHexString(),
          eventName: "Team A - Team B",
          oddsId: new mongoose.Types.ObjectId().toHexString(),
          oddsValue: 1.5,
          oddsName: "Team A",
          productName: "Next corner",
          productId: new mongoose.Types.ObjectId().toHexString(),
          timestamp: new Date().toISOString(),
          id: rowId,
          betKind: BetKind.LIVE,
          marketId: "event-one:NEXT_CORNER",
        },
      ],
    },
  };

  await placeListener.onMessage(placeEvent, buildMessage());

  const bet = await Bet.findOne({ slipId });
  expect(bet!.status).toEqual(BetStatus.DECLINED);
  expect(bet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
  expect(bet!.rows[0].declineReason).toEqual(
    ModerationDeclineReason.STALE_QUOTE
  );
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(0);
});

it("does not regress settled terminal states on late moderation results", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId);
  await Bet.updateOne({ slipId }, { status: BetStatus.WIN });

  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IModerationResultEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
    },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.WIN);
  expect(updatedBet!.declineReason).toBeUndefined();
});
