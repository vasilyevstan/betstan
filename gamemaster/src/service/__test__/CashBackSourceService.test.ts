import {
  BetKind, BettingStatus, CashBackSourceReleaseRequest, CashBackSourceReserveRequest,
  CashBackSourceSnapshotRequest, EventPhase, EventStatus, ILiveEventUpdateEvent,
  LiveMarketStatus, LiveMarketType, TeamSide,
} from "@betstan/common";
import { Event } from "../../model/Event";
import { EventArchive } from "../../model/EventArchive";
import { GamemasterWorker } from "../../worker/GamemasterWorker";
import LiveEventUpdatePublisher from "../../event/publisher/LiveEventUpdatePublisher";
import ResultSetPublisher from "../../event/publisher/ResultSetPublisher";
import { handleCashBackSourceRequest } from "../CashBackSourceService";

beforeAll(() => {
  jest.spyOn(LiveEventUpdatePublisher.prototype, "init").mockResolvedValue(undefined);
  jest.spyOn(LiveEventUpdatePublisher.prototype, "initConfirmChannel").mockResolvedValue(undefined);
  jest.spyOn(LiveEventUpdatePublisher.prototype, "publishWithConfirm").mockResolvedValue(undefined);
  jest.spyOn(ResultSetPublisher.prototype, "init").mockResolvedValue(undefined);
  jest.spyOn(ResultSetPublisher.prototype, "initConfirmChannel").mockResolvedValue(undefined);
  jest.spyOn(ResultSetPublisher.prototype, "publishWithConfirm").mockResolvedValue(undefined);
});

const snapshotRequest = (
  operationId = "one", betKind = BetKind.LIVE
): CashBackSourceSnapshotRequest => ({
  action: "SNAPSHOT", requestId: `snapshot-${operationId}`,
  requestedAt: new Date().toISOString(),
  participant: { owner: "GAMEMASTER", eventId: "event-one" },
  operation: {
    operationId, clientOperationId: `client-${operationId}`, fingerprint: `fingerprint-${operationId}`,
    userId: "user-one", slipId: "slip-one", betKind,
  },
  selections: betKind === BetKind.LIVE ? [{
    betKind, eventId: "event-one", slipRowId: "row-one", productId: "score", oddsId: "score-zero",
    marketId: "score", marketType: LiveMarketType.SECOND_HALF_SCORE,
    marketVersion: 2, selectionId: "score-zero",
  }] : [{
    betKind, eventId: "event-one", slipRowId: "row-one", productId: "1X2", oddsId: "home",
  }],
});

const createLiveEvent = async () => {
  const now = Date.now();
  const snapshot: ILiveEventUpdateEvent["data"] = {
    eventId: "event-one", sequence: 5, occurredAt: new Date(now - 1_000).toISOString(),
    kickoffAt: new Date(now - 60_000).toISOString(), minute: 70,
    phase: EventPhase.SECOND_HALF, homeScore: 0, awayScore: 0, bettingStatus: BettingStatus.OPEN,
    markets: [{
      marketId: "score", marketType: LiveMarketType.SECOND_HALF_SCORE,
      marketVersion: 2, quoteVersion: 4, quoteValidUntil: new Date(now + 60_000).toISOString(),
      status: LiveMarketStatus.OPEN,
      selections: [
        { selectionId: "score-zero", side: TeamSide.NONE, odds: 3 },
        { selectionId: "score-one", side: TeamSide.NONE, odds: 6 },
      ],
    }],
    settlements: [],
  };
  return Event.create({
    eventId: "event-one", name: "A - B", home: "A", away: "B",
    time: new Date(now - 60_000), status: EventStatus.NO_RESULT,
    phase: EventPhase.SECOND_HALF, liveSequence: 5, liveConfirmedReplayCursor: 5,
    cashBackAuthoritySnapshot: snapshot,
    liveSeed: "private-fixture-seed", liveTimeline: { futureOutcome: "not-public" },
    liveTransitions: [{ markets: [{ selections: [{ odds: 9999 }] }] }],
  });
};

const reserveRequest = async (
  operationId = "one", betKind = BetKind.LIVE
): Promise<CashBackSourceReserveRequest> => {
  const request = snapshotRequest(operationId, betKind);
  const reply = await handleCashBackSourceRequest(request);
  if (reply.outcome !== "SNAPSHOT") throw new Error(`Unexpected snapshot ${reply.outcome}`);
  return {
    action: "RESERVE", requestId: `reserve-${operationId}`, operation: request.operation,
    participant: request.participant, requestedAt: new Date().toISOString(),
    expected: reply.snapshot, grantedGeneration: reply.snapshot.baseGeneration + 1,
    deadline: new Date(Date.now() + 7_000).toISOString(),
    quote: {
      quoteId: `quote-${operationId}`, quoteFingerprint: `quote-fingerprint-${operationId}`,
      expectedRevision: 0, originalManifestFingerprint: "manifest",
    },
  };
};

