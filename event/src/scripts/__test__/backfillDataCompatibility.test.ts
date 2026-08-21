import { BettingStatus, EventPhase, EventStatus, EventVisibility } from "@betstan/common";
import { Event } from "../../model/Event";
import { runDataCompatibilityBackfill } from "../backfillDataCompatibility";

const buildLegacyLiveState = () => ({
  sequence: 0,
  occurredAt: new Date("2025-01-01T12:00:00.000Z").toISOString(),
  kickoffAt: new Date("2025-01-01T12:00:00.000Z").toISOString(),
  minute: 0,
  homeScore: 0,
  awayScore: 0,
  bettingStatus: BettingStatus.OPEN,
  incidentHistory: [],
  currentMarkets: [],
});

it("supports dry-run, batched apply, terminal preservation, and idempotence", async () => {
  await Event.collection.insertMany([
    {
      eventId: "legacy-event",
      name: "Legacy",
      time: new Date("2025-01-01T12:00:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: buildLegacyLiveState(),
    },
    {
      eventId: "active-event",
      name: "Active",
      time: new Date("2025-01-01T12:10:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        ...buildLegacyLiveState(),
        sequence: 3,
        phase: EventPhase.FIRST_HALF,
        minute: 17,
        homeScore: 1,
      },
    },
    {
      eventId: "resulted-event",
      name: "Resulted",
      time: new Date("2025-01-01T10:00:00.000Z"),
      status: EventStatus.RESULTED,
      visibility: EventVisibility.OFFLINE,
      products: [],
      live: {
        ...buildLegacyLiveState(),
        sequence: 5,
        minute: 90,
        homeScore: 2,
        awayScore: 1,
      },
    },
  ]);

  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun.changed).toBe(0);
  expect(dryRun.matched).toBe(1);

  const applied = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(applied.changed).toBe(1);

  const legacyEvent = await Event.findOne({ eventId: "legacy-event" }).lean();
  expect((legacyEvent?.live as { phase?: EventPhase }).phase).toBe(
    EventPhase.PRE_MATCH
  );

  const activeEvent = await Event.findOne({ eventId: "active-event" }).lean();
  expect((activeEvent?.live as { phase?: EventPhase }).phase).toBe(
    EventPhase.FIRST_HALF
  );

  const resultedEvent = await Event.findOne({ eventId: "resulted-event" }).lean();
  expect((resultedEvent?.live as { phase?: EventPhase }).phase).toBeUndefined();

  const idempotent = await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  expect(idempotent.changed).toBe(0);
});
