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
    visibilityInitialized: true,
    eventMetadataInitialized: true,
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
  expect(updated!.get("visibilityInitialized")).toBe(true);
  expect(updated!.get("visibilityDecision")).toEqual(EventVisibility.OFFLINE);
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
  expect(updated!.get("visibilityInitialized")).toBe(true);
  expect(updated!.get("visibilityDecision")).toEqual(EventVisibility.ONLINE);
});

it("stores a fail-dark pending visibility when event metadata has not arrived", async () => {
  const listener = new EventVisibilityListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();

  const event: IEventVibibilityEvent = {
    timestamp: new Date().toISOString(),
    data: {
      eventId,
      visibility: EventVisibility.ONLINE,
    },
  };

  await listener.onMessage(event, buildMessage());

  const events = await Event.find({});
  expect(events.length).toEqual(1);
  expect(events[0].eventId).toEqual(eventId);
  expect(events[0].visibility).toEqual(EventVisibility.OFFLINE);
  expect(events[0].get("pendingVisibility")).toEqual(EventVisibility.ONLINE);
  expect(events[0].get("visibilityDecision")).toEqual(EventVisibility.ONLINE);
  expect(events[0].get("visibilityInitialized")).toBe(false);
  expect(events[0].get("eventMetadataInitialized")).toBe(false);
});

it("retries the pending decision after a duplicate-key upsert race", async () => {
  const listener = new EventVisibilityListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  await createEvent(eventId, EventVisibility.ONLINE);
  jest
    .spyOn(Event, "updateOne")
    .mockRejectedValueOnce({ code: 11000 } as any);

  await listener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, visibility: EventVisibility.OFFLINE },
    },
    buildMessage()
  );

  const storedEvent = await Event.findOne({ eventId });
  expect(storedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(storedEvent!.get("pendingVisibility")).toBeUndefined();
  expect(storedEvent!.get("visibilityDecision")).toEqual(
    EventVisibility.OFFLINE
  );
  expect((listener as any).channel.ack).toHaveBeenCalledTimes(1);
});
