import mongoose from "mongoose";
import { messengerWrapper, BetKind, SlipStatus } from "@betstan/common";
import PlaceBetEventPublisher from "../../event/publisher/PlaceBetEventPublisher";
import { Slip } from "../../model/Slip";
import { SlipPublicationState } from "../../model/SlipPublicationState";
import { SlipSubmissionWorker } from "../SlipSubmissionWorker";

const buildPlacementAttemptId = (label: string) =>
  `placement-attempt-${label}`;

const buildRow = ({
  betKind = BetKind.PRE_MATCH,
  marketId = "event-one:NEXT_CORNER",
  marketVersion = 1,
  quoteVersion = 1,
}: {
  betKind?: BetKind;
  marketId?: string;
  marketVersion?: number;
  quoteVersion?: number;
} = {}) => {
  const rowId = new mongoose.Types.ObjectId();

  return {
    _id: rowId,
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
          marketId,
          marketVersion,
          quoteVersion,
          selectionId: `${marketId}:${marketVersion}:HOME`,
        }
      : {}),
  };
};

const buildSubmittedEventRows = (rows: ReturnType<typeof buildRow>[]) =>
  rows.map((row) => ({
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
  }));

const createSubmittedSlip = async ({
  userId = new mongoose.Types.ObjectId().toHexString(),
  betKind = BetKind.PRE_MATCH,
  rows = [buildRow({ betKind })],
  publication,
  submittedAt = new Date().toISOString(),
  placementAttemptId,
}: {
  userId?: string;
  betKind?: BetKind;
  rows?: ReturnType<typeof buildRow>[];
  publication?: Record<string, unknown>;
  submittedAt?: string;
  placementAttemptId?: string;
} = {}) => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const slip = new Slip({
    _id: slipId,
    userId,
    betKind,
    draftKey: betKind,
    status: SlipStatus.SUBMITTED,
    timestamp: submittedAt,
    submittedAt,
    submittedEvent: {
      userId,
      userName: `${userId}@example.com`,
      slipId,
      placementAttemptId:
        placementAttemptId ?? buildPlacementAttemptId(slipId),
      wager: 5,
      rows: buildSubmittedEventRows(rows),
      betKind,
    },
    publication: {
      state: SlipPublicationState.PENDING,
      attemptCount: 0,
      nextAttemptAt: submittedAt,
      ...publication,
    },
    rows,
  });
  await slip.save();
  return slip;
};

afterEach(() => {
  jest.useRealTimers();
});

it("keeps the slip submitted, times out unknown delivery, and retries the same payload successfully", async () => {
  const publishWithConfirmMock =
    PlaceBetEventPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirmMock.mockImplementationOnce(
    () => new Promise<void>(() => undefined)
  );

  const placementAttemptId = buildPlacementAttemptId("worker-timeout");
  const slip = await createSubmittedSlip({
    betKind: BetKind.LIVE,
    placementAttemptId,
  });
  const worker = new SlipSubmissionWorker(messengerWrapper.connection, {
    confirmTimeoutMs: 5,
    baseBackoffMs: 0,
    maxBackoffMs: 0,
  });
  await worker.init();

  const firstAttempt = await worker.publishSlipNow(slip.id);
  expect(firstAttempt).toEqual({
    claimed: true,
    outcome: "rescheduled",
  });

  const pendingSlip = await Slip.findById(slip.id);
  expect(pendingSlip!.status).toEqual(SlipStatus.SUBMITTED);
  expect(pendingSlip!.publication?.state).toEqual(SlipPublicationState.PENDING);
  expect(pendingSlip!.publication?.attemptCount).toEqual(1);
  expect(pendingSlip!.publication?.lastError).toEqual("Publish confirm timed out");
  expect(pendingSlip!.submittedEvent?.slipId).toEqual(slip.id);
  expect(pendingSlip!.submittedEvent?.placementAttemptId).toEqual(
    placementAttemptId
  );

  publishWithConfirmMock.mockResolvedValueOnce(undefined);
  await worker.replayDueSubmissions();

  const publishedSlip = await Slip.findById(slip.id);
  expect(publishedSlip!.publication?.state).toEqual(SlipPublicationState.PUBLISHED);
  expect(publishedSlip!.publication?.attemptCount).toEqual(2);
  expect(publishWithConfirmMock).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      data: expect.objectContaining({
        slipId: slip.id,
        placementAttemptId,
        wager: 5,
      }),
    })
  );

  await worker.stop();
});

