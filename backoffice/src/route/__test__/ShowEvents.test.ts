import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility } from "@betstan/common";

it("returns an empty array to an anonymous visitor when no events exist", async () => {
  const response = await request(app)
    .get("/api/backoffice")
    .send()
    .expect(200);

  expect(Array.isArray(response.body)).toBe(true);
  expect(response.body.length).toEqual(0);
  expect(response.headers["cache-control"]).toEqual("no-store");
  expect(response.headers["x-backoffice-access"]).toEqual("public");
});

it("returns all events, including offline events, to anonymous visitors", async () => {
  await Event.create({
    eventId: "evt-1",
    name: "A - B",
    time: new Date().toISOString(),
    home: "A",
    away: "B",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.OFFLINE,
    creationRequestId: "private-request-id",
    creationRequestFingerprint: "private-fingerprint",
    newEventPublicationPending: true,
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
  expect(response.body).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        eventId: "evt-1",
        visibility: EventVisibility.OFFLINE,
      }),
    ])
  );
  const offlineEvent = response.body.find(
    (event: { eventId: string }) => event.eventId === "evt-1"
  );
  expect(offlineEvent.creationRequestId).toBeUndefined();
  expect(offlineEvent.creationRequestFingerprint).toBeUndefined();
  expect(offlineEvent.newEventPublicationPending).toBeUndefined();
});
