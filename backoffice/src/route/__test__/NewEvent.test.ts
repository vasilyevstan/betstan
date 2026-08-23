import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility } from "@betstan/common";
import NewEventPublisher from "../../event/publisher/NewEventPublisher";
import { buildSessionCookie } from "../../test/session";

const adminCookie = () => buildSessionCookie("ADMIN");

it("returns empty object when home or away is missing", async () => {
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .set("Cookie", adminCookie())
    .send({ home: "Team A" })
    .expect(200);

  expect(response.body).toEqual({});
});

it("creates a new event and publishes it", async () => {
  const beforeRequest = Date.now();
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .set("Cookie", adminCookie())
    .send({ home: "Team A", away: "Team B" })
    .expect(200);

  expect(response.body.event).toBeDefined();
  expect(response.body.event.home).toEqual("Team A");
  expect(response.body.event.away).toEqual("Team B");
  expect(response.body.event.status).toEqual(EventStatus.NO_RESULT);
  expect(new Date(response.body.event.time).getTime()).toBeGreaterThanOrEqual(
    beforeRequest + 30 * 60 * 1000
  );

  const storedEvent = await Event.findOne({ eventId: response.body.event.eventId });
  expect(storedEvent).not.toBeNull();

  expect(NewEventPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("allows an administrator to schedule a bounded near-term kickoff", async () => {
  const beforeRequest = Date.now();
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .set("Cookie", adminCookie())
    .send({
      home: "Team A",
      away: "Team B",
      kickoffDelaySeconds: 15,
    })
    .expect(200);

  const kickoffTime = new Date(response.body.event.time).getTime();
  expect(kickoffTime).toBeGreaterThanOrEqual(beforeRequest + 15 * 1000);
  expect(kickoffTime).toBeLessThan(beforeRequest + 16 * 1000);
});

it("creates an offline event without exposing it during acceptance setup", async () => {
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .set("Cookie", adminCookie())
    .send({
      home: "Hidden A",
      away: "Hidden B",
      visibility: EventVisibility.OFFLINE,
    })
    .expect(200);

  expect(response.body.event.visibility).toEqual(EventVisibility.OFFLINE);
  expect(NewEventPublisher.prototype.publish).toHaveBeenCalledWith({
    data: expect.objectContaining({
      id: response.body.event.eventId,
      visibility: EventVisibility.OFFLINE,
    }),
  });
});

it("rejects an invalid event visibility", async () => {
  await request(app)
    .post("/api/backoffice/new_event")
    .set("Cookie", adminCookie())
    .send({
      home: "Team A",
      away: "Team B",
      visibility: "PRIVATE",
    })
    .expect(400);

  expect(NewEventPublisher.prototype.publish).not.toHaveBeenCalled();
});

it.each([14, 86401, 15.5, "15"])(
  "rejects an invalid kickoff delay of %s",
  async (kickoffDelaySeconds) => {
    await request(app)
      .post("/api/backoffice/new_event")
      .set("Cookie", adminCookie())
      .send({ home: "Team A", away: "Team B", kickoffDelaySeconds })
      .expect(400);

    expect(NewEventPublisher.prototype.publish).not.toHaveBeenCalled();
  }
);
