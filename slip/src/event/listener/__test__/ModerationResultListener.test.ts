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
  expect(restoredLiveSlip!.rows[1].moderation).toBeUndefined();

  const unchangedPreMatchSlip = await Slip.findById(siblingPreMatchSlip.id);
  expect(unchangedPreMatchSlip!.status).toEqual(SlipStatus.SUBMITTED);
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
