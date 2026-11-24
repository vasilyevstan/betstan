import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  IEventOddsSelectedEvent,
  LiveMarketType,
  SlipStatus,
  messengerWrapper,
} from "@betstan/common";
import OddsClickedListener from "../OddsClickedListener";
import {
  Slip,
  SLIP_DRAFT_UNIQUE_INDEX_KEYS,
  SLIP_DRAFT_UNIQUE_INDEX_NAME,
  SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
} from "../../../model/Slip";

const buildMessage = (): ConsumeMessage => ({
  content: Buffer.alloc(5),
  fields: {
    consumerTag: "",
    deliveryTag: 0,
    redelivered: false,
    exchange: "",
    routingKey: "",
  },
  properties: {
    contentType: undefined,
    contentEncoding: undefined,
    headers: {},
    deliveryMode: undefined,
    priority: undefined,
    correlationId: undefined,
    replyTo: undefined,
    expiration: undefined,
    messageId: undefined,
    timestamp: undefined,
    type: undefined,
    userId: undefined,
    appId: undefined,
    clusterId: undefined,
  },
});

const buildEvent = (
  userId: string,
  overrides: Partial<IEventOddsSelectedEvent["data"]> = {}
): IEventOddsSelectedEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    userId,
    eventId: new mongoose.Types.ObjectId().toHexString(),
    eventName: "Team A - Team B",
    oddsId: new mongoose.Types.ObjectId().toHexString(),
    oddsValue: 1.5,
    oddsName: "Team A",
    productName: "1X2",
    productId: new mongoose.Types.ObjectId().toHexString(),
    ...overrides,
  },
});

const createSubmittedSlip = async (userId: string, betKind: BetKind) => {
  const slip = new Slip({
    userId,
    betKind,
    status: SlipStatus.SUBMITTED,
    timestamp: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
        betKind,
        ...(betKind === BetKind.LIVE
          ? {
              marketId: "event-one:NEXT_CORNER",
              marketVersion: 1,
              quoteVersion: 1,
              selectionId: "event-one:NEXT_CORNER:1:HOME",
            }
          : {}),
      },
    ],
  });

  await slip.save();
  return slip;
};

const createGuardedDraftIndex = () =>
  Slip.collection.createIndex(SLIP_DRAFT_UNIQUE_INDEX_KEYS, {
    name: SLIP_DRAFT_UNIQUE_INDEX_NAME,
    unique: true,
    partialFilterExpression: SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
  });

it("creates a new PRE_MATCH draft slip when betKind is missing", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(buildEvent(userId), buildMessage());

  const slip = await Slip.findOne({ userId, status: SlipStatus.DRAFT });
  expect(slip).not.toBeNull();
  expect(slip!.betKind).toEqual(BetKind.PRE_MATCH);
  expect(slip!.rows.length).toEqual(1);
  expect(slip!.rows[0].betKind).toEqual(BetKind.PRE_MATCH);
});

it("keeps PRE_MATCH and LIVE boards separate for the same user", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(buildEvent(userId), buildMessage());
  await listener.onMessage(
    buildEvent(userId, {
      betKind: BetKind.LIVE,
      marketId: "event-one:NEXT_CORNER",
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: "event-one:NEXT_CORNER:1:HOME",
    }),
    buildMessage()
  );

  const slips = await Slip.find({ userId, status: SlipStatus.DRAFT });
  expect(slips).toHaveLength(2);
  expect(slips.map((slip) => slip.betKind).sort()).toEqual([
    BetKind.LIVE,
    BetKind.PRE_MATCH,
  ]);
});

it("coalesces simultaneous PRE_MATCH clicks into one shared draft", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();
  await createGuardedDraftIndex();

  await Promise.all([
    listener.onMessage(buildEvent(userId), buildMessage()),
    listener.onMessage(buildEvent(userId), buildMessage()),
  ]);

  const slips = await Slip.find({
    userId,
    status: SlipStatus.DRAFT,
  });
  expect(slips).toHaveLength(1);
  expect(slips[0].betKind).toEqual(BetKind.PRE_MATCH);
  expect(slips[0].rows).toHaveLength(2);
});

