import mongoose from "mongoose";
import {
  BetKind,
  EventPhase,
  LiveMarketStatus,
  ModerationDeclineReason,
  ModerationStatus,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import { Bet } from "../../../model/Bet";
import { LiveEventMirror } from "../../../model/LiveEventMirror";
import { Resulted } from "../../../model/Resulted";
import PlaceBetListener from "../PlaceBetListener";
import BetModerationResultPublisher from "../../publisher/BetModerationResultPublisher";
import {
  createDeferred,
  createLiveMarket,
  createLivePlaceBetEvent,
  createLiveUpdateEvent,
  createMessage,
  createPlaceBetEvent,
} from "./helpers";

const setup = async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();
  return { listener };
};

const saveMirror = async (
  eventId: string,
  market = createLiveMarket(eventId),
  phase = EventPhase.FIRST_HALF
) => {
  await LiveEventMirror.create(
    createLiveUpdateEvent({
      eventId,
      phase,
      markets: [market],
    }).data
  );

  return market;
};

it("old PRE_MATCH payloads remain approved before kickoff", async () => {
  const { listener } = await setup();
  const message = createMessage();
  const data = createPlaceBetEvent({
    row: {
      eventTime: undefined,
    },
  });

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(savedBet!.betKind).toEqual(BetKind.PRE_MATCH);
  expect(savedBet!.affectedRows).toHaveLength(0);
  expect(listener.ack).toHaveBeenCalled();
  expect(
    BetModerationResultPublisher.prototype.publishWithConfirm
  ).toHaveBeenCalled();
});

it("publisher is initialised once during listener.init(), not on every message", async () => {
  const { listener } = await setup();

  expect(BetModerationResultPublisher.prototype.init).toHaveBeenCalledTimes(1);
  expect(
    BetModerationResultPublisher.prototype.initConfirmChannel
  ).toHaveBeenCalledTimes(1);

  jest.clearAllMocks();

  await listener.onMessage(createPlaceBetEvent(), createMessage());
  await listener.onMessage(createPlaceBetEvent(), createMessage());

  expect(BetModerationResultPublisher.prototype.init).not.toHaveBeenCalled();
  expect(
    BetModerationResultPublisher.prototype.initConfirmChannel
  ).not.toHaveBeenCalled();
});

it("mixed top-level and row kinds are declined with a stable reason", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = createLiveMarket(eventId);
  const message = createMessage();
  const data = createLivePlaceBetEvent(market, {
    data: {
      betKind: BetKind.PRE_MATCH,
    },
  });

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const publishedEvent = publishMock.mock.calls[0][0];

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(
    ModerationDeclineReason.MIXED_BET_KINDS
  );
  expect(publishedEvent.data.declineReason).toEqual(
    ModerationDeclineReason.MIXED_BET_KINDS
  );
  expect(publishedEvent.data.affectedRows).toEqual([
    {
      rowId: data.data.rows[0].id,
      declineReason: ModerationDeclineReason.MIXED_BET_KINDS,
    },
  ]);
  expect(listener.ack).toHaveBeenCalled();
});

it("PRE_MATCH rows are declined at or after kickoff", async () => {
  const { listener } = await setup();
  const pastKickoff = new Date(Date.now() - 1_000).toISOString();
  const message = createMessage();
  const data = createPlaceBetEvent({
    row: {
      timestamp: pastKickoff,
      eventTime: pastKickoff,
    },
  });

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const publishedEvent = publishMock.mock.calls[0][0];

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_STARTED);
  expect(publishedEvent.data.affectedRows).toEqual([
    {
      rowId: data.data.rows[0].id,
      declineReason: ModerationDeclineReason.EVENT_STARTED,
    },
  ]);
});

