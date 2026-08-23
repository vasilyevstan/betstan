import request from "supertest";
import { app } from "../../app";
import { buildSessionCookie } from "../../test/session";
import { setAdminSessionVerifierForTests } from "../../middleware/RequireAdmin";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility } from "@betstan/common";

const mutations = [
  {
    path: "/api/backoffice/new_event",
    body: { home: "Team A", away: "Team B" },
  },
  {
    path: "/api/backoffice/result",
    body: { eventId: "event-id", homeResult: 1, awayResult: 0 },
  },
  {
    path: "/api/backoffice/event_visibility",
    body: { eventId: "event-id" },
  },
];

it("does not disclose offline fixtures to anonymous reads", async () => {
  await Event.create({
    eventId: "offline-secret",
    name: "Private acceptance fixture",
    time: new Date(),
    home: "Private",
    away: "Fixture",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.OFFLINE,
  });

  const response = await request(app).get("/api/backoffice").expect(401);

  expect(JSON.stringify(response.body)).not.toContain(
    "Private acceptance fixture"
  );
});

it.each([
  { name: "ordinary users", role: "USER" as const },
  { name: "legacy sessions", role: undefined },
])("rejects backoffice reads from $name", async ({ role }) => {
  await request(app)
    .get("/api/backoffice")
    .set("Cookie", buildSessionCookie(role))
    .expect(403);
});

it("rejects backoffice reads after persisted-role revocation", async () => {
  setAdminSessionVerifierForTests(async () => 403);

  await request(app)
    .get("/api/backoffice")
    .set("Cookie", buildSessionCookie("ADMIN"))
    .expect(403);
});

it("fails backoffice reads closed when persisted-role verification is unavailable", async () => {
  setAdminSessionVerifierForTests(async () => {
    throw new Error("auth unavailable");
  });

  await request(app)
    .get("/api/backoffice")
    .set("Cookie", buildSessionCookie("ADMIN"))
    .expect(503);
});

it.each(mutations)(
  "rejects unauthenticated $path mutations",
  async ({ path, body }) => {
    await request(app).post(path).send(body).expect(401);
  }
);

it("rejects a locally valid admin token after auth revokes it", async () => {
  setAdminSessionVerifierForTests(async () => 403);

  await request(app)
    .post("/api/backoffice/new_event")
    .set("Cookie", buildSessionCookie("ADMIN"))
    .send({ home: "Team A", away: "Team B" })
    .expect(403);
});

it("fails closed when persisted-role verification is unavailable", async () => {
  setAdminSessionVerifierForTests(async () => {
    throw new Error("auth unavailable");
  });

  await request(app)
    .post("/api/backoffice/new_event")
    .set("Cookie", buildSessionCookie("ADMIN"))
    .send({ home: "Team A", away: "Team B" })
    .expect(503);
});

it.each(mutations)(
  "rejects non-admin $path mutations",
  async ({ path, body }) => {
    await request(app)
      .post(path)
      .set("Cookie", buildSessionCookie("USER"))
      .send(body)
      .expect(403);
  }
);

it.each(mutations)(
  "rejects legacy no-role $path mutations",
  async ({ path, body }) => {
    await request(app)
      .post(path)
      .set("Cookie", buildSessionCookie())
      .send(body)
      .expect(403);
  }
);
