import mongoose from "mongoose";
import {
  BetKind,
  BettingStatus,
  EventPhase,
  LiveMarketStatus,
  ModerationDeclineReason,
  ModerationStatus,
} from "@betstan/common";
import { Bet } from "../../model/Bet";
import { LiveEventMirror } from "../../model/LiveEventMirror";
import { Resulted } from "../../model/Resulted";
import ModerationService, {
  MAX_MARKET_HISTORY_VERSIONS_PER_MARKET,
  MAX_MARKET_HISTORY_WRITE_ATTEMPTS,
  ModerationPublisher,
} from "../ModerationService";
import {
  createLiveMarket,
  createLivePlaceBetEvent,
  createLiveUpdateEvent,
} from "../../event/listener/__test__/helpers";

const timelineAt = (offsetMs: number) =>
  new Date(Date.parse("2030-01-01T00:00:00.000Z") + offsetMs).toISOString();

const createPublisher = () => ({
  publishWithConfirm: jest.fn(async () => undefined),
}) as unknown as ModerationPublisher & {
  publishWithConfirm: jest.Mock<Promise<void>, [unknown]>;
};

it("approves a live bet whose valid quote predates a newer snapshot that already replaced the mirror", async () => {
  const publisher = createPublisher();
  const service = new ModerationService(publisher);
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const submittedAt = timelineAt(5_000);
  const oldMarket = createLiveMarket(eventId, {
    marketVersion: 10,
    quoteVersion: 5,
    quoteValidUntil: timelineAt(30_000),
  });
  const newMarket = createLiveMarket(eventId, {
    marketVersion: 11,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      markets: [oldMarket],
    })
  );
  // A newer snapshot arrives and replaces the mirror's current market entry
  // *before* moderation ever evaluates the bet that referenced the old quote.
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(10_000),
      markets: [newMarket],
    })
  );

  const placeBet = createLivePlaceBetEvent(oldMarket, {
    data: { submittedAt },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(savedBet!.betKind).toEqual(BetKind.LIVE);
  expect(publisher.publishWithConfirm).toHaveBeenCalledWith({
    data: {
      slipId: placeBet.data.slipId,
      result: ModerationStatus.APPROVED,
      betKind: BetKind.LIVE,
    },
  });

  const mirror = await LiveEventMirror.findOne({ eventId });
  expect(mirror!.markets).toHaveLength(1);
  expect(mirror!.markets[0].marketVersion).toEqual(11);
  expect(
    mirror!.marketHistory!.some(
      (entry) => entry.marketVersion === 10 && entry.quoteVersion === 5
    )
  ).toBe(true);
});

it("declines a live bet against an ordinary market's frozen PRE_MATCH-phase history entry, even though it was recorded OPEN", async () => {
  const publisher = createPublisher();
  const service = new ModerationService(publisher);
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const submittedAt = timelineAt(5_000);
  // Default createLiveMarket() is LiveMarketType.NEXT_CORNER -- an ordinary
  // live market that must never be treated as live while phase is
  // PRE_MATCH, regardless of what its frozen history entry recorded.
  const oldMarket = createLiveMarket(eventId, {
    marketVersion: 1,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(30_000),
  });
  const newMarket = createLiveMarket(eventId, {
    marketVersion: 2,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      phase: EventPhase.PRE_MATCH,
      markets: [oldMarket],
    })
  );
  // A newer snapshot supersedes the old identity, archiving it into
  // history with phase PRE_MATCH (the phase that was current when it was
  // captured as OPEN).
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(10_000),
      phase: EventPhase.PRE_MATCH,
      markets: [newMarket],
    })
  );

  const mirror = await LiveEventMirror.findOne({ eventId });
  expect(
    mirror!.marketHistory!.some(
      (entry) =>
        entry.marketVersion === 1
        && entry.quoteVersion === 1
        && entry.phase === EventPhase.PRE_MATCH
        && entry.status === LiveMarketStatus.OPEN
    )
  ).toBe(true);

  const placeBet = createLivePlaceBetEvent(oldMarket, {
    data: { submittedAt },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_NOT_LIVE);
});

