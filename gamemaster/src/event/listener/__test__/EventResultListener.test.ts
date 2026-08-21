import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  EventStatus,
  IEventResultEvent,
  messengerWrapper,
} from "@betstan/common";

import { Event } from "../../../model/Event";
import { EventArchive } from "../../../model/EventArchive";
import { LiveResultSource } from "../../../model/liveStateFields";
import EventResultListener from "../EventResultListener";

const setup = async (numberOfEvents = 1) => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const events = await Promise.all(
    Array.from({ length: numberOfEvents }, async () => {
      const event = new Event({
        eventId: new mongoose.Types.ObjectId().toHexString(),
        name: "Team 1 - Team 2",
        time: new Date(),
        home: "Team 1",
        away: "Team 2",
        status: EventStatus.NO_RESULT,
      });

      await event.save();
      return event;
    })
  );

  const message: ConsumeMessage = {
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
  };

  return { listener, events, message };
};

const getData = (
  eventId: string,
  homeScore: number,
  awayScore: number
): IEventResultEvent => ({
  sender: "backoffice_result_set",
  timestamp: new Date("2025-01-01T12:00:01.000Z").toISOString(),
  data: {
    eventId,
    homeScore,
    awayScore,
    home: "Team 1",
    away: "Team 2",
  },
});

it("stores a pending manual result without archiving the live match immediately", async () => {
  const { listener, events, message } = await setup(3);
  const data = getData(events[0].eventId, 3, 0);

  await listener.onMessage(data, message);

  const storedEvent = await Event.findOne({ eventId: events[0].eventId });
  expect(await Event.countDocuments()).toBe(3);
  expect(await EventArchive.countDocuments()).toBe(0);
  expect(storedEvent?.pendingResult?.source).toBe(LiveResultSource.MANUAL);
  expect(storedEvent?.homeResult).toBe(3);
  expect(storedEvent?.awayResult).toBe(0);
  expect(storedEvent?.resultPublishedAt).toBeTruthy();
});

it("keeps the first manual result when a duplicate delivery is received", async () => {
  const { listener, events, message } = await setup();
  const first = getData(events[0].eventId, 3, 0);
  const second = getData(events[0].eventId, 0, 3);

  await listener.onMessage(first, message);
  await listener.onMessage(second, message);

  const storedEvent = await Event.findOne({ eventId: events[0].eventId });
  expect(storedEvent?.pendingResult?.source).toBe(LiveResultSource.MANUAL);
  expect(storedEvent?.homeResult).toBe(3);
  expect(storedEvent?.awayResult).toBe(0);
});

it("acknowledges self-emitted final results without changing stored events", async () => {
  const { listener, events, message } = await setup();
  const data = {
    ...getData(events[0].eventId, 3, 0),
    sender: listener.serviceName,
  };

  await listener.onMessage(data, message);

  expect(await Event.countDocuments()).toBe(1);
  expect(await EventArchive.countDocuments()).toBe(0);
  expect(listener.ack).toHaveBeenCalledWith(message);
});

it("acknowledges result events when the stored event is missing", async () => {
  const { listener, message } = await setup();
  const data = getData(
    new mongoose.Types.ObjectId().toHexString(),
    3,
    0
  );

  await listener.onMessage(data, message);

  expect(await Event.countDocuments()).toBe(1);
  expect(await EventArchive.countDocuments()).toBe(0);
  expect(listener.ack).toHaveBeenCalledWith(message);
});
