import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  IEventResultEvent,
  IEventVibibilityEvent,
  INewEventEvent,
  messengerWrapper,
} from "@betstan/common";
import EventResultListener from "../EventResultListener";
import NewEventListener from "../NewEventListener";
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

const buildResultEvent = (eventId: string): IEventResultEvent => ({
  timestamp: new Date().toISOString(),
  data: { eventId, homeScore: 2, awayScore: 0, home: "A", away: "B" },
});

it("marks event as resulted and offline when EventResult arrives", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();
  await createEvent(eventId);

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(buildResultEvent(eventId), buildMessage());

  const updatedEvent = await Event.findOne({ eventId });
  expect(updatedEvent!.status).toEqual(EventStatus.RESULTED);
  expect(updatedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
  // No explicit admin/backoffice visibility decision governs this ordinary
  // event, so the race-provenance marker is stamped, making it eligible
  // for `applyLiveEventUpdate`'s auto-restoration if it later goes live.
  expect(updatedEvent!.liveRaceResultedAt).toBeTruthy();
});

it("stamps the race-provenance marker for an ordinary event onboarded through the real NewEventListener path, even though visibilityInitialized is already true", async () => {
  // Regression: `NewEventListener` sets `visibilityInitialized: true` for
  // every event it onboards, regardless of the chosen visibility -- an
  // ordinary externally-onboarded ONLINE event is not "admin-gated" just
  // because it went through that path, and must still be eligible for
  // race-provenance marking if its result genuinely races ahead of its
  // very first live projection.
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const newEventListener = new NewEventListener(messengerWrapper.connection);
  await newEventListener.init();

  const newEvent: INewEventEvent = {
    sender: "other_service",
    timestamp: new Date().toISOString(),
    data: {
      id: eventId,
      name: "Team A - Team B",
      time: new Date().toISOString(),
      home: "Team A",
      away: "Team B",
    },
  };
  await newEventListener.onMessage(newEvent, buildMessage());

  const onboarded = await Event.findOne({ eventId });
  expect(onboarded!.visibility).toEqual(EventVisibility.ONLINE);
  expect(onboarded!.get("visibilityInitialized")).toBe(true);

  const resultListener = new EventResultListener(messengerWrapper.connection);
  await resultListener.init();
  await resultListener.onMessage(buildResultEvent(eventId), buildMessage());

  const updatedEvent = await Event.findOne({ eventId });
  expect(updatedEvent!.status).toEqual(EventStatus.RESULTED);
  expect(updatedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(updatedEvent!.liveRaceResultedAt).toBeTruthy();
});

it("does not stamp the race-provenance marker for an event explicitly onboarded OFFLINE through the real NewEventListener path", async () => {
  // The admin/acceptance-gating case: `NewEventListener` explicitly onboards
  // this event OFFLINE (e.g. a synthetic production-acceptance fixture).
  // `visibilityInitialized` is true here exactly as it would be for the
  // ordinary ONLINE case above, so the actual OFFLINE *visibility value*
  // itself -- not `visibilityInitialized` -- is what must gate the marker.
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const newEventListener = new NewEventListener(messengerWrapper.connection);
  await newEventListener.init();

  const newEvent = {
    sender: "backoffice_new_event",
    timestamp: new Date().toISOString(),
    data: {
      id: eventId,
      name: "Hidden A - Hidden B",
      time: new Date().toISOString(),
      home: "Hidden A",
      away: "Hidden B",
      visibility: EventVisibility.OFFLINE,
    },
  };
  await newEventListener.onMessage(newEvent, buildMessage());

  const onboarded = await Event.findOne({ eventId });
  expect(onboarded!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(onboarded!.get("visibilityInitialized")).toBe(true);

  const resultListener = new EventResultListener(messengerWrapper.connection);
  await resultListener.init();
  await resultListener.onMessage(buildResultEvent(eventId), buildMessage());

  const updatedEvent = await Event.findOne({ eventId });
  expect(updatedEvent!.status).toEqual(EventStatus.RESULTED);
  expect(updatedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
  // Admin/acceptance-gated OFFLINE, not a race artifact -- must never be
  // auto-restored later, so no marker is stamped.
  expect(updatedEvent!.liveRaceResultedAt ?? null).toBeNull();
});

it("does not stamp the race-provenance marker while an explicit pending visibility decision is queued through the real EventVisibilityListener path, even though visibilityInitialized is still false", async () => {
  // The other admin/acceptance-gating case: a visibility decision has
  // already arrived for a brand-new event via `EventVisibilityListener`
  // alone (no metadata yet), leaving `pendingVisibility` set and
  // `visibilityInitialized` still false because finalization requires
  // metadata that has not arrived yet. Gating the marker on
  // `visibilityInitialized` alone would misclassify this as a race.
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const visibilityListener = new EventVisibilityListener(
    messengerWrapper.connection
  );
  await visibilityListener.init();

  const visibilityEvent: IEventVibibilityEvent = {
    timestamp: new Date().toISOString(),
    data: { eventId, visibility: EventVisibility.ONLINE },
  };
  await visibilityListener.onMessage(visibilityEvent, buildMessage());

  const pending = await Event.findOne({ eventId });
  expect(pending!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(pending!.get("visibilityInitialized")).toBe(false);
  expect(pending!.get("pendingVisibility")).toEqual(EventVisibility.ONLINE);

  const resultListener = new EventResultListener(messengerWrapper.connection);
  await resultListener.init();
  await resultListener.onMessage(buildResultEvent(eventId), buildMessage());

  const updatedEvent = await Event.findOne({ eventId });
  expect(updatedEvent!.status).toEqual(EventStatus.RESULTED);
  expect(updatedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
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

  await listener.onMessage(buildResultEvent(eventId), buildMessage());

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
