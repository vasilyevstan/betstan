import { ChildProcess, fork } from "child_process";
import { resolve } from "path";
import mongoose from "mongoose";
import { BetKind, ModerationStatus } from "@betstan/common";
import { createPlaceBetEvent } from "../../event/listener/__test__/helpers";
import { Bet } from "../../model/Bet";
import { beginSnapshotImport, finalizeSnapshotImport, importSnapshotPage, verifyLegacySnapshotPlacement } from "../SnapshotImport";
import { SnapshotCompletion, SnapshotManifest, SnapshotPage, SnapshotPosition } from "../SnapshotContract";
import * as fence from "../SnapshotFence";
import { fingerprint, parseRule } from "../Policy";
import { getPolicy, initializeRisk, mutatePolicy, RiskAccountingInbox, RiskBaseline, RiskMovement, RiskPosition, RiskState } from "../Store";
import { receiveRisk, terminalRisk } from "../Gateway";
import { applyAccountingInbox, receiveAccounting, replayAccounting } from "../Accounting";
import ModerationService from "../../service/ModerationService";
import { catalogue, WINDOWS } from "../Policy";
import { readLegacyOriginals } from "../../scripts/reconcileLegacyAccounting";

const authority = { namespace: "test-only", operationId: "test-bootstrap", sourceSha: "a".repeat(40), generation: "1", identityHash: "b".repeat(64) };
const actualFenceCheck = fence.verifyReceiverFence;
const FROM = "2019-01-01T00:00:00.000Z";
type Source = { manifest: SnapshotManifest; pages: SnapshotPage[]; completion: SnapshotCompletion; prefixes: Record<string, unknown>;
  finishSource?: (acks: unknown[]) => Promise<SnapshotCompletion> };
const children = new Set<ChildProcess>();
const event = (wager = 10, odds = 2) => createPlaceBetEvent({
  data: { betKind: BetKind.PRE_MATCH, wager }, row: { betKind: BetKind.PRE_MATCH, oddsValue: odds },
});
const cap = (type: string, limit: number) => parseRule({ id: `test:${type}`, type, enabled: true, scope: {},
  parameters: { limit, ...(type === "MAX_CUSTOMER_LOSS" ? { window: "UTC_DAY" } : { perCustomer: false }) } });
