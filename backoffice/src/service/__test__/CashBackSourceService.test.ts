import request from "supertest";
import {
  BetKind,
  CashBackSourceReleaseRequest,
  CashBackSourceReserveRequest,
  CashBackSourceSnapshotRequest,
  EventStatus,
  EventVisibility,
} from "@betstan/common";
import { app } from "../../app";
import { Event } from "../../model/Event";
import * as cashBackSettingModel from "../../model/CashBackSetting";
import ResultSetPublisher from "../../event/publisher/ResultSetPublisher";
import { handleCashBackSourceRequest } from "../CashBackSourceService";

const snapshotRequest = (operationId = "operation-one"): CashBackSourceSnapshotRequest => ({
  action: "SNAPSHOT",
  requestId: `snapshot-${operationId}`,
  requestedAt: new Date().toISOString(),
  participant: { owner: "BACKOFFICE", eventId: "event-one" },
  operation: {
    operationId,
    clientOperationId: `client-${operationId}`,
    fingerprint: `fingerprint-${operationId}`,
    userId: "user-one",
    slipId: "slip-one",
    betKind: BetKind.PRE_MATCH,
  },
  selections: [{
    betKind: BetKind.PRE_MATCH,
    eventId: "event-one",
    slipRowId: "row-one",
    productId: "product-one",
    oddsId: "odds-one",
  }],
});

const createEvent = async () => Event.create({
  eventId: "event-one",
  name: "A - B",
  home: "A",
  away: "B",
  time: new Date(Date.now() + 60_000).toISOString(),
  status: EventStatus.NO_RESULT,
  visibility: EventVisibility.ONLINE,
});

const reserveRequest = async (operationId = "operation-one"): Promise<CashBackSourceReserveRequest> => {
  const snapshot = snapshotRequest(operationId);
  const reply = await handleCashBackSourceRequest(snapshot);
  if (reply.outcome !== "SNAPSHOT") throw new Error(`Unexpected snapshot ${reply.outcome}`);
  return {
    action: "RESERVE",
    requestId: `reserve-${operationId}`,
    operation: snapshot.operation,
    participant: snapshot.participant,
    requestedAt: new Date().toISOString(),
    expected: reply.snapshot,
    grantedGeneration: reply.snapshot.baseGeneration + 1,
    quote: {
      quoteId: `quote-${operationId}`,
      quoteFingerprint: `quote-fingerprint-${operationId}`,
      expectedRevision: 0,
      originalManifestFingerprint: "manifest-one",
    },
    deadline: new Date(Date.now() + 7_000).toISOString(),
  };
};

const releaseRequest = (reserve: CashBackSourceReserveRequest): CashBackSourceReleaseRequest => ({
  action: "RELEASE",
  requestId: `release-${reserve.operation.operationId}`,
  reserveRequestId: reserve.requestId,
  operation: reserve.operation,
  participant: reserve.participant,
  requestedAt: new Date().toISOString(),
  baseGeneration: reserve.expected.baseGeneration,
  grantedGeneration: reserve.grantedGeneration,
  decision: {
    issuer: "RESULTING",
    decisionId: `decision-${reserve.operation.operationId}`,
    receiptFingerprint: `receipt-${reserve.operation.operationId}`,
    outcome: "REJECTED",
    quoteId: reserve.quote.quoteId,
    quoteFingerprint: reserve.quote.quoteFingerprint,
    expectedRevision: 0,
    revision: 1,
    decisionTime: new Date().toISOString(),
  },
});

it("snapshots do not reserve and missing sources are never recreated", async () => {
  const missing = await handleCashBackSourceRequest(snapshotRequest());
  expect(missing).toMatchObject({ outcome: "DENIED", reason: "MISSING" });
  expect(await Event.countDocuments()).toBe(0);
  await createEvent();
  const reserve = await reserveRequest();
  expect(reserve.expected.baseGeneration).toBe(0);
  const stored = await Event.findOne({ eventId: "event-one" }).select("+cashBackHold");
  expect(stored?.cashBackHold).toBeUndefined();
});

