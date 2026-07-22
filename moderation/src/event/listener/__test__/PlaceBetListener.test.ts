import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  IPlaceBetEvent,
  ModerationStatus,
  messengerWrapper,
} from "@betstan/common";
import PlaceBetListener from "../PlaceBetListener";
import { Bet } from "../../../model/Bet";
import BetModerationResultPublisher from "../../publisher/BetModerationResultPublisher";

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

const buildEvent = (slipId: string): IPlaceBetEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testuser",
    slipId,
    wager: 10,
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
        id: new mongoose.Types.ObjectId().toHexString(),
      },
    ],
  },
});

it("approves bet when no resulted events match", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(buildEvent(slipId), buildMessage());

  const bet = await Bet.findOne({ slipId });
  expect(bet).not.toBeNull();
  expect(bet!.status).toEqual(ModerationStatus.APPROVED);
  expect(BetModerationResultPublisher.prototype.publish).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ result: ModerationStatus.APPROVED }) })
  );
});

it("acks message after processing", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(buildEvent(slipId), buildMessage());

  expect(listener.ack).toHaveBeenCalled();
});
