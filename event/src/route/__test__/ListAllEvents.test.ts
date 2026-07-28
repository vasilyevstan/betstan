import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility } from "@betstan/common";

it("returns existing events when DB is not empty", async () => {
  await Event.create({
    eventId: "existing-event",
    name: "Team A - Team B",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  const res = await request(app).get("/api/event").expect(200);
  expect(res.body.length).toBeGreaterThan(0);
});

it("generates and returns events when DB is empty", async () => {
  const res = await request(app).get("/api/event").expect(200);
  expect(Array.isArray(res.body)).toBe(true);
});