const releaseRequest = (reserve: CashBackSourceReserveRequest): CashBackSourceReleaseRequest => ({
  action: "RELEASE", requestId: `release-${reserve.operation.operationId}`,
  reserveRequestId: reserve.requestId, operation: reserve.operation, participant: reserve.participant,
  requestedAt: new Date().toISOString(), baseGeneration: reserve.expected.baseGeneration,
  grantedGeneration: reserve.grantedGeneration,
  decision: {
    issuer: "RESULTING", decisionId: `decision-${reserve.operation.operationId}`,
    receiptFingerprint: "receipt-fingerprint", outcome: "REJECTED",
    quoteId: reserve.quote.quoteId, quoteFingerprint: reserve.quote.quoteFingerprint,
    expectedRevision: 0, revision: 1, decisionTime: new Date().toISOString(),
  },
});

it("quotes the exact current selection without reading future prices or exposing private simulation data", async () => {
  await createLiveEvent();
  const reply = await handleCashBackSourceRequest(snapshotRequest());
  expect(reply).toMatchObject({
    outcome: "SNAPSHOT",
    snapshot: { evidence: { quoteEvidence: { quotes: [{ selectionId: "score-zero", odds: "3" }] } } },
  });
  expect(JSON.stringify(reply)).not.toContain("private-fixture-seed");
  expect(JSON.stringify(reply)).not.toContain("not-public");
  expect(JSON.stringify(reply)).not.toContain("9999");
});

it("rejects a resolved original market even while the match remains live", async () => {
  await createLiveEvent();
  await Event.updateOne({ eventId: "event-one" }, {
    $set: { "cashBackAuthoritySnapshot.markets.0.status": LiveMarketStatus.SETTLED },
  });
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({
    outcome: "DENIED", reason: "RESOLVED",
  });
});

it.each([
  [LiveMarketStatus.SUSPENDED, "SUSPENDED"],
  [LiveMarketStatus.CLOSED, "QUOTE_CHANGED"],
])("does not claim an unresolved %s market is settled", async (status, reason) => {
  await createLiveEvent();
  await Event.updateOne({ eventId: "event-one" }, {
    $set: { "cashBackAuthoritySnapshot.markets.0.status": status },
  });
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({ outcome: "DENIED", reason });
});

it("treats missing market lineage as unknown rather than proof of settlement", async () => {
  await createLiveEvent();
  await Event.updateOne({ eventId: "event-one" }, {
    $set: { "cashBackAuthoritySnapshot.markets": [] },
  });
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({
    outcome: "DENIED", reason: "UNKNOWN_AUTHORITY",
  });
});

it("requires a fresh quote when quoteVersion changes even at the same odds", async () => {
  await createLiveEvent();
  const reserve = await reserveRequest();
  await Event.updateOne({ eventId: "event-one" }, {
    $set: { "cashBackAuthoritySnapshot.markets.0.quoteVersion": 5 },
  });
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({
    outcome: "DENIED", reason: "AUTHORITY_CHANGED",
  });
});

it("reserves exactly once, replays its persisted grant and releases without needing its ACK", async () => {
  await createLiveEvent();
  const reserve = await reserveRequest();
  const grant = await handleCashBackSourceRequest(reserve);
  expect(grant).toMatchObject({ outcome: "GRANTED", grantedGeneration: 1 });
  if (grant.outcome !== "GRANTED") throw new Error("Missing grant");
  expect(Date.parse(grant.decisionTime)).toBeLessThan(Date.parse(reserve.deadline));
  expect(await handleCashBackSourceRequest(reserve)).toEqual(grant);
  expect(await handleCashBackSourceRequest(releaseRequest(reserve))).toMatchObject({
    outcome: "RELEASED", fenceGeneration: 2,
  });
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({ outcome: "DENIED" });
});

it("cancels an unused generation and preserves a different newer hold", async () => {
  await createLiveEvent();
  const old = await reserveRequest();
  const release = releaseRequest(old);
  expect(await handleCashBackSourceRequest(release)).toMatchObject({ outcome: "FENCED", fenceGeneration: 2 });
  const next = await reserveRequest("next");
  const grant = await handleCashBackSourceRequest(next);
  expect(await handleCashBackSourceRequest(release)).toMatchObject({
    outcome: "FENCED", observedGeneration: 3,
  });
  expect(await handleCashBackSourceRequest(next)).toEqual(grant);
});

it("fails closed on a regressed generation rather than replaying stale grant authority", async () => {
  await createLiveEvent();
  const reserve = await reserveRequest();
  await handleCashBackSourceRequest(reserve);
  await Event.updateOne({ eventId: "event-one" }, { $set: { cashBackGeneration: 0 } });
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({
    outcome: "DENIED", reason: "PROTOCOL_ERROR",
  });
});

