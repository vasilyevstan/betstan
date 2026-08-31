import mongoose from "mongoose";
import { BettingStatus, EventPhase, EventStatus, EventVisibility } from "@betstan/common";
import { ProductType } from "../../data/product/ProductType";
import {
  buildPreMatchPricing,
  CORRECT_SCORE_OPTION_COUNT,
  expectedGoalsFromSeed,
  MAX_GOALS_PER_SIDE,
} from "../../data/product/preMatchPricing";
import { Event } from "../../model/Event";
import {
  parseBackfillArgs,
  runBackfillCli,
  runDataCompatibilityBackfill,
} from "../backfillDataCompatibility";

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

const LEGACY_SCORE_LABELS = [
  "1 - 0",
  "8 - 10",
  "0 - 0",
  "10 - 4",
  "1 - 1",
  "9 - 6",
  "2 - 0",
  "1 - 0",
  "10 - 8",
  "3 - 10",
];

const PLAUSIBLE_SCORE_LABELS = [
  "0 - 0",
  "1 - 0",
  "0 - 1",
  "1 - 1",
  "2 - 0",
  "0 - 2",
  "2 - 1",
  "1 - 2",
  "2 - 2",
  "3 - 1",
];

const buildProducts = (
  eventId: string,
  scoreLabels: string[] = LEGACY_SCORE_LABELS
) => [
  {
    _id: new mongoose.Types.ObjectId(),
    id: `${eventId}-1x2`,
    type: ProductType.ONE_CROSS_TWO,
    name: "1X2",
    odds: [
      {
        _id: new mongoose.Types.ObjectId(),
        id: `${eventId}-home`,
        name: "Home",
        value: 9.1,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        id: `${eventId}-draw`,
        name: "draw",
        value: 9.2,
      },
      {
        _id: new mongoose.Types.ObjectId(),
        id: `${eventId}-away`,
        name: "Away",
        value: 9.3,
      },
    ],
  },
  {
    _id: new mongoose.Types.ObjectId(),
    id: `${eventId}-cs`,
    type: ProductType.CORRECT_SCORE,
    name: "Correct Score",
    odds: scoreLabels.map((name, index) => ({
      _id: new mongoose.Types.ObjectId(),
      id: `${eventId}-cs-${index}`,
      name,
      value: 50 + index,
    })),
  },
];

const getProductIdentity = (products: any[]) => products.map((product) => ({
  _id: product._id,
  id: product.id,
  type: product.type,
  name: product.name,
  odds: product.odds.map((odd: any) => ({ _id: odd._id })),
}));

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.MONGO_URI;
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

