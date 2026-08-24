import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  IModerationResultEvent,
  LiveMarketStatus,
  ModerationDeclineReason,
  ModerationStatus,
  SlipStatus,
  messengerWrapper,
} from "@betstan/common";
import ModerationResultListener from "../ModerationResultListener";
import { Slip, SlipArchive } from "../../../model/Slip";
import { SlipPublicationState } from "../../../model/SlipPublicationState";

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

const buildRow = (betKind: BetKind = BetKind.PRE_MATCH) => ({
  _id: new mongoose.Types.ObjectId(),
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
});

const createSubmittedSlip = async (
  userId: string,
  betKind: BetKind,
  rows = [buildRow(betKind)],
  publication: Record<string, unknown> = {
    state: SlipPublicationState.PUBLISHED,
    attemptCount: 1,
    publishedAt: new Date().toISOString(),
  }
) => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const slip = new Slip({
    _id: slipId,
    userId,
    betKind,
    status: SlipStatus.SUBMITTED,
    timestamp: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    submittedEvent: {
      userId,
      userName: `${userId}@example.com`,
      slipId,
      wager: 5,
      rows: rows.map((row) => ({
        eventId: row.eventId,
        eventName: row.eventName,
        oddsId: row.oddsId,
        oddsValue: row.oddsValue,
        oddsName: row.oddsName,
        productName: row.productName,
        productId: row.productId,
        timestamp: row.timestamp,
        id: row._id.toHexString(),
        betKind: row.betKind,
        marketId: row.marketId,
        marketVersion: row.marketVersion,
        quoteVersion: row.quoteVersion,
        selectionId: row.selectionId,
      })),
      betKind,
    },
    publication,
    rows,
  });

  await slip.save();
  return slip;
};

const buildEvent = (
  overrides: Partial<IModerationResultEvent["data"]>
): IModerationResultEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    slipId: new mongoose.Types.ObjectId().toHexString(),
    result: ModerationStatus.APPROVED,
    ...overrides,
  },
});

it("approves only the targeted submitted slip and normalizes legacy PRE_MATCH documents", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const legacySlipId = new mongoose.Types.ObjectId();
  await Slip.collection.insertOne({
    _id: legacySlipId,
    userId,
    status: SlipStatus.SUBMITTED,
    timestamp: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
    rows: [
      {
        _id: new mongoose.Types.ObjectId(),
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
      },
    ],
  });
  const siblingLiveSlip = await createSubmittedSlip(userId, BetKind.LIVE);

  await listener.onMessage(
    buildEvent({
      slipId: legacySlipId.toHexString(),
      result: ModerationStatus.APPROVED,
    }),
    buildMessage()
  );

  expect(await Slip.findById(legacySlipId)).toBeNull();
  expect((await Slip.findById(siblingLiveSlip.id))!.status).toEqual(
    SlipStatus.SUBMITTED
  );

  const archivedSlip = await SlipArchive.findById(legacySlipId);
  expect(archivedSlip).not.toBeNull();
  expect(archivedSlip!.status).toEqual(SlipStatus.COMPLETE);
  expect(archivedSlip!.betKind).toEqual(BetKind.PRE_MATCH);
  expect(archivedSlip!.rows[0].betKind).toEqual(BetKind.PRE_MATCH);
});

it("approves a pending unknown-delivery submission without waiting for publication confirmation", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const pendingSlip = await createSubmittedSlip(
    userId,
    BetKind.LIVE,
    [buildRow(BetKind.LIVE)],
    {
      state: SlipPublicationState.PENDING,
      attemptCount: 1,
      nextAttemptAt: new Date().toISOString(),
      lastError: "Publish confirm timed out",
    }
  );

  await listener.onMessage(
    buildEvent({
      slipId: pendingSlip.id,
      result: ModerationStatus.APPROVED,
      betKind: BetKind.LIVE,
    }),
    buildMessage()
  );

  expect(await Slip.findById(pendingSlip.id)).toBeNull();
  const archivedSlip = await SlipArchive.findById(pendingSlip.id);
  expect(archivedSlip).not.toBeNull();
  expect(archivedSlip!.status).toEqual(SlipStatus.COMPLETE);
  expect(archivedSlip!.publication?.state).toEqual(SlipPublicationState.PENDING);
});