async function source(positions: any[] = [], deferCompletion = false): Promise<Source> {
  const id = new mongoose.Types.ObjectId().toHexString();
  return new Promise((resolveValue, reject) => {
    const child = fork(resolve(__dirname, "snapshotSource.fixture.ts"), [], {
      execArgv: ["-r", require.resolve("ts-node/register/transpile-only")], silent: true,
      env: { ...process.env, RISK_SOURCE_FIXTURE: "true",
        NODE_PATH: resolve(__dirname, "../../../node_modules") },
    });
    children.add(child);
    const timer = setTimeout(() => { child.kill(); reject(new Error("Source fixture timed out")); }, 45000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("message", (data: any) => {
      clearTimeout(timer);
      if (data.error) reject(new Error(data.error));
      else resolveValue({ ...data, ...(deferCompletion ? { finishSource: (acknowledgements: unknown[]) =>
        new Promise<SnapshotCompletion>((resolveCompletion, rejectCompletion) => {
          const timeout = setTimeout(() => { child.kill(); rejectCompletion(new Error("Source completion timeout")); }, 45000);
          child.once("message", (final: any) => {
            clearTimeout(timeout);
            if (final.error) rejectCompletion(new Error(final.error)); else resolveCompletion(final.completion);
          });
          child.send({ acknowledgements });
        }) } : {}) });
    });
    child.once("exit", code => { children.delete(child); clearTimeout(timer); if (code) reject(new Error("Source fixture exited unsuccessfully")); });
    child.send({ uri: mongoose.connection.getClient().options.hosts.map(h => h.toString()).length
      ? `mongodb://${mongoose.connection.getClient().options.hosts.map(h => h.toString()).join(",")}/?replicaSet=${mongoose.connection.getClient().options.replicaSet}`
      : "", database: `source_${id}`, id, from: FROM, authority, positions, deferCompletion });
  });
}
async function stage(value: Source) {
  await beginSnapshotImport(value.manifest);
  const acknowledgements = [];
  for (const page of value.pages) acknowledgements.push(await importSnapshotPage(page));
  if (value.finishSource) {
    value.completion = await value.finishSource(acknowledgements);
    value.finishSource = undefined;
  }
}
async function complete(value: Source) {
  await stage(value);
  await finalizeSnapshotImport(value.completion);
}
beforeEach(async () => {
  process.env.RISK_CENTRE_ENABLED = "true";
  await initializeRisk();
  jest.spyOn(fence, "verifyReceiverFence").mockImplementation(async () => ({
    fence: authority, leaseUntilEpoch: Math.floor(Date.now() / 1000) + 600,
  }));
});
afterEach(() => {
  for (const child of children) child.kill();
  children.clear();
  jest.restoreAllMocks(); delete process.env.RISK_CENTRE_ENABLED;
});

it.each(["MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"])(
  "runs real source export -> import -> %s Save -> racing admissions without inventing intake receipts", async type => {
  const original = event();
  const snapshot = await source([{ data: original.data }], true);
  await complete(snapshot);
  expect((await getPolicy()).readiness.accounting.ready).toBe(true);
  expect((await getPolicy()).readiness.accounting.readyLossWindows).toEqual([...WINDOWS]);
  expect(await RiskPosition.countDocuments()).toBe(0);
  expect(await RiskBaseline.countDocuments()).toBe(1);
  const limit = type === "MAX_OPEN_RETURN" ? 4000 : type === "MAX_OPERATOR_EXPOSURE" ? 3000 : 2000;
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "open-cap", rule: cap(type, limit) });
  const incoming = [event(), event()];
  incoming.forEach(e => { e.data.userId = original.data.userId; });
  const outcomes = await Promise.all(incoming.map(e => receiveRisk(e, new Date())));
  expect(outcomes.filter(p => p.reserved)).toHaveLength(1);
  expect(outcomes.filter(p => p.reason === `RISK_${type}`)).toHaveLength(1);
  const winner = outcomes.find(p => p.reserved);
  await terminalRisk(winner._id, { status: ModerationStatus.APPROVED, affectedRows: [], moderationTimestamp: new Date().toISOString() }, new Date());
  expect(await Bet.findOne({ slipId: winner._id }).lean()).toMatchObject({ status: ModerationStatus.APPROVED, publishedAt: "" });
  expect(JSON.stringify(await getPolicy())).not.toContain(original.data.userId);
});

it("deduplicates source/live overlap, preserves later closure, and credits each historical movement once", async () => {
  const input = event();
  const receipt = await receiveRisk(input, new Date());
  await terminalRisk(input.data.slipId, { status: ModerationStatus.APPROVED, affectedRows: [], moderationTimestamp: new Date().toISOString() }, new Date());
  const snapshot = await source([{ data: input.data, closes: [{ source: "CASH_BACK", closed: 400, returned: 800, occurredAt: "2020-01-01T00:00:00.000Z" }] }]);
  const first: any = snapshot.pages.flatMap(p => p.entries).find(e => e.kind === "MOVEMENT");
  const second = { ...first.movement, movementId: `${input.data.slipId}:accounting:2`, revision: 2,
    closedStakeMinor: 600, returnMinor: 0, remainingStakeMinor: 0, source: "SETTLEMENT", occurredAt: "2020-01-02T00:00:00.000Z" };
  expect(first.movement.placementFingerprint).toBe(receipt.accountingFingerprint);
  await receiveAccounting(input.data.slipId, { schemaVersion: 1, status: "COMPLETE", movements: [first.movement, second] });
  await replayAccounting();
  await stage(snapshot);
  for (const page of snapshot.pages) await importSnapshotPage(page);
  await finalizeSnapshotImport(snapshot.completion);
  expect(await RiskBaseline.countDocuments()).toBe(0);
  expect((await RiskPosition.findById(input.data.slipId).lean() as any).remainingStakeMinor).toBe(0);
  expect(await RiskMovement.countDocuments()).toBe(2);
  await receiveAccounting(input.data.slipId, { schemaVersion: 1, status: "COMPLETE", movements: [first.movement] });
  await replayAccounting();
  expect(await RiskMovement.countDocuments()).toBe(2);
  await RiskState.updateOne({ _id: "active" }, { $set: { "accountingCoverage.valid": false } });
  await finalizeSnapshotImport(snapshot.completion);
  expect((await getPolicy()).readiness.accounting.ready).toBe(false); // historical ACK cannot regrant readiness
});

