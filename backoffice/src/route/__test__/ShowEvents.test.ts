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

it("hides events finished more than a day ago unless a manual market still needs its result", async () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const manualMarket = (decided: boolean) => ({
    marketId: "manual-1", creationFingerprint: "fingerprint", revision: 2, rulesRevision: 1,
    template: { templateId: "template-1", version: 1, definition: { name: "Manual", settlementMode: "MANUAL" } },
    parameters: {}, availability: "OPEN", status: "PUBLISHED", configuredAt: hoursAgo(50),
    publishedConfiguration: { marketId: "manual-1" },
    ...(decided ? { decision: { result: "VOID", winningOutcomeKeys: [] } } : {}),
  });
  const event = (eventId: string, time: string, status: EventStatus, customMarkets: unknown[] = []) =>
    Event.create({ eventId, name: eventId, time, home: "H", away: "A", status, customMarkets });

  await event("old-finished", hoursAgo(48), EventStatus.RESULTED);
  await event("old-settled-manual", hoursAgo(48), EventStatus.RESULTED, [manualMarket(true)]);
  await event("old-awaiting-manual", hoursAgo(48), EventStatus.RESULTED, [manualMarket(false)]);
  await event("recent-finished", hoursAgo(2), EventStatus.RESULTED);
  await event("old-without-result", hoursAgo(48), EventStatus.NO_RESULT);
  await event("upcoming", new Date(Date.now() + 60 * 60 * 1000).toISOString(), EventStatus.NO_RESULT);

  const response = await request(app).get("/api/backoffice").send().expect(200);

  expect(response.body.map((item: { eventId: string }) => item.eventId).sort()).toEqual([
    "old-awaiting-manual", "old-without-result", "recent-finished", "upcoming",
  ]);
  expect(response.body[0].customMarkets).toBeUndefined();
});