it("declines only the targeted LIVE board, preserves the attempt, and restores a new draft", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const siblingPreMatchSlip = await createSubmittedSlip(userId, BetKind.PRE_MATCH);
  const liveSlip = await createSubmittedSlip(userId, BetKind.LIVE, [
    buildRow(BetKind.LIVE),
    buildRow(BetKind.LIVE),
  ]);
  const affectedRow = liveSlip.rows[0];

  await listener.onMessage(
    buildEvent({
      slipId: liveSlip.id,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
      affectedRows: [
        {
          rowId: affectedRow.id,
          declineReason: ModerationDeclineReason.STALE_QUOTE,
          marketId: affectedRow.marketId ?? undefined,
          marketVersion: affectedRow.marketVersion ?? undefined,
          quoteVersion: (affectedRow.quoteVersion ?? 1) + 1,
          currentOdds: 2.1,
          marketStatus: LiveMarketStatus.OPEN,
          selectionId: affectedRow.selectionId ?? undefined,
        },
      ],
    }),
    buildMessage()
  );

  expect(await Slip.findById(liveSlip.id)).toBeNull();

  const archivedLiveSlip = await SlipArchive.findById(liveSlip.id);
  expect(archivedLiveSlip).not.toBeNull();
  expect(archivedLiveSlip!.status).toEqual(SlipStatus.SUBMITTED);
  expect(archivedLiveSlip!.replacementSlipId).toBeDefined();

  const restoredLiveSlip = await Slip.findOne({
    userId,
    betKind: BetKind.LIVE,
    status: SlipStatus.DRAFT,
    sourceSlipId: liveSlip.id,
  });
  expect(restoredLiveSlip).not.toBeNull();
  expect(restoredLiveSlip!.id).toEqual(archivedLiveSlip!.replacementSlipId);
  expect(restoredLiveSlip!.id).not.toEqual(liveSlip.id);
  expect(restoredLiveSlip!.submittedAt).toBeUndefined();
  expect(restoredLiveSlip!.declineReason).toEqual(
    ModerationDeclineReason.STALE_QUOTE
  );
  expect(restoredLiveSlip!.rows[0].moderation).toEqual(
    expect.objectContaining({
      rowId: affectedRow.id,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
      quoteVersion: (affectedRow.quoteVersion ?? 1) + 1,
      currentOdds: 2.1,
      marketStatus: LiveMarketStatus.OPEN,
    })
  );
  expect(restoredLiveSlip!.rows[1].moderation ?? undefined).toBeUndefined();

  const unchangedPreMatchSlip = await Slip.findById(siblingPreMatchSlip.id);
  expect(unchangedPreMatchSlip!.status).toEqual(SlipStatus.SUBMITTED);
});

it("merges a declined LIVE attempt into an existing draft of the same kind", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const submittedRows = [
    {
      ...buildRow(BetKind.LIVE),
      oddsId: 'submitted-home',
      selectionId: 'event-one:NEXT_CORNER:1:HOME',
    },
    {
      ...buildRow(BetKind.LIVE),
      marketId: 'event-three:NEXT_CORNER',
      oddsId: 'submitted-extra',
      selectionId: 'event-three:NEXT_CORNER:1:AWAY',
    },
  ];
  const submittedSlip = await createSubmittedSlip(userId, BetKind.LIVE, submittedRows);
  const existingDraft = await Slip.create({
    userId,
    status: SlipStatus.DRAFT,
    betKind: BetKind.LIVE,
    draftKey: BetKind.LIVE,
    timestamp: new Date().toISOString(),
    rows: [
      {
        ...buildRow(BetKind.LIVE),
        oddsId: 'existing-home',
        oddsName: 'Away',
        oddsValue: 2.4,
        quoteVersion: 3,
        selectionId: 'event-one:NEXT_CORNER:1:AWAY',
      },
      {
        ...buildRow(BetKind.LIVE),
        marketId: 'event-two:NEXT_CORNER',
        oddsId: 'draft-extra',
        selectionId: 'event-two:NEXT_CORNER:1:HOME',
      },
    ],
  });
  const affectedRow = submittedSlip.rows[0];

  await listener.onMessage(
    buildEvent({
      slipId: submittedSlip.id,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
      affectedRows: [
        {
          rowId: affectedRow.id,
          declineReason: ModerationDeclineReason.STALE_QUOTE,
          marketId: affectedRow.marketId ?? undefined,
          marketVersion: affectedRow.marketVersion ?? undefined,
          quoteVersion: (affectedRow.quoteVersion ?? 1) + 1,
          currentOdds: 2.1,
          marketStatus: LiveMarketStatus.OPEN,
          selectionId: affectedRow.selectionId ?? undefined,
        },
      ],
    }),
    buildMessage()
  );

  const mergedDraft = await Slip.findById(existingDraft.id);
  const archivedDeclinedSlip = await SlipArchive.findById(submittedSlip.id);

  expect(mergedDraft).not.toBeNull();
  expect(mergedDraft!.sourceSlipId).toEqual(submittedSlip.id);
  expect(mergedDraft!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
  expect(mergedDraft!.rows.map((row) => row.oddsId).sort()).toEqual([
    'draft-extra',
    'existing-home',
    'submitted-extra',
  ]);
  expect(mergedDraft!.rows.every((row) => row.betKind === BetKind.LIVE)).toBe(true);
  expect(archivedDeclinedSlip!.replacementSlipId).toEqual(existingDraft.id);
  expect(await Slip.findById(submittedSlip.id)).toBeNull();
});

