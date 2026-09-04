import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus } from "@betstan/common";
import ResultSetPublisher from "../../event/publisher/ResultSetPublisher";

const createEvent = async (
  eventId: string,
  status = EventStatus.NO_RESULT,
  homeResult?: number,
  awayResult?: number
) => {
  return Event.create({
    eventId,
    name: "A - B",
    time: new Date().toISOString(),
    home: "A",
    away: "B",
    status,
    homeResult,
    awayResult,
  });
};

it("returns 404 when event not found", async () => {
  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "nonexistent", homeResult: 2, awayResult: 1 })
    .expect(404);

  expect(response.body.message).toEqual("Event not found");
  expect(response.headers["cache-control"]).toEqual("no-store");
  expect(response.headers["x-backoffice-access"]).toEqual("public");
});

it("allows an anonymous visitor to set a result and publishes the event", async () => {
  await createEvent("evt-1");

  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-1", homeResult: 3, awayResult: 1 })
    .expect(200);

  expect(response.body.event.status).toEqual(EventStatus.RESULTED);
  expect(response.body.event.homeResult).toEqual(3);
  expect(response.body.event.awayResult).toEqual(1);

  expect(ResultSetPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("keeps a failed result publication pending and repairs it on retry", async () => {
  const publishWithConfirm =
    ResultSetPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockRejectedValueOnce(new Error("confirm unavailable"));
  await createEvent("evt-result-retry");

  const firstResponse = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-result-retry", homeResult: 2, awayResult: 1 })
    .expect(202);

  expect(firstResponse.body.publication).toEqual("PENDING");
  expect(firstResponse.body.event.resultPublicationPending).toBeUndefined();
  expect(firstResponse.body.event.newEventPublicationPending).toBeUndefined();
  const pendingEvent = await Event.findOne({
    eventId: "evt-result-retry",
  }).select("+resultPublicationPending");
  expect(pendingEvent?.resultPublicationPending).toBe(true);

  const retryResponse = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-result-retry", homeResult: 2, awayResult: 1 })
    .expect(200);

  expect(retryResponse.body.unchanged).toBe(true);
  expect(retryResponse.body.event.resultPublicationPending).toBeUndefined();
  expect(retryResponse.body.event.newEventPublicationPending).toBeUndefined();
  const publishedEvent = await Event.findOne({
    eventId: "evt-result-retry",
  }).select("+resultPublicationPending");
  expect(publishedEvent?.resultPublicationPending).toBeUndefined();
  expect(publishWithConfirm).toHaveBeenCalledTimes(2);
});

it("does not result an event before its creation publication is confirmed", async () => {
  await Event.create({
    eventId: "evt-creation-pending",
    name: "A - B",
    time: new Date().toISOString(),
    home: "A",
    away: "B",
    status: EventStatus.NO_RESULT,
    newEventPublicationPending: true,
  });

  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-creation-pending", homeResult: 2, awayResult: 1 })
    .expect(409);

  expect(response.body.message).toContain("creation is still being published");
  expect(ResultSetPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("treats an identical repeated result as an idempotent success", async () => {
  await createEvent("evt-2", EventStatus.RESULTED, 1, 0);

  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-2", homeResult: 1, awayResult: 0 })
    .expect(200);

  expect(response.body.event.status).toEqual(EventStatus.RESULTED);
  expect(response.body.unchanged).toBe(true);
  expect(ResultSetPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("rejects omitted scores instead of silently settling a public event 0-0", async () => {
  await createEvent("evt-3");

  await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-3" })
    .expect(400);

  const event = await Event.findOne({ eventId: "evt-3" });
  expect(event?.status).toEqual(EventStatus.NO_RESULT);
  expect(ResultSetPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("accepts numeric score strings from older clients", async () => {
  await createEvent("evt-4");

  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-4", homeResult: "2", awayResult: "1" })
    .expect(200);

  expect(response.body.event.homeResult).toEqual(2);
  expect(response.body.event.awayResult).toEqual(1);
});

it.each([
  { homeResult: -1, awayResult: 0 },
  { homeResult: 100, awayResult: 0 },
  { homeResult: 1.5, awayResult: 0 },
  { homeResult: "not-a-score", awayResult: 0 },
])("rejects invalid public scores without mutating the event", async (scores) => {
  await createEvent("evt-invalid");

  await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-invalid", ...scores })
    .expect(400);

  const event = await Event.findOne({ eventId: "evt-invalid" });
  expect(event?.status).toEqual(EventStatus.NO_RESULT);
  expect(ResultSetPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("rejects a conflicting repeated result", async () => {
  await Event.create({
    eventId: "evt-conflict",
    name: "A - B",
    time: new Date().toISOString(),
    home: "A",
    away: "B",
    status: EventStatus.RESULTED,
    homeResult: 2,
    awayResult: 1,
    resultPublicationPending: true,
  });

  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-conflict", homeResult: 3, awayResult: 2 })
    .expect(409);

  expect(response.body.message).toEqual("Event already has a different result");
  expect(response.body.event.homeResult).toEqual(2);
  expect(response.body.event.awayResult).toEqual(1);
  expect(response.body.event.resultPublicationPending).toBeUndefined();
  expect(response.body.event.newEventPublicationPending).toBeUndefined();
  expect(ResultSetPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("publishes only once and rejects the losing conflicting caller", async () => {
  await createEvent("evt-race");

  const responses = await Promise.all([
    request(app)
      .post("/api/backoffice/result")
      .send({ eventId: "evt-race", homeResult: 2, awayResult: 1 }),
    request(app)
      .post("/api/backoffice/result")
      .send({ eventId: "evt-race", homeResult: 3, awayResult: 2 }),
  ]);

  expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  expect(ResultSetPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("keeps identical concurrent result requests idempotent", async () => {
  await createEvent("evt-same-result");

  const responses = await Promise.all([
    request(app)
      .post("/api/backoffice/result")
      .send({ eventId: "evt-same-result", homeResult: 2, awayResult: 1 }),
    request(app)
      .post("/api/backoffice/result")
      .send({ eventId: "evt-same-result", homeResult: 2, awayResult: 1 }),
  ]);

  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(ResultSetPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});