it("retains the original payout bound after partial close (3 cents * 1.5, remaining 2)", async () => {
  const input = event(0.03, 1.5);
  const snapshot = await source([{ data: input.data, closes: [{ source: "CASH_BACK", closed: 1, returned: 1, occurredAt: "2020-01-01T00:00:00.000Z" }] }]);
  await complete(snapshot);
  const baseline = await RiskBaseline.findById(input.data.slipId).lean() as any;
  expect(baseline).toMatchObject({ stakeMinor: 3, remainingStakeMinor: 2, returnMinor: 4 });
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "return-cap", rule: cap("MAX_OPEN_RETURN", 4) });
  expect((await receiveRisk(event(0.01, 1), new Date())).reason).toBe("RISK_MAX_OPEN_RETURN");
});

it("uses actual source settlement time and signed win credit in an enabled loss window without duplicate credits", async () => {
  const closed = event();
  const occurredAt = new Date(Date.now() - 60000).toISOString();
  const snapshot = await source([{ data: closed.data, closes: [
    { source: "SETTLEMENT", closed: 1000, returned: 2000, occurredAt },
  ] }], true);
  await complete(snapshot);
  const rule = parseRule({ id: "loss-window", type: "MAX_CUSTOMER_LOSS", enabled: true, scope: {},
    parameters: { limit: 1000, window: "ROLLING_24H" } });
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "loss-window", rule });
  const first = event(20), second = event(0.01);
  first.data.userId = second.data.userId = closed.data.userId;
  expect((await receiveRisk(first, new Date())).reserved).toBe(true);
  await receiveAccounting(closed.data.slipId, snapshot.prefixes[closed.data.slipId]);
  await replayAccounting();
  expect((await receiveRisk(second, new Date())).reason).toBe("RISK_MAX_CUSTOMER_LOSS");
  expect(await RiskMovement.countDocuments()).toBe(1);
  expect((await RiskMovement.findOne({}).lean() as any).occurredAt).toBe(occurredAt);
});

it("recovers more than 600 partial closures from source history after inline evidence spills", async () => {
  const input = event();
  const snapshot = await source([{ data: input.data, retainHistory: true, closes: Array.from({ length: 601 }, () => ({
    source: "CASH_BACK", closed: 1, returned: 1, occurredAt: "2020-01-01T00:00:00.000Z",
  })) }], true);
  expect(snapshot.prefixes[input.data.slipId]).toMatchObject({ status: "UNAVAILABLE" });
  expect(snapshot.manifest.coverage.unavailableHistories).toBe(0);
  expect(snapshot.manifest.movements).toBe(601);
  await complete(snapshot);
  expect((await getPolicy()).readiness.accounting.ready).toBe(true);
  expect(await RiskBaseline.findById(input.data.slipId).lean()).toMatchObject({
    accountingRevision: 601, remainingStakeMinor: 399, returnMinor: 2000,
  });
  expect(await RiskMovement.countDocuments()).toBe(601);
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "large-history-cap", rule: cap("MAX_OPEN_STAKE", 1000) });
  expect((await receiveRisk(event(6.01), new Date())).reserved).toBe(true);
  expect((await receiveRisk(event(0.01), new Date())).reason).toBe("RISK_MAX_OPEN_STAKE");
  await finalizeSnapshotImport(snapshot.completion);
  expect(await RiskMovement.countDocuments()).toBe(601);
});

