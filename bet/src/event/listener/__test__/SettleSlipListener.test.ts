import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  BetStatus,
  ISettleSlipEvent,
  ResultingStatus,
  SlipRowStatus,
  messengerWrapper,
} from "@betstan/common";
import SettleSlipListener from "../SettleSlipListener";
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

const createBet = async (slipId: string) => {
  const bet = new Bet({
    status: BetStatus.CONFIRMED,
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testuser",
    slipId,
    wager: 10,
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
  });
  await bet.save();
  return bet;
};

it("sets bet status to WIN and defaults historical kind to PRE_MATCH", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  await Bet.collection.insertOne({
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testuser",
    slipId,
    status: BetStatus.CONFIRMED,
    wager: 10,
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
  });

  const listener = new SettleSlipListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipEvent = {
    timestamp: new Date().toISOString(),
    data: { slipId, result: ResultingStatus.BET_WIN },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.WIN);
  expect(updatedBet!.betKind).toEqual(BetKind.PRE_MATCH);
  expect(updatedBet!.rows[0].betKind).toEqual(BetKind.PRE_MATCH);
});

it("sets bet status to LOSS when slip is lost", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId);

  const listener = new SettleSlipListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipEvent = {
    timestamp: new Date().toISOString(),
    data: { slipId, result: ResultingStatus.BET_LOSS },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.LOSS);
});

it("sets bet status to VOID when slip is voided", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId);

  const listener = new SettleSlipListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipEvent = {
    timestamp: new Date().toISOString(),
    data: { slipId, result: ResultingStatus.BET_VOID, betKind: BetKind.LIVE },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.VOID);
  expect(updatedBet!.betKind).toEqual(BetKind.LIVE);
});

it("parks settlement updates when the bet is not found", async () => {
  const listener = new SettleSlipListener(messengerWrapper.connection);
  await listener.init();

  const slipId = new mongoose.Types.ObjectId().toHexString();
  const event: ISettleSlipEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      result: ResultingStatus.BET_WIN,
    },
  };

  await listener.onMessage(event, buildMessage());

  expect(listener.ack).toHaveBeenCalled();
  expect((listener as unknown as { channel: { nack: jest.Mock } }).channel.nack).not.toHaveBeenCalled();
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(1);

  const pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.kind).toEqual(PendingBetUpdateKind.SETTLE_SLIP);
});

it("does not regress terminal states on duplicate or older settlement updates", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId);
  await Bet.updateOne({ slipId }, { status: BetStatus.WIN, betKind: BetKind.LIVE });

  const listener = new SettleSlipListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      result: ResultingStatus.BET_LOSS,
      betKind: BetKind.LIVE,
    },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.WIN);
  expect(updatedBet!.betKind).toEqual(BetKind.LIVE);
});
