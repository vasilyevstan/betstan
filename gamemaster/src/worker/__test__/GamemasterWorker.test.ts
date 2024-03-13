import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import { EventStatus } from "@betstan/common";

import { Event } from "../../model/Event";
import NewEventPublisher from "../../event/publisher/NewEventPublisher";
import { EventArchive } from "../../model/EventArchive";
import { GamemasterWorker } from "../GamemasterWorker";

const futureDate = new Date(new Date().getTime() + 30000);
const pastDate = new Date(new Date().getTime() - 30000);

const createEvent = async (eventTime?: Date) => {
  const event = new Event({
    eventId: new mongoose.Types.ObjectId().toHexString(),
    time: eventTime ? eventTime : new Date(),
    home: "Team 1",
    away: "Team 2",
    status: EventStatus.NO_RESULT,
  });

  await event.save();
  return event;
};

const setup = async (eventTimes: Date[], numberOfEvents?: number) => {
  const events = Array();

  if (!numberOfEvents) numberOfEvents = 1;

  for (let i = 0; i < numberOfEvents; i++) {
    const event = await createEvent(eventTimes[i]);
    events.push(event);
  }

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

  return { events, message };
};

it("with three events in the database, start time in the future, none is resulted", async () => {
  const { events, message } = await setup(
    [futureDate, futureDate, futureDate],
    3
  );

  const gameMaster = new GamemasterWorker();
  await gameMaster.checkEventsOnce();

  const storedEvents = await Event.find({});
  const storedArchievedEvents = await EventArchive.find({});

  expect(storedEvents.length).toEqual(3);
  expect(storedArchievedEvents.length).toEqual(0);
  expect(NewEventPublisher.prototype.publish).not.toHaveBeenCalled();
});

it.skip("with three events in the database, 2 start in the future, one is resulted", async () => {
  const { events, message } = await setup(
    [futureDate, pastDate, futureDate],
    3
  );

  // const eventId = events[0].eventId;

  const gameMaster = new GamemasterWorker();
  await gameMaster.checkEventsOnce().then(() => {
    console.log("checking event finished");
  });

  console.log("checking collections");
  const storedEvents = await Event.find({});
  const storedArchievedEvents = await EventArchive.find({});

  console.log("events", storedEvents);
  expect(storedEvents.length).toEqual(2);
  expect(storedArchievedEvents.length).toEqual(1);
  expect(NewEventPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});