it("keeps missing legacy history unavailable for past windows but validates open exposure independently", async () => {
  const snapshot = await source([{ data: event().data }, { data: event().data, legacy: true }]);
  await complete(snapshot);
  const ready = (await getPolicy()).readiness.accounting;
  expect(ready).toMatchObject({ ready: false, openPositionsReady: true, code: "HISTORY_WINDOW_UNAVAILABLE" });
  expect(ready.readyLossWindows).toEqual([]);
  expect(await RiskMovement.countDocuments()).toBe(0);
  await expect(mutatePolicy("CREATE", { expectedRevision: 1, requestId: "loss", rule: cap("MAX_CUSTOMER_LOSS", 5000) })).rejects.toMatchObject({ code: "ACCOUNTING_NOT_READY" });
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "open", rule: cap("MAX_OPEN_STAKE", 5000) });
  const tomorrow = new Date(snapshot.manifest.cutAt);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 1);
  await RiskState.updateOne({ _id: "active" }, { $set: { lockTime: tomorrow } });
  expect((await getPolicy()).readiness.accounting.readyLossWindows).toContain("UTC_DAY");
  await mutatePolicy("CREATE", { expectedRevision: 2, requestId: "loss-after-coverage", rule: cap("MAX_CUSTOMER_LOSS", 5000) });
});

it.each([10, 0.015])("accepts an owned closed legacy original (%s stake) without inventing monetary history", async wager => {
  const input = event(wager);
  await Bet.create({ ...input.data, timestamp: "2020-01-01T00:00:00.000Z", status: ModerationStatus.APPROVED });
  await complete(await source([{ data: input.data, legacy: true }]));
  expect((await getPolicy()).readiness.accounting).toMatchObject({
    openPositionsReady: true, ready: false, readyLossWindows: [],
  });
  expect(await RiskMovement.countDocuments()).toBe(0);
  expect(await RiskPosition.countDocuments()).toBe(0);
  expect(await RiskBaseline.countDocuments()).toBe(0);
});