it("blocks cash-back quotes and old confirmations when an event is switched off, including after re-enabling", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  const toggle = { eventId: "event-one", enabled: false, expectedEnabled: true };
  await request(app).post("/api/backoffice/event_cash_back").send(toggle).expect(200);
  await request(app).post("/api/backoffice/event_cash_back").send(toggle).expect(200);
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({ outcome: "DENIED", reason: "SUSPENDED" });
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({ outcome: "DENIED", reason: "SUSPENDED" });
  await request(app).post("/api/backoffice/event_cash_back")
    .send({ eventId: "event-one", enabled: true, expectedEnabled: false }).expect(200);
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({ outcome: "DENIED", reason: "AUTHORITY_CHANGED" });
  expect(await handleCashBackSourceRequest(snapshotRequest("fresh"))).toMatchObject({ outcome: "SNAPSHOT" });
});

it("cannot switch cash-back off underneath a granted reservation, and permits it after release", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  const grant = await handleCashBackSourceRequest(reserve);
  expect(grant.outcome).toBe("GRANTED");
  const toggle = { eventId: "event-one", enabled: false, expectedEnabled: true };
  await request(app).post("/api/backoffice/event_cash_back").send(toggle).expect(409);
  expect(await handleCashBackSourceRequest(reserve)).toEqual(grant);
  await handleCashBackSourceRequest(releaseRequest(reserve));
  await request(app).post("/api/backoffice/event_cash_back").send(toggle).expect(200);
});

it("validates cash-back settings and does not recreate missing events", async () => {
  await request(app).post("/api/backoffice/event_cash_back").send({ eventId: "missing", enabled: "false", expectedEnabled: true }).expect(400);
  await request(app).post("/api/backoffice/event_cash_back").send({ eventId: "missing", enabled: false, expectedEnabled: true }).expect(404);
  expect(await Event.countDocuments()).toBe(0);
});

it("keeps unchanged cash-back settings idempotent without invalidating quotes", async () => {
  await createEvent();
  const before = await Event.findOne({ eventId: "event-one" }).lean();
  await request(app).post("/api/backoffice/event_cash_back")
    .send({ eventId: "event-one", enabled: true, expectedEnabled: true }).expect(200);
  const after = await Event.findOne({ eventId: "event-one" }).lean();
  expect(after?.cashBackAuthorityRevision).toBe(before?.cashBackAuthorityRevision);
  expect(after?.cashBackAuthorityAt).toEqual(before?.cashBackAuthorityAt);
});

it("persists the exact grant at b+1 and retries without extending its time", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  const granted = await handleCashBackSourceRequest(reserve);
  expect(granted).toMatchObject({
    outcome: "GRANTED", grantedGeneration: 1, request: reserve,
  });
  if (granted.outcome !== "GRANTED") throw new Error("Missing grant");
  expect(Date.parse(granted.decisionTime)).toBeLessThan(Date.parse(reserve.deadline));
  const repeated = await handleCashBackSourceRequest(JSON.parse(JSON.stringify(reserve)));
  expect(repeated).toEqual(granted);
  const stored = await Event.findOne({ eventId: "event-one" }).select("+cashBackHold +cashBackGeneration");
  expect(stored?.cashBackGeneration).toBe(1);
  expect(stored?.cashBackHold?.grant).toEqual(granted);
});

it("arbitrates concurrent reserves with one Mongo CAS, not a process lock", async () => {
  await createEvent();
  const [one, two] = await Promise.all([reserveRequest("one"), reserveRequest("two")]);
  const outcomes = await Promise.all([
    handleCashBackSourceRequest(one), handleCashBackSourceRequest(two),
  ]);
  expect(outcomes.filter(reply => reply.outcome === "GRANTED")).toHaveLength(1);
  expect(outcomes.filter(reply => reply.outcome === "DENIED")).toHaveLength(1);
});

