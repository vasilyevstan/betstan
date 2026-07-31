import mongoose from "mongoose";
import EventResultListener from "../EventResultListener";
import { ConsumeMessage } from "amqplib";
import {
  EventStatus,
  IEventResultEvent,
  ResultingStatus,
  messengerWrapper,
} from "@betstan/common";

import { Event } from "../../../model/Event";
import { EventArchive } from "../../../model/EventArchive";
import NewEventListener from "../NewEventListener";
import NewEventPublisher from "../../publisher/NewEventPublisher";

const setup = async (numberOfEvents?: number) => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const events = Array();

  if (!numberOfEvents) numberOfEvents = 1;

  for (let i = 0; i < numberOfEvents; i++) {
    const event = await createEvent();
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

  return { listener, events, message };

  async function createEvent() {
    // const betData = getBetData();

    const event = new Event({
      eventId: new mongoose.Types.ObjectId().toHexString(),
      time: new Date(),
      home: "Team 1",
      away: "Team 2",
      status: EventStatus.NO_RESULT,
    });

    await event.save();
    return event;
  }
};

const getData = (
  homeScore: number,
  awayScore: number,
  eventId: string,
  home: string,
  away: string
): IEventResultEvent => {
  return {
    data: {
      eventId: eventId,
      homeScore: homeScore,
      awayScore: awayScore,
      home,
      away,
    },
  };
};

it("when event is resulted and moved to archive", async () => {
  const { listener, events, message } = await setup(3);

  const eventId = events[0].eventId;

  const data = getData(3, 0, eventId, "Team 1", "Team 2");

  await listener.onMessage(data, message);

  const archievedEvent = await EventArchive.findById(events[0].id);

  const storedEvents = await Event.find({});
  const storedArchievedEvents = await EventArchive.find({});

  expect(storedEvents.length).toEqual(2);
  expect(storedArchievedEvents.length).toEqual(1);
  expect(archievedEvent?.status).toEqual(EventStatus.RESULTED);
  expect(NewEventPublisher.prototype.publish).not.toHaveBeenCalled();
});

it("acknowledges self-emitted result events without changing stored events", async () => {
  const { listener, events, message } = await setup();
  const data = {
    ...getData(3, 0, events[0].eventId, "Team 1", "Team 2"),
    sender: listener.serviceName,
  };

  await listener.onMessage(data, message);

  expect(await Event.countDocuments()).toEqual(1);
  expect(await EventArchive.countDocuments()).toEqual(0);
  expect(listener.ack).toHaveBeenCalledWith(message);
});

it("acknowledges result events when the stored event is missing", async () => {
  const { listener, message } = await setup();
  const data = getData(
    3,
    0,
    new mongoose.Types.ObjectId().toHexString(),
    "Missing",
    "Event"
  );

  await listener.onMessage(data, message);

  expect(await Event.countDocuments()).toEqual(1);
  expect(await EventArchive.countDocuments()).toEqual(0);
  expect(listener.ack).toHaveBeenCalledWith(message);
});
