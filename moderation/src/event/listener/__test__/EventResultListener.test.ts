import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import { IEventResultEvent, messengerWrapper } from "@betstan/common";
import { Resulted } from "../../../model/Resulted";
import EventResultListener from "../EventResultListener";

const createMessage = (): ConsumeMessage => ({
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

const createEventData = (eventId?: string): IEventResultEvent => ({
  data: {
    eventId: eventId ?? new mongoose.Types.ObjectId().toHexString(),
    homeScore: 2,
    awayScore: 1,
    home: "Team A",
    away: "Team B",
  },
});

const setup = async () => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  return { listener };
};

it("event result is saved in the Resulted collection", async () => {
  const { listener } = await setup();
  const message = createMessage();
  const data = createEventData();

  await listener.onMessage(data, message);

  const resulted = await Resulted.findOne({ eventId: data.data.eventId });
  expect(resulted).not.toBeNull();
  expect(resulted!.eventId).toEqual(data.data.eventId);
  expect(listener.ack).toHaveBeenCalled();
});

it("multiple event results are each saved as separate Resulted entries", async () => {
  const { listener } = await setup();
  const message = createMessage();

  await listener.onMessage(createEventData(), message);
  await listener.onMessage(createEventData(), message);

  const results = await Resulted.find({});
  expect(results).toHaveLength(2);
});

it("resulted entry for a specific event prevents future bets on that event from being approved", async () => {
  const { listener } = await setup();
  const message = createMessage();
  const eventId = new mongoose.Types.ObjectId().toHexString();

  await listener.onMessage(createEventData(eventId), message);

  const resulted = await Resulted.findOne({ eventId });
  expect(resulted).not.toBeNull();
  expect(resulted!.eventId).toEqual(eventId);
});
