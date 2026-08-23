import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import { EventStatus, INewEventEvent, messengerWrapper } from "@betstan/common";

import { Event } from "../../../model/Event";
import { EventArchive } from "../../../model/EventArchive";
import NewEventListener from "../NewEventListener";

const setup = async (numberOfEvents = 1) => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();

  const events = await Promise.all(
    Array.from({ length: numberOfEvents }, async () => {
      const event = new Event({
        eventId: new mongoose.Types.ObjectId().toHexString(),
        name: "Existing event",
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

const getData = (): INewEventEvent => ({
  data: {
    id: new mongoose.Types.ObjectId().toHexString(),
    name: "New event",
    time: new Date().toISOString(),
    home: "Player 1",
    away: "Player 2",
  },
});

it("stores new events with their live pre-match defaults", async () => {
  const { listener, message } = await setup(3);
  const data = getData();

  await listener.onMessage(data, message);

  const stored = await Event.findOne({ eventId: data.data.id });
  expect(await Event.countDocuments()).toBe(4);
  expect(await EventArchive.countDocuments()).toBe(0);
  expect(stored?.name).toBe("New event");
  expect(stored?.phase).toBe("PRE_MATCH");
  expect(stored?.liveConfirmedReplayCursor).toBe(0);
  expect(stored?.liveSeed).toMatch(/^[a-f0-9]{64}$/);
  expect(stored?.liveSeed).not.toBe(data.data.id);
});

it("keeps the first insert when a NewEvent delivery is duplicated", async () => {
  const { listener, message } = await setup();
  const data = getData();

  await listener.onMessage(data, message);
  const firstSeed = (await Event.findOne({ eventId: data.data.id }))?.liveSeed;
  await listener.onMessage(
    {
      ...data,
      data: {
        ...data.data,
        name: "Changed",
        home: "Changed",
        away: "Changed",
      },
    },
    message
  );

  const stored = await Event.findOne({ eventId: data.data.id });
  expect(await Event.countDocuments({ eventId: data.data.id })).toBe(1);
  expect(stored?.name).toBe("New event");
  expect(stored?.home).toBe("Player 1");
  expect(stored?.away).toBe("Player 2");
  expect(stored?.liveSeed).toBe(firstSeed);
});

it("acknowledges late NewEvent deliveries without resurrecting an archive", async () => {
  const { listener, message } = await setup();
  const data = getData();
  await EventArchive.create({
    eventId: data.data.id,
    name: data.data.name,
    time: data.data.time,
    home: data.data.home,
    away: data.data.away,
    status: EventStatus.RESULTED,
  });

  await listener.onMessage(data, message);

  expect(await Event.countDocuments({ eventId: data.data.id })).toBe(0);
  expect(listener.ack).toHaveBeenCalledWith(message);
});

it("swallows duplicate-key races when the insert already won elsewhere", async () => {
  const { listener, message } = await setup();
  const data = getData();
  const updateSpy = jest
    .spyOn(Event, "updateOne")
    .mockRejectedValueOnce({ code: 11000 });

  await listener.onMessage(data, message);

  expect(listener.ack).toHaveBeenCalledWith(message);
  updateSpy.mockRestore();
});

it("rethrows unexpected persistence errors so the delivery can be retried", async () => {
  const { listener, message } = await setup();
  const data = getData();
  const error = Object.assign(new Error("write failed"), { code: 500 });
  const updateSpy = jest
    .spyOn(Event, "updateOne")
    .mockRejectedValueOnce(error);

  await expect(listener.onMessage(data, message)).rejects.toThrow("write failed");
  updateSpy.mockRestore();
});