it("declines a live bet whose quote had already expired at submission, even though its market state is retained in history", async () => {
  const publisher = createPublisher();
  const service = new ModerationService(publisher);
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const oldMarket = createLiveMarket(eventId, {
    marketVersion: 20,
    quoteVersion: 3,
    quoteValidUntil: new Date(Date.now() - 5_000).toISOString(),
  });
  const newMarket = createLiveMarket(eventId, {
    marketVersion: 21,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({ eventId, sequence: 1, markets: [oldMarket] })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({ eventId, sequence: 2, markets: [newMarket] })
  );

  const placeBet = createLivePlaceBetEvent(oldMarket, {
    data: { submittedAt: new Date().toISOString() },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
});

it("still declines a live bet referencing a market version that was never actually broadcast", async () => {
  const publisher = createPublisher();
  const service = new ModerationService(publisher);
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const oldMarket = createLiveMarket(eventId, {
    marketVersion: 30,
    quoteVersion: 2,
    quoteValidUntil: new Date(Date.now() + 30_000).toISOString(),
  });
  const newMarket = createLiveMarket(eventId, {
    marketVersion: 31,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({ eventId, sequence: 1, markets: [oldMarket] })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({ eventId, sequence: 2, markets: [newMarket] })
  );

  const forgedMarket = createLiveMarket(eventId, {
    marketVersion: 29,
    quoteVersion: 9,
    quoteValidUntil: new Date(Date.now() + 30_000).toISOString(),
  });
  const placeBet = createLivePlaceBetEvent(forgedMarket, {
    data: { submittedAt: new Date().toISOString() },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
});

it("keeps market history idempotent across duplicates and preserves late out-of-order quotes", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketA = createLiveMarket(eventId, {
    marketVersion: 40,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });
  const marketB = createLiveMarket(eventId, {
    marketVersion: 41,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });
  // Represents a snapshot whose own sequence is lower than the mirror's
  // current sequence by the time it is delivered/replayed (out of order).
  const lateMarket = createLiveMarket(eventId, {
    marketVersion: 39,
    quoteVersion: 7,
    quoteValidUntil: timelineAt(60_000),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 5,
      occurredAt: timelineAt(10_000),
      markets: [marketA],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 10,
      occurredAt: timelineAt(20_000),
      markets: [marketB],
    })
  );

  // Duplicate redelivery of already-applied snapshots must not grow history.
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 10,
      occurredAt: timelineAt(20_000),
      markets: [marketB],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 5,
      occurredAt: timelineAt(10_000),
      markets: [marketA],
    })
  );

  let mirror = await LiveEventMirror.findOne({ eventId });
  expect(mirror!.sequence).toEqual(10);
  expect(mirror!.marketHistory).toHaveLength(2);

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 3,
      occurredAt: timelineAt(0),
      markets: [lateMarket],
    })
  );

  mirror = await LiveEventMirror.findOne({ eventId });
  expect(mirror!.sequence).toEqual(10);
  expect(mirror!.marketHistory).toHaveLength(3);
  expect(
    mirror!.marketHistory!.some(
      (entry) => entry.marketVersion === 39 && entry.quoteVersion === 7
    )
  ).toBe(true);

  const placeBet = createLivePlaceBetEvent(lateMarket, {
    data: { submittedAt: timelineAt(5_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
});

it("persists market history across a fresh ModerationService instance (simulated restart)", async () => {
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const oldMarket = createLiveMarket(eventId, {
    marketVersion: 50,
    quoteVersion: 4,
    quoteValidUntil: timelineAt(30_000),
  });
  const newMarket = createLiveMarket(eventId, {
    marketVersion: 51,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });

  const firstProcessService = new ModerationService(createPublisher());
  await firstProcessService.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      markets: [oldMarket],
    })
  );
  await firstProcessService.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(10_000),
      markets: [newMarket],
    })
  );

  const submittedAt = timelineAt(5_000);
  const placeBet = createLivePlaceBetEvent(oldMarket, { data: { submittedAt } });

  // No JS state is shared beyond this point: a brand-new service instance
  // stands in for a fresh process after a restart, reading only from the
  // persisted MongoDB document.
  const restartedPublisher = createPublisher();
  const restartedService = new ModerationService(restartedPublisher);

  await restartedService.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(restartedPublisher.publishWithConfirm).toHaveBeenCalled();
});

it("bounds persisted market history to the most recent versions per market", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketId = `${eventId}:bounded`;
  // Ten more than the documented worst-case per-marketId bound, so the
  // oldest ten entries must be pruned.
  const totalVersions = MAX_MARKET_HISTORY_VERSIONS_PER_MARKET + 10;

  for (let quoteVersion = 1; quoteVersion <= totalVersions; quoteVersion += 1) {
    await service.upsertLiveEventMirror(
      createLiveUpdateEvent({
        eventId,
        sequence: quoteVersion,
        markets: [
          createLiveMarket(eventId, {
            marketId,
            marketVersion: 1,
            quoteVersion,
            quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
          }),
        ],
      })
    );
  }

  const mirror = await LiveEventMirror.findOne({ eventId });
  const historyForMarket = (mirror!.marketHistory ?? []).filter(
    (entry) => entry.marketId === marketId
  );

  expect(historyForMarket).toHaveLength(
    MAX_MARKET_HISTORY_VERSIONS_PER_MARKET
  );
  expect(
    historyForMarket.map((entry) => entry.quoteVersion).sort((a, b) => a - b)
  ).toEqual(Array.from(
    { length: MAX_MARKET_HISTORY_VERSIONS_PER_MARKET },
    (_, index) => index + 11
  ));
});

