import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  EventStatus,
  EventVisibility,
  IEventVibibilityEvent,
  messengerWrapper,
} from "@betstan/common";
import EventVisibilityListener from "../EventVisibilityListener";
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

const createEvent = async (eventId: string, visibility = EventVisibility.ONLINE) => {
  return Event.create({
    eventId,
    name: "A - B",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility,
    products: [],
  });
};

it("marks event as offline when visibility OFFLINE arrives", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();
  await createEvent(eventId, EventVisibility.ONLINE);

  const listener = new EventVisibilityListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventVibibilityEvent = {
    timestamp: new Date().toISOString(),
    data: { eventId, visibility: EventVisibility.OFFLINE },
  };

  await listener.onMessage(event, buildMessage());

  const updated = await Event.findOne({ eventId });
  expect(updated!.visibility).toEqual(EventVisibility.OFFLINE);
});

it("marks event as online when visibility ONLINE arrives", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();
  await createEvent(eventId, EventVisibility.OFFLINE);

  const listener = new EventVisibilityListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventVibibilityEvent = {
    timestamp: new Date().toISOString(),
    data: { eventId, visibility: EventVisibility.ONLINE },
  };

  await listener.onMessage(event, buildMessage());

  const updated = await Event.findOne({ eventId });
  expect(updated!.visibility).toEqual(EventVisibility.ONLINE);
});

it("acks without error when event is not found", async () => {
  const listener = new EventVisibilityListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventVibibilityEvent = {
    timestamp: new Date().toISOString(),
    data: {
      eventId: new mongoose.Types.ObjectId().toHexString(),
      visibility: EventVisibility.ONLINE,
    },
  };

  await listener.onMessage(event, buildMessage());

  const events = await Event.find({});
  expect(events.length).toEqual(0);
});