it("retains five LIVE markets from each of two events under concurrent delivery", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  const eventIds = ["event-one", "event-two"];
  const marketTypes = [
    LiveMarketType.NEXT_YELLOW_CARD,
    LiveMarketType.NEXT_RED_CARD,
    LiveMarketType.NEXT_CORNER,
    LiveMarketType.NEXT_PENALTY,
    LiveMarketType.HALF_TIME_RESULT,
  ];
  await listener.init();
  await createGuardedDraftIndex();

  await Promise.all(eventIds.flatMap((eventId) => (
    marketTypes.map((marketType) => {
      const marketId = `${eventId}:${marketType}`;
      return listener.onMessage(
        buildEvent(userId, {
          eventId,
          eventName: `${eventId}-home - ${eventId}-away`,
          betKind: BetKind.LIVE,
          marketId,
          marketType,
          marketVersion: 1,
          quoteVersion: 1,
          selectionId: `${marketId}:1:HOME`,
          oddsId: `${marketId}:HOME`,
          productId: marketId,
          productName: marketType,
        }),
        buildMessage()
      );
    })
  )));

  const slips = await Slip.find({
    userId,
    status: SlipStatus.DRAFT,
    betKind: BetKind.LIVE,
  });
  expect(slips).toHaveLength(1);
  expect(slips[0].rows).toHaveLength(10);
  expect(new Set(slips[0].rows.map((row) => row.marketId))).toEqual(
    new Set(eventIds.flatMap((eventId) => (
      marketTypes.map((marketType) => `${eventId}:${marketType}`)
    )))
  );
});

it("appends a row to an existing draft board of the same kind", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(buildEvent(userId), buildMessage());
  await listener.onMessage(buildEvent(userId), buildMessage());

  const slip = await Slip.findOne({
    userId,
    status: SlipStatus.DRAFT,
    betKind: BetKind.PRE_MATCH,
  });
  expect(slip!.rows.length).toEqual(2);
});

it("does not add duplicate odds to the same board", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent(userId);
  await listener.onMessage(event, buildMessage());
  await listener.onMessage(event, buildMessage());

  const slip = await Slip.findOne({ userId, status: SlipStatus.DRAFT });
  expect(slip!.rows.length).toEqual(1);
});

it("updates the legacy PRE_MATCH draft instead of creating a parallel normalized board", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const legacySlipId = new mongoose.Types.ObjectId();
  const legacyOddsId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  await Slip.collection.insertOne({
    _id: legacySlipId,
    userId,
    status: SlipStatus.DRAFT,
    timestamp: new Date().toISOString(),
    rows: [
      {
        _id: new mongoose.Types.ObjectId(),
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: legacyOddsId,
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
      },
    ],
  });

  await listener.onMessage(buildEvent(userId), buildMessage());

  const slips = await Slip.find({
    userId,
    status: SlipStatus.DRAFT,
  });
  expect(slips).toHaveLength(1);
  expect(slips[0].id).toEqual(legacySlipId.toHexString());
  expect(slips[0].betKind).toEqual(BetKind.PRE_MATCH);
  expect(slips[0].rows).toHaveLength(2);
  expect(slips[0].rows[0].betKind).toEqual(BetKind.PRE_MATCH);
});

