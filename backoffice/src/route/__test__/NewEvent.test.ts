import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility } from "@betstan/common";
import NewEventPublisher from "../../event/publisher/NewEventPublisher";

it("rejects a public create request when home or away is missing", async () => {
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .send({ home: "Team A" })
    .expect(400);

  expect(response.body.message).toContain("Team names");
  expect(response.headers["cache-control"]).toEqual("no-store");
  expect(response.headers["x-backoffice-access"]).toEqual("public");
  expect(NewEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("allows an anonymous visitor to create a new event and publishes trimmed names", async () => {
  const beforeRequest = Date.now();
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .send({ home: "  Team A ", away: " Team B  " })
    .expect(200);

  expect(response.body.event).toBeDefined();
  expect(response.body.event.home).toEqual("Team A");
  expect(response.body.event.away).toEqual("Team B");
  expect(response.body.event.status).toEqual(EventStatus.NO_RESULT);
  expect(response.body.event.creationRequestId).toBeUndefined();
  expect(response.body.event.newEventPublicationPending).toBeUndefined();
  expect(new Date(response.body.event.time).getTime()).toBeGreaterThanOrEqual(
    beforeRequest + 30 * 60 * 1000
  );

  const storedEvent = await Event.findOne({ eventId: response.body.event.eventId });
  expect(storedEvent).not.toBeNull();

  expect(NewEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("retries a failed publication without creating a duplicate event", async () => {
  const publishWithConfirm =
    NewEventPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirm.mockRejectedValueOnce(new Error("confirm unavailable"));
  const requestBody = {
    home: "Team A",
    away: "Team B",
    requestId: "request-1234567890",
  };

  const firstResponse = await request(app)
    .post("/api/backoffice/new_event")
    .send(requestBody)
    .expect(202);

  expect(firstResponse.body.publication).toEqual("PENDING");
  expect(firstResponse.body.event.creationRequestId).toBeUndefined();
  const pendingEvent = await Event.findOne({
    eventId: firstResponse.body.event.eventId,
  }).select("+newEventPublicationPending");
  expect(pendingEvent?.newEventPublicationPending).toBe(true);

  const retryResponse = await request(app)
    .post("/api/backoffice/new_event")
    .send(requestBody)
    .expect(200);

  expect(retryResponse.body.event.eventId).toEqual(
    firstResponse.body.event.eventId
  );
  expect(retryResponse.body.event.creationRequestId).toBeUndefined();
  expect(retryResponse.body.event.creationRequestFingerprint).toBeUndefined();
  expect(retryResponse.body.event.newEventPublicationPending).toBeUndefined();
  expect(await Event.countDocuments()).toEqual(1);
  const publishedEvent = await Event.findOne({
    eventId: firstResponse.body.event.eventId,
  }).select("+newEventPublicationPending");
  expect(publishedEvent?.newEventPublicationPending).toBeUndefined();
  expect(publishWithConfirm).toHaveBeenCalledTimes(2);
});

it("rejects reuse of a creation request id for different event data", async () => {
  const requestId = "request-1234567890";
  await request(app)
    .post("/api/backoffice/new_event")
    .send({ home: "Team A", away: "Team B", requestId })
    .expect(200);

  const response = await request(app)
    .post("/api/backoffice/new_event")
    .send({ home: "Team C", away: "Team D", requestId })
    .expect(409);

  expect(response.body.message).toContain("already used");
  expect(await Event.countDocuments()).toEqual(1);
});

it("converges concurrent retries with the same creation request id", async () => {
  const requestBody = {
    home: "Team A",
    away: "Team B",
    requestId: "request-concurrent-1234",
  };

  const responses = await Promise.all([
    request(app).post("/api/backoffice/new_event").send(requestBody),
    request(app).post("/api/backoffice/new_event").send(requestBody),
  ]);

  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(responses[0].body.event.eventId).toEqual(
    responses[1].body.event.eventId
  );
  expect(await Event.countDocuments()).toEqual(1);
});

it("allows a public caller to schedule a bounded near-term kickoff", async () => {
  const beforeRequest = Date.now();
  const response = await request(app)
    .post("/api/backoffice/new_event")
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

it("creates an offline event for production acceptance setup", async () => {
  const response = await request(app)
    .post("/api/backoffice/new_event")
    .send({
      home: "Hidden A",
      away: "Hidden B",
      visibility: EventVisibility.OFFLINE,
    })
    .expect(200);

  expect(response.body.event.visibility).toEqual(EventVisibility.OFFLINE);
  expect(NewEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledWith({
    data: expect.objectContaining({
      id: response.body.event.eventId,
      visibility: EventVisibility.OFFLINE,
    }),
  });
});

it("rejects an invalid event visibility", async () => {
  await request(app)
    .post("/api/backoffice/new_event")
    .send({
      home: "Team A",
      away: "Team B",
      visibility: "PRIVATE",
    })
    .expect(400);

  expect(NewEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it.each(["   ", "r".repeat(129)])(
  "rejects an invalid creation request id",
  async (requestId) => {
    await request(app)
      .post("/api/backoffice/new_event")
      .send({ home: "Team A", away: "Team B", requestId })
      .expect(400);

    expect(NewEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
  }
);

it.each([14, 86401, 15.5, "15"])(
  "rejects an invalid kickoff delay of %s",
  async (kickoffDelaySeconds) => {
    await request(app)
      .post("/api/backoffice/new_event")
      .send({ home: "Team A", away: "Team B", kickoffDelaySeconds })
      .expect(400);

    expect(NewEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
  }
);

it("rejects team names longer than 80 characters", async () => {
  await request(app)
    .post("/api/backoffice/new_event")
    .send({ home: "A".repeat(81), away: "Team B" })
    .expect(400);

  expect(NewEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});