it("treats duplicate decline delivery as idempotent for the restored draft", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const liveSlip = await createSubmittedSlip(userId, BetKind.LIVE, [
    buildRow(BetKind.LIVE),
  ]);
  const affectedRow = liveSlip.rows[0];
  const declineEvent = buildEvent({
    slipId: liveSlip.id,
    result: ModerationStatus.DECLINED,
    betKind: BetKind.LIVE,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    affectedRows: [
      {
        rowId: affectedRow.id,
        declineReason: ModerationDeclineReason.STALE_QUOTE,
        marketId: affectedRow.marketId ?? undefined,
        marketVersion: affectedRow.marketVersion ?? undefined,
        quoteVersion: (affectedRow.quoteVersion ?? 1) + 1,
        currentOdds: 2.1,
        marketStatus: LiveMarketStatus.OPEN,
        selectionId: affectedRow.selectionId ?? undefined,
      },
    ],
  });

  await listener.onMessage(declineEvent, buildMessage());

  const firstRestoredDraft = await Slip.findOne({
    userId,
    betKind: BetKind.LIVE,
    status: SlipStatus.DRAFT,
    sourceSlipId: liveSlip.id,
  });
  const archivedDeclinedSlip = await SlipArchive.findById(liveSlip.id);

  await listener.onMessage(declineEvent, buildMessage());

  const drafts = await Slip.find({
    userId,
    betKind: BetKind.LIVE,
    status: SlipStatus.DRAFT,
  });
  expect(drafts).toHaveLength(1);
  expect(drafts[0].id).toEqual(firstRestoredDraft!.id);
  expect(archivedDeclinedSlip!.replacementSlipId).toEqual(firstRestoredDraft!.id);
});

it("never reverts a restored draft after it is resubmitted during decline replay", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();
  const sourceSlip = await createSubmittedSlip(userId, BetKind.LIVE, [
    buildRow(BetKind.LIVE),
  ]);
  const replacementSlip = await Slip.create({
    userId,
    status: SlipStatus.DRAFT,
    betKind: BetKind.LIVE,
    draftKey: BetKind.LIVE,
    timestamp: new Date().toISOString(),
    sourceSlipId: sourceSlip.id,
    rows: [
      {
        ...buildRow(BetKind.LIVE),
        oddsId: "replacement-selection",
      },
    ],
  });
  const declineEvent = buildEvent({
    slipId: sourceSlip.id,
    result: ModerationStatus.DECLINED,
    betKind: BetKind.LIVE,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
  });
  const originalFindOneAndUpdate =
    Slip.collection.findOneAndUpdate.bind(Slip.collection);
  const updateSpy = jest.spyOn(
    Slip.collection,
    "findOneAndUpdate"
  ) as jest.SpyInstance;

  updateSpy.mockImplementationOnce(async (...args: unknown[]) => {
    await Slip.collection.updateOne(
      { _id: replacementSlip._id },
      {
        $set: {
          status: SlipStatus.SUBMITTED,
          submittedAt: new Date().toISOString(),
        },
      }
    );
    return originalFindOneAndUpdate(...(args as Parameters<
      typeof originalFindOneAndUpdate
    >));
  });

  try {
    await listener.onMessage(declineEvent, buildMessage());
  } finally {
    updateSpy.mockRestore();
  }

  await listener.onMessage(declineEvent, buildMessage());

  const progressedReplacement = await Slip.findById(replacementSlip.id);
  expect(progressedReplacement).not.toBeNull();
  expect(progressedReplacement!.status).toEqual(SlipStatus.SUBMITTED);
  expect(progressedReplacement!.rows).toHaveLength(1);
  expect(progressedReplacement!.rows[0].oddsId).toEqual(
    "replacement-selection"
  );
  expect(
    await Slip.countDocuments({
      userId,
      betKind: BetKind.LIVE,
      status: SlipStatus.DRAFT,
    })
  ).toEqual(0);
  expect((await SlipArchive.findById(sourceSlip.id))!.replacementSlipId).toEqual(
    replacementSlip.id
  );
});

