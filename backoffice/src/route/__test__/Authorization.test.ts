import request from "supertest";
import { app } from "../../app";
import { buildSessionCookie } from "../../test/session";
import { setAdminSessionVerifierForTests } from "../../middleware/RequireAdmin";
import { Event } from "../../model/Event";
import { EventStatus, EventVisibility } from "@betstan/common";
import NewEventPublisher from "../../event/publisher/NewEventPublisher";
import ResultSetPublisher from "../../event/publisher/ResultSetPublisher";
import EventVisibilityPublisher from "../../event/publisher/EventVisibilityPublisher";

// A pre-existing event that a bypassed guard would be able to find and
// mutate/publish for the `result` and `event_visibility` routes.
const guardedEventId = "guarded-event";

const seedGuardedEvent = () =>
  Event.create({
    eventId: guardedEventId,
    name: "Guarded A - Guarded B",
    time: new Date().toISOString(),
    home: "Guarded A",
    away: "Guarded B",
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
  });

const mutations = [
  {
    path: "/api/backoffice/new_event",
    body: { home: "Team A", away: "Team B" },
    publisher: NewEventPublisher,
  },
  {
    path: "/api/backoffice/result",
    body: { eventId: guardedEventId, homeResult: 4, awayResult: 2 },
    publisher: ResultSetPublisher,
  },
  {
    path: "/api/backoffice/event_visibility",
    body: { eventId: guardedEventId },
    publisher: EventVisibilityPublisher,
  },
];

// Confirms a rejected mutation attempt never reached the handler: the
// pre-existing guarded event is untouched, no extra event was persisted
// (e.g. via new_event), and no message was published to the queue.
const expectNoMutationOccurred = async (
  publisher: { prototype: { publish: (...args: never[]) => unknown } },
  snapshot: { guarded: unknown; count: number }
) => {
  const guardedAfter = await Event.findOne({ eventId: guardedEventId }).lean();
  expect(guardedAfter).toEqual(snapshot.guarded);
  expect(await Event.countDocuments()).toEqual(snapshot.count);
  expect(publisher.prototype.publish).not.toHaveBeenCalled();
};

const snapshotGuardedEvent = async () => ({
  guarded: await Event.findOne({ eventId: guardedEventId }).lean(),
  count: await Event.countDocuments(),
});

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
  "rejects unauthenticated $path mutations and performs no mutation",
  async ({ path, body, publisher }) => {
    await seedGuardedEvent();
    const snapshot = await snapshotGuardedEvent();

    await request(app).post(path).send(body).expect(401);

    await expectNoMutationOccurred(publisher, snapshot);
  }
);

it.each(mutations)(
  "rejects non-admin $path mutations and performs no mutation",
  async ({ path, body, publisher }) => {
    await seedGuardedEvent();
    const snapshot = await snapshotGuardedEvent();

    await request(app)
      .post(path)
      .set("Cookie", buildSessionCookie("USER"))
      .send(body)
      .expect(403);

    await expectNoMutationOccurred(publisher, snapshot);
  }
);

it.each(mutations)(
  "rejects legacy no-role $path mutations and performs no mutation",
  async ({ path, body, publisher }) => {
    await seedGuardedEvent();
    const snapshot = await snapshotGuardedEvent();

    await request(app)
      .post(path)
      .set("Cookie", buildSessionCookie())
      .send(body)
      .expect(403);

    await expectNoMutationOccurred(publisher, snapshot);
  }
);

it.each(mutations)(
  "ignores a spoofed admin role in the $path request body",
  async ({ path, body, publisher }) => {
    await seedGuardedEvent();
    const snapshot = await snapshotGuardedEvent();

    await request(app)
      .post(path)
      .send({ ...body, role: "ADMIN", currentUser: { role: "ADMIN" } })
      .expect(401);

    await expectNoMutationOccurred(publisher, snapshot);
  }
);

it.each(mutations)(
  "rejects a locally valid admin token for $path after auth revokes it, without mutating",
  async ({ path, body, publisher }) => {
    await seedGuardedEvent();
    const snapshot = await snapshotGuardedEvent();
    setAdminSessionVerifierForTests(async () => 403);

    await request(app)
      .post(path)
      .set("Cookie", buildSessionCookie("ADMIN"))
      .send(body)
      .expect(403);

    await expectNoMutationOccurred(publisher, snapshot);
  }
);

it.each(mutations)(
  "fails $path closed without mutating when persisted-role verification is unavailable",
  async ({ path, body, publisher }) => {
    await seedGuardedEvent();
    const snapshot = await snapshotGuardedEvent();
    setAdminSessionVerifierForTests(async () => {
      throw new Error("auth unavailable");
    });

    await request(app)
      .post(path)
      .set("Cookie", buildSessionCookie("ADMIN"))
      .send(body)
      .expect(503);

    await expectNoMutationOccurred(publisher, snapshot);
  }
);
