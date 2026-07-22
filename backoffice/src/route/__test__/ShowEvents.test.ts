import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus } from "@betstan/common";

it("returns empty array when no events exist", async () => {
  const response = await request(app)
    .get("/api/backoffice")
    .send()
    .expect(200);

  expect(Array.isArray(response.body)).toBe(true);
  expect(response.body.length).toEqual(0);
});

it("returns all events sorted by status and time", async () => {
  await Event.create({
    eventId: "evt-1",
    name: "A - B",
    time: new Date().toISOString(),
    home: "A",
    away: "B",
    status: EventStatus.NO_RESULT,
  });

  await Event.create({
    eventId: "evt-2",
    name: "C - D",
    time: new Date().toISOString(),
    home: "C",
    away: "D",
    status: EventStatus.NO_RESULT,
  });

  const response = await request(app)
    .get("/api/backoffice")
    .send()
    .expect(200);

  expect(response.body.length).toEqual(2);
});