it("an early quote submitted before expiry survives the full documented per-market history lineage bound", async () => {
  // Proves the bound is sized to safely cover the maximum number of in-match
  // repricing transitions the live simulator can produce for a single
  // still-open market (see MAX_MARKET_HISTORY_VERSIONS_PER_MARKET's
  // derivation from gamemaster's HARD_CAPS + fixed incident schedule). An
  // early quote issued at kickoff must remain approvable even after exactly
  // that many subsequent quote transitions for the same market.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketId = `${eventId}:lineage`;
  const submittedAt = new Date().toISOString();
  const earlyQuote = createLiveMarket(eventId, {
    marketId,
    marketVersion: 1,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({ eventId, sequence: 1, markets: [earlyQuote] })
  );

  // Simulate repricing this same market up to (and including) the maximum
  // documented lineage length for a single marketId across an entire match.
  for (
    let quoteVersion = 2;
    quoteVersion <= MAX_MARKET_HISTORY_VERSIONS_PER_MARKET;
    quoteVersion += 1
  ) {
    await service.upsertLiveEventMirror(
      createLiveUpdateEvent({
        eventId,
        sequence: quoteVersion,
        markets: [
          createLiveMarket(eventId, {
            marketId,
            marketVersion: 1,
            quoteVersion,
            quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
          }),
        ],
      })
    );
  }

  const mirror = await LiveEventMirror.findOne({ eventId });
  const historyForMarket = (mirror!.marketHistory ?? []).filter(
    (entry) => entry.marketId === marketId
  );

  expect(historyForMarket).toHaveLength(
    MAX_MARKET_HISTORY_VERSIONS_PER_MARKET
  );
  expect(historyForMarket.some((entry) => entry.quoteVersion === 1)).toBe(true);

  const placeBet = createLivePlaceBetEvent(earlyQuote, {
    data: { submittedAt },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
});

it("approves a valid pre-expiry quote even when a newer quoteVersion for the same marketVersion now occupies the current mirror", async () => {
  // Gap 1 regression: the current-mirror entry shares marketId+marketVersion
  // with the row but carries a newer quoteVersion. It must not "shadow" the
  // historical exact triple and short-circuit the lookup before history is
  // ever consulted.
  const publisher = createPublisher();
  const service = new ModerationService(publisher);
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketId = `${eventId}:gap1`;
  const oldQuote = createLiveMarket(eventId, {
    marketId,
    marketVersion: 5,
    quoteVersion: 5,
    quoteValidUntil: timelineAt(30_000),
  });
  const newQuote = createLiveMarket(eventId, {
    marketId,
    marketVersion: 5,
    quoteVersion: 6,
    quoteValidUntil: timelineAt(60_000),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      markets: [oldQuote],
    })
  );
  // Same marketVersion, only quoteVersion advances: the current mirror entry
  // now matches the row's marketVersion but not its quoteVersion.
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(10_000),
      markets: [newQuote],
    })
  );

  const mirrorBeforeBet = await LiveEventMirror.findOne({ eventId });
  expect(mirrorBeforeBet!.markets).toHaveLength(1);
  expect(mirrorBeforeBet!.markets[0].marketVersion).toEqual(5);
  expect(mirrorBeforeBet!.markets[0].quoteVersion).toEqual(6);

  const placeBet = createLivePlaceBetEvent(oldQuote, {
    data: { submittedAt: timelineAt(5_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(savedBet!.betKind).toEqual(BetKind.LIVE);
});

it("approves a live quote submitted before the later suspension ended its authority", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const suspendedAt = timelineAt(10_000);
  const liveQuote = createLiveMarket(eventId, {
    marketVersion: 60,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(30_000),
  });
  const suspendedMarket = createLiveMarket(eventId, {
    marketVersion: 61,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [liveQuote],
    })
  );
  // The event becomes suspended only after the quote was already recorded as
  // live in history.
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: suspendedAt,
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.SUSPENDED,
      markets: [suspendedMarket],
    })
  );

  const placeBet = createLivePlaceBetEvent(liveQuote, {
    data: { submittedAt: timelineAt(5_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);

  const mirror = await LiveEventMirror.findOne({ eventId });
  const historicalQuote = mirror!.marketHistory!.find(
    (entry) =>
      entry.marketVersion === liveQuote.marketVersion
      && entry.quoteVersion === liveQuote.quoteVersion
  );
  expect(historicalQuote!.authorityEndedAt).toEqual(suspendedAt);
  expect(historicalQuote!.authorityEndSequence).toEqual(2);
});

it("declines a live quote submitted after suspension even when its original expiry is later", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const liveQuote = createLiveMarket(eventId, {
    marketVersion: 65,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(30_000),
  });
  const suspendedMarket = createLiveMarket(eventId, {
    marketVersion: 66,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [liveQuote],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(10_000),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.SUSPENDED,
      markets: [suspendedMarket],
    })
  );

  const placeBet = createLivePlaceBetEvent(liveQuote, {
    data: { submittedAt: timelineAt(15_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
});

it("approves a live quote submitted before full time ended its authority", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const fullTimeAt = timelineAt(10_000);
  const liveQuote = createLiveMarket(eventId, {
    marketVersion: 70,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(30_000),
  });
  const fullTimeMarket = createLiveMarket(eventId, {
    marketVersion: 71,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [liveQuote],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: fullTimeAt,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [fullTimeMarket],
    })
  );

  const placeBet = createLivePlaceBetEvent(liveQuote, {
    data: { submittedAt: timelineAt(5_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);

  const mirror = await LiveEventMirror.findOne({ eventId });
  const historicalQuote = mirror!.marketHistory!.find(
    (entry) =>
      entry.marketVersion === liveQuote.marketVersion
      && entry.quoteVersion === liveQuote.quoteVersion
  );
  expect(historicalQuote!.authorityEndedAt).toEqual(fullTimeAt);
});

it("declines a live quote submitted after full time even when its original expiry is later", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const liveQuote = createLiveMarket(eventId, {
    marketVersion: 75,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(30_000),
  });
  const fullTimeMarket = createLiveMarket(eventId, {
    marketVersion: 76,
    quoteVersion: 1,
    quoteValidUntil: timelineAt(60_000),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [liveQuote],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(10_000),
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [fullTimeMarket],
    })
  );

  const placeBet = createLivePlaceBetEvent(liveQuote, {
    data: { submittedAt: timelineAt(15_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
});

it("still declines EVENT_RESULTED even when a perfectly valid historical quote exists", async () => {
  // Guard: Resulted must remain the absolute hard stop, taking precedence
  // over any historically-live, unexpired quote.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const liveQuote = createLiveMarket(eventId, {
    marketVersion: 80,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 30_000).toISOString(),
  });
  const laterMarket = createLiveMarket(eventId, {
    marketVersion: 81,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [liveQuote],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [laterMarket],
    })
  );
  await Resulted.create({ eventId, timestamp: new Date().toISOString() });

  const placeBet = createLivePlaceBetEvent(liveQuote, {
    data: { submittedAt: new Date().toISOString() },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_RESULTED);
});

it("never deletes the terminal Resulted guard when delayed live projections arrive afterward", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();

  // EVENT_RESULT wins its queue race before moderation observes any live
  // projection. It is still terminal domain authority.
  await Resulted.create({ eventId, timestamp: new Date().toISOString() });

  const decliningPlaceBet = createLivePlaceBetEvent(
    createLiveMarket(eventId, { marketVersion: 1, quoteVersion: 1 }),
    { data: { submittedAt: new Date().toISOString() } }
  );
  await service.handlePlaceBet(decliningPlaceBet);
  const declinedBet = await Bet.findOne({ slipId: decliningPlaceBet.data.slipId });
  expect(declinedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(declinedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_RESULTED);

  // Earlier live snapshots then arrive late on the independent queue.
  const openMarket = createLiveMarket(eventId, {
    marketVersion: 1,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [openMarket],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 180,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [],
    })
  );

  expect(await Resulted.findOne({ eventId }).lean()).not.toBeNull();

  const laterPlaceBet = createLivePlaceBetEvent(openMarket, {
    data: { submittedAt: new Date().toISOString() },
  });
  await service.handlePlaceBet(laterPlaceBet);
  const laterBet = await Bet.findOne({ slipId: laterPlaceBet.data.slipId });
  expect(laterBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(laterBet!.declineReason).toEqual(
    ModerationDeclineReason.EVENT_RESULTED
  );
});

it("keeps declining EVENT_RESULTED when the very first live projection ever observed for the event is already FULL_TIME", async () => {
  // Edge case mirroring event service's own symmetric guard: if the very
  // first live update moderation ever sees for an event is already its
  // FULL_TIME conclusion, any existing Resulted marker is a genuine final
  // result and must never be reversed.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();

  await Resulted.create({ eventId, timestamp: new Date().toISOString() });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 180,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [createLiveMarket(eventId, { marketVersion: 1, quoteVersion: 1 })],
    })
  );

  expect(await Resulted.findOne({ eventId }).lean()).not.toBeNull();

  const placeBet = createLivePlaceBetEvent(
    createLiveMarket(eventId, { marketVersion: 1, quoteVersion: 1 }),
    { data: { submittedAt: new Date().toISOString() } }
  );
  await service.handlePlaceBet(placeBet);
  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_RESULTED);
});