it("never resurrects a restored draft after it is archived during decline replay", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();
  const sourceSlip = await createSubmittedSlip(userId, BetKind.LIVE, [
    buildRow(BetKind.LIVE),
  ]);
  const replacementSlip = await Slip.create({
    userId,
    status: SlipStatus.DRAFT,
    betKind: BetKind.LIVE,
    draftKey: BetKind.LIVE,
    timestamp: new Date().toISOString(),
    sourceSlipId: sourceSlip.id,
    rows: [buildRow(BetKind.LIVE)],
  });
  const declineEvent = buildEvent({
    slipId: sourceSlip.id,
    result: ModerationStatus.DECLINED,
    betKind: BetKind.LIVE,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
  });
  const originalFindOneAndUpdate =
    Slip.collection.findOneAndUpdate.bind(Slip.collection);
  const updateSpy = jest.spyOn(
    Slip.collection,
    "findOneAndUpdate"
  ) as jest.SpyInstance;

  updateSpy.mockImplementationOnce(async (...args: unknown[]) => {
    const replacement = await Slip.findById(replacementSlip.id).lean();
    await SlipArchive.create({
      ...replacement,
      status: SlipStatus.COMPLETE,
    });
    await Slip.deleteOne({ _id: replacementSlip.id });
    return originalFindOneAndUpdate(...(args as Parameters<
      typeof originalFindOneAndUpdate
    >));
  });

  try {
    await listener.onMessage(declineEvent, buildMessage());
  } finally {
    updateSpy.mockRestore();
  }

  await listener.onMessage(declineEvent, buildMessage());

  expect(await Slip.findById(replacementSlip.id)).toBeNull();
  expect(await SlipArchive.findById(replacementSlip.id)).not.toBeNull();
  expect((await SlipArchive.findById(sourceSlip.id))!.replacementSlipId).toEqual(
    replacementSlip.id
  );
});

it("acks invalid ids, archived approvals, archived declines without replacement ids, and unknown results", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const channel = {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn(),
    consume: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    publish: jest.fn(),
  };
  ((messengerWrapper as any).connection.createChannel as jest.Mock).mockResolvedValueOnce(
    channel
  );
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();
  Object.defineProperty(listener, "channel", {
    configurable: true,
    get: () => channel,
  });
  const ackSpy = jest.spyOn(listener, "ack");
  const nackSpy = channel.nack;

  const archivedApprovedId = new mongoose.Types.ObjectId().toHexString();
  await SlipArchive.create({
    _id: archivedApprovedId,
    userId,
    status: SlipStatus.COMPLETE,
    betKind: BetKind.PRE_MATCH,
    draftKey: BetKind.PRE_MATCH,
    timestamp: new Date().toISOString(),
    rows: [buildRow()],
  });
  const archivedDeclinedId = new mongoose.Types.ObjectId().toHexString();
  await SlipArchive.create({
    _id: archivedDeclinedId,
    userId,
    status: SlipStatus.SUBMITTED,
    betKind: BetKind.LIVE,
    draftKey: BetKind.LIVE,
    timestamp: new Date().toISOString(),
    rows: [buildRow(BetKind.LIVE)],
  });

  await listener.onMessage(
    buildEvent({
      slipId: "not-an-object-id",
      result: ModerationStatus.APPROVED,
    }),
    buildMessage()
  );
  await listener.onMessage(
    buildEvent({
      slipId: archivedApprovedId,
      result: ModerationStatus.APPROVED,
    }),
    buildMessage()
  );
  await listener.onMessage(
    buildEvent({
      slipId: archivedDeclinedId,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
    }),
    buildMessage()
  );
  await listener.onMessage(
    buildEvent({
      slipId: archivedApprovedId,
      result: "UNKNOWN" as ModerationStatus,
    }),
    buildMessage()
  );

  expect(ackSpy).toHaveBeenCalledTimes(4);
  expect(nackSpy).not.toHaveBeenCalled();
});

