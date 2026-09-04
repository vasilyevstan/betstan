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

it("rejects a public visibility request without an event id", async () => {
  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({ visibility: EventVisibilityStatus.OFFLINE })
    .expect(400);

  expect(response.body.message).toEqual("No event id");
  expect(EventVisibilityPublisher.prototype.publish).not.toHaveBeenCalled();
});

it("returns message when event not found", async () => {
  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({ eventId: "nonexistent" })
    .expect(200);

  expect(response.body.message).toEqual("Event not found");
});

it("allows an anonymous visitor to flip event visibility from ONLINE to OFFLINE", async () => {
  await createEvent("evt-1", EventVisibilityStatus.ONLINE);

  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({
      eventId: "evt-1",
      visibility: EventVisibilityStatus.OFFLINE,
    })
    .expect(200);

  expect(response.body.visibility).toEqual(EventVisibilityStatus.OFFLINE);
  expect(EventVisibilityPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("flips event visibility from OFFLINE to ONLINE", async () => {
  await createEvent("evt-2", EventVisibilityStatus.OFFLINE);

  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({
      eventId: "evt-2",
      visibility: EventVisibilityStatus.ONLINE,
    })
    .expect(200);

  expect(response.body.visibility).toEqual(EventVisibilityStatus.ONLINE);
  expect(EventVisibilityPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("defaults corrupted visibility to OFFLINE before publishing", async () => {
  await createEvent("evt-3", undefined as unknown as EventVisibilityStatus);

  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({ eventId: "evt-3" })
    .expect(200);

  expect(response.body.visibility).toEqual(EventVisibilityStatus.OFFLINE);
  expect(EventVisibilityPublisher.prototype.publish).toHaveBeenCalledWith({
    data: { eventId: "evt-3", visibility: EventVisibilityStatus.OFFLINE },
  });
});

it("keeps repeated public visibility requests idempotent", async () => {
  await createEvent("evt-race", EventVisibilityStatus.ONLINE);

  const responses = await Promise.all([
    request(app)
      .post("/api/backoffice/event_visibility")
      .send({
        eventId: "evt-race",
        visibility: EventVisibilityStatus.OFFLINE,
      }),
    request(app)
      .post("/api/backoffice/event_visibility")
      .send({
        eventId: "evt-race",
        visibility: EventVisibilityStatus.OFFLINE,
      }),
  ]);

  expect(responses.every((response) => response.status === 200)).toBe(true);
  const event = await Event.findOne({ eventId: "evt-race" });
  expect(event?.visibility).toEqual(EventVisibilityStatus.OFFLINE);
  expect(EventVisibilityPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("keeps the legacy toggle request compatible", async () => {
  await createEvent("evt-legacy", EventVisibilityStatus.ONLINE);

  const response = await request(app)
    .post("/api/backoffice/event_visibility")
    .send({ eventId: "evt-legacy" })
    .expect(200);

  expect(response.body.visibility).toEqual(EventVisibilityStatus.OFFLINE);
});
