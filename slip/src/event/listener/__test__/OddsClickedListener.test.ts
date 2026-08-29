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
