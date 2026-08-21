import mongoose from "mongoose";
import {
  BetKind,
  ModerationStatus,
} from "@betstan/common";
import { Bet } from "../../model/Bet";
import { LiveEventMirror } from "../../model/LiveEventMirror";
import {
  ParkedPlaceBet,
  ParkedPlaceBetStatus,
} from "../../model/ParkedPlaceBet";
import BetModerationResultPublisher from "../../event/publisher/BetModerationResultPublisher";
import {
  createLiveMarket,
  createLivePlaceBetEvent,
  createLiveUpdateEvent,
  createPlaceBetEvent,
  createReplayContext,
} from "../../event/listener/__test__/helpers";

const createParkedPlaceBet = async (
  event: ReturnType<typeof createPlaceBetEvent>,
  overrides: Partial<{
    pendingEventIds: string[];
    status: ParkedPlaceBetStatus;
    attemptCount: number;
    nextAttemptAt: string;
    leaseOwner: string;
    leaseUntil: string;
    lastAttemptAt: string;
    lastError: string;
    exhaustedAt: string;
  }> = {}
) => {
  const rowEventIds = [...new Set(event.data.rows.map((row) => row.eventId))];

  await ParkedPlaceBet.create({
    slipId: event.data.slipId,
    event,
    pendingEventIds: overrides.pendingEventIds ?? rowEventIds,
    status: overrides.status ?? ParkedPlaceBetStatus.PENDING,
    attemptCount: overrides.attemptCount ?? 0,
    nextAttemptAt: overrides.nextAttemptAt ?? new Date().toISOString(),
    leaseOwner: overrides.leaseOwner ?? "",
    leaseUntil: overrides.leaseUntil ?? "",
    lastAttemptAt: overrides.lastAttemptAt ?? "",
    lastError: overrides.lastError ?? "",
    exhaustedAt: overrides.exhaustedAt ?? "",
  });
};