it.each([
  {
    name: "event is not live",
    reason: ModerationDeclineReason.EVENT_NOT_LIVE,
    phase: EventPhase.PRE_MATCH,
    status: LiveMarketStatus.OPEN,
  },
  {
    name: "market is suspended",
    reason: ModerationDeclineReason.MARKET_SUSPENDED,
    phase: EventPhase.FIRST_HALF,
    status: LiveMarketStatus.SUSPENDED,
  },
  {
    name: "market is closed",
    reason: ModerationDeclineReason.MARKET_CLOSED,
    phase: EventPhase.FIRST_HALF,
    status: LiveMarketStatus.CLOSED,
  },
])("live bets are declined when $name", async ({ phase, reason, status }) => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = await saveMirror(
    eventId,
    createLiveMarket(eventId, { status }),
    phase
  );
  const message = createMessage();
  const data = createLivePlaceBetEvent(market);

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const publishedEvent = publishMock.mock.calls[0][0];

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(reason);
  expect(publishedEvent.data.affectedRows[0]).toMatchObject({
    rowId: data.data.rows[0].id,
    declineReason: reason,
    marketId: market.marketId,
    marketVersion: market.marketVersion,
    quoteVersion: market.quoteVersion,
    marketStatus: status,
    selectionId: market.selections[0].selectionId,
    currentOdds: market.selections[0].odds,
  });
});

it("live bets keep the existing resulted guard", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = createLiveMarket(eventId);
  const message = createMessage();
  const data = createLivePlaceBetEvent(market);

  await Resulted.create({
    eventId,
    timestamp: new Date().toISOString(),
  });

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const publishedEvent = publishMock.mock.calls[0][0];

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_RESULTED);
  expect(publishedEvent.data.affectedRows).toEqual([
    {
      rowId: data.data.rows[0].id,
      declineReason: ModerationDeclineReason.EVENT_RESULTED,
    },
  ]);
});

it.each([
  {
    name: "market version moves on",
    rowOverrides: (market: ReturnType<typeof createLiveMarket>) => ({
      marketVersion: market.marketVersion - 1,
      quoteVersion: market.quoteVersion - 1,
      selectionId: `${market.marketId}:${market.marketVersion - 1}:${TeamSide.HOME}`,
    }),
  },
  {
    name: "quote version changes",
    rowOverrides: (market: ReturnType<typeof createLiveMarket>) => ({
      quoteVersion: market.quoteVersion - 1,
    }),
  },
  {
    name: "odds are altered",
    rowOverrides: () => ({
      oddsValue: 9.99,
    }),
  },
])("stale live quotes are declined when $name", async ({ rowOverrides }) => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = await saveMirror(eventId);
  const message = createMessage();
  const data = createLivePlaceBetEvent(market, {
    row: rowOverrides(market),
  });

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const publishedEvent = publishMock.mock.calls[0][0];

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
  expect(publishedEvent.data.affectedRows[0]).toMatchObject({
    rowId: data.data.rows[0].id,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    marketId: market.marketId,
    marketVersion: market.marketVersion,
    quoteVersion: market.quoteVersion,
    marketStatus: LiveMarketStatus.OPEN,
    selectionId: market.selections[0].selectionId,
    currentOdds: market.selections[0].odds,
  });
});

it("invalid live selections are declined with current row metadata", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = await saveMirror(eventId);
  const message = createMessage();
  const data = createLivePlaceBetEvent(market, {
    row: {
      selectionId: "invalid-selection",
    },
  });

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const publishedEvent = publishMock.mock.calls[0][0];

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(
    ModerationDeclineReason.INVALID_SELECTION
  );
  expect(publishedEvent.data.affectedRows[0]).toMatchObject({
    rowId: data.data.rows[0].id,
    declineReason: ModerationDeclineReason.INVALID_SELECTION,
    marketId: market.marketId,
    marketVersion: market.marketVersion,
    quoteVersion: market.quoteVersion,
    marketStatus: LiveMarketStatus.OPEN,
    selectionId: market.selections[0].selectionId,
    currentOdds: market.selections[0].odds,
  });
});

