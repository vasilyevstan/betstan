import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetStatus,
  IModerationResultEvent,
  ModerationStatus,
  messengerWrapper,
} from "@betstan/common";
import ModerationResultListener from "../ModerationResultListener";
import { Bet } from "../../../model/Bet";

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
    status: BetStatus.PENDING,
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
        status: "NOT_SETTLED",
        id: new mongoose.Types.ObjectId().toHexString(),
      },
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

it("sets bet status to DECLINED when moderation declines", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId);

  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IModerationResultEvent = {
    timestamp: new Date().toISOString(),
    data: { slipId, result: ModerationStatus.DECLINED },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.status).toEqual(BetStatus.DECLINED);
});

it("nacks if bet is not found", async () => {
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IModerationResultEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId: new mongoose.Types.ObjectId().toHexString(),
      result: ModerationStatus.APPROVED,
    },
  };

  await listener.onMessage(event, buildMessage());

  // ack is not called when bet not found — channel.nack requeues the message
  expect(listener.ack).not.toHaveBeenCalled();
});