it("imports a tagged legacy reconciliation identity and consumes its later real Source settlement once", async () => {
  const input = event();
  await Bet.create({ ...input.data, timestamp: "2020-01-01T00:00:00.000Z", status: ModerationStatus.APPROVED });
  const originals = await readLegacyOriginals({
    schemaVersion: 1, sourceSha: authority.sourceSha, sourceDigest: "c".repeat(64), positions: [],
    candidates: [{ slipId: input.data.slipId, userId: input.data.userId,
      sourceStatus: "BET_APPROVED", sourceFingerprint: "d".repeat(64),
      sourceRowIds: input.data.rows.map(row => row.id) }],
  });
  const legacyPlacementFingerprint = originals.originals[0].placementFingerprint;
  await complete(await source([{ data: input.data, legacyPlacementFingerprint }]));
  expect(await RiskBaseline.findById(input.data.slipId).lean()).toMatchObject({
    accountingFingerprint: legacyPlacementFingerprint, remainingStakeMinor: 1000,
  });
  const settled = await source([{ data: input.data, legacyPlacementFingerprint, closes: [{
    source: "SETTLEMENT", closed: 1000, returned: 2000, occurredAt: "2020-01-01T00:00:00.000Z",
  }] }]);
  const entry = settled.pages.flatMap(page => page.entries).find(item => item.kind === "MOVEMENT")!;
  if (entry.kind !== "MOVEMENT") throw new Error("Expected real Source settlement");
  const evidence = { schemaVersion: 1, status: "COMPLETE", movements: [entry.movement] };
  await receiveAccounting(input.data.slipId, evidence);
  await replayAccounting();
  await receiveAccounting(input.data.slipId, evidence);
  await replayAccounting();
  expect(await RiskMovement.countDocuments()).toBe(1);
  expect(await RiskBaseline.findById(input.data.slipId).lean()).toMatchObject({ remainingStakeMinor: 0 });
});
it("still rejects present original-fact conflicts and open legacy unknown amounts", async () => {
  const input = event();
  const snapshot = await source([{ data: input.data, legacy: true }]);
  const position = snapshot.pages.flatMap(page => page.entries).find(
    (entry): entry is SnapshotPosition => entry.kind === "POSITION"
  )!;
  expect(() => verifyLegacySnapshotPlacement(input.data, { ...position, originalStakeMinor: 999 }))
    .toThrow("conflicts");
  expect(() => verifyLegacySnapshotPlacement(input.data, { ...position, facts: {
    betKind: "PRE_MATCH", structure: "SINGLE", eventIds: ["wrong-event"],
    productIds: [input.data.rows[0].productId], marketIds: [], templateIds: [],
  } })).toThrow("conflicts");
  expect(() => verifyLegacySnapshotPlacement(input.data, {
    ...position, state: "ACCEPTED", sourceStatus: "BET_APPROVED", openExposure: "UNAVAILABLE",
  })).toThrow();
});
it("does not backdate activity at import; complete windows warm up, reset preserves usage, feature-off breaks continuity", async () => {
  const historical = event();
  const snapshot = await source([{ data: historical.data }]);
  const activityRule = parseRule({ id: "activity", type: "MAX_SUBMISSIONS", enabled: true, scope: {},
    parameters: { limit: 1, window: "ROLLING_1H", perCustomer: false } });
  const save = (revision: number, requestId: string) => mutatePolicy("CREATE", { expectedRevision: revision, requestId, rule: activityRule });
  await expect(save(1, "unavailable")).rejects.toMatchObject({ code: "ACTIVITY_NOT_READY" });
  await complete(snapshot);
  const since = (await getPolicy()).readiness.activity.trackedSince!;
  expect(since >= snapshot.manifest.cutAt).toBe(true);
  expect(await RiskPosition.countDocuments()).toBe(0);
  await expect(save(1, "warming")).rejects.toMatchObject({ code: "ACTIVITY_NOT_READY" });
  // Advance the persisted Mongo decision clock instead of sleeping for a window.
  await RiskState.updateOne({ _id: "active" }, { $set: { lockTime: new Date(Date.parse(since) + 3600001) } });
  expect((await getPolicy()).readiness.activity.readyWindows).toContain("ROLLING_1H");
  await save(1, "ready");
  const first = event();
  expect((await receiveRisk(first, new Date())).reserved).toBe(true);
  expect((await receiveRisk(event(), new Date())).reason).toBe("RISK_MAX_SUBMISSIONS");
  await mutatePolicy("RESET", { expectedRevision: 2, requestId: "reset-activity" });
  await save(3, "restore-cap");
  expect((await receiveRisk(event(), new Date())).reason).toBe("RISK_MAX_SUBMISSIONS");
  expect((await getPolicy()).readiness.activity.trackedSince).toBe(since);
  delete process.env.RISK_CENTRE_ENABLED;
  await new ModerationService({ publishWithConfirm: async () => undefined }).handlePlaceBet(event());
  process.env.RISK_CENTRE_ENABLED = "true";
  expect((await getPolicy()).readiness.activity).toMatchObject({ tracking: false, readyWindows: [] });
  expect((await receiveRisk(event(), new Date())).reason).toBe("RISK_EVIDENCE_UNAVAILABLE");
  await expect(mutatePolicy("UPDATE", { expectedRevision: 4, requestId: "no-zero-reset", rule: activityRule }, "activity"))
    .rejects.toMatchObject({ code: "ACTIVITY_NOT_READY" });
});

it("checks turnover/cooldown coverage and exposes only currently certified loss windows", async () => {
  const snapshot = await source([]);
  await complete(snapshot);
  const turnover = parseRule({ id: "turnover", type: "MAX_TURNOVER", enabled: true, scope: {},
    parameters: { limit: 1000, window: "ROLLING_1H", perCustomer: false } });
  const cooldown = parseRule({ id: "cooldown", type: "REPEAT_BET_COOLDOWN_MS", enabled: true, scope: {},
    parameters: { limit: 1000, perCustomer: false } });
  await expect(mutatePolicy("CREATE", { expectedRevision: 1, requestId: "turnover-early", rule: turnover })).rejects.toMatchObject({ code: "ACTIVITY_NOT_READY" });
  await expect(mutatePolicy("CREATE", { expectedRevision: 1, requestId: "cooldown-early", rule: cooldown })).rejects.toMatchObject({ code: "ACTIVITY_NOT_READY" });
  const state = await RiskState.findById("active").lean() as any;
  await RiskState.updateOne({ _id: "active" }, { $set: { lockTime: new Date(Date.parse(state.activityCoverage.since) + 3600001) } });
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "turnover-ready", rule: turnover });
  await mutatePolicy("CREATE", { expectedRevision: 2, requestId: "cooldown-ready", rule: cooldown });
  await receiveAccounting("unavailable-legacy-close", undefined);
  expect((await getPolicy()).readiness.accounting).toMatchObject({ openPositionsReady: true, readyLossWindows: [], ready: false });
});

