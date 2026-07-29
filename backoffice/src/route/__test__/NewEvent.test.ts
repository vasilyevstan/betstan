import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus } from "@betstan/common";
import NewEventPublisher from "../../event/publisher/NewEventPublisher";

it("returns empty object when home or away is missing", async () => {
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .send({ home: "Team A" })
    .expect(200);

  expect(response.body).toEqual({});
});

it("creates a new event and publishes it", async () => {
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .send({ home: "Team A", away: "Team B" })
    .expect(200);

  expect(response.body.event).toBeDefined();
  expect(response.body.event.home).toEqual("Team A");
  expect(response.body.event.away).toEqual("Team B");
  expect(response.body.event.status).toEqual(EventStatus.NO_RESULT);

  const storedEvent = await Event.findOne({ eventId: response.body.event.eventId });
  expect(storedEvent).not.toBeNull();

  expect(NewEventPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});