it("repairs a legacy pricing board deterministically while preserving durable identities", async () => {
  const eventId = "legacy-pricing-event";
  const originalProducts = buildProducts(eventId);
  await Event.collection.insertOne({
    eventId,
    home: "Home",
    away: "Away",
    name: "Legacy pricing",
    time: new Date("2026-09-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: originalProducts,
    live: {
      ...buildLegacyLiveState(),
      phase: EventPhase.PRE_MATCH,
    },
  });

  const before = await Event.collection.findOne({ eventId });
  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun).toMatchObject({ matched: 1, changed: 0, errorCount: 0 });
  expect(await Event.collection.findOne({ eventId })).toEqual(before);

  const applied = await runDataCompatibilityBackfill({
    apply: true,
    batchSize: 1,
  });
  expect(applied).toMatchObject({ matched: 1, changed: 1, errorCount: 0 });

  const repaired = await Event.collection.findOne({ eventId });
  expect(repaired).not.toBeNull();
  expect(getProductIdentity(repaired!.products)).toEqual(
    getProductIdentity(before!.products)
  );

  const oneCrossTwo = repaired!.products.find(
    (product: any) => product.type === ProductType.ONE_CROSS_TWO
  );
  const correctScore = repaired!.products.find(
    (product: any) => product.type === ProductType.CORRECT_SCORE
  );
  expect(oneCrossTwo.odds.map((odd: any) => odd.id)).toEqual(
    before!.products[0].odds.map((odd: any) => odd.id)
  );
  expect(oneCrossTwo.odds.map((odd: any) => odd.name)).toEqual([
    "Home",
    "draw",
    "Away",
  ]);
  expect(oneCrossTwo.odds.map((odd: any) => odd.value)).not.toEqual([
    9.1,
    9.2,
    9.3,
  ]);

  const repairedLabels = correctScore.odds.map((odd: any) => odd.name);
  expect(correctScore.odds).toHaveLength(CORRECT_SCORE_OPTION_COUNT);
  expect(new Set(repairedLabels).size).toBe(CORRECT_SCORE_OPTION_COUNT);
  repairedLabels.forEach((label: string) => {
    const [homeGoals, awayGoals] = label.split(" - ").map(Number);
    expect(homeGoals).toBeLessThanOrEqual(MAX_GOALS_PER_SIDE);
    expect(awayGoals).toBeLessThanOrEqual(MAX_GOALS_PER_SIDE);
  });
  expect(repairedLabels).not.toContain("8 - 10");
  expect(repairedLabels).not.toContain("10 - 8");

  const firstExistingIdByLabel = new Map<string, string>();
  before!.products[1].odds.forEach((odd: any) => {
    if (!firstExistingIdByLabel.has(odd.name)) {
      firstExistingIdByLabel.set(odd.name, odd.id);
    }
  });
  correctScore.odds.forEach((odd: any) => {
    const existingId = firstExistingIdByLabel.get(odd.name);
    if (existingId) {
      expect(odd.id).toBe(existingId);
    } else {
      expect(odd.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
    }
  });
  expect(correctScore.odds.map((odd: any) => odd.id)).not.toContain(
    `${eventId}-cs-7`
  );

  const afterFirstApply = await Event.collection.findOne({ eventId });
  const idempotent = await runDataCompatibilityBackfill({
    apply: true,
    batchSize: 1,
  });
  expect(idempotent).toMatchObject({ matched: 0, changed: 0, errorCount: 0 });
  expect(await Event.collection.findOne({ eventId })).toEqual(afterFirstApply);

  const stableBoard = correctScore.odds.map((odd: any) => ({
    id: odd.id,
    name: odd.name,
    value: odd.value,
  }));
  await Event.collection.deleteOne({ eventId });
  await Event.collection.insertOne({
    eventId,
    home: "Home",
    away: "Away",
    name: "Legacy pricing replay",
    time: new Date("2026-09-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: buildProducts(eventId),
    live: {
      ...buildLegacyLiveState(),
      phase: EventPhase.PRE_MATCH,
    },
  });
  await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });
  const replayed = await Event.collection.findOne({ eventId });
  const replayedCorrectScore = replayed!.products.find(
    (product: any) => product.type === ProductType.CORRECT_SCORE
  );
  expect(replayedCorrectScore.odds.map((odd: any) => ({
    id: odd.id,
    name: odd.name,
    value: odd.value,
  }))).toEqual(stableBoard);
});