it("does not reverse Resulted once a live mirror already existed before the result arrived (genuine final result)", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();

  // The event genuinely went live first...
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [createLiveMarket(eventId, { marketVersion: 1, quoteVersion: 1 })],
    })
  );
  // ...and only then does its genuine final result arrive.
  await Resulted.create({ eventId, timestamp: new Date().toISOString() });

  // A subsequent live update can no longer be the "very first ever" one, so
  // it must never clear the now-genuine Resulted marker.
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [createLiveMarket(eventId, { marketVersion: 2, quoteVersion: 1 })],
    })
  );

  expect(await Resulted.findOne({ eventId }).lean()).not.toBeNull();
});

it("declines EVENT_NOT_LIVE for an exact historical match that was itself never live when recorded", async () => {
  // Guard: the historical fallback must not become a blanket bypass. A
  // historical entry whose own persisted phase/bettingStatus were already
  // non-live (e.g. suspended) at the moment it was captured must still be
  // declined, even though it is an exact marketId+marketVersion+quoteVersion
  // match and the mirror is currently live elsewhere.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const neverLiveQuote = createLiveMarket(eventId, {
    marketVersion: 90,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 30_000).toISOString(),
  });
  const currentMarket = createLiveMarket(eventId, {
    marketVersion: 91,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.SUSPENDED,
      markets: [neverLiveQuote],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [currentMarket],
    })
  );

  const placeBet = createLivePlaceBetEvent(neverLiveQuote, {
    data: { submittedAt: new Date().toISOString() },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_NOT_LIVE);
});

