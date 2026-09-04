import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus } from "@betstan/common";
import ResultSetPublisher from "../../event/publisher/ResultSetPublisher";

const createEvent = async (eventId: string, status = EventStatus.NO_RESULT) => {
  return Event.create({
    eventId,
    name: "A - B",
    time: new Date().toISOString(),
    home: "A",
    away: "B",
    status,
  });
};

it("returns 400 when event not found", async () => {
  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "nonexistent", homeResult: 2, awayResult: 1 })
    .expect(400);

  expect(response.body.message).toEqual("No event id");
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

  expect(ResultSetPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("returns event without change if already resulted", async () => {
  await createEvent("evt-2", EventStatus.RESULTED);

  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-2", homeResult: 1, awayResult: 0 })
    .expect(200);

  expect(response.body.event.status).toEqual(EventStatus.RESULTED);
  expect(ResultSetPublisher.prototype.publish).not.toHaveBeenCalled();
});

it("defaults omitted scores to 0 for compatibility", async () => {
  await createEvent("evt-3");

  const response = await request(app)
    .post("/api/backoffice/result")
    .send({ eventId: "evt-3" })
    .expect(200);

  expect(response.body.event.homeResult).toEqual(0);
  expect(response.body.event.awayResult).toEqual(0);
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
  expect(ResultSetPublisher.prototype.publish).not.toHaveBeenCalled();
});

it("publishes only once when concurrent callers result the same event", async () => {
  await createEvent("evt-race");

  const responses = await Promise.all([
    request(app)
      .post("/api/backoffice/result")
      .send({ eventId: "evt-race", homeResult: 2, awayResult: 1 }),
    request(app)
      .post("/api/backoffice/result")
      .send({ eventId: "evt-race", homeResult: 3, awayResult: 2 }),
  ]);

  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(ResultSetPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});
