import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  IEventOddsSelectedEvent,
  SlipStatus,
  messengerWrapper,
} from "@betstan/common";
import OddsClickedListener from "../OddsClickedListener";
import { Slip } from "../../../model/Slip";

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

const buildEvent = (userId: string): IEventOddsSelectedEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    userId,
    eventId: new mongoose.Types.ObjectId().toHexString(),
    eventName: "Team A - Team B",
    oddsId: new mongoose.Types.ObjectId().toHexString(),
    oddsValue: 1.5,
    oddsName: "Team A",
    productName: "1X2",
    productId: new mongoose.Types.ObjectId().toHexString(),
  },
});

it("creates a new draft slip when user has no existing slip", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(buildEvent(userId), buildMessage());

  const slip = await Slip.findOne({ userId, status: SlipStatus.DRAFT });
  expect(slip).not.toBeNull();
  expect(slip!.rows.length).toEqual(1);
});

it("appends a row to existing draft slip", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const event1 = buildEvent(userId);
  const event2 = buildEvent(userId);

  await listener.onMessage(event1, buildMessage());
  await listener.onMessage(event2, buildMessage());

  const slip = await Slip.findOne({ userId, status: SlipStatus.DRAFT });
  expect(slip!.rows.length).toEqual(2);
});

it("does not add duplicate odds to the slip", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent(userId);
  await listener.onMessage(event, buildMessage());
  await listener.onMessage(event, buildMessage());

  const slip = await Slip.findOne({ userId, status: SlipStatus.DRAFT });
  expect(slip!.rows.length).toEqual(1);
});

it("acks message without creating slip when userId is missing", async () => {
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent("");
  await listener.onMessage(event, buildMessage());

  const slips = await Slip.find({});
  expect(slips.length).toEqual(0);
});