it("throws instead of silently dropping market history when CAS writes stay exhausted under injected contention", async () => {
  // Durability regression: recordMarketHistory must not "succeed" (resolve
  // normally) while quietly failing to persist a snapshot's quote history.
  // Force every historyRevision CAS write to lose the race (matchedCount: 0)
  // and confirm upsertLiveEventMirror rejects after exactly the documented
  // bounded number of attempts, with no history silently lost/half-applied.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = createLiveMarket(eventId, {
    marketVersion: 1,
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });

  const originalUpdateOne = LiveEventMirror.updateOne.bind(LiveEventMirror);
  let historyWriteAttempts = 0;

  const updateSpy = jest
    .spyOn(LiveEventMirror, "updateOne")
    .mockImplementation((filter: any, update: any, options?: any) => {
      const isHistoryWrite = Boolean(
        filter && Object.prototype.hasOwnProperty.call(filter, "historyRevision")
      );

      if (isHistoryWrite) {
        historyWriteAttempts += 1;
        // Every attempt loses the optimistic-concurrency race, simulating
        // perpetual contention from other concurrent snapshot writers.
        return Promise.resolve({
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 0,
        }) as unknown as ReturnType<typeof LiveEventMirror.updateOne>;
      }

      return originalUpdateOne(filter, update, options);
    });

  try {
    await expect(
      service.upsertLiveEventMirror(
        createLiveUpdateEvent({ eventId, sequence: 1, markets: [market] })
      )
    ).rejects.toThrow();

    // Bounded, not infinite: exactly MAX_MARKET_HISTORY_WRITE_ATTEMPTS writes
    // were attempted before giving up and throwing.
    expect(historyWriteAttempts).toEqual(MAX_MARKET_HISTORY_WRITE_ATTEMPTS);

    const mirror = await LiveEventMirror.findOne({ eventId });

    // The "current" mirror write (unaffected by the mock) still applied, but
    // the history write is verifiably absent -- not a silent, success-shaped
    // partial loss.
    expect(mirror).not.toBeNull();
    expect(mirror!.sequence).toEqual(1);
    expect(mirror!.marketHistory ?? []).toHaveLength(0);
  } finally {
    updateSpy.mockRestore();
  }
});