it("replaces a LIVE row by market identity even when the replacement quote is stale", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const initialEvent = buildEvent(userId, {
    betKind: BetKind.LIVE,
    marketId: "event-one:NEXT_CORNER",
    marketVersion: 2,
    quoteVersion: 5,
    selectionId: "event-one:NEXT_CORNER:2:HOME",
    oddsId: "odds-home",
    oddsValue: 1.5,
    oddsName: "Home",
  });
  const replacementEvent = buildEvent(userId, {
    betKind: BetKind.LIVE,
    marketId: "event-one:NEXT_CORNER",
    marketVersion: 2,
    quoteVersion: 4,
    selectionId: "event-one:NEXT_CORNER:2:AWAY",
    oddsId: "odds-away",
    oddsValue: 2.4,
    oddsName: "Away",
  });

  await listener.onMessage(initialEvent, buildMessage());
  await listener.onMessage(replacementEvent, buildMessage());

  const slip = await Slip.findOne({
    userId,
    status: SlipStatus.DRAFT,
    betKind: BetKind.LIVE,
  });

  expect(slip!.rows).toHaveLength(1);
  expect(slip!.rows[0].oddsId).toEqual("odds-away");
  expect(slip!.rows[0].quoteVersion).toEqual(4);
  expect(slip!.rows[0].oddsValue).toEqual(2.4);
});

it("replaces a LIVE row when the same market rolls to a new version", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(
    buildEvent(userId, {
      betKind: BetKind.LIVE,
      marketId: "event-one:NEXT_CORNER",
      marketVersion: 1,
      quoteVersion: 3,
      selectionId: "event-one:NEXT_CORNER:1:HOME",
      oddsId: "version-one-odds",
    }),
    buildMessage()
  );
  await listener.onMessage(
    buildEvent(userId, {
      betKind: BetKind.LIVE,
      marketId: "event-one:NEXT_CORNER",
      marketVersion: 2,
      quoteVersion: 1,
      selectionId: "event-one:NEXT_CORNER:2:AWAY",
      oddsId: "version-two-odds",
      oddsValue: 2.2,
      oddsName: "Away",
    }),
    buildMessage()
  );

  const slip = await Slip.findOne({
    userId,
    status: SlipStatus.DRAFT,
    betKind: BetKind.LIVE,
  });
  expect(slip!.rows).toHaveLength(1);
  expect(slip!.rows[0].marketId).toEqual("event-one:NEXT_CORNER");
  expect(slip!.rows[0].marketVersion).toEqual(2);
  expect(slip!.rows[0].quoteVersion).toEqual(1);
  expect(slip!.rows[0].selectionId).toEqual("event-one:NEXT_CORNER:2:AWAY");
  expect(slip!.rows[0].oddsId).toEqual("version-two-odds");
});

it("ignores same-kind selections while that board is submitted", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const submittedSlip = await createSubmittedSlip(userId, BetKind.LIVE);

  await listener.onMessage(
    buildEvent(userId, {
      betKind: BetKind.LIVE,
      marketId: "event-one:NEXT_CORNER",
      marketVersion: 2,
      quoteVersion: 1,
      selectionId: "event-one:NEXT_CORNER:2:HOME",
    }),
    buildMessage()
  );

  expect(await Slip.countDocuments({ userId, betKind: BetKind.LIVE })).toEqual(1);
  expect(
    await Slip.findOne({
      userId,
      betKind: BetKind.LIVE,
      status: SlipStatus.DRAFT,
    })
  ).toBeNull();
  expect(await Slip.findById(submittedSlip.id)).not.toBeNull();
});

it("updates an existing replacement draft while the submitted board still exists", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const submittedSlip = await createSubmittedSlip(userId, BetKind.LIVE);
  const draftEvent = buildEvent(userId, {
    betKind: BetKind.LIVE,
    marketId: "event-one:NEXT_CORNER",
    marketVersion: 1,
    quoteVersion: 1,
    selectionId: "event-one:NEXT_CORNER:1:HOME",
    oddsId: "draft-odds",
  });
  const nextEvent = buildEvent(userId, {
    betKind: BetKind.LIVE,
    marketId: "event-two:NEXT_CORNER",
    marketVersion: 1,
    quoteVersion: 1,
    selectionId: "event-two:NEXT_CORNER:1:AWAY",
    oddsId: "next-odds",
    oddsName: "Away",
    oddsValue: 2.1,
  });
  const { userId: _ignoredUserId, ...draftRow } = draftEvent.data;

  const replacementDraft = await Slip.create({
    userId,
    betKind: BetKind.LIVE,
    draftKey: BetKind.LIVE,
    status: SlipStatus.DRAFT,
    sourceSlipId: submittedSlip.id,
    timestamp: new Date().toISOString(),
    rows: [{
      timestamp: draftEvent.timestamp,
      ...draftRow,
    }],
  });

  await listener.onMessage(nextEvent, buildMessage());

  const refreshedDraft = await Slip.findById(replacementDraft.id);
  expect(refreshedDraft!.rows).toHaveLength(2);
  expect(refreshedDraft!.rows.map((row) => row.oddsId).sort()).toEqual([
    'draft-odds',
    'next-odds',
  ]);
  expect((await Slip.findById(submittedSlip.id))!.rows).toHaveLength(1);
  expect(
    await Slip.countDocuments({
      userId,
      betKind: BetKind.LIVE,
      status: SlipStatus.DRAFT,
    })
  ).toEqual(1);
});