it("promotes source-pending exposure into one immutable intake receipt without double reservation", async () => {
  const input = event();
  await complete(await source([{ data: input.data, pending: true }]));
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "pending-cap", rule: cap("MAX_OPEN_STAKE", 1000) });
  expect((await receiveRisk(input, new Date())).reserved).toBe(true);
  await receiveRisk(input, new Date());
  expect(await RiskBaseline.countDocuments()).toBe(0);
  expect(await RiskPosition.countDocuments()).toBe(1);
});

it("cannot silently drop an imported position at a later snapshot", async () => {
  await complete(await source([{ data: event().data }]));
  const missing = await source([]);
  await stage(missing);
  await expect(finalizeSnapshotImport(missing.completion)).rejects.toThrow("Previously imported exposure");
  expect(await RiskBaseline.countDocuments()).toBe(1);
  expect((await getPolicy()).readiness.accounting.ready).toBe(false);
});

it("does not release a prior full reserve when a later terminal source record lacks monetary proof", async () => {
  const input = event();
  await complete(await source([{ data: input.data }]));
  await Bet.create({ ...input.data, timestamp: "2020-01-01T00:00:00.000Z", status: ModerationStatus.APPROVED });
  await complete(await source([{ data: input.data, legacy: true }]));
  expect((await RiskBaseline.findById(input.data.slipId).lean() as any).remainingStakeMinor).toBe(1000);
  expect(await RiskMovement.countDocuments()).toBe(0);
  expect((await getPolicy()).readiness.accounting.readyLossWindows).toEqual([]);
});

it("keeps full principal across a real source prefix gap, then applies complete live recovery once", async () => {
  const input = event();
  const snapshot = await source([{ data: input.data, gap: true, closes: [
    { source: "CASH_BACK", closed: 400, returned: 500, occurredAt: "2020-01-01T00:00:00.000Z" },
    { source: "CASH_BACK", closed: 100, returned: 200, occurredAt: "2020-01-02T00:00:00.000Z" },
  ] }]);
  expect(snapshot.manifest.coverage.unavailableHistories).toBe(1);
  await complete(snapshot);
  expect((await RiskBaseline.findById(input.data.slipId).lean() as any).remainingStakeMinor).toBe(1000);
  expect(await RiskMovement.countDocuments()).toBe(0);
  expect((await getPolicy()).readiness.accounting.readyLossWindows).toEqual([]);
  await receiveAccounting(input.data.slipId, snapshot.prefixes[input.data.slipId]);
  await replayAccounting();
  expect((await RiskBaseline.findById(input.data.slipId).lean() as any).remainingStakeMinor).toBe(500);
  expect(await RiskMovement.countDocuments()).toBe(2);
  await receiveAccounting(input.data.slipId, snapshot.prefixes[input.data.slipId]);
  await replayAccounting();
  expect(await RiskMovement.countDocuments()).toBe(2);
});

it("requires every actual source page and coalesces identical completions before fence verification", async () => {
  const snapshot = await source(Array.from({ length: 51 }, () => ({ data: event().data })));
  expect(snapshot.pages).toHaveLength(2);
  await beginSnapshotImport(snapshot.manifest);
  await expect(importSnapshotPage(snapshot.pages[1])).rejects.toThrow("gap");
  await Promise.all([importSnapshotPage(snapshot.pages[0]), importSnapshotPage(snapshot.pages[0])]);
  await expect(finalizeSnapshotImport(snapshot.completion)).rejects.toThrow("incomplete");
  await importSnapshotPage(snapshot.pages[1]);
  (fence.verifyReceiverFence as jest.Mock).mockClear();
  const results = await Promise.all([finalizeSnapshotImport(snapshot.completion), finalizeSnapshotImport(snapshot.completion)]);
  expect(results[0]).toEqual(results[1]);
  expect(fence.verifyReceiverFence).toHaveBeenCalledTimes(1);
  expect(await RiskBaseline.countDocuments()).toBe(51);
});

