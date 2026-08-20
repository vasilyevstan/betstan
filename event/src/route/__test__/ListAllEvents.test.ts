import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility } from "@betstan/common";
import NewEventPublisher from "../../messaging/publisher/NewEventPublisher";

it("returns existing events sorted by time", async () => {
  await Event.create({
    eventId: "later-event",
    name: "Team A - Team B",
    time: new Date("2030-01-02T00:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });
  await Event.create({
    eventId: "earlier-event",
    name: "Team C - Team D",
    time: new Date("2030-01-01T00:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  const res = await request(app).get("/api/event").expect(200);
  expect(res.body.map((event: { eventId: string }) => event.eventId)).toEqual([
    "earlier-event",
    "later-event",
  ]);
});

it("returns an empty array without creating events when DB is empty", async () => {
  const res = await request(app).get("/api/event").expect(200);
  expect(res.body).toEqual([]);
  expect(await Event.countDocuments()).toEqual(0);
  expect(NewEventPublisher.prototype.publish).not.toHaveBeenCalled();
});