it("acks message without creating slip when userId is missing", async () => {
  const listener = new OddsClickedListener(messengerWrapper.connection);
  await listener.init();

  const event = buildEvent("");
  await listener.onMessage(event, buildMessage());

  expect(await Slip.find({})).toHaveLength(0);
});

it("reports exactly once for the first draft insert and not for ordinary updates", async () => {
  const telemetry = {
    initialize: jest.fn().mockResolvedValue(undefined),
    reportSlipCreated: jest.fn(),
  };
  const listener = new OddsClickedListener(
    messengerWrapper.connection,
    telemetry
  );
  const userId = new mongoose.Types.ObjectId().toHexString();
  await listener.init();

  await listener.onMessage(buildEvent(userId), buildMessage());
  await listener.onMessage(buildEvent(userId), buildMessage());

  expect(telemetry.initialize).toHaveBeenCalledTimes(1);
  expect(telemetry.reportSlipCreated).toHaveBeenCalledTimes(1);
});

it("still acknowledges the source event when telemetry publishing fails", async () => {
  const telemetry = {
    initialize: jest.fn().mockResolvedValue(undefined),
    reportSlipCreated: jest.fn(() => {
      throw new Error("telemetry unavailable");
    }),
  };
  const listener = new OddsClickedListener(
    messengerWrapper.connection,
    telemetry
  );
  const ack = jest.spyOn(listener, "ack");
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const msg = buildMessage();
  await listener.init();

  await expect(
    listener.onMessage(
      buildEvent(new mongoose.Types.ObjectId().toHexString()),
      msg
    )
  ).resolves.toBeUndefined();

  expect(telemetry.reportSlipCreated).toHaveBeenCalledTimes(1);
  expect(ack).toHaveBeenCalledWith(msg);
  expect(error).toHaveBeenCalledWith("slip_telemetry_publish_failed");
});

it("does not await optional telemetry initialization and contains its rejection", async () => {
  let rejectInitialization!: (error: Error) => void;
  const initialization = new Promise<void>((_resolve, reject) => {
    rejectInitialization = reject;
  });
  const telemetry = {
    initialize: jest.fn(() => initialization),
    reportSlipCreated: jest.fn(),
  };
  const listener = new OddsClickedListener(
    messengerWrapper.connection,
    telemetry
  );
  const error = jest.spyOn(console, "error").mockImplementation(() => {});

  const outcome = await Promise.race([
    listener.init().then(() => "ready"),
    new Promise<"blocked">((resolve) =>
      setTimeout(() => resolve("blocked"), 100)
    ),
  ]);

  expect(outcome).toBe("ready");
  expect(telemetry.initialize).toHaveBeenCalledTimes(1);

  rejectInitialization(new Error("private telemetry failure"));
  await new Promise((resolve) => setImmediate(resolve));
  expect(error).toHaveBeenCalledWith("slip_telemetry_disabled");
  expect(JSON.stringify(error.mock.calls)).not.toContain(
    "private telemetry failure"
  );
});

