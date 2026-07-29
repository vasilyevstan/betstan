import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility as EventVisibilityStatus } from "@betstan/common";
import EventVisibilityPublisher from "../../event/publisher/EventVisibilityPublisher";

const createEvent = async (eventId: string, visibility = EventVisibilityStatus.ONLINE) => {
  return Event.create({
    eventId,
    name: "A - B",
    time: new Date().toISOString(),
    home: "A",
    away: "B",
    status: EventStatus.NO_RESULT,
    visibility,
  });
};

it("returns message when event not found", async () => {
  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({ eventId: "nonexistent" })
    .expect(200);

  expect(response.body.message).toEqual("Event not found");
});

it("flips event visibility from ONLINE to OFFLINE", async () => {
  await createEvent("evt-1", EventVisibilityStatus.ONLINE);

  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({ eventId: "evt-1" })
    .expect(200);

  expect(response.body.visibility).toEqual(EventVisibilityStatus.OFFLINE);
  expect(EventVisibilityPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("flips event visibility from OFFLINE to ONLINE", async () => {
  await createEvent("evt-2", EventVisibilityStatus.OFFLINE);

  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({ eventId: "evt-2" })
    .expect(200);

  expect(response.body.visibility).toEqual(EventVisibilityStatus.ONLINE);
  expect(EventVisibilityPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});
