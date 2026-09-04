import mongoose from "mongoose";
import {
  BetKind,
  EventPhase,
  LiveMarketStatus,
  ModerationDeclineReason,
  ModerationStatus,
  messengerWrapper,
} from "@betstan/common";
import {
  LiveMarketType,
  TeamSide,
} from "../../../compat/LiveContract";
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

it("declines a slip mixing a pre-match row with a pre-kickoff live row (kickoff team)", async () => {
  // Isolation guard for the new pre-kickoff live markets: they are tagged
  // BetKind.LIVE exactly like every other live market, so they must be
  // caught by the same generic mixed-bet-kinds guard as any other
  // live+pre-match mix, never allowed to slip through as a special case.
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const kickoffTeamMarket = createLiveMarket(eventId, {
    marketType: LiveMarketType.KICKOFF_TEAM,
  });
  const liveSelection = kickoffTeamMarket.selections[0];
  const message = createMessage();
  const futureKickoff = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const data = createPlaceBetEvent({
    data: {
      betKind: BetKind.LIVE,
      submittedAt: new Date().toISOString(),
    },
    rows: [
      {
        eventId,
        eventName: "Test Match",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: futureKickoff,
        eventTime: futureKickoff,
        id: new mongoose.Types.ObjectId().toHexString(),
        betKind: BetKind.PRE_MATCH,
      },
      {
        eventId,
        eventName: "Test Match",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: liveSelection.odds,
        oddsName: "Home",
        productName: "Kickoff Team",
        productId: kickoffTeamMarket.marketId,
        timestamp: futureKickoff,
        eventTime: futureKickoff,
        id: new mongoose.Types.ObjectId().toHexString(),
        betKind: BetKind.LIVE,
        marketId: kickoffTeamMarket.marketId,
        marketType: kickoffTeamMarket.marketType,
        marketVersion: kickoffTeamMarket.marketVersion,
        quoteVersion: kickoffTeamMarket.quoteVersion,
        selectionId: liveSelection.selectionId,
        side: liveSelection.side,
      },
    ],
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
    // PRE_MATCH is now itself a live phase (the pre-kickoff live-slip
    // window), so FULL_TIME -- the only other genuinely non-live phase --
    // is used here to represent "event is not live".
    name: "event is not live",
    reason: ModerationDeclineReason.EVENT_NOT_LIVE,
    phase: EventPhase.FULL_TIME,
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

it.each([
  { marketType: LiveMarketType.KICKOFF_TEAM, side: TeamSide.HOME },
  { marketType: LiveMarketType.KICKOFF_TEAM, side: TeamSide.AWAY },
  { marketType: LiveMarketType.FIRST_MINUTE_GOAL, side: TeamSide.YES },
  { marketType: LiveMarketType.FIRST_MINUTE_GOAL, side: TeamSide.NO },
])(
  "approves a pre-kickoff $marketType bet for $side while the event is in PRE_MATCH phase",
  async ({ marketType, side }) => {
    const { listener } = await setup();
    const eventId = new mongoose.Types.ObjectId().toHexString();
    const marketId = `${eventId}:${marketType}`;
    const otherSide =
      marketType === LiveMarketType.KICKOFF_TEAM
        ? side === TeamSide.HOME
          ? TeamSide.AWAY
          : TeamSide.HOME
        : side === TeamSide.YES
          ? TeamSide.NO
          : TeamSide.YES;
    const preKickoffMarket = createLiveMarket(eventId, {
      marketType,
      marketId,
      marketVersion: 1,
      quoteVersion: 1,
      selections: [
        { selectionId: `${marketId}:1:${side}`, side, odds: 1.95 },
        { selectionId: `${marketId}:1:${otherSide}`, side: otherSide, odds: 1.95 },
      ],
    });
    const market = await saveMirror(eventId, preKickoffMarket, EventPhase.PRE_MATCH);
    const selection = market.selections.find(
      (candidate) => candidate.side === side
    )!;
    const message = createMessage();
    const data = createLivePlaceBetEvent(market, {
      row: { selectionId: selection.selectionId, side: selection.side },
    });

    await listener.onMessage(data, message);

    const savedBet = await Bet.findOne({ slipId: data.data.slipId });
    expect(savedBet).not.toBeNull();
    expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
    expect(savedBet!.affectedRows).toHaveLength(0);
    expect(listener.ack).toHaveBeenCalled();
  }
);

it("declines an ordinary live market bet during PRE_MATCH even though the mirror is currently open", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  // Default createLiveMarket() is LiveMarketType.NEXT_CORNER, OPEN -- an
  // ordinary live market that must never be reachable while phase is
  // PRE_MATCH, unlike KICKOFF_TEAM/FIRST_MINUTE_GOAL.
  const market = await saveMirror(eventId, createLiveMarket(eventId), EventPhase.PRE_MATCH);
  const message = createMessage();
  const data = createLivePlaceBetEvent(market);

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_NOT_LIVE);
  expect(listener.ack).toHaveBeenCalled();
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

it("does not fall back to an arbitrary NONE selection for score markets", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketId = `${eventId}:SECOND_HALF_SCORE`;
  const market = createLiveMarket(eventId, {
    marketId,
    marketType: LiveMarketType.SECOND_HALF_SCORE,
    selections: [
      {
        selectionId: `${marketId}:1:SCORE_0_0`,
        side: TeamSide.NONE,
        odds: 3.5,
      },
      {
        selectionId: `${marketId}:1:SCORE_1_0`,
        side: TeamSide.NONE,
        odds: 4.5,
      },
    ],
  });
  await saveMirror(eventId, market);
  const message = createMessage();
  const data = createLivePlaceBetEvent(market, {
    row: {
      selectionId: `${marketId}:1:SCORE_9_9`,
      side: TeamSide.NONE,
    },
  });

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;
  const affectedRow = publishMock.mock.calls[0][0].data.affectedRows[0];

  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(
    ModerationDeclineReason.INVALID_SELECTION
  );
  expect(affectedRow).not.toHaveProperty("selectionId");
  expect(affectedRow).not.toHaveProperty("currentOdds");
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

it.each([
  ["missing quote expiry", "missing-expiry"],
  ["missing submission time", "missing-submission"],
  ["invalid submission time", "invalid-submission"],
])("fails closed for live bets with %s", async (_label, scenario) => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = createLiveMarket(eventId);

  if (scenario === "missing-expiry") {
    market.quoteValidUntil = undefined;
  }

  await saveMirror(eventId, market);
  const data = createLivePlaceBetEvent(market, {
    data: {
      submittedAt:
        scenario === "missing-submission"
          ? undefined
          : scenario === "invalid-submission"
            ? "not-a-date"
            : new Date().toISOString(),
    },
  });

  await listener.onMessage(data, createMessage());

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
});

it("approves delayed moderation when the server accepted the bet before cutoff", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const quoteValidUntil = new Date(Date.now() - 1_000);
  const submittedAt = new Date(quoteValidUntil.getTime() - 1_000).toISOString();
  const market = await saveMirror(
    eventId,
    createLiveMarket(eventId, {
      quoteValidUntil: quoteValidUntil.toISOString(),
    })
  );
  const data = createLivePlaceBetEvent(market, {
    data: { submittedAt },
  });

  await listener.onMessage(data, createMessage());

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(savedBet!.submittedAt).toEqual(submittedAt);
});

it("declines a bet accepted at the cutoff even while the mirror is stale and open", async () => {
  const { listener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const quoteValidUntil = new Date(Date.now() - 1_000).toISOString();
  const market = await saveMirror(
    eventId,
    createLiveMarket(eventId, { quoteValidUntil })
  );
  const data = createLivePlaceBetEvent(market, {
    data: { submittedAt: quoteValidUntil },
  });

  await listener.onMessage(data, createMessage());

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
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