describe("guest selections", () => {
  // The event service publishes "guest:" + the SHA-256 hex digest of the cookie
  // value, never the cookie value itself.
  const guestDigest =
    "3eb1bd439947eb762998e566ccc2e099c791118b2f40579cc4f7da2b5061b7f9";
  const rawCookieValue = "0123456789abcdef0123456789abcdef";
  const guestPrincipal = `guest:${guestDigest}`;
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;

  const buildLiveEvent = (
    userId: string,
    index: number,
    overrides: Partial<IEventOddsSelectedEvent["data"]> = {}
  ) => {
    const marketId = `event-live:MARKET_${index}`;

    return buildEvent(userId, {
      eventId: "event-live",
      betKind: BetKind.LIVE,
      marketId,
      marketType: LiveMarketType.NEXT_CORNER,
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: `${marketId}:1:HOME`,
      oddsId: `${marketId}:HOME`,
      ...overrides,
    });
  };

  const seedGuestLiveDraft = async (rowCount: number) => {
    const timestamp = new Date().toISOString();

    await Slip.collection.insertOne({
      userId: guestPrincipal,
      status: SlipStatus.DRAFT,
      betKind: BetKind.LIVE,
      draftKey: BetKind.LIVE,
      timestamp,
      boardRevision: 1,
      boardFingerprint: "seed-fingerprint",
      rows: Array.from({ length: rowCount }, (_value, index) => ({
        _id: new mongoose.Types.ObjectId(),
        eventId: "event-live",
        eventName: "Team A - Team B",
        oddsId: `event-live:MARKET_${index}:HOME`,
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "NEXT_CORNER",
        productId: `event-live:MARKET_${index}`,
        timestamp,
        betKind: BetKind.LIVE,
        marketId: `event-live:MARKET_${index}`,
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: 1,
        quoteVersion: 1,
        selectionId: `event-live:MARKET_${index}:1:HOME`,
      })),
    });
  };

  const guestDrafts = (betKind: BetKind) =>
    Slip.find({
      userId: guestPrincipal,
      status: SlipStatus.DRAFT,
      betKind,
    }).lean();

  it("stores a guest selection under the guest principal with a 30 day expiry", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    const ack = jest.spyOn(listener, "ack");
    const msg = buildMessage();
    await listener.init();

    const before = Date.now();
    await listener.onMessage(buildEvent(guestPrincipal), msg);
    const after = Date.now();

    const drafts = await Slip.find({ userId: guestPrincipal }).lean();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toEqual(SlipStatus.DRAFT);
    expect(drafts[0].betKind).toEqual(BetKind.PRE_MATCH);
    expect(drafts[0].rows).toHaveLength(1);
    expect(drafts[0].guestExpiresAt).toBeInstanceOf(Date);
    const expiresAt = drafts[0].guestExpiresAt!.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + thirtyDaysMs);
    expect(expiresAt).toBeLessThanOrEqual(after + thirtyDaysMs);
    expect(ack).toHaveBeenCalledWith(msg);
  });

  it("stores the published principal verbatim and nothing derived from the raw cookie value", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    await listener.init();

    await listener.onMessage(buildEvent(guestPrincipal), buildMessage());

    const stored = await Slip.collection.find({}).toArray();
    expect(stored.map((slip) => slip.userId)).toEqual([guestPrincipal]);
    expect(JSON.stringify(stored)).not.toContain(rawCookieValue);
  });

  it("keeps a guest's PRE_MATCH and LIVE drafts separate", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    await listener.init();

    await listener.onMessage(buildEvent(guestPrincipal), buildMessage());
    await listener.onMessage(buildLiveEvent(guestPrincipal, 1), buildMessage());

    expect(await guestDrafts(BetKind.PRE_MATCH)).toHaveLength(1);
    expect(await guestDrafts(BetKind.LIVE)).toHaveLength(1);
  });

  it("refreshes the expiry on every guest write", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    await listener.init();
    const event = buildEvent(guestPrincipal);
    await listener.onMessage(event, buildMessage());

    const nearExpiry = new Date(Date.now() + 60_000);
    await Slip.collection.updateOne(
      { userId: guestPrincipal },
      { $set: { guestExpiresAt: nearExpiry } }
    );

    await listener.onMessage(event, buildMessage());

    const [draft] = await Slip.find({ userId: guestPrincipal }).lean();
    expect(draft.rows).toHaveLength(1);
    expect(draft.guestExpiresAt!.getTime()).toBeGreaterThan(
      Date.now() + thirtyDaysMs - 60_000
    );
  });

  it("applies the user draft rules to guest clicks: duplicates are no-ops and a LIVE market is replaced", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    await listener.init();

    const duplicate = buildEvent(guestPrincipal);
    await listener.onMessage(duplicate, buildMessage());
    const [afterFirst] = await guestDrafts(BetKind.PRE_MATCH);
    await listener.onMessage(duplicate, buildMessage());
    const [afterDuplicate] = await guestDrafts(BetKind.PRE_MATCH);

    expect(afterDuplicate.rows).toHaveLength(1);
    expect(afterDuplicate.boardRevision).toEqual(afterFirst.boardRevision);
    expect(afterDuplicate.boardFingerprint).toEqual(
      afterFirst.boardFingerprint
    );

    await listener.onMessage(buildLiveEvent(guestPrincipal, 1), buildMessage());
    await listener.onMessage(
      buildLiveEvent(guestPrincipal, 1, {
        oddsId: "event-live:MARKET_1:AWAY",
        selectionId: "event-live:MARKET_1:1:AWAY",
        oddsValue: 2.25,
      }),
      buildMessage()
    );

    const [liveDraft] = await guestDrafts(BetKind.LIVE);
    expect(liveDraft.rows).toHaveLength(1);
    expect(liveDraft.rows[0].oddsValue).toEqual(2.25);
    expect(liveDraft.rows[0].selectionId).toEqual("event-live:MARKET_1:1:AWAY");
  });

  it("coalesces simultaneous guest clicks into one shared draft", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    await listener.init();
    await createGuardedDraftIndex();

    await Promise.all([
      listener.onMessage(buildEvent(guestPrincipal), buildMessage()),
      listener.onMessage(buildEvent(guestPrincipal), buildMessage()),
    ]);

    const drafts = await guestDrafts(BetKind.PRE_MATCH);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].rows).toHaveLength(2);
  });

  it("drops a click that would add a row beyond 50 and still updates an existing market", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    const ack = jest.spyOn(listener, "ack");
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await listener.init();
    await seedGuestLiveDraft(49);

    await listener.onMessage(buildLiveEvent(guestPrincipal, 49), buildMessage());
    const [full] = await guestDrafts(BetKind.LIVE);
    expect(full.rows).toHaveLength(50);

    const overflow = buildMessage();
    await listener.onMessage(buildLiveEvent(guestPrincipal, 50), overflow);

    const [afterOverflow] = await guestDrafts(BetKind.LIVE);
    expect(afterOverflow.rows).toHaveLength(50);
    expect(
      afterOverflow.rows.some((row) => row.marketId === "event-live:MARKET_50")
    ).toBe(false);
    expect(afterOverflow.boardRevision).toEqual(full.boardRevision);
    expect(afterOverflow.boardFingerprint).toEqual(full.boardFingerprint);
    expect(ack).toHaveBeenCalledWith(overflow);
    expect(warn).toHaveBeenCalledWith(
      "slip_selection_not_applied_review_current_board"
    );

    await listener.onMessage(
      buildLiveEvent(guestPrincipal, 3, {
        oddsId: "event-live:MARKET_3:AWAY",
        selectionId: "event-live:MARKET_3:1:AWAY",
        oddsValue: 3.1,
      }),
      buildMessage()
    );

    const [afterUpdate] = await guestDrafts(BetKind.LIVE);
    expect(afterUpdate.rows).toHaveLength(50);
    expect(
      afterUpdate.rows.find((row) => row.marketId === "event-live:MARKET_3")
    ).toMatchObject({ oddsValue: 3.1, oddsId: "event-live:MARKET_3:AWAY" });
    expect(afterUpdate.boardRevision).toBeGreaterThan(full.boardRevision!);

    await listener.onMessage(buildEvent(guestPrincipal), buildMessage());
    expect(await guestDrafts(BetKind.PRE_MATCH)).toHaveLength(1);
    warn.mockRestore();
  });

  it("never lets simultaneous guest clicks exceed the cap", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await listener.init();
    await seedGuestLiveDraft(45);

    await Promise.all(
      Array.from({ length: 12 }, (_value, index) =>
        listener.onMessage(
          buildLiveEvent(guestPrincipal, 100 + index),
          buildMessage()
        )
      )
    );

    const [draft] = await guestDrafts(BetKind.LIVE);
    expect(draft.rows).toHaveLength(50);
    warn.mockRestore();
  });

  it("reports SLIP_CREATED for a new user draft but never for a guest draft", async () => {
    const telemetry = {
      initialize: jest.fn().mockResolvedValue(undefined),
      reportSlipCreated: jest.fn(),
    };
    const listener = new OddsClickedListener(
      messengerWrapper.connection,
      telemetry
    );
    await listener.init();

    await listener.onMessage(buildEvent(guestPrincipal), buildMessage());
    await listener.onMessage(buildLiveEvent(guestPrincipal, 1), buildMessage());
    expect(telemetry.reportSlipCreated).not.toHaveBeenCalled();

    const userId = new mongoose.Types.ObjectId().toHexString();
    await listener.onMessage(buildEvent(userId), buildMessage());
    expect(telemetry.reportSlipCreated).toHaveBeenCalledTimes(1);

    const userDraft = await Slip.collection.findOne({ userId });
    expect(userDraft).not.toBeNull();
    expect(userDraft).not.toHaveProperty("guestExpiresAt");
  });

  it("still drops and acknowledges an empty userId", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    const ack = jest.spyOn(listener, "ack");
    const msg = buildMessage();
    await listener.init();

    await listener.onMessage(buildEvent(""), msg);

    expect(await Slip.countDocuments({})).toEqual(0);
    expect(ack).toHaveBeenCalledWith(msg);
  });

  it.each([
    ["only the prefix", "guest:"],
    ["a short digest", `guest:${guestDigest.slice(1)}`],
    ["a long digest", `guest:${guestDigest}0`],
    ["an uppercase digest", `guest:${guestDigest.toUpperCase()}`],
    ["a non-hex digest", `guest:${"z".repeat(64)}`],
    ["a trailing newline", `guest:${guestDigest}\n`],
    [
      "an embedded separator",
      `guest:${guestDigest.slice(0, 32)}:${guestDigest.slice(32)}`,
    ],
    ["the raw 32 character cookie value", `guest:${rawCookieValue}`],
  ])("drops and acknowledges a malformed guest principal: %s", async (_name, userId) => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    const ack = jest.spyOn(listener, "ack");
    const msg = buildMessage();
    await listener.init();

    await listener.onMessage(buildEvent(userId), msg);

    expect(await Slip.countDocuments({})).toEqual(0);
    expect(ack).toHaveBeenCalledWith(msg);
  });

  it("keeps treating other non-empty ids as ordinary users", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    await listener.init();

    await listener.onMessage(buildEvent("Guest:not-a-guest"), buildMessage());

    const draft = await Slip.collection.findOne({ userId: "Guest:not-a-guest" });
    expect(draft).not.toBeNull();
    expect(draft).not.toHaveProperty("guestExpiresAt");
  });

  it("drops a guest selection that carries a custom market quote", async () => {
    const listener = new OddsClickedListener(messengerWrapper.connection);
    const ack = jest.spyOn(listener, "ack");
    const msg = buildMessage();
    await listener.init();

    await listener.onMessage(
      buildEvent(guestPrincipal, {
        marketBet: { quoteId: "quote-1" } as never,
      }),
      msg
    );

    expect(await Slip.countDocuments({})).toEqual(0);
    expect(ack).toHaveBeenCalledWith(msg);
  });
});