it("approves a bet against the persisted OPEN historical entry when a later snapshot carries the very same triple forward as settled, before the original expiry", async () => {
  // Gamemaster does not bump marketVersion/quoteVersion at full-time -- it
  // re-broadcasts the exact same marketId+marketVersion+quoteVersion triple
  // with status flipped to SETTLED and no quoteValidUntil (buildLiveUpdatePayload
  // only includes quoteValidUntil while status === OPEN). The bet was
  // submitted while the persisted historical observation of that triple was
  // still genuinely OPEN and live, before its own quoteValidUntil, so it must
  // be approved even though the *current* mirror now shows the same triple as
  // settled with no expiry.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketVersion = 200;
  const quoteVersion = 1;
  const openQuoteValidUntil = timelineAt(30_000);
  const openQuote = createLiveMarket(eventId, {
    marketVersion,
    quoteVersion,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: openQuoteValidUntil,
  });
  // Same exact identity triple, carried forward with a different status and
  // no quoteValidUntil -- mirroring gamemaster's real full-time payload shape.
  const settledSameTriple = {
    ...createLiveMarket(eventId, {
      marketId: openQuote.marketId,
      marketType: openQuote.marketType,
      marketVersion,
      quoteVersion,
      status: LiveMarketStatus.SETTLED,
      selections: openQuote.selections,
    }),
  };
  delete (settledSameTriple as { quoteValidUntil?: string }).quoteValidUntil;

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [openQuote],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(20_000),
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [settledSameTriple],
    })
  );

  const mirror = await LiveEventMirror.findOne({ eventId });
  // The current mirror now shows the very same triple as settled with no
  // expiry -- confirming the scenario actually reproduces the real bug shape.
  expect(mirror!.markets).toHaveLength(1);
  expect(mirror!.markets[0].marketVersion).toEqual(marketVersion);
  expect(mirror!.markets[0].quoteVersion).toEqual(quoteVersion);
  expect(mirror!.markets[0].status).toEqual(LiveMarketStatus.SETTLED);
  expect(mirror!.markets[0].quoteValidUntil).toBeUndefined();
  const historyEntry = mirror!.marketHistory!.find(
    (entry) => entry.marketVersion === marketVersion && entry.quoteVersion === quoteVersion
  );
  expect(historyEntry?.status).toEqual(LiveMarketStatus.OPEN);
  expect(historyEntry?.quoteValidUntil).toEqual(openQuoteValidUntil);

  const placeBet = createLivePlaceBetEvent(openQuote, {
    data: { submittedAt: timelineAt(10_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
});

it("declines a bet as STALE_QUOTE when submitted after the original expiry, even though the same triple was carried forward as settled", async () => {
  // Same exact reproduction as above, but submittedAt is after the original
  // (historical) quote's quoteValidUntil. The immutable submittedAt must
  // still be correctly declined as STALE_QUOTE -- not approved, and not
  // declined for the unrelated reason of the current mirror being
  // settled/closed (EVENT_NOT_LIVE/MARKET_CLOSED) -- proving the fix does
  // not turn the historical-preference path into a blanket bypass of
  // expiry. (The row's own claimed quoteValidUntil mirrors the historical
  // quote's real expiry here, so this is also caught by the immutable
  // submitted-payload expiry gate applied before market resolution; both
  // gates independently agree the bet is stale.)
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketVersion = 210;
  const quoteVersion = 1;
  const openQuoteValidUntil = timelineAt(5_000);
  const openQuote = createLiveMarket(eventId, {
    marketVersion,
    quoteVersion,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: openQuoteValidUntil,
  });
  const settledSameTriple = {
    ...createLiveMarket(eventId, {
      marketId: openQuote.marketId,
      marketType: openQuote.marketType,
      marketVersion,
      quoteVersion,
      status: LiveMarketStatus.SETTLED,
      selections: openQuote.selections,
    }),
  };
  delete (settledSameTriple as { quoteValidUntil?: string }).quoteValidUntil;

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      occurredAt: timelineAt(0),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [openQuote],
    })
  );
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(10_000),
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [settledSameTriple],
    })
  );

  const placeBet = createLivePlaceBetEvent(openQuote, {
    data: { submittedAt: timelineAt(20_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.STALE_QUOTE);
});

it("archives a legacy mirror's pre-update current quote into history before a rolling-deployment snapshot replaces it, and a bet against it still validates", async () => {
  // Backward-compat + rolling-deployment regression: a document written
  // before market history existed (or before historyRevision was ever set)
  // has neither `marketHistory` nor `historyRevision` at all -- not empty
  // defaults, genuinely absent fields, as a raw pre-deploy document would
  // look. When a later snapshot replaces its "current" markets, the
  // pre-update quote must be archived into history first (otherwise it is
  // gone forever the instant it is overwritten), and the CAS write that
  // creates history for the very first time must tolerate the missing
  // historyRevision field rather than exhausting retries against it.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const oldMarket = createLiveMarket(eventId, {
    marketVersion: 300,
    quoteVersion: 1,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: timelineAt(30_000),
  });
  const legacyMirror = createLiveUpdateEvent({
    eventId,
    sequence: 1,
    occurredAt: timelineAt(0),
    phase: EventPhase.FIRST_HALF,
    bettingStatus: BettingStatus.OPEN,
    markets: [oldMarket],
  }).data;

  // Simulate a genuinely pre-deploy document: insert the raw shape directly
  // via the driver, bypassing Mongoose entirely so no schema defaults are
  // applied -- `marketHistory`/`historyRevision` are truly absent keys, not
  // empty-array/zero defaults.
  await LiveEventMirror.collection.insertOne(legacyMirror as never);

  const rawBefore = await LiveEventMirror.collection.findOne({ eventId });
  expect(rawBefore).not.toBeNull();
  expect("marketHistory" in (rawBefore as object)).toBe(false);
  expect("historyRevision" in (rawBefore as object)).toBe(false);

  const newMarket = createLiveMarket(eventId, {
    marketVersion: 301,
    quoteVersion: 1,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: timelineAt(60_000),
  });

  const changed = await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      occurredAt: timelineAt(20_000),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [newMarket],
    })
  );

  expect(changed).toBe(true);

  const mirror = await LiveEventMirror.findOne({ eventId });
  expect(mirror!.markets).toHaveLength(1);
  expect(mirror!.markets[0].marketVersion).toEqual(301);
  expect(mirror!.historyRevision).toBeGreaterThan(0);
  expect(
    mirror!.marketHistory!.some(
      (entry) => entry.marketVersion === 300 && entry.quoteVersion === 1
    )
  ).toBe(true);
  expect(
    mirror!.marketHistory!.some(
      (entry) => entry.marketVersion === 301 && entry.quoteVersion === 1
    )
  ).toBe(true);

  const placeBet = createLivePlaceBetEvent(oldMarket, {
    data: { submittedAt: timelineAt(10_000) },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
});