it("does not recreate an absent or archived source", async () => {
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({
    outcome: "DENIED", reason: "MISSING",
  });
  await EventArchive.create({
    eventId: "event-one", name: "A - B", home: "A", away: "B",
    time: new Date().toISOString(), status: EventStatus.RESULTED,
  });
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({
    outcome: "DENIED", reason: "ARCHIVED",
  });
  expect(await Event.countDocuments()).toBe(0);
});

it("rejects expired deadlines and exhausted generations without consuming a hold", async () => {
  await createLiveEvent();
  const reserve = await reserveRequest();
  expect(await handleCashBackSourceRequest({
    ...reserve, deadline: reserve.expected.observedAt,
  })).toMatchObject({ outcome: "DENIED", reason: "DEADLINE_REACHED" });
  await Event.updateOne({ eventId: "event-one" }, { $set: { cashBackGeneration: Number.MAX_SAFE_INTEGER } });
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({
    outcome: "DENIED", reason: "GENERATION_EXHAUSTED",
  });
});

it("persists authority intent before publication and refuses snapshots while publication is paused", async () => {
  await Event.create({
    eventId: "event-one", name: "A - B", home: "A", away: "B",
    time: new Date(Date.now() + 60_000), status: EventStatus.NO_RESULT, phase: EventPhase.PRE_MATCH,
  });
  expect((await handleCashBackSourceRequest(snapshotRequest("one", BetKind.PRE_MATCH))).outcome).toBe("SNAPSHOT");
  let entered!: () => void;
  let release!: () => void;
  const publishing = new Promise<void>(resolve => { entered = resolve; });
  const paused = new Promise<void>(resolve => { release = resolve; });
  jest.spyOn(LiveEventUpdatePublisher.prototype, "publishWithConfirm")
    .mockImplementationOnce(async () => { entered(); await paused; });
  const worker = new GamemasterWorker({ liveKickoffsEnabled: () => true });
  const tick = worker.checkEventsOnce();
  await publishing;
  try {
    const stored = await Event.findOne({ eventId: "event-one" }).select("+cashBackAuthorityIntent");
    expect(stored?.cashBackAuthorityIntent?.kind).toBe("LIVE");
    expect(await handleCashBackSourceRequest(snapshotRequest("during", BetKind.PRE_MATCH)))
      .toMatchObject({ outcome: "DENIED", reason: "AUTHORITY_CHANGE_PENDING" });
  } finally {
    release();
  }
  await tick;
  expect((await handleCashBackSourceRequest(snapshotRequest("after", BetKind.PRE_MATCH))).outcome).toBe("SNAPSHOT");
});

it("recovers the same persisted publication after restart without regenerating its intent", async () => {
  await Event.create({
    eventId: "event-one", name: "A - B", home: "A", away: "B",
    time: new Date(Date.now() + 60_000), status: EventStatus.NO_RESULT, phase: EventPhase.PRE_MATCH,
  });
  const publisher = jest.spyOn(LiveEventUpdatePublisher.prototype, "publishWithConfirm");
  publisher.mockRejectedValueOnce(new Error("broker unavailable"));
  await expect(new GamemasterWorker({ liveKickoffsEnabled: () => true }).checkEventsOnce())
    .rejects.toThrow("broker unavailable");
  const pending = await Event.findOne({ eventId: "event-one" }).select("+cashBackAuthorityIntent");
  const original = pending?.cashBackAuthorityIntent;
  expect(original?.kind).toBe("LIVE");
  publisher.mockResolvedValue(undefined);
  await new GamemasterWorker({ liveKickoffsEnabled: () => true }).checkEventsOnce();
  expect(publisher.mock.calls[publisher.mock.calls.length - 1]?.[0].data).toEqual(original?.message?.data);
  const recovered = await Event.findOne({ eventId: "event-one" }).select("+cashBackAuthorityIntent");
  expect(recovered?.cashBackAuthorityIntent).toBeUndefined();
});

it("recovers archival after terminalization and retains the source generation tombstone", async () => {
  await Event.create({
    eventId: "event-one", name: "A - B", home: "A", away: "B",
    time: new Date(Date.now() - 60_000), status: EventStatus.RESULTED,
    phase: EventPhase.FULL_TIME, homeResult: 1, awayResult: 0,
    resultPublishedAt: new Date(), cashBackGeneration: 2, cashBackAuthorityRevision: 1,
    cashBackAuthorityAt: new Date(), cashBackArchivePending: true,
  });
  await new GamemasterWorker({ liveKickoffsEnabled: () => true }).checkEventsOnce();
  const stored = await Event.findOne({ eventId: "event-one" })
    .select("+cashBackGeneration +cashBackArchived +cashBackArchivePending");
  expect(stored?.cashBackGeneration).toBe(2);
  expect(stored?.cashBackArchived).toBe(true);
  expect(stored?.cashBackArchivePending).toBeUndefined();
  expect(await EventArchive.exists({ eventId: "event-one" })).toBeTruthy();
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({
    outcome: "DENIED", reason: "ARCHIVED",
  });
  expect(LiveEventUpdatePublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
  expect(ResultSetPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});
