import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import { EventStatus } from "@betstan/common";

import { Event } from "../../model/Event";
import ResultSetPublisher from "../../event/publisher/ResultSetPublisher";
import { EventArchive } from "../../model/EventArchive";
import { GamemasterWorker } from "../GamemasterWorker";

beforeAll(() => {
  jest.spyOn(ResultSetPublisher.prototype, "init").mockResolvedValue(undefined);
});

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
});

it("results and archives a past event without publishing a replacement", async () => {
  const { events, message } = await setup(
    [futureDate, pastDate, futureDate],
    3
  );

  const gameMaster = new GamemasterWorker();
  await gameMaster.init();
  await gameMaster.checkEventsOnce();

  const storedEvents = await Event.find({});
  const storedArchievedEvents = await EventArchive.find({});

  expect(storedEvents.length).toEqual(2);
  expect(storedArchievedEvents.length).toEqual(1);
  expect(ResultSetPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("initialises the result publisher once during worker.init()", async () => {
  jest.clearAllMocks();
  await setup([pastDate, pastDate, pastDate], 3);

  const gameMaster = new GamemasterWorker();
  await gameMaster.init();

  const resultSetInitCallsAfterInit = (
    ResultSetPublisher.prototype.init as jest.Mock
  ).mock.calls.length;
  await gameMaster.checkEventsOnce();

  expect((ResultSetPublisher.prototype.init as jest.Mock).mock.calls.length).toEqual(
    resultSetInitCallsAfterInit
  );
});
