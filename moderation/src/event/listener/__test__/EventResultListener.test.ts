import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import { IEventResultEvent, messengerWrapper } from "@betstan/common";
import EventResultListener from "../EventResultListener";
import { Resulted } from "../../../model/Resulted";

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

it("records an event result in the Resulted collection", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventResultEvent = {
    timestamp: new Date().toISOString(),
    data: { eventId, homeScore: 2, awayScore: 1, home: "A", away: "B" },
  };

  await listener.onMessage(event, buildMessage());

  const resulted = await Resulted.findOne({ eventId });
  expect(resulted).not.toBeNull();
  expect(resulted!.eventId).toEqual(eventId);
});

it("acks the message after saving", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventResultEvent = {
    timestamp: new Date().toISOString(),
    data: { eventId, homeScore: 0, awayScore: 0, home: "A", away: "B" },
  };

  await listener.onMessage(event, buildMessage());

  expect(listener.ack).toHaveBeenCalled();
});