it("maps 1X2 prices by team meaning rather than legacy array order", async () => {
  const eventId = "shuffled-1x2";
  const products = buildProducts(eventId);
  products[0].odds = [
    products[0].odds[2],
    products[0].odds[0],
    products[0].odds[1],
  ];
  await Event.collection.insertOne({
    eventId,
    home: "Home",
    away: "Away",
    name: "Shuffled 1X2",
    time: new Date("2026-09-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products,
  });

  await runDataCompatibilityBackfill({ apply: true, batchSize: 1 });

  const repaired = await Event.collection.findOne({ eventId });
  const oneCrossTwo = repaired!.products.find(
    (product: any) => product.type === ProductType.ONE_CROSS_TWO
  );
  const valuesByLabel = new Map(
    oneCrossTwo.odds.map((odd: any) => [odd.name.toLowerCase(), odd.value])
  );
  const pricing = buildPreMatchPricing(expectedGoalsFromSeed(eventId));
  expect(valuesByLabel.get("home")).toBe(pricing.oneCrossTwoOdds.home);
  expect(valuesByLabel.get("draw")).toBe(pricing.oneCrossTwoOdds.draw);
  expect(valuesByLabel.get("away")).toBe(pricing.oneCrossTwoOdds.away);
});

it("repairs the bounded nine-slot pool and converges with batch size one", async () => {
  await Event.collection.insertMany(
    Array.from({ length: 9 }, (_, index) => {
      const eventId = `pool-event-${index}`;
      return {
        eventId,
        home: "Home",
        away: "Away",
        name: `Pool event ${index}`,
        time: new Date(Date.UTC(2026, 7, 31, 18, 40 + index * 160)),
        status: EventStatus.NO_RESULT,
        visibility: EventVisibility.ONLINE,
        products: buildProducts(eventId),
        live: index === 0
          ? buildLegacyLiveState()
          : {
            ...buildLegacyLiveState(),
            phase: EventPhase.PRE_MATCH,
          },
      };
    })
  );

  const dryRun = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(dryRun).toMatchObject({
    collection: "all",
    matched: 9,
    changed: 0,
    errorCount: 0,
  });

  const applied = await runDataCompatibilityBackfill({
    apply: true,
    batchSize: 1,
  });
  expect(applied).toMatchObject({ matched: 9, changed: 9, errorCount: 0 });

  const firstEvent = await Event.collection.findOne({ eventId: "pool-event-0" });
  expect(firstEvent?.live.phase).toBe(EventPhase.PRE_MATCH);
  const verify = await runDataCompatibilityBackfill({ batchSize: 1 });
  expect(verify).toMatchObject({ matched: 0, changed: 0, errorCount: 0 });
});

it("repairs in-play legacy products but preserves terminal, plausible, and unsafe boards", async () => {
  const documents = [
    {
      eventId: "in-play",
      status: EventStatus.NO_RESULT,
      live: {
        ...buildLegacyLiveState(),
        sequence: 12,
        phase: EventPhase.SECOND_HALF,
      },
      products: buildProducts("in-play"),
    },
    {
      eventId: "resulted",
      status: EventStatus.RESULTED,
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.FULL_TIME,
      },
      products: buildProducts("resulted"),
    },
    {
      eventId: "full-time",
      status: EventStatus.NO_RESULT,
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.FULL_TIME,
      },
      products: buildProducts("full-time"),
    },
    {
      eventId: "retired",
      status: EventStatus.NO_RESULT,
      liveRetiredAt: new Date("2026-08-31T12:00:00.000Z"),
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.PRE_MATCH,
      },
      products: buildProducts("retired"),
    },
    {
      eventId: "race-resulted",
      status: EventStatus.NO_RESULT,
      liveRaceResultedAt: new Date("2026-08-31T12:00:00.000Z"),
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.PRE_MATCH,
      },
      products: buildProducts("race-resulted"),
    },
    {
      eventId: "plausible",
      status: EventStatus.NO_RESULT,
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.PRE_MATCH,
      },
      products: buildProducts("plausible", PLAUSIBLE_SCORE_LABELS),
    },
    {
      eventId: "unsafe-identity",
      status: EventStatus.NO_RESULT,
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.PRE_MATCH,
      },
      products: buildProducts("unsafe-identity"),
    },
    {
      eventId: "unsafe-labels",
      status: EventStatus.NO_RESULT,
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.PRE_MATCH,
      },
      products: buildProducts("unsafe-labels"),
    },
  ].map((document) => ({
    home: "Home",
    away: "Away",
    name: document.eventId,
    time: new Date("2026-09-01T12:00:00.000Z"),
    visibility: EventVisibility.ONLINE,
    ...document,
  }));
  delete (documents[6].products[1].odds[0] as any).id;
  documents[7].products[0].odds[0].name = "Unknown";

  await Event.collection.insertMany(documents);
  const before = new Map(
    (await Event.collection.find({}).toArray())
      .map((document) => [document.eventId, document])
  );

  const applied = await runDataCompatibilityBackfill({
    apply: true,
    batchSize: 2,
  });
  expect(applied).toMatchObject({ matched: 1, changed: 1, errorCount: 0 });

  const after = new Map(
    (await Event.collection.find({}).toArray())
      .map((document) => [document.eventId, document])
  );
  expect(after.get("in-play")?.live.phase).toBe(EventPhase.SECOND_HALF);
  expect(after.get("in-play")?.products).not.toEqual(
    before.get("in-play")?.products
  );
  for (const eventId of [
    "resulted",
    "full-time",
    "retired",
    "race-resulted",
    "plausible",
    "unsafe-identity",
    "unsafe-labels",
  ]) {
    expect(after.get(eventId)).toEqual(before.get(eventId));
  }
});