it("fences release-before-reserve and never clears a newer operation's hold", async () => {
  await createEvent();
  const first = await reserveRequest("first");
  const cancel = releaseRequest(first);
  expect(await handleCashBackSourceRequest(cancel)).toMatchObject({
    outcome: "FENCED", fenceGeneration: 2, observedGeneration: 2,
  });
  expect(await handleCashBackSourceRequest(first)).toMatchObject({
    outcome: "DENIED", reason: "GENERATION_CONFLICT",
  });
  const second = await reserveRequest("second");
  const secondGrant = await handleCashBackSourceRequest(second);
  expect(secondGrant.outcome).toBe("GRANTED");
  expect(await handleCashBackSourceRequest(cancel)).toMatchObject({
    outcome: "FENCED", fenceGeneration: 2, observedGeneration: 3,
  });
  expect(await handleCashBackSourceRequest(second)).toEqual(secondGrant);
});

it("releases a lost-ACK grant from the request obligation and terminal receipt", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  await handleCashBackSourceRequest(reserve);
  expect(await handleCashBackSourceRequest(releaseRequest(reserve))).toMatchObject({
    outcome: "RELEASED", fenceGeneration: 2,
  });
  const stored = await Event.findOne({ eventId: "event-one" }).select("+cashBackHold +cashBackGeneration");
  expect(stored?.cashBackHold).toBeUndefined();
  expect(stored?.cashBackGeneration).toBe(2);
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({ outcome: "DENIED" });
});

it("rejects a mismatched terminal receipt without clearing its hold", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  const grant = await handleCashBackSourceRequest(reserve);
  const release = releaseRequest(reserve);
  const forged = {
    ...release,
    decision: { ...release.decision, quoteFingerprint: "another-quote" },
  };
  expect(await handleCashBackSourceRequest(forged)).toMatchObject({ outcome: "DENIED" });
  expect(await handleCashBackSourceRequest(reserve)).toEqual(grant);
});

it("fails closed instead of wrapping an exhausted generation", async () => {
  await createEvent();
  await reserveRequest();
  await Event.updateOne({ eventId: "event-one" }, { $set: { cashBackGeneration: Number.MAX_SAFE_INTEGER } });
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({
    outcome: "DENIED", reason: "GENERATION_EXHAUSTED",
  });
});

it("does not replay a grant from inconsistent persisted generation state", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  await handleCashBackSourceRequest(reserve);
  await Event.updateOne({ eventId: "event-one" }, { $set: { cashBackGeneration: 0 } });
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({
    outcome: "DENIED", reason: "PROTOCOL_ERROR",
  });
});

it("rejects an expired request using Mongo domain time and never consumes a generation", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  const expired = { ...reserve, deadline: reserve.expected.observedAt };
  expect(await handleCashBackSourceRequest(expired)).toMatchObject({
    outcome: "DENIED", reason: "DEADLINE_REACHED",
  });
  const stored = await Event.findOne({ eventId: "event-one" }).select("+cashBackGeneration");
  expect(stored?.cashBackGeneration).toBe(0);
});

it("rejects changed authority even when visibility returns to its original value", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  for (const visibility of [EventVisibility.OFFLINE, EventVisibility.ONLINE]) {
    await request(app).post("/api/backoffice/event_visibility")
      .send({ eventId: "event-one", visibility }).expect(200);
  }
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({
    outcome: "DENIED", reason: "AUTHORITY_CHANGED",
  });
});

it("blocks manual result and visibility writes until canonical release", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  await handleCashBackSourceRequest(reserve);
  await request(app).post("/api/backoffice/result")
    .send({ eventId: "event-one", homeResult: 1, awayResult: 0 }).expect(409);
  await request(app).post("/api/backoffice/event_visibility")
    .send({ eventId: "event-one", visibility: EventVisibility.OFFLINE }).expect(409);
  const stored = await Event.findOne({ eventId: "event-one" });
  expect(stored?.status).toBe(EventStatus.NO_RESULT);
  expect(stored?.visibility).toBe(EventVisibility.ONLINE);
  expect(ResultSetPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
  await handleCashBackSourceRequest(releaseRequest(reserve));
  const response = await request(app).post("/api/backoffice/result")
    .send({ eventId: "event-one", homeResult: 1, awayResult: 0 }).expect(200);
  expect(response.body.event.cashBackGeneration).toBeUndefined();
  expect(response.body.event.cashBackHold).toBeUndefined();
});

