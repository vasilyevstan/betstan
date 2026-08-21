import { EventPhase, EventStatus } from "@betstan/common";
import { Event } from "../../model/Event";
import { EventArchive } from "../../model/EventArchive";
import { runDataCompatibilityBackfill } from "../backfillDataCompatibility";

it("supports dry-run, batched apply, active/archive coverage, terminal preservation, and idempotence", async () => {
  await Event.collection.insertMany([
    {
      eventId: "legacy-event",
      name: "Legacy",
      time: new Date("2025-01-01T12:00:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      liveConfirmedReplayCursor: 0,
    },
    {
      eventId: "active-event",
      name: "Active",
      time: new Date("2025-01-01T12:10:00.000Z"),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      phase: EventPhase.FIRST_HALF,
      liveConfirmedReplayCursor: 2,
    },
  ]);

  await EventArchive.collection.insertMany([
    {
      eventId: "archive-legacy",
      name: "Archive legacy",
      time: new Date("2025-01-01T11:00:00.000Z").toISOString(),
      home: "A",
      away: "B",
      status: EventStatus.NO_RESULT,
      liveConfirmedReplayCursor: 0,
    },
    {
      eventId: "archive-resulted",
      name: "Archive resulted",
      time: new Date("2025-01-01T10:00:00.000Z").toISOString(),
      home: "A",
      away: "B",
      status: EventStatus.RESULTED,
      resultPublishedAt: new Date("2025-01-01T12:00:00.000Z"),
    },
  ]);

  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun.changed).toBe(0);
  expect(dryRun.matched).toBe(2);

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(2);

  const legacyEvent = await Event.findOne({ eventId: "legacy-event" }).lean();
  expect(legacyEvent?.phase).toBe(EventPhase.PRE_MATCH);

  const activeEvent = await Event.findOne({ eventId: "active-event" }).lean();
  expect(activeEvent?.phase).toBe(EventPhase.FIRST_HALF);

  const archiveLegacy = await EventArchive.findOne({ eventId: "archive-legacy" }).lean();
  expect(archiveLegacy?.phase).toBe(EventPhase.PRE_MATCH);

  const archiveResulted = await EventArchive.findOne({ eventId: "archive-resulted" }).lean();
  expect(archiveResulted?.phase).toBeUndefined();

  const idempotent = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(idempotent.changed).toBe(0);
});