it("upgrades a persisted CLOSED history entry to OPEN when the genuinely earlier live snapshot for the same triple is delivered out of order, and the bet then validates", async () => {
  // Out-of-order/concurrent-delivery regression: a CLOSED/SETTLED
  // observation of a triple can be persisted to history before its own
  // earlier OPEN observation arrives (delayed redelivery, or two publishers
  // racing). First-write-wins dedupe would freeze the CLOSED observation
  // forever and silently skip the delayed OPEN one, permanently hiding the
  // only evidence that the quote was ever genuinely live. The authoritative
  // live+OPEN observation must instead replace the inferior placeholder.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketVersion = 400;
  const quoteVersion = 1;
  const closedMarket = createLiveMarket(eventId, {
    marketVersion,
    quoteVersion,
    status: LiveMarketStatus.CLOSED,
  });
  delete (closedMarket as { quoteValidUntil?: string }).quoteValidUntil;
  const terminalAt = timelineAt(20_000);
  const submittedAt = timelineAt(10_000);
  const openMarket = createLiveMarket(eventId, {
    marketId: closedMarket.marketId,
    marketType: closedMarket.marketType,
    marketVersion,
    quoteVersion,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: timelineAt(30_000),
  });

  // The CLOSED snapshot (a later point in the match) is delivered -- and
  // processed -- first, becoming both the mirror's only "current" state and
  // the triple's first-ever history entry.
  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 5,
      occurredAt: terminalAt,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [closedMarket],
    })
  );

  const mirrorAfterClosed = await LiveEventMirror.findOne({ eventId });
  expect(
    mirrorAfterClosed!.marketHistory!.find(
      (entry) => entry.marketVersion === marketVersion && entry.quoteVersion === quoteVersion
    )?.status
  ).toEqual(LiveMarketStatus.CLOSED);

  // The genuinely earlier OPEN snapshot for the exact same triple now
  // arrives, delayed -- its own sequence (3) is lower than the mirror's
  // current sequence (5), so it cannot (and must not) become "current", but
  // its live+OPEN observation must still upgrade the persisted history.
  const changed = await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 3,
      occurredAt: timelineAt(0),
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [openMarket],
    })
  );

  expect(changed).toBe(true);

  const mirror = await LiveEventMirror.findOne({ eventId });
  // "Current" is untouched by the out-of-order delivery -- it is still the
  // later, genuinely-authoritative CLOSED snapshot.
  expect(mirror!.markets[0].status).toEqual(LiveMarketStatus.CLOSED);
  const historyEntry = mirror!.marketHistory!.find(
    (entry) => entry.marketVersion === marketVersion && entry.quoteVersion === quoteVersion
  );
  expect(historyEntry?.status).toEqual(LiveMarketStatus.OPEN);
  expect(historyEntry?.quoteValidUntil).toEqual(timelineAt(30_000));
  expect(historyEntry?.authorityEndedAt).toEqual(terminalAt);
  expect(historyEntry?.authorityEndSequence).toEqual(5);

  const placeBet = createLivePlaceBetEvent(openMarket, {
    data: { submittedAt },
  });

  await service.handlePlaceBet(placeBet);

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);

  const latePlaceBet = createLivePlaceBetEvent(openMarket, {
    data: { submittedAt: timelineAt(25_000) },
  });

  await service.handlePlaceBet(latePlaceBet);

  const lateSavedBet = await Bet.findOne({
    slipId: latePlaceBet.data.slipId,
  });
  expect(lateSavedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(lateSavedBet!.declineReason).toEqual(
    ModerationDeclineReason.STALE_QUOTE
  );
});