it("nacks missing approvals and declines, and repairs archived replacement ids from restored drafts", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const channel = {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    assertQueue: jest.fn().mockResolvedValue(undefined),
    bindQueue: jest.fn(),
    consume: jest.fn(),
    ack: jest.fn(),
    nack: jest.fn(),
    publish: jest.fn(),
  };
  ((messengerWrapper as any).connection.createChannel as jest.Mock).mockResolvedValueOnce(
    channel
  );
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();
  Object.defineProperty(listener, "channel", {
    configurable: true,
    get: () => channel,
  });
  const ackSpy = jest.spyOn(listener, "ack");
  const nackSpy = channel.nack;

  const missingSlipId = new mongoose.Types.ObjectId().toHexString();
  await listener.onMessage(
    buildEvent({
      slipId: missingSlipId,
      result: ModerationStatus.APPROVED,
    }),
    buildMessage()
  );
  await listener.onMessage(
    buildEvent({
      slipId: new mongoose.Types.ObjectId().toHexString(),
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
    }),
    buildMessage()
  );

  const archivedSlip = await SlipArchive.create({
    userId,
    status: SlipStatus.SUBMITTED,
    betKind: BetKind.LIVE,
    draftKey: BetKind.LIVE,
    timestamp: new Date().toISOString(),
    replacementSlipId: "old-replacement-id",
    rows: [buildRow(BetKind.LIVE)],
  });
  const restoredDraft = await Slip.create({
    userId,
    status: SlipStatus.DRAFT,
    betKind: BetKind.LIVE,
    draftKey: BetKind.LIVE,
    timestamp: new Date().toISOString(),
    sourceSlipId: archivedSlip.id,
    rows: [buildRow(BetKind.LIVE)],
  });

  await listener.onMessage(
    buildEvent({
      slipId: archivedSlip.id,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
    }),
    buildMessage()
  );

  const repairedArchive = await SlipArchive.findById(archivedSlip.id);
  expect(repairedArchive!.replacementSlipId).toEqual(restoredDraft.id);
  expect(nackSpy).toHaveBeenCalledTimes(2);
  expect(ackSpy).toHaveBeenCalledTimes(1);
});

it("recreates a restored draft from an archived declined attempt with a stored replacement id", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const replacementSlipId = new mongoose.Types.ObjectId().toHexString();
  const archivedSlip = await SlipArchive.create({
    userId,
    status: SlipStatus.SUBMITTED,
    betKind: BetKind.LIVE,
    draftKey: BetKind.LIVE,
    timestamp: new Date().toISOString(),
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    replacementSlipId,
    submittedEvent: {
      userId,
      userName: `${userId}@example.com`,
      slipId: new mongoose.Types.ObjectId().toHexString(),
      wager: 10,
      rows: [
        {
          ...buildRow(BetKind.LIVE),
          id: new mongoose.Types.ObjectId().toHexString(),
        },
      ],
      betKind: BetKind.LIVE,
    },
    publication: {
      state: SlipPublicationState.PENDING,
      attemptCount: 2,
    },
    rows: [buildRow(BetKind.LIVE)],
  });

  await listener.onMessage(
    buildEvent({
      slipId: archivedSlip.id,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.STALE_QUOTE,
    }),
    buildMessage()
  );

  const restoredDraft = await Slip.findById(replacementSlipId);
  expect(restoredDraft).not.toBeNull();
  expect(restoredDraft!.status).toEqual(SlipStatus.DRAFT);
  expect(restoredDraft!.sourceSlipId).toEqual(archivedSlip.id);
  expect(restoredDraft!.submittedEvent).toBeUndefined();
  expect(restoredDraft!.publication).toBeUndefined();
});
