import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import { EventStatus, INewEventEvent, messengerWrapper } from "@betstan/common";

import { Event } from "../../../model/Event";
import { EventArchive } from "../../../model/EventArchive";
import NewEventListener from "../NewEventListener";
import NewEventPublisher from "../../publisher/NewEventPublisher";

const setup = async (numberOfEvents?: number) => {
  const listener = new NewEventListener(messengerWrapper.connection);
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

const getData = (): INewEventEvent => {
  return {
    data: {
      id: new mongoose.Types.ObjectId().toHexString(),
      name: "New event",
      time: new Date().toISOString(),
      home: "Player 1",
      away: "Player 2",
    },
  };
};

it("when new event arrives it is added to a collection", async () => {
  const { listener, events, message } = await setup(3);

  const eventId = events[0].eventId;

  const data = getData();

  await listener.onMessage(data, message);

  const storedEvents = await Event.find({});
  const storedArchievedEvents = await EventArchive.find({});

  expect(storedEvents.length).toEqual(4);
  expect(storedArchievedEvents.length).toEqual(0);
  expect(NewEventPublisher.prototype.publish).not.toHaveBeenCalled();
});