it("expired live quotes are declined", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = await saveMirror(eventId);
  const message = createMessage();
  const data = createLivePlaceBetEvent(market, {
    row: {
      quoteValidUntil: new Date(Date.now() - 1_000).toISOString(),
    },
  });

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const publishedEvent = publishMock.mock.calls[0][0];

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
  expect(publishedEvent.data.affectedRows[0]).toMatchObject({
    rowId: data.data.rows[0].id,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    marketId: market.marketId,
    marketVersion: market.marketVersion,
    quoteVersion: market.quoteVersion,
    marketStatus: LiveMarketStatus.OPEN,
    selectionId: market.selections[0].selectionId,
    currentOdds: market.selections[0].odds,
  });
});

it("valid live bets are approved against the mirrored market", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = await saveMirror(
    eventId,
    createLiveMarket(eventId, {
      quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
    })
  );
  const message = createMessage();
  const data = createLivePlaceBetEvent(market);

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(savedBet!.betKind).toEqual(BetKind.LIVE);
  expect(publishMock.mock.calls[0][0]).toEqual({
    data: {
      slipId: data.data.slipId,
      result: ModerationStatus.APPROVED,
      betKind: BetKind.LIVE,
    },
  });
});

it("concurrent duplicate deliveries publish one confirmed logical result", async () => {
  const { listener } = await setup();
  const publishStarted = createDeferred();
  const releasePublish = createDeferred();
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const data = createPlaceBetEvent({
    row: {
      eventTime: undefined,
    },
  });

  publishMock.mockImplementationOnce(async () => {
    publishStarted.resolve();
    await releasePublish.promise;
  });

  const firstDelivery = listener.onMessage(data, createMessage());
  await publishStarted.promise;
  const secondDelivery = listener.onMessage(data, createMessage());
  await Promise.resolve();

  expect(publishMock).toHaveBeenCalledTimes(1);

  releasePublish.resolve();
  await Promise.all([firstDelivery, secondDelivery]);

  const bets = await Bet.find({ slipId: data.data.slipId });

  expect(bets).toHaveLength(1);
  expect(publishMock).toHaveBeenCalledTimes(1);
  expect(bets[0].publishedAt).not.toEqual("");
});

it("confirm failures keep the decision retryable until publish succeeds", async () => {
  const { listener } = await setup();
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const data = createPlaceBetEvent({
    row: {
      eventTime: undefined,
    },
  });

  publishMock.mockRejectedValueOnce(new Error("nack"));

  await expect(listener.onMessage(data, createMessage())).rejects.toThrow("nack");

  let savedBet = await Bet.findOne({ slipId: data.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(savedBet!.publishedAt).toEqual("");
  expect(listener.ack).not.toHaveBeenCalled();

  await listener.onMessage(data, createMessage());

  savedBet = await Bet.findOne({ slipId: data.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.publishedAt).not.toEqual("");
  expect(publishMock).toHaveBeenCalledTimes(2);
});

it("a corrected resubmission with a new slip ID is moderated independently", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const userId = new mongoose.Types.ObjectId().toHexString();
  const market = await saveMirror(eventId);
  const declinedAttempt = createLivePlaceBetEvent(market, {
    data: {
      userId,
      userName: "same-user@test.dev",
    },
    row: {
      quoteVersion: market.quoteVersion - 1,
    },
  });
  const approvedAttempt = createLivePlaceBetEvent(market, {
    data: {
      userId,
      userName: "same-user@test.dev",
    },
  });

  await listener.onMessage(declinedAttempt, createMessage());
  await listener.onMessage(approvedAttempt, createMessage());

  const firstBet = await Bet.findOne({ slipId: declinedAttempt.data.slipId });
  const secondBet = await Bet.findOne({ slipId: approvedAttempt.data.slipId });

  expect(firstBet).not.toBeNull();
  expect(firstBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(firstBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
  expect(firstBet!.publishedAt).not.toEqual("");
  expect(secondBet).not.toBeNull();
  expect(secondBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(secondBet!.betKind).toEqual(BetKind.LIVE);
  expect(secondBet!.publishedAt).not.toEqual("");
  expect(await Bet.countDocuments({ userId, "rows.eventId": eventId })).toEqual(2);
});