it("uses a terminal mirror timestamp when legacy history has no authority-ended fields", async () => {
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const openMarket = createLiveMarket(eventId, {
    marketVersion: 405,
    quoteVersion: 1,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: timelineAt(30_000),
  });
  const terminalMarket = createLiveMarket(eventId, {
    marketVersion: 406,
    quoteVersion: 1,
    status: LiveMarketStatus.SETTLED,
  });
  delete (terminalMarket as { quoteValidUntil?: string }).quoteValidUntil;
  const terminalMirror = createLiveUpdateEvent({
    eventId,
    sequence: 2,
    occurredAt: timelineAt(10_000),
    phase: EventPhase.FULL_TIME,
    bettingStatus: BettingStatus.CLOSED,
    markets: [terminalMarket],
  }).data;

  await LiveEventMirror.collection.insertOne({
    ...terminalMirror,
    marketHistory: [
      {
        ...openMarket,
        sequence: 1,
        phase: EventPhase.FIRST_HALF,
        bettingStatus: BettingStatus.OPEN,
      },
    ],
    historyRevision: 1,
  } as never);

  const beforeTerminal = createLivePlaceBetEvent(openMarket, {
    data: { submittedAt: timelineAt(5_000) },
  });
  const afterTerminal = createLivePlaceBetEvent(openMarket, {
    data: { submittedAt: timelineAt(15_000) },
  });

  await service.handlePlaceBet(beforeTerminal);
  await service.handlePlaceBet(afterTerminal);

  expect(
    (await Bet.findOne({ slipId: beforeTerminal.data.slipId }))!.status
  ).toEqual(ModerationStatus.APPROVED);
  const declinedBet = await Bet.findOne({
    slipId: afterTerminal.data.slipId,
  });
  expect(declinedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(declinedBet!.declineReason).toEqual(
    ModerationDeclineReason.STALE_QUOTE
  );
});

it("never downgrades an already-persisted OPEN history entry when a later in-place status mutation of the same triple is folded in", async () => {
  // Guard: the merge must be one-directional. Once a triple is frozen as
  // live+OPEN in history, a subsequent observation of the very same triple
  // that is no longer OPEN (the normal in-place suspension/settlement
  // lifecycle from earlier rounds) must never overwrite it.
  const service = new ModerationService(createPublisher());
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const marketVersion = 410;
  const quoteVersion = 1;
  const openQuoteValidUntil = new Date(Date.now() + 30_000).toISOString();
  const openMarket = createLiveMarket(eventId, {
    marketVersion,
    quoteVersion,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: openQuoteValidUntil,
  });
  const settledMarket = {
    ...createLiveMarket(eventId, {
      marketId: openMarket.marketId,
      marketType: openMarket.marketType,
      marketVersion,
      quoteVersion,
      status: LiveMarketStatus.SETTLED,
      selections: openMarket.selections,
    }),
  };
  delete (settledMarket as { quoteValidUntil?: string }).quoteValidUntil;

  await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 1,
      phase: EventPhase.FIRST_HALF,
      bettingStatus: BettingStatus.OPEN,
      markets: [openMarket],
    })
  );
  const changed = await service.upsertLiveEventMirror(
    createLiveUpdateEvent({
      eventId,
      sequence: 2,
      phase: EventPhase.FULL_TIME,
      bettingStatus: BettingStatus.CLOSED,
      markets: [settledMarket],
    })
  );

  // The current mirror legitimately changed (a new "current" snapshot was
  // applied), but the frozen historical entry for this triple must not have
  // been touched by it.
  expect(changed).toBe(true);

  const mirror = await LiveEventMirror.findOne({ eventId });
  const historyEntry = mirror!.marketHistory!.find(
    (entry) => entry.marketVersion === marketVersion && entry.quoteVersion === quoteVersion
  );

  expect(historyEntry?.status).toEqual(LiveMarketStatus.OPEN);
  expect(historyEntry?.quoteValidUntil).toEqual(openQuoteValidUntil);
});

it("safely resolves concurrent writers racing to persist history on a legacy mirror missing historyRevision, with no data loss or corruption", async () => {
  // Concurrency regression for the inferred-revision-0 CAS fix: two pods
  // processing different snapshots for the same legacy (historyRevision-
  // less) mirror concurrently must not exhaust retries, corrupt history, or
  // silently drop either snapshot's evidence -- exactly one writer's CAS can
  // apply at a time for any given historyRevision value, and bounded retries
  // let the loser observe the winner's write and safely layer its own
  // change on top.
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const baseMarket = createLiveMarket(eventId, {
    marketVersion: 500,
    quoteVersion: 1,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: new Date(Date.now() + 30_000).toISOString(),
  });
  const legacyMirror = createLiveUpdateEvent({
    eventId,
    sequence: 1,
    phase: EventPhase.FIRST_HALF,
    bettingStatus: BettingStatus.OPEN,
    markets: [baseMarket],
  }).data;

  await LiveEventMirror.collection.insertOne(legacyMirror as never);

  const marketB = createLiveMarket(eventId, {
    marketVersion: 501,
    quoteVersion: 1,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const marketC = createLiveMarket(eventId, {
    marketVersion: 502,
    quoteVersion: 1,
    status: LiveMarketStatus.OPEN,
    quoteValidUntil: new Date(Date.now() + 90_000).toISOString(),
  });

  const serviceA = new ModerationService(createPublisher());
  const serviceB = new ModerationService(createPublisher());

  const results = await Promise.all([
    serviceA.upsertLiveEventMirror(
      createLiveUpdateEvent({
        eventId,
        sequence: 2,
        phase: EventPhase.FIRST_HALF,
        bettingStatus: BettingStatus.OPEN,
        markets: [marketB],
      })
    ),
    serviceB.upsertLiveEventMirror(
      createLiveUpdateEvent({
        eventId,
        sequence: 3,
        phase: EventPhase.FIRST_HALF,
        bettingStatus: BettingStatus.OPEN,
        markets: [marketC],
      })
    ),
  ]);

  // Neither concurrent writer was lost.
  expect(results.some((result) => result === true)).toBe(true);

  const mirror = await LiveEventMirror.findOne({ eventId });
  const historyKeys = mirror!.marketHistory!.map(
    (entry) => `${entry.marketVersion}:${entry.quoteVersion}`
  );

  // The pre-update legacy quote plus both concurrently-delivered snapshots
  // are all present exactly once -- no loss, no duplication.
  expect(historyKeys.sort()).toEqual(["500:1", "501:1", "502:1"]);
  expect(new Set(historyKeys).size).toEqual(historyKeys.length);
  expect(mirror!.historyRevision).toBeGreaterThanOrEqual(1);
});
