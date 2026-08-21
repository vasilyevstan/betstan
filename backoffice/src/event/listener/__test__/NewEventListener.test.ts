import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  EventStatus,
  INewEventEvent,
  messengerWrapper,
} from "@betstan/common";
import NewEventListener from "../NewEventListener";
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

it("saves a new event when a NewEvent message arrives from another service", async () => {
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
});

it("ignores self-inflicted messages", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();

  const event: INewEventEvent = {
    sender: "backoffice_new_event",
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

it("keeps the original event when delivery is duplicated", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const first: INewEventEvent = {
    sender: "other_service",
    timestamp: new Date().toISOString(),
    data: {
      id: eventId,
      name: "Team A - Team B",
      time: "2030-01-01T00:00:00.000Z",
      home: "Team A",
      away: "Team B",
    },
  };

  await listener.onMessage(first, buildMessage());
  await listener.onMessage(
    {
      ...first,
      data: {
        ...first.data,
        name: "Changed",
        time: "2031-01-01T00:00:00.000Z",
        home: "Changed A",
        away: "Changed B",
      },
    },
    buildMessage()
  );

  const stored = await Event.findOne({ eventId });
  expect(await Event.countDocuments({ eventId })).toEqual(1);
  expect(stored!.name).toEqual("Team A - Team B");
  expect(stored!.time).toEqual("2030-01-01T00:00:00.000Z");
});

it("acks duplicate key errors emitted by persistence", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();

  const updateOneSpy = jest
    .spyOn(Event, "updateOne")
    .mockRejectedValueOnce({ code: 11000 });

  const event: INewEventEvent = {
    sender: "other_service",
    timestamp: new Date().toISOString(),
    data: {
      id: new mongoose.Types.ObjectId().toHexString(),
      name: "Team A - Team B",
      time: new Date().toISOString(),
      home: "Team A",
      away: "Team B",
    },
  };

  await expect(listener.onMessage(event, buildMessage())).resolves.toBeUndefined();
  expect(updateOneSpy).toHaveBeenCalledTimes(1);
});

it("rethrows unexpected persistence errors", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();

  const error = new Error("db unavailable");
  jest.spyOn(Event, "updateOne").mockRejectedValueOnce(error);

  const event: INewEventEvent = {
    sender: "other_service",
    timestamp: new Date().toISOString(),
    data: {
      id: new mongoose.Types.ObjectId().toHexString(),
      name: "Team A - Team B",
      time: new Date().toISOString(),
      home: "Team A",
      away: "Team B",
    },
  };

  await expect(listener.onMessage(event, buildMessage())).rejects.toThrow(error);
});
