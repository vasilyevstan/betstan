import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  EventStatus,
  EventVisibility,
  INewEventEvent,
  messengerWrapper,
} from "@betstan/common";
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

it("creates a new event with products when a NewEvent message arrives", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();

  const eventId = new mongoose.Types.ObjectId().toHexString();
  const event: INewEventEvent = {
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

  await listener.onMessage(event, buildMessage());

  const storedEvent = await Event.findOne({ eventId });
  expect(storedEvent).not.toBeNull();
  expect(storedEvent!.status).toEqual(EventStatus.NO_RESULT);
  expect(storedEvent!.products.length).toBeGreaterThan(0);
});

it("keeps an acceptance event offline from its first projection", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const event = {
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

  await listener.onMessage(event, buildMessage());

  expect((await Event.findOne({ eventId }))!.visibility).toEqual(
    EventVisibility.OFFLINE
  );
});

it("repairs a fail-dark live projection when event metadata arrives later", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();

  await Event.create({
    eventId,
    name: "Provisional live event",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.OFFLINE,
    visibilityInitialized: false,
    products: [],
  });

  await listener.onMessage(
    {
      sender: "other_service",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Team A - Team B",
        time: "2030-01-01T00:00:00.000Z",
        home: "Team A",
        away: "Team B",
        visibility: EventVisibility.ONLINE,
      },
    } as INewEventEvent,
    buildMessage()
  );

  const storedEvent = await Event.findOne({ eventId });
  expect(storedEvent!.visibility).toEqual(EventVisibility.ONLINE);
  expect(storedEvent!.get("visibilityInitialized")).toBe(true);
  expect(storedEvent!.get("eventMetadataInitialized")).toBe(true);
  expect(storedEvent!.products.length).toBeGreaterThan(0);
});

it("repairs legacy live projections whose initialization markers are missing", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();

  await Event.collection.insertOne({
    eventId,
    name: "Legacy provisional event",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    source: "EXTERNAL",
    live: { sequence: 1 },
  });

  await listener.onMessage(
    {
      sender: "other_service",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Hidden A - Hidden B",
        time: "2030-01-01T00:00:00.000Z",
        home: "Hidden A",
        away: "Hidden B",
        visibility: EventVisibility.OFFLINE,
      },
    } as INewEventEvent,
    buildMessage()
  );

  const storedEvent = await Event.findOne({ eventId });
  expect(storedEvent!.name).toEqual("Hidden A - Hidden B");
  expect(storedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(storedEvent!.get("visibilityInitialized")).toBe(true);
  expect(storedEvent!.get("eventMetadataInitialized")).toBe(true);
  expect(storedEvent!.products.length).toBeGreaterThan(0);
});

it("repairs metadata without undoing a newer visibility message", async () => {
  const newEventListener = new NewEventListener(messengerWrapper.connection);
  const visibilityListener = new EventVisibilityListener(
    messengerWrapper.connection
  );
  await newEventListener.init();
  await visibilityListener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();

  await visibilityListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, visibility: EventVisibility.OFFLINE },
    },
    buildMessage()
  );
  const placeholder = await Event.findOne({ eventId });
  expect(placeholder!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(placeholder!.get("pendingVisibility")).toEqual(
    EventVisibility.OFFLINE
  );
  await newEventListener.onMessage(
    {
      sender: "other_service",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Team A - Team B",
        time: "2030-01-01T00:00:00.000Z",
        home: "Team A",
        away: "Team B",
        visibility: EventVisibility.ONLINE,
      },
    } as INewEventEvent,
    buildMessage()
  );

  const storedEvent = await Event.findOne({ eventId });
  expect(storedEvent!.name).toEqual("Team A - Team B");
  expect(storedEvent!.products.length).toBeGreaterThan(0);
  expect(storedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(storedEvent!.get("visibilityInitialized")).toBe(true);
  expect(storedEvent!.get("eventMetadataInitialized")).toBe(true);
  expect(storedEvent!.get("pendingVisibility")).toBeUndefined();
});

it("keeps ambiguous legacy hidden projections fail-dark during metadata repair", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();

  await Event.collection.insertOne({
    eventId,
    name: "Legacy hidden projection",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.OFFLINE,
    products: [],
    source: "EXTERNAL",
    live: { sequence: 1 },
  });

  await listener.onMessage(
    {
      sender: "other_service",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Team A - Team B",
        time: "2030-01-01T00:00:00.000Z",
        home: "Team A",
        away: "Team B",
        visibility: EventVisibility.ONLINE,
      },
    } as INewEventEvent,
    buildMessage()
  );

  const storedEvent = await Event.findOne({ eventId });
  expect(storedEvent!.name).toEqual("Team A - Team B");
  expect(storedEvent!.products.length).toBeGreaterThan(0);
  expect(storedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(storedEvent!.get("visibilityInitialized")).toBe(true);
  expect(storedEvent!.get("eventMetadataInitialized")).toBe(true);
});

it("ignores self-inflicted messages", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();

  const event: INewEventEvent = {
    sender: "event_new_event",
    timestamp: new Date().toISOString(),
    data: {
      id: new mongoose.Types.ObjectId().toHexString(),
      name: "Team A - Team B",
      time: new Date().toISOString(),
      home: "Team A",
      away: "Team B",
    },
  };

  await listener.onMessage(event, buildMessage());

  const events = await Event.find({});
  expect(events.length).toEqual(0);
});

it("keeps the original generated products when delivery is duplicated", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();

  await listener.onMessage(
    {
      sender: "other_service",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Team A - Team B",
        time: "2030-01-01T00:00:00.000Z",
        home: "Team A",
        away: "Team B",
      },
    },
    buildMessage()
  );
  await Event.updateOne(
    { eventId },
    { $set: { visibility: EventVisibility.OFFLINE } }
  );
  await listener.onMessage(
    {
      sender: "other_service",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Changed",
        time: "2031-01-01T00:00:00.000Z",
        home: "Changed A",
        away: "Changed B",
      },
    },
    buildMessage()
  );

  const storedEvent = await Event.findOne({ eventId });
  expect(await Event.countDocuments()).toEqual(1);
  expect(storedEvent!.name).toEqual("Team A - Team B");
  expect(storedEvent!.products[0].odds[0].name).toEqual("Team A");
  expect(storedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
});

it("acks duplicate key races without failing the consumer", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const updateOneSpy = jest
    .spyOn(Event, "updateOne")
    .mockRejectedValueOnce({ code: 11000 } as any)
    .mockResolvedValueOnce({ matchedCount: 0 } as any);

  await expect(
    listener.onMessage(
      {
        sender: "other_service",
        timestamp: new Date().toISOString(),
        data: {
          id: new mongoose.Types.ObjectId().toHexString(),
          name: "Team A - Team B",
          time: new Date().toISOString(),
          home: "Team A",
          away: "Team B",
        },
      },
      buildMessage()
    )
  ).resolves.toBeUndefined();

  expect(updateOneSpy).toHaveBeenCalledTimes(6);
  expect((listener as any).channel.ack).toHaveBeenCalledTimes(1);
});

it("rethrows non-duplicate persistence errors", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  jest.spyOn(Event, "updateOne").mockRejectedValueOnce({ code: 500 } as any);

  await expect(
    listener.onMessage(
      {
        sender: "other_service",
        timestamp: new Date().toISOString(),
        data: {
          id: new mongoose.Types.ObjectId().toHexString(),
          name: "Team A - Team B",
          time: new Date().toISOString(),
          home: "Team A",
          away: "Team B",
        },
      },
      buildMessage()
    )
  ).rejects.toMatchObject({ code: 500 });
});
