import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BettingStatus,
  EventPhase,
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
  // No explicit admin/backoffice visibility decision governs this ordinary
  // event, so the race-provenance marker is stamped, making it eligible
  // for `applyLiveEventUpdate`'s auto-restoration if it later goes live.
  expect(updatedEvent!.liveRaceResultedAt).toBeTruthy();
});

it("does not stamp the race-provenance marker when an explicit admin/backoffice visibility decision already governs the event", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();
  await Event.create({
    eventId,
    name: "A - B",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.OFFLINE,
    visibilityInitialized: true,
    products: [],
  });

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
  // Admin/acceptance-gated OFFLINE, not a race artifact -- must never be
  // auto-restored later, so no marker is stamped.
  expect(updatedEvent!.liveRaceResultedAt ?? null).toBeNull();
});

it("retains a live-simulated event ONLINE with its full-time snapshot when EventResult arrives", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();
  await Event.create({
    eventId,
    name: "A - B",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 12,
      occurredAt: new Date().toISOString(),
      kickoffAt: new Date().toISOString(),
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 2,
      awayScore: 0,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventResultEvent = {
    timestamp: new Date().toISOString(),
    data: { eventId, homeScore: 2, awayScore: 0, home: "A", away: "B" },
  };

  await listener.onMessage(event, buildMessage());

  const updatedEvent = await Event.findOne({ eventId });
  expect(updatedEvent!.status).toEqual(EventStatus.RESULTED);
  expect(updatedEvent!.visibility).toEqual(EventVisibility.ONLINE);
  expect(updatedEvent!.live?.phase).toEqual(EventPhase.FULL_TIME);
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
