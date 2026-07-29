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
    time: new Date().toISOString(),
    home: "A",
    away: "B",
    status: EventStatus.NO_RESULT,
  });
};

it("updates event with result scores and marks as resulted and offline", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();
  await createEvent(eventId);

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventResultEvent = {
    sender: "other_service",
    timestamp: new Date().toISOString(),
    data: { eventId, homeScore: 3, awayScore: 1, home: "A", away: "B" },
  };

  await listener.onMessage(event, buildMessage());

  const updatedEvent = await Event.findOne({ eventId });
  expect(updatedEvent!.status).toEqual(EventStatus.RESULTED);
  expect(updatedEvent!.visibility).toEqual(EventVisibility.OFFLINE);
  expect(updatedEvent!.homeResult).toEqual(3);
  expect(updatedEvent!.awayResult).toEqual(1);
});

it("acks without update when event is not found", async () => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const event: IEventResultEvent = {
    sender: "other_service",
    timestamp: new Date().toISOString(),
    data: {
      eventId: new mongoose.Types.ObjectId().toHexString(),
      homeScore: 1,
      awayScore: 0,
      home: "A",
      away: "B",
    },
  };

  await listener.onMessage(event, buildMessage());

  const events = await Event.find({});
  expect(events.length).toEqual(0);
});