it("does not overwrite a candidate that becomes terminal after it is scanned", async () => {
  const eventId = "concurrent-terminal";
  await Event.collection.insertOne({
    eventId,
    home: "Home",
    away: "Away",
    name: "Concurrent terminal",
    time: new Date("2026-09-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: buildProducts(eventId),
    live: {
      ...buildLegacyLiveState(),
      phase: EventPhase.PRE_MATCH,
    },
  });
  const before = await Event.collection.findOne({ eventId });
  const originalBulkWrite = Event.collection.bulkWrite.bind(Event.collection);
  jest.spyOn(Event.collection, "bulkWrite").mockImplementationOnce(
    (async (operations: any[], options: any) => {
      await Event.collection.updateOne(
        { eventId },
        {
          $set: {
            status: EventStatus.RESULTED,
            liveRaceResultedAt: new Date("2026-08-31T12:00:00.000Z"),
          },
        }
      );
      return originalBulkWrite(operations, options);
    }) as any
  );

  await expect(
    runDataCompatibilityBackfill({ apply: true, batchSize: 1 })
  ).rejects.toThrow(
    "Event backfill matched 0 and modified 0 of 1 source-bound documents"
  );

  const after = await Event.collection.findOne({ eventId });
  expect(after?.status).toBe(EventStatus.RESULTED);
  expect(after?.liveRaceResultedAt).toEqual(
    new Date("2026-08-31T12:00:00.000Z")
  );
  expect(after?.products).toEqual(before?.products);
});

it("uses defaults and skips documents without live state, with a phase, or with a positive string sequence", async () => {
  await Event.collection.insertMany([
    {
      eventId: "missing-live",
      name: "Missing live",
      time: new Date("2025-01-01T12:00:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
    },
    {
      eventId: "phase-present",
      name: "Phase present",
      time: new Date("2025-01-01T12:05:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        ...buildLegacyLiveState(),
        phase: EventPhase.FIRST_HALF,
      },
    },
    {
      eventId: "string-sequence",
      name: "String sequence",
      time: new Date("2025-01-01T12:10:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        ...buildLegacyLiveState(),
        sequence: "2",
      },
    },
  ]);

  const report = await runDataCompatibilityBackfill();

  expect(report).toMatchObject({
    mode: "dry-run",
    batchSize: 100,
    scanned: 3,
    matched: 0,
    changed: 0,
    skipped: 3,
  });
});

it("parses supported CLI arguments and rejects invalid forms", () => {
  expect(parseBackfillArgs([])).toEqual({ apply: false, batchSize: 100 });
  expect(parseBackfillArgs(["--apply", "--batch-size", "5"])).toEqual({
    apply: true,
    batchSize: 5,
  });
  expect(parseBackfillArgs(["--batch-size=7"])).toEqual({
    apply: false,
    batchSize: 7,
  });

  expect(() => parseBackfillArgs(["--batch-size"])).toThrow(
    "Missing value for --batch-size"
  );
  expect(() => parseBackfillArgs(["--batch-size", "0"])).toThrow(
    "Invalid --batch-size value: 0"
  );
  expect(() => parseBackfillArgs(["--unknown"])).toThrow(
    "Unknown argument: --unknown"
  );
});

it("runs the CLI with mocked connect/disconnect and logs the generated report", async () => {
  process.env.MONGO_URI = "mongodb://unused/test";
  const logger = {
    log: jest.fn(),
    error: jest.fn(),
  };
  jest.spyOn(mongoose, "connect").mockResolvedValue(mongoose as any);
  jest.spyOn(mongoose, "disconnect").mockResolvedValue(undefined as never);

  await Event.collection.insertOne({
    eventId: "cli-event",
    name: "CLI",
    time: new Date("2025-01-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: buildLegacyLiveState(),
  });

  const report = await runBackfillCli(["--apply", "--batch-size=1"], logger);

  expect(report.mode).toEqual("apply");
  expect(report.batchSize).toEqual(1);
  expect(report.changed).toEqual(1);
  expect(mongoose.connect).toHaveBeenCalledWith("mongodb://unused/test");
  expect(mongoose.disconnect).toHaveBeenCalledTimes(1);
  expect(logger.log).toHaveBeenCalledWith(JSON.stringify(report, null, 2));
});

it("fails fast when the CLI is missing MONGO_URI", async () => {
  await expect(runBackfillCli([], { log: jest.fn(), error: jest.fn() })).rejects.toThrow(
    "Missing MONGO_URI variable"
  );
});