it("rejects after the manual result commits even while publication is paused", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  let published!: () => void;
  let entered!: () => void;
  const publicationEntered = new Promise<void>(resolve => { entered = resolve; });
  const publicationPaused = new Promise<void>(resolve => { published = resolve; });
  const publish = ResultSetPublisher.prototype.publishWithConfirm as jest.Mock;
  publish.mockImplementationOnce(async () => { entered(); await publicationPaused; });
  const result = request(app).post("/api/backoffice/result")
    .send({ eventId: "event-one", homeResult: 1, awayResult: 0 }).then(response => response);
  await publicationEntered;
  try {
    expect(await handleCashBackSourceRequest(reserve)).toMatchObject({
      outcome: "DENIED", reason: "RESOLVED",
    });
  } finally {
    published();
  }
  expect((await result).status).toBe(200);
});

const setGlobalCashBack = (enabled: boolean) => request(app).put("/api/backoffice/cash-back-setting")
  .send({ enabled, expectedEnabled: !enabled }).expect(200);

const storedFence = () => Event.findOne({ eventId: "event-one" })
  .select("+cashBackHold +cashBackGeneration +cashBackAuthorityRevision").lean();

it("denies snapshots while the global switch is off even though the event allows cash-back, and restores them when on", async () => {
  await createEvent();
  await reserveRequest();
  const before = await storedFence();
  await setGlobalCashBack(false);
  expect(await handleCashBackSourceRequest(snapshotRequest())).toMatchObject({ outcome: "DENIED", reason: "SUSPENDED" });
  expect(await storedFence()).toEqual(before);
  expect(before?.cashBackEnabled).toBe(true);
  await setGlobalCashBack(true);
  const restored = await handleCashBackSourceRequest(snapshotRequest("fresh"));
  expect(restored).toMatchObject({ outcome: "SNAPSHOT", snapshot: { baseGeneration: 0 } });
});

it("denies a new reservation while the global switch is off without consuming a generation", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  await setGlobalCashBack(false);
  expect(await handleCashBackSourceRequest(reserve)).toMatchObject({ outcome: "DENIED", reason: "SUSPENDED" });
  const stored = await storedFence();
  expect(stored?.cashBackGeneration).toBe(0);
  expect(stored?.cashBackHold).toBeUndefined();
});

it("replays a held grant and releases it while the global switch is off", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  const grant = await handleCashBackSourceRequest(reserve);
  expect(grant.outcome).toBe("GRANTED");
  await setGlobalCashBack(false);
  expect(await handleCashBackSourceRequest(JSON.parse(JSON.stringify(reserve)))).toEqual(grant);
  expect(await handleCashBackSourceRequest(releaseRequest(reserve))).toMatchObject({
    outcome: "RELEASED", fenceGeneration: 2,
  });
  const stored = await storedFence();
  expect(stored?.cashBackHold).toBeUndefined();
  expect(stored?.cashBackGeneration).toBe(2);
});

it("does not confirm a quote snapshotted before a global off/on cycle", async () => {
  await createEvent();
  const stale = await reserveRequest("stale");
  await setGlobalCashBack(false);
  await setGlobalCashBack(true);
  expect(await handleCashBackSourceRequest(stale)).toMatchObject({ outcome: "DENIED", reason: "AUTHORITY_CHANGED" });
  expect((await storedFence())?.cashBackGeneration).toBe(0);
  expect(await handleCashBackSourceRequest(await reserveRequest("fresh"))).toMatchObject({ outcome: "GRANTED" });
});

it("re-reads the global switch immediately before the reservation write", async () => {
  await createEvent();
  const reserve = await reserveRequest();
  const read = cashBackSettingModel.readCashBackSetting;
  const spy = jest.spyOn(cashBackSettingModel, "readCashBackSetting").mockImplementationOnce(async () => {
    const enabled = await read();
    await setGlobalCashBack(false);
    return enabled;
  });
  try {
    expect(await handleCashBackSourceRequest(reserve)).toMatchObject({ outcome: "DENIED", reason: "SUSPENDED" });
  } finally {
    spy.mockRestore();
  }
  expect((await storedFence())?.cashBackHold).toBeUndefined();
});
