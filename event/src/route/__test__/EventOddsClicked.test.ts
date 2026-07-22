import request from "supertest";
import { app } from "../../app";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility } from "@betstan/common";
import EventOddsSelectedPublisher from "../../messaging/publisher/EventOddsSelectedPublisher";

const createEvent = async () => {
  const event = new Event({
    eventId: "test-event-id",
    name: "Team A - Team B",
    time: new Date(),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [
      {
        id: "product-1",
        type: "1X2",
        name: "1X2",
        odds: [
          { id: "odds-1", name: "Team A", value: 1.5 },
          { id: "odds-2", name: "draw", value: 3.0 },
          { id: "odds-3", name: "Team B", value: 2.5 },
        ],
      },
    ],
  });
  await event.save();
  return event;
};

it("returns 200 and publishes odds selected event", async () => {
  await createEvent();

  await request(app)
    .post("/api/event/odds")
    .send({ eventId: "test-event-id", productId: "product-1", oddsId: "odds-1", data: "present" })
    .expect(200);

  expect(EventOddsSelectedPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});

it("returns 400 when event not found", async () => {
  await request(app)
    .post("/api/event/odds")
    .send({ eventId: "nonexistent", productId: "product-1", oddsId: "odds-1", data: "present" })
    .expect(400);
});

it("returns 400 when product not found", async () => {
  await createEvent();

  await request(app)
    .post("/api/event/odds")
    .send({ eventId: "test-event-id", productId: "nonexistent-product", oddsId: "odds-1", data: "present" })
    .expect(400);
});

it("returns 400 when odds not found", async () => {
  await createEvent();

  await request(app)
    .post("/api/event/odds")
    .send({ eventId: "test-event-id", productId: "product-1", oddsId: "nonexistent-odds", data: "present" })
    .expect(400);
});

it("returns 400 when required fields are missing", async () => {
  await request(app)
    .post("/api/event/odds")
    .send({ eventId: "test-event-id" })
    .expect(400);
});
