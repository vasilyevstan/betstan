import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetStatus,
  IPlaceBetEvent,
  messengerWrapper,
  SlipRowStatus,
} from "@betstan/common";
import PlaceBetListener from "../PlaceBetListener";
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

const buildEvent = (): IPlaceBetEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testuser",
    slipId: new mongoose.Types.ObjectId().toHexString(),
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

it("saves a bet when a PlaceBet event is received", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent();
  await listener.onMessage(event, buildMessage());

  const bets = await Bet.find({});
  expect(bets.length).toEqual(1);
  expect(bets[0].slipId).toEqual(event.data.slipId);
  expect(bets[0].status).toEqual(BetStatus.PENDING);
  expect(bets[0].rows.length).toEqual(1);
  expect(bets[0].rows[0].status).toEqual(SlipRowStatus.NOT_SETTLED);
});

it("acks the message after saving the bet", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent();
  await listener.onMessage(event, buildMessage());

  expect(listener.ack).toHaveBeenCalled();
});
