import { BetKind, ModerationStatus } from "@betstan/common";
import { Bet } from "../../model/Bet";
import { ParkedPlaceBet, ParkedPlaceBetStatus } from "../../model/ParkedPlaceBet";
import ModerationService, { ModerationPublisher } from "../ModerationService";
import {
  createDeferred,
  createPlaceBetEvent,
} from "../../event/listener/__test__/helpers";

const createPublisher = () => ({
  publishWithConfirm: jest.fn(async () => undefined),
}) as unknown as ModerationPublisher & {
  publishWithConfirm: jest.Mock<Promise<void>, [unknown]>;
};

const createDecidedBet = async (
  event: ReturnType<typeof createPlaceBetEvent>,
  overrides: Partial<{
    publishedAt: string;
    publishToken: string;
    publishLeaseOwner: string;
    publishLeaseUntil: string;
  }> = {}
) => {
  const betKind = event.data.betKind ?? BetKind.PRE_MATCH;
  await Bet.create({
    userId: event.data.userId,
    slipId: event.data.slipId,
    status: ModerationStatus.APPROVED,
    wager: event.data.wager,
    timestamp: event.timestamp ?? new Date().toISOString(),
    moderationTimestamp: new Date().toISOString(),
    publishedAt: overrides.publishedAt ?? "",
    publishToken: overrides.publishToken ?? "",
    publishLeaseOwner: overrides.publishLeaseOwner ?? "",
    publishLeaseUntil: overrides.publishLeaseUntil ?? "",
    betKind,
    affectedRows: [],
    rows: event.data.rows.map((row) => ({
      ...row,
      betKind: row.betKind ?? betKind,
    })),
  });
};

const createParkedRecord = async (
  event: ReturnType<typeof createPlaceBetEvent>
) => {
  await ParkedPlaceBet.create({
    slipId: event.data.slipId,
    event,
    pendingEventIds: [...new Set(event.data.rows.map((row) => row.eventId))],
    status: ParkedPlaceBetStatus.PENDING,
    attemptCount: 0,
    nextAttemptAt: new Date().toISOString(),
    leaseOwner: "",
    leaseUntil: "",
    lastAttemptAt: "",
    lastError: "",
    exhaustedAt: "",
  });
};

const sleep = async (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

it("reclaims stale publication leases and redelivers crash-window decisions", async () => {
  const publisher = createPublisher();
  const service = new ModerationService(publisher, {
    publicationLeaseOwner: "recovery-owner",
    publicationLeaseDurationMs: 50,
    publicationLeaseHeartbeatMs: 10,
  });
  const event = createPlaceBetEvent({
    data: {
      betKind: BetKind.PRE_MATCH,
    },
    row: {
      eventTime: undefined,
    },
  });

  await createDecidedBet(event, {
    publishToken: "stale-token",
    publishLeaseOwner: "dead-owner",
    publishLeaseUntil: new Date(Date.now() - 1_000).toISOString(),
  });
  await createParkedRecord(event);

  await service.handlePlaceBet(event);

  const savedBet = await Bet.findOne({ slipId: event.data.slipId });

  expect(publisher.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(savedBet).not.toBeNull();
  expect(savedBet!.publishedAt).not.toEqual("");
  expect(savedBet!.publishToken).toEqual("");
  expect(savedBet!.publishLeaseOwner).toEqual("");
  expect(savedBet!.publishLeaseUntil).toEqual("");
  expect(await ParkedPlaceBet.findOne({ slipId: event.data.slipId })).toBeNull();
});

it("reclaims old unpublished decisions even when lease fields are missing", async () => {
  const publisher = createPublisher();
  const service = new ModerationService(publisher, {
    publicationLeaseOwner: "legacy-reclaimer",
  });
  const event = createPlaceBetEvent({
    data: {
      betKind: BetKind.PRE_MATCH,
    },
    row: {
      eventTime: undefined,
    },
  });
  const betKind = event.data.betKind ?? BetKind.PRE_MATCH;

  await Bet.collection.insertOne({
    userId: event.data.userId,
    slipId: event.data.slipId,
    status: ModerationStatus.APPROVED,
    wager: event.data.wager,
    timestamp: event.timestamp ?? new Date().toISOString(),
    moderationTimestamp: new Date().toISOString(),
    publishedAt: "",
    publishToken: "legacy-token",
    betKind,
    affectedRows: [],
    rows: event.data.rows.map((row) => ({
      ...row,
      betKind: row.betKind ?? betKind,
    })),
  });

  await service.handlePlaceBet(event);

  const savedBet = await Bet.findOne({ slipId: event.data.slipId });

  expect(publisher.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(savedBet).not.toBeNull();
  expect(savedBet!.publishedAt).not.toEqual("");
  expect(savedBet!.publishToken).toEqual("");
  expect(savedBet!.publishLeaseOwner).toEqual("");
  expect(savedBet!.publishLeaseUntil).toEqual("");
});

it("heartbeats slow confirms so competing services cannot steal the decision", async () => {
  const publisherOne = createPublisher();
  const publisherTwo = createPublisher();
  const publishRelease = createDeferred<void>();
  const publishStarted = createDeferred<void>();
  const serviceOne = new ModerationService(publisherOne, {
    publicationLeaseOwner: "publisher-one",
    publicationLeaseDurationMs: 40,
    publicationLeaseHeartbeatMs: 10,
  });
  const serviceTwo = new ModerationService(publisherTwo, {
    publicationLeaseOwner: "publisher-two",
    publicationLeaseDurationMs: 40,
    publicationLeaseHeartbeatMs: 10,
  });
  const event = createPlaceBetEvent({
    data: {
      betKind: BetKind.PRE_MATCH,
    },
    row: {
      eventTime: undefined,
    },
  });

  publisherOne.publishWithConfirm.mockImplementationOnce(async () => {
    publishStarted.resolve();
    await publishRelease.promise;
  });

  const firstPublish = serviceOne.handlePlaceBet(event);
  await publishStarted.promise;
  await sleep(120);
  await serviceTwo.handlePlaceBet(event);

  expect(publisherOne.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(publisherTwo.publishWithConfirm).not.toHaveBeenCalled();

  publishRelease.resolve();
  await firstPublish;

  const savedBet = await Bet.findOne({ slipId: event.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.publishedAt).not.toEqual("");
});

it("does not overwrite another owner's publication lease after ownership loss", async () => {
  const publisher = createPublisher();
  const publishRelease = createDeferred<void>();
  const publishStarted = createDeferred<void>();
  const service = new ModerationService(publisher, {
    publicationLeaseOwner: "publisher-one",
    publicationLeaseDurationMs: 1_000,
    publicationLeaseHeartbeatMs: 500,
  });
  const event = createPlaceBetEvent({
    data: {
      betKind: BetKind.PRE_MATCH,
    },
    row: {
      eventTime: undefined,
    },
  });

  publisher.publishWithConfirm.mockImplementationOnce(async () => {
    publishStarted.resolve();
    await publishRelease.promise;
  });

  const inFlightPublish = service.handlePlaceBet(event);
  await publishStarted.promise;
  await Bet.updateOne(
    { slipId: event.data.slipId },
    {
      $set: {
        publishToken: "other-token",
        publishLeaseOwner: "publisher-two",
        publishLeaseUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    }
  );

  publishRelease.resolve();
  await inFlightPublish;

  const savedBet = await Bet.findOne({ slipId: event.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.publishedAt).toEqual("");
  expect(savedBet!.publishToken).toEqual("other-token");
  expect(savedBet!.publishLeaseOwner).toEqual("publisher-two");
});