it("publishes concrete locked limits without changing their IDs or mutability", () => {
  const locked = catalogue().filter(item => item.locked);
  expect(locked.find(item => item.type === "QUOTE_AUTHORITY")?.description).toContain("30s");
  expect(locked.find(item => item.type === "QUOTE_AUTHORITY")?.description).toContain("1.01-1000");
  expect(locked.find(item => item.type === "MARKET_CAPABILITY")?.description).toContain("2-10");
  const resources = locked.find(item => item.type === "RESOURCE_BOUNDS")!;
  for (const value of ["255KiB", "16 parameters", "64 outcomes", "128 rule nodes", "depth 8", "0-99"]) expect(resources.description).toContain(value);
  expect(resources.label).toBe("Resource limits");
});

it("requires real held-maintenance authority outside the source/receiver test fixtures", async () => {
  const namespace = process.env.NAMESPACE;
  try {
    delete process.env.NAMESPACE;
    await expect(actualFenceCheck()).rejects.toThrow("verified held lease");
  } finally {
    if (namespace === undefined) delete process.env.NAMESPACE;
    else process.env.NAMESPACE = namespace;
  }
});

it("does not enable required exposure controls for missing exact cents", async () => {
  const snapshot = await source([{ data: event(1.001).data }]);
  await complete(snapshot);
  expect((await getPolicy()).readiness.accounting.openPositionsReady).toBe(false);
  await expect(mutatePolicy("CREATE", { expectedRevision: 1, requestId: "open", rule: cap("MAX_OPEN_STAKE", 5000) })).rejects.toMatchObject({ code: "ACCOUNTING_NOT_READY" });
  expect((await receiveRisk(event(1.001), new Date())).reason).toBeUndefined();
});

it("rejects corrupt/gapped pages, changed completion, released maintenance and unreconciled intake", async () => {
  const snapshot = await source([{ data: event().data }]);
  await beginSnapshotImport(snapshot.manifest);
  await expect(importSnapshotPage({ ...snapshot.pages[0], page: 2 })).rejects.toThrow();
  await expect(finalizeSnapshotImport(snapshot.completion)).rejects.toThrow("incomplete");
  for (const p of snapshot.pages) await importSnapshotPage(p);
  await expect(finalizeSnapshotImport({ ...snapshot.completion, manifestHash: "c".repeat(64) })).rejects.toThrow("completion");
  (fence.verifyReceiverFence as jest.Mock).mockRejectedValueOnce(new Error("released"));
  await expect(finalizeSnapshotImport(snapshot.completion)).rejects.toThrow("released");
  const missing = event();
  await Bet.create({ ...missing.data, status: ModerationStatus.APPROVED, timestamp: new Date().toISOString(), moderationTimestamp: new Date().toISOString(), publishedAt: "" });
  await expect(finalizeSnapshotImport(snapshot.completion)).rejects.toThrow("intake");
  expect(await RiskBaseline.countDocuments()).toBe(0); // no partial book/ready commit
});

it("applies staged source plus unprocessed accounting inbox in one final commit and survives feature-off replay", async () => {
  const input = event();
  const snapshot = await source([{ data: input.data }]);
  const movement = { schemaVersion: 1, movementId: `${input.data.slipId}:accounting:1`, slipId: input.data.slipId,
    userId: input.data.userId, revision: 1, occurredAt: "2020-01-01T00:00:00.000Z", closedStakeMinor: 1000,
    returnMinor: 2000, remainingStakeMinor: 0, originalStakeMinor: 1000, source: "SETTLEMENT", placementFingerprint: fingerprint(input.data) };
  await receiveAccounting(input.data.slipId, { schemaVersion: 1, status: "COMPLETE", movements: [movement] });
  const inbox = await RiskAccountingInbox.findOne({}).lean() as any;
  expect(await applyAccountingInbox(inbox._id)).toBe(false);
  await complete(snapshot);
  expect(await RiskMovement.countDocuments()).toBe(1);
  expect((await RiskAccountingInbox.findById(inbox._id).lean() as any).applied).toBe(true);
  delete process.env.RISK_CENTRE_ENABLED;
  await replayAccounting();
  expect((await RiskBaseline.findById(input.data.slipId).lean() as any).remainingStakeMinor).toBe(0);
});