it("reclaims a stale processing lease on replay and publishes the submitted attempt", async () => {
  const publishWithConfirmMock =
    PlaceBetEventPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirmMock.mockResolvedValueOnce(undefined);

  const staleSubmittedAt = new Date(Date.now() - 60_000).toISOString();
  const placementAttemptId = buildPlacementAttemptId("worker-stale-lease");
  const slip = await createSubmittedSlip({
    betKind: BetKind.LIVE,
    placementAttemptId,
    submittedAt: staleSubmittedAt,
    publication: {
      state: SlipPublicationState.PROCESSING,
      attemptCount: 1,
      leaseOwner: "stale-worker",
      leaseUntil: new Date(Date.now() - 1_000).toISOString(),
    },
  });
  const worker = new SlipSubmissionWorker(messengerWrapper.connection, {
    confirmTimeoutMs: 5,
    baseBackoffMs: 0,
    maxBackoffMs: 0,
  });
  await worker.init();

  await worker.replayDueSubmissions();

  const publishedSlip = await Slip.findById(slip.id);
  expect(publishedSlip!.publication?.state).toEqual(SlipPublicationState.PUBLISHED);
  expect(publishedSlip!.publication?.attemptCount).toEqual(2);
  expect(publishedSlip!.submittedEvent?.placementAttemptId).toEqual(
    placementAttemptId
  );
  expect(publishWithConfirmMock).toHaveBeenCalledTimes(1);
  expect(publishWithConfirmMock).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        slipId: slip.id,
        placementAttemptId,
      }),
    })
  );

  await worker.stop();
});

it("heartbeats an in-flight submission lease while waiting for broker confirm", async () => {
  let resolvePublish: (() => void) | undefined;
  const publishWithConfirmMock =
    PlaceBetEventPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirmMock.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        resolvePublish = resolve;
      })
  );

  const slip = await createSubmittedSlip({ betKind: BetKind.LIVE });
  const worker = new SlipSubmissionWorker(messengerWrapper.connection, {
    heartbeatIntervalMs: 5,
    leaseDurationMs: 15,
    confirmTimeoutMs: 100,
    baseBackoffMs: 0,
    maxBackoffMs: 0,
  });
  await worker.init();

  const publishPromise = worker.publishSlipNow(slip.id);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const processingSlip = await Slip.findById(slip.id);
  expect(processingSlip!.publication?.state).toEqual(
    SlipPublicationState.PROCESSING
  );
  expect(processingSlip!.publication?.heartbeatAt).toBeTruthy();
  expect(processingSlip!.publication?.leaseUntil).toBeTruthy();
  expect(
    Date.parse(processingSlip!.publication!.leaseUntil!)
      > Date.parse(processingSlip!.publication!.lastAttemptAt!)
  ).toBe(true);

  if (resolvePublish) {
    resolvePublish();
  }
  await publishPromise;

  const publishedSlip = await Slip.findById(slip.id);
  expect(publishedSlip!.publication?.state).toEqual(SlipPublicationState.PUBLISHED);

  await worker.stop();
});

it("marks submissions exhausted when retries or age exceed the configured bounds", async () => {
  const publishWithConfirmMock =
    PlaceBetEventPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirmMock.mockRejectedValueOnce(new Error("confirm unavailable"));

  const exhaustedByAttempts = await createSubmittedSlip({
    publication: {
      state: SlipPublicationState.PENDING,
      attemptCount: 4,
      nextAttemptAt: new Date().toISOString(),
    },
  });
  const worker = new SlipSubmissionWorker(messengerWrapper.connection, {
    maxAttempts: 5,
    confirmTimeoutMs: 5,
    baseBackoffMs: 0,
    maxBackoffMs: 0,
  });
  await worker.init();

  const exhaustedResult = await worker.publishSlipNow(exhaustedByAttempts.id);
  expect(exhaustedResult).toEqual({
    claimed: true,
    outcome: "exhausted",
  });

  const exhaustedSlip = await Slip.findById(exhaustedByAttempts.id);
  expect(exhaustedSlip!.publication?.state).toEqual(SlipPublicationState.EXHAUSTED);
  expect(exhaustedSlip!.publication?.exhaustedAt).toBeTruthy();
  expect(exhaustedSlip!.publication?.lastError).toEqual("confirm unavailable");

  const publishNeverCalledSlip = await createSubmittedSlip({
    submittedAt: new Date(Date.now() - 120_000).toISOString(),
  });
  publishWithConfirmMock.mockClear();

  const ageBoundedWorker = new SlipSubmissionWorker(messengerWrapper.connection, {
    maxAgeMs: 1_000,
    confirmTimeoutMs: 5,
  });
  await ageBoundedWorker.init();

  await ageBoundedWorker.publishSlipNow(publishNeverCalledSlip.id);

  const ageExhaustedSlip = await Slip.findById(publishNeverCalledSlip.id);
  expect(ageExhaustedSlip!.publication?.state).toEqual(
    SlipPublicationState.EXHAUSTED
  );
  expect(publishWithConfirmMock).not.toHaveBeenCalled();

  await ageBoundedWorker.stop();
  await worker.stop();
});
