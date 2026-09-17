import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  EventStatus,
  INewEventEvent,
  messengerWrapper,
} from "@betstan/common";
import NewEventListener from "../NewEventListener";
import { Event } from "../../../model/Event";
import request from "supertest";
import { app } from "../../../app";
import { PRE_SEPTEMBER_CLEANUP_CUTOFF } from "../../preSeptemberCleanupBoundary";

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
      time: "2026-09-01T00:00:00.001Z",
      home: "Team A",
      away: "Team B",
    },
  };

  await listener.onMessage(event, buildMessage());

  const storedEvent = await Event.findOne({ eventId });
  expect(storedEvent).not.toBeNull();
  expect(storedEvent!.status).toEqual(EventStatus.NO_RESULT);
});

it.each([
  {
    label: "strictly before the cleanup cutoff",
    time: "2026-09-01T01:59:59.999+02:00",
    stored: false,
  },
  {
    label: "equal to the cleanup cutoff",
    time: "2026-09-01T02:00:00+02:00",
    stored: true,
  },
  {
    label: "strictly after the cleanup cutoff",
    time: "2026-09-01T00:00:00.001Z",
    stored: true,
  },
])("$label follows the fixed listener boundary", async ({ time, stored }) => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const message = buildMessage();

  await listener.onMessage(
    {
      sender: "other_service",
      timestamp: "2026-09-16T00:00:00.000Z",
      data: {
        id: eventId,
        name: "Boundary A - Boundary B",
        time,
        home: "Boundary A",
        away: "Boundary B",
      },
    },
    message
  );

  expect(await Event.exists({ eventId })).toEqual(
    stored ? expect.anything() : null
  );
  expect((listener as any).channel.ack).toHaveBeenCalledWith(message);
});

it("keeps equal and newer listener rows visible on the Backoffice route", async () => {
  const listener = new NewEventListener(messengerWrapper.connection);
  await listener.init();
  const rows = [
    ["before-route", "2026-08-31T23:59:59.999Z"],
    ["equal-route", PRE_SEPTEMBER_CLEANUP_CUTOFF],
    ["after-route", "2026-09-01T00:00:00.001Z"],
  ] as const;

  for (const [eventId, time] of rows) {
    await listener.onMessage(
      {
        sender: "other_service",
        timestamp: "2026-09-16T00:00:00.000Z",
        data: {
          id: eventId,
          name: `${eventId} A - B`,
          time,
          home: "A",
          away: "B",
        },
      },
      buildMessage()
    );
  }

  const response = await request(app).get("/api/backoffice").expect(200);
  expect(
    response.body
      .map((event: { eventId: string }) => event.eventId)
      .sort()
  ).toEqual(["after-route", "equal-route"]);
});

it.each([
  { label: "malformed", time: "not-an-explicit-zone-time" },
  { label: "missing", time: undefined },
  { label: "non-string", time: 1234567890 },
])(
  "keeps the existing upsert path for $label time data",
  async ({ label, time }) => {
    const listener = new NewEventListener(messengerWrapper.connection);
    await listener.init();
    const updateOne = jest.spyOn(Event, "updateOne");
    const data: Record<string, unknown> = {
      id: `${label}-time-event`,
      name: "Compatibility A - Compatibility B",
      time,
      home: "Compatibility A",
      away: "Compatibility B",
    };
    if (label === "missing") {
      delete data.time;
    }
    const message = buildMessage();

    try {
      await listener.onMessage(
        {
          sender: "other_service",
          timestamp: "2026-09-16T00:00:00.000Z",
          data,
        } as unknown as INewEventEvent,
        message
      );

      expect(updateOne).toHaveBeenCalledTimes(1);
      expect((listener as any).channel.ack).toHaveBeenCalledWith(message);
    } finally {
      updateOne.mockRestore();
    }
  }
);

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