it("approves parked PRE_MATCH slips through the replay worker", async () => {
  const { worker } = await createReplayContext({ batchSize: 1 });
  const placeBet = createPlaceBetEvent({
    row: {
      eventTime: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  await createParkedPlaceBet(placeBet);
  await worker.runOnce();

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(savedBet!.betKind).toEqual(BetKind.PRE_MATCH);
  expect(await ParkedPlaceBet.findOne({ slipId: placeBet.data.slipId })).toBeNull();
});

it("coalesces duplicate parked slips by slip id", async () => {
  const { service } = await createReplayContext();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const placeBet = createLivePlaceBetEvent(createLiveMarket(eventId));

  await service.handlePlaceBet(placeBet);
  await service.handlePlaceBet(placeBet);

  const parkedPlaceBets = await ParkedPlaceBet.find({
    slipId: placeBet.data.slipId,
  });

  expect(parkedPlaceBets).toHaveLength(1);
  expect(parkedPlaceBets[0].status).toEqual(ParkedPlaceBetStatus.PENDING);
  expect(parkedPlaceBets[0].attemptCount).toEqual(0);
});

it("reschedules missing context with backoff and no premature decline", async () => {
  const { service, worker } = await createReplayContext({
    baseBackoffMs: 250,
    maxAttempts: 3,
  });
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const placeBet = createLivePlaceBetEvent(createLiveMarket(eventId));
  const beforeRun = new Date();

  await service.handlePlaceBet(placeBet);
  await worker.runOnce();

  const parkedPlaceBet = await ParkedPlaceBet.findOne({
    slipId: placeBet.data.slipId,
  });
  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(parkedPlaceBet).not.toBeNull();
  expect(parkedPlaceBet!.status).toEqual(ParkedPlaceBetStatus.PENDING);
  expect(parkedPlaceBet!.attemptCount).toEqual(1);
  expect(new Date(parkedPlaceBet!.nextAttemptAt).getTime()).toBeGreaterThan(
    beforeRun.getTime()
  );
  expect(parkedPlaceBet!.lastError).toEqual("Awaiting moderation context");
  expect(parkedPlaceBet!.lastError).not.toContain("\n");
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.RECEIVED);
  expect(
    BetModerationResultPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
});

it.each([
  {
    name: "the configured attempt budget is spent",
    options: {
      maxAttempts: 1,
      maxAgeMs: 60_000,
    },
  },
  {
    name: "the configured age budget is spent",
    options: {
      maxAttempts: 5,
      maxAgeMs: 0,
    },
  },
])( "exhausts parked slips once $name", async ({ options }) => {
  const { service, worker } = await createReplayContext(options);
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const placeBet = createLivePlaceBetEvent(createLiveMarket(eventId));

  await service.handlePlaceBet(placeBet);
  await worker.runOnce();

  const parkedPlaceBet = await ParkedPlaceBet.findOne({
    slipId: placeBet.data.slipId,
  });
  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(parkedPlaceBet).not.toBeNull();
  expect(parkedPlaceBet!.status).toEqual(ParkedPlaceBetStatus.EXHAUSTED);
  expect(parkedPlaceBet!.exhaustedAt).not.toEqual("");
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.RECEIVED);
  expect(
    BetModerationResultPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
});

it("respects batch limits while draining due parked slips", async () => {
  const { worker } = await createReplayContext({ batchSize: 2 });
  const placeBetOne = createPlaceBetEvent({
    row: {
      eventTime: new Date(Date.now() + 60_000).toISOString(),
    },
  });
  const placeBetTwo = createPlaceBetEvent({
    row: {
      eventTime: new Date(Date.now() + 120_000).toISOString(),
    },
  });
  const placeBetThree = createPlaceBetEvent({
    row: {
      eventTime: new Date(Date.now() + 180_000).toISOString(),
    },
  });

  await createParkedPlaceBet(placeBetOne);
  await createParkedPlaceBet(placeBetTwo);
  await createParkedPlaceBet(placeBetThree);

  const processed = await worker.runOnce();

  expect(processed).toEqual(2);
  expect(await Bet.countDocuments({ status: ModerationStatus.APPROVED })).toEqual(2);
  expect(await ParkedPlaceBet.countDocuments({})).toEqual(1);
});

it("uses leases to prevent concurrent replay claims", async () => {
  const { service, worker } = await createReplayContext({
    leaseDurationMs: 60_000,
  });
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const placeBet = createLivePlaceBetEvent(createLiveMarket(eventId));

  await service.handlePlaceBet(placeBet);

  const claimedPlaceBet = await service.claimParkedPlaceBet(
    "owner-one",
    60_000,
    new Date()
  );
  const processed = await worker.runOnce();
  const parkedPlaceBet = await ParkedPlaceBet.findOne({
    slipId: placeBet.data.slipId,
  });

  expect(claimedPlaceBet).not.toBeNull();
  expect(processed).toEqual(0);
  expect(parkedPlaceBet).not.toBeNull();
  expect(parkedPlaceBet!.status).toEqual(ParkedPlaceBetStatus.PROCESSING);
  expect(parkedPlaceBet!.leaseOwner).toEqual("owner-one");
});

it("recovers stale leases immediately when the worker starts", async () => {
  const { worker } = await createReplayContext({ pollIntervalMs: 60_000 });
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = createLiveMarket(eventId, {
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const placeBet = createLivePlaceBetEvent(market);

  await LiveEventMirror.create(
    createLiveUpdateEvent({
      eventId,
      markets: [market],
    }).data
  );
  await createParkedPlaceBet(placeBet, {
    status: ParkedPlaceBetStatus.PROCESSING,
    attemptCount: 1,
    nextAttemptAt: new Date(Date.now() - 10_000).toISOString(),
    leaseOwner: "dead-owner",
    leaseUntil: new Date(Date.now() - 1_000).toISOString(),
    lastAttemptAt: new Date(Date.now() - 10_000).toISOString(),
  });

  await worker.start();

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(await ParkedPlaceBet.findOne({ slipId: placeBet.data.slipId })).toBeNull();
  expect(worker.isRunning()).toEqual(true);

  await worker.stop();
  await worker.stop();

  expect(worker.isRunning()).toEqual(false);
});

it("surfaces startup failures with explicit errors and leaves shutdown idempotent", async () => {
  const { worker } = await createReplayContext();
  const runOnceSpy = jest
    .spyOn(worker, "runOnce")
    .mockRejectedValueOnce(new Error("boom startup"));

  await expect(worker.start()).rejects.toThrow(
    "Failed to start parked place bet replay worker: boom startup"
  );

  expect(worker.isRunning()).toEqual(false);

  await worker.stop();
  await worker.stop();
  runOnceSpy.mockRestore();
});
