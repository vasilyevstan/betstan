import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  EventStatus,
  EventVisibility,
  IEventResultEvent,
  messengerWrapper,
} from "@betstan/common";
import EventResultListener from "../EventResultListener";
import { Event } from "../../../model/Event";

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

const createEvent = async (eventId: string) => {
  return Event.create({
    eventId,
    name: "A - B",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });
};

it("marks event as resulted and offline when EventResult arrives", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();
  await createEvent(eventId);

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventResultEvent = {
    timestamp: new Date().toISOString(),
    data: { eventId, homeScore: 2, awayScore: 0, home: "A", away: "B" },
  };

  await listener.onMessage(event, buildMessage());

  const updatedEvent = await Event.findOne({ eventId });
  expect(updatedEvent!.status).toEqual(EventStatus.RESULTED);
  expect(updatedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
});

it("acks without error when event is not found", async () => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventResultEvent = {
    timestamp: new Date().toISOString(),
    data: {
      eventId: new mongoose.Types.ObjectId().toHexString(),
      homeScore: 1,
      awayScore: 1,
      home: "A",
      away: "B",
    },
  };

  await listener.onMessage(event, buildMessage());

  const events = await Event.find({});
  expect(events.length).toEqual(0);
});
