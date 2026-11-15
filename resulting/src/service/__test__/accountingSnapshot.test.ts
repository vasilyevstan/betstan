import { MarketBet, messengerWrapper, ResultingStatus } from "@betstan/common";
import { Bet, BetArchive } from "../../model/Bet";
import { CashBackOperation } from "../../model/CashBackOperation";
import RetryRecord from "../../model/RetryRecord";
import PendingModerationResult from "../../model/PendingModerationResult";
import SettleSlipPublisher from "../../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../event/publisher/SettleSlipRowPublisher";
import {
  createFinalScoreEvent, createModerationEvent, createPlaceBetEvent, createPreMatchRow, setupPublisherSpies,
} from "../../test/resultingTestUtils";
import { accountingClosureState, accountingPlacementState } from "../betAccounting";
import { retainAccountingHistory } from "../accountingHistory";
import {
  AccountingSnapshot, AccountingSnapshotEntry, AccountingSnapshotPosition,
  acknowledgeAccountingSnapshotPage, completeAccountingSnapshot, createAccountingSnapshot,
  readAccountingSnapshotManifest, readAccountingSnapshotPage,
} from "../accountingSnapshot";
import * as fence from "../accountingSnapshotFence";
import { cashBackHash } from "../cashBackIdentity";
import { applyModerationResult, processFinalScore, upsertPlaceBet } from "../resulting";
import { runAccountingExportCommand } from "../../scripts/exportAccounting";

const FROM = "2019-01-01T00:00:00.000Z";
const TIME = "2020-01-01T00:00:00.000Z";
const authority: fence.AccountingSnapshotFence = {
  namespace: "test-only", operationId: "test-bootstrap", sourceSha: "a".repeat(40),
  generation: "1", identityHash: "b".repeat(64),
};
const actualFenceCheck = fence.verifyAccountingSnapshotFence;
setupPublisherSpies();
beforeEach(() => { jest.spyOn(fence, "verifyAccountingSnapshotFence").mockResolvedValue(authority); });
afterEach(() => jest.restoreAllMocks());
const publishers = () => ({
  settleSlipPublisher: new SettleSlipPublisher(messengerWrapper.connection),
  settleSlipRowPublisher: new SettleSlipRowPublisher(messengerWrapper.connection),
});
const input = (slipId: string, overrides: any = {}) => createPlaceBetEvent({
  slipId, userId: "source-owner", wager: 10,
  rows: [createPreMatchRow({ id: `${slipId}-row`, eventId: `${slipId}-event`, oddsValue: 2, oddsName: "Home" })],
  ...overrides,
});
async function fixture(slipId: string, overrides: any = {}) {
  const event = input(slipId, overrides);
  return Bet.create({ ...event.data, ...accountingPlacementState(event.data), timestamp: TIME, status: ResultingStatus.BET_APPROVED });
}
async function entries(snapshotId: string): Promise<AccountingSnapshotEntry[]> {
  const manifest = await readAccountingSnapshotManifest(snapshotId);
  const values: AccountingSnapshotEntry[] = [];
  let previousHash = cashBackHash({ schemaVersion: 1, source: "RESULTING", snapshotId });
  for (let page = 1; page <= manifest.pageCount; page++) {
    const data = (await readAccountingSnapshotPage(snapshotId, page))!;
    expect(data.previousHash).toBe(previousHash);
    const { hash, ...payload } = data;
    expect(hash).toBe(cashBackHash(payload));
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(512 * 1024);
    previousHash = hash;
    values.push(...data.entries);
  }
  expect(previousHash).toBe(manifest.lastPageHash);
  expect(values.filter(value => value.kind === "POSITION")).toHaveLength(manifest.positions);
  expect(values.filter(value => value.kind === "MOVEMENT")).toHaveLength(manifest.movements);
  return values;
}

it("attests authoritative OPEN scope/principal/bound and actual archived settlement without envelope time", async () => {
  const open = input("open");
  const closed = input("closed");
  const pub = publishers();
  for (const event of [open, closed]) {
    await upsertPlaceBet(event, pub);
    await applyModerationResult(createModerationEvent(event.data.slipId), pub);
  }
  const result = createFinalScoreEvent({ eventId: closed.data.rows[0].eventId, home: "Home" });
  result.data.occurredAt = TIME;
  await processFinalScore(result, pub);
  const archived = await BetArchive.findOne({ slipId: "closed" });
  expect(archived?.accountingScope).toBeDefined();
  const manifest = await createAccountingSnapshot("authoritative", FROM);
  expect(manifest.coverage).toEqual({
    openPositions: "COMPLETE", unavailableOpenPositions: 0, unavailableHistories: 0,
    realisedCompleteSince: FROM, through: manifest.cutAt, submissionAndTurnoverReceipts: "NOT_OWNED",
  });
  const values = await entries("authoritative");
  const position = values.find(value => value.kind === "POSITION" && value.slipId === "open") as AccountingSnapshotPosition;
  expect(position).toMatchObject({
    state: "ACCEPTED", originalStakeMinor: 1000, remainingStakeMinor: 1000, maximumReturnMinor: 2000,
    expectedRevision: 0, history: "COMPLETE", openExposure: "COMPLETE",
    placementFingerprint: cashBackHash(open.data),
  });
  expect(position.facts).toEqual({
    betKind: "PRE_MATCH", structure: "SINGLE", eventIds: [open.data.rows[0].eventId],
    productIds: [open.data.rows[0].productId], marketIds: [], templateIds: [],
  });
  expect(values.filter(value => value.kind === "MOVEMENT")).toEqual([{
    kind: "MOVEMENT", movement: expect.objectContaining({
      slipId: "closed", occurredAt: TIME, revision: 1, closedStakeMinor: 1000, returnMinor: 2000, remainingStakeMinor: 0,
    }),
  }]);
});

it("coalesces identical captures and durably enforces page/hash/last-marker acknowledgements", async () => {
  const records = Array.from({ length: 51 }, (_, n) => {
    const event = input(`page-${n}`);
    return { ...event.data, ...accountingPlacementState(event.data), timestamp: TIME, status: ResultingStatus.BET_APPROVED, __v: 0 };
  });
  await Bet.insertMany(records);
  const [manifest, repeated] = await Promise.all([
    createAccountingSnapshot("pages", FROM), createAccountingSnapshot("pages", FROM),
  ]);
  expect(repeated).toEqual(manifest);
  expect(manifest.pageCount).toBe(2);
  const first = (await readAccountingSnapshotPage("pages"))!;
  const second = (await readAccountingSnapshotPage("pages", 2))!;
  await expect(acknowledgeAccountingSnapshotPage("pages", 2, second.hash)).rejects.toThrow("gap");
  await expect(acknowledgeAccountingSnapshotPage("pages", 1, "incorrect")).rejects.toThrow("conflict");
  await expect(completeAccountingSnapshot("pages", cashBackHash(manifest))).rejects.toThrow("not acknowledged");
  await acknowledgeAccountingSnapshotPage("pages", 1, first.hash);
  await acknowledgeAccountingSnapshotPage("pages", 1, first.hash);
  expect(await runAccountingExportCommand(["snapshot-read", "pages"])).toEqual(second);
  await runAccountingExportCommand(["snapshot-ack", "pages", "2", second.hash]);
  expect(await readAccountingSnapshotPage("pages")).toBeNull();
  const completion = await completeAccountingSnapshot("pages", cashBackHash(manifest));
  expect(completion).toMatchObject({ status: "SOURCE_HANDOFF_COMPLETE", pageCount: 2, lastPageHash: second.hash });
  // A restart/retry returns retained bytes, not a new economic cut or a new grant.
  (fence.verifyAccountingSnapshotFence as jest.Mock).mockRejectedValue(new Error("maintenance released"));
  expect(await createAccountingSnapshot("pages", FROM)).toEqual(manifest);
  expect(await completeAccountingSnapshot("pages", cashBackHash(manifest))).toEqual(completion);
  await expect(createAccountingSnapshot("pages", TIME)).rejects.toThrow("conflict");
  await entries("pages");
});

it("keeps missing old economic time unavailable while allowing future windows after the observed cut", async () => {
  await fixture("known-open");
  const old = input("old-closed");
  await BetArchive.create({
    ...old.data, status: ResultingStatus.BET_WIN,
    timestamp: TIME, resultingTimestamp: TIME, // legacy envelope/order fields are NOT credit authority
  });
  const manifest = await createAccountingSnapshot("legacy", FROM);
  expect(manifest.coverage.openPositions).toBe("COMPLETE");
  expect(manifest.coverage.unavailableHistories).toBe(1);
  expect(manifest.coverage.realisedCompleteSince).toBe(new Date(Date.parse(manifest.cutAt) + 1).toISOString());
  const values = await entries("legacy");
  expect(values.filter(value => value.kind === "MOVEMENT")).toHaveLength(0);
  expect(values.find(value => value.kind === "POSITION" && value.slipId === "old-closed")).toMatchObject({
    history: "UNAVAILABLE", state: "TERMINAL", openExposure: "NONE",
    remainingStakeMinor: null, originalStakeMinor: null, maximumReturnMinor: null,
  });
});

it("does not round high precision or turn missing original scope into an empty scope", async () => {
  await fixture("precision", { wager: 1.001 });
  const pruned = await fixture("pruned", { rows: [
    createPreMatchRow({ id: "a", eventId: "first", productId: "one" }),
    createPreMatchRow({ id: "b", eventId: "second", productId: "two" }),
  ] });
  await Bet.updateOne({ _id: pruned._id }, { $pull: { rows: { id: "a" } }, $unset: { accountingScope: "" } });
  const manifest = await createAccountingSnapshot("unsupported", FROM);
  expect(manifest.coverage.unavailableOpenPositions).toBe(2);
  const values = await entries("unsupported");
  expect(values.find(value => value.kind === "POSITION" && value.slipId === "pruned")).toMatchObject({ facts: null, openExposure: "UNAVAILABLE" });
  expect(values.find(value => value.kind === "POSITION" && value.slipId === "precision")).toMatchObject({
    openExposure: "UNAVAILABLE", originalStakeMinor: null, remainingStakeMinor: null,
  });
});

it("retains original scoped IDs after void pruning and keeps Builder as one composite payout factor", async () => {
  const pruned = await fixture("retained", { rows: [
    createPreMatchRow({ id: "a", eventId: "first", productId: "one" }),
    createPreMatchRow({ id: "b", eventId: "second", productId: "two" }),
  ] });
  await Bet.updateOne({ _id: pruned._id }, { $pull: { rows: { id: "a" } } });
  const quote: MarketBet = {
    schemaVersion: 1, kind: "BUILDER", eventId: "builder-event", quoteId: "quote", odds: 3.75,
    modelId: "model", issuedAt: TIME, expiresAt: "2020-01-01T00:00:30.000Z",
    selections: ["one", "two"].map(marketId => ({
      origin: "TEMPLATE", marketId, outcomeKey: "yes", rulesRevision: 1, quoteRevision: 1,
      templateId: "template", templateVersion: 1, marketName: "Misleading 1X2", label: "Home",
      terms: "", settlementMode: "FINAL_SCORE", pricingMethod: "SCORE_MODEL",
      rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: 0.5 },
    })) as MarketBet["selections"],
  };
  await fixture("builder", { rows: [
    { ...createPreMatchRow({ id: "composite", eventId: quote.eventId, oddsValue: quote.odds }), marketBet: quote },
  ] });
  const manifest = await createAccountingSnapshot("scope", FROM);
  expect(manifest.coverage.openPositions).toBe("COMPLETE");
  const values = await entries("scope");
  expect(values.find(value => value.kind === "POSITION" && value.slipId === "retained")).toMatchObject({
    facts: { structure: "ACCUMULATOR", eventIds: ["first", "second"], productIds: ["one", "two"] },
  });
  expect(values.find(value => value.kind === "POSITION" && value.slipId === "builder")).toMatchObject({
    originalStakeMinor: 1000, maximumReturnMinor: 3750,
    facts: { structure: "BUILDER", marketIds: ["one", "two"], templateIds: ["template"] },
  });
  expect(JSON.stringify(values)).not.toContain("Misleading");
});

it("joins reordered projections, prefix/live duplicates and scalar tails; a revision gap blocks past-window coverage", async () => {
  const bet = (await fixture("partials")).toObject();
  const first = accountingClosureState(bet, "CASH_BACK", 400, 500, TIME);
  const second = accountingClosureState({ ...bet, ...first }, "CASH_BACK", 100, 200, TIME);
  await Bet.updateOne({ _id: bet._id }, { $set: {
    ...second, accounting: { schemaVersion: 1, status: "UNAVAILABLE", reason: "HISTORY_MISSING" }, accountingPrefixTruncated: true,
  } });
  const gap = await createAccountingSnapshot("gap", FROM);
  expect(gap.coverage).toMatchObject({ openPositions: "COMPLETE", unavailableHistories: 1 });
  expect((await entries("gap")).find(value => value.kind === "POSITION")).toMatchObject({
    remainingStakeMinor: 500, expectedRevision: 2, history: "UNAVAILABLE",
  });
  // History arrived in reverse delivery order; canonical tail was already stored.
  await retainAccountingHistory(undefined, second.accountingLastMovement);
  await retainAccountingHistory(undefined, first.accountingLastMovement);
  await retainAccountingHistory(undefined, first.accountingLastMovement);
  const complete = await createAccountingSnapshot("repaired", FROM);
  expect(complete.coverage).toMatchObject({ openPositions: "COMPLETE", unavailableHistories: 0, realisedCompleteSince: FROM });
  expect(complete.movements).toBe(2);
  const rows = (await entries("repaired")).filter(value => value.kind === "MOVEMENT");
  expect(rows.map(row => row.kind === "MOVEMENT" && row.movement.revision)).toEqual([1, 2]);
});

it("deduplicates an archive copy and fails on conflicting active/archive economic data", async () => {
  const bet = (await fixture("copy")).toObject();
  const closed = accountingClosureState(bet, "SETTLEMENT", 1000, 2000, TIME);
  await Bet.updateOne({ _id: bet._id }, { $set: { ...closed, status: ResultingStatus.BET_WIN } });
  const copy = (await Bet.findById(bet._id).lean())!;
  await BetArchive.create(copy);
  const manifest = await createAccountingSnapshot("copy-ok", FROM);
  expect(manifest.positions).toBe(1);
  expect(manifest.movements).toBe(1);
  await BetArchive.updateOne({ slipId: "copy" }, { $set: { wager: 20 } });
  await expect(createAccountingSnapshot("copy-conflict", FROM)).rejects.toThrow("Active/archive");
  await expect(readAccountingSnapshotManifest("copy-conflict")).rejects.toThrow("not sealed");
});

it("never publishes an incomplete build or certifies a source that changed during capture", async () => {
  const bet = await fixture("raced");
  let checks = 0;
  (fence.verifyAccountingSnapshotFence as jest.Mock).mockImplementation(async () => {
    if (++checks === 2) await Bet.updateOne({ _id: bet._id }, { $set: { wager: 20 }, $inc: { __v: 1 } });
    return authority;
  });
  await expect(createAccountingSnapshot("raced", FROM)).rejects.toThrow("changed during snapshot");
  expect((await AccountingSnapshot.findById("raced").lean() as any).state).toBe("FAILED");
  await expect(readAccountingSnapshotPage("raced")).rejects.toThrow("not sealed");
  await expect(createAccountingSnapshot("raced", FROM)).rejects.toThrow("new snapshot identity");
});

it("requires real maintenance authority and refuses parked/dead-letter ingress, not a caller completeness flag", async () => {
  (fence.verifyAccountingSnapshotFence as jest.Mock).mockRejectedValueOnce(new Error("fence missing"));
  await expect(createAccountingSnapshot("not-held", FROM)).rejects.toThrow("fence missing");
  expect(await AccountingSnapshot.exists({ _id: "not-held" })).toBeNull();
  await RetryRecord.collection.insertOne({ status: "DEAD_LETTER", __v: 0 });
  await expect(createAccountingSnapshot("parked", FROM)).rejects.toThrow("ingress");
  await RetryRecord.deleteMany({});
  await PendingModerationResult.collection.insertOne({ slipId: "missing", status: "EXHAUSTED", __v: 0 });
  await expect(createAccountingSnapshot("exhausted", FROM)).rejects.toThrow("ingress");
  for (const state of [{}, { messages: 1 }, { messages_unacknowledged: 1 }, { consumers: 1 }]) {
    expect(() => fence.assertDrainedAccountingQueue({
      name: "resulting_place_bet", vhost: "/", messages: 0, messages_ready: 0, messages_unacknowledged: 0, consumers: 0,
      ...state, ...(Object.keys(state).length ? {} : { messages_ready: undefined }),
    }, "resulting_place_bet", "/")).toThrow();
  }
});

it("refuses a stale final handoff after source changes, even when all page acknowledgements were durable", async () => {
  const bet = await fixture("handoff");
  const manifest = await createAccountingSnapshot("handoff", FROM);
  const page = (await readAccountingSnapshotPage("handoff"))!;
  await acknowledgeAccountingSnapshotPage("handoff", page.page, page.hash);
  await Bet.updateOne({ _id: bet._id }, { $set: { wager: 30 }, $inc: { __v: 1 } });
  await expect(completeAccountingSnapshot("handoff", cashBackHash(manifest))).rejects.toThrow("no longer held");
  expect(await readAccountingSnapshotPage("handoff", 1)).toEqual(page);
  expect((await AccountingSnapshot.findById("handoff").lean() as any).completion).toBeUndefined();
});

it("joins accepted receipts to immutable movements rather than inventing monetary identity from receipts alone", async () => {
  const bet = (await fixture("receipt")).toObject();
  const partial = accountingClosureState(bet, "CASH_BACK", 400, 500, TIME);
  await Bet.updateOne({ _id: bet._id }, { $set: partial });
  const receipt = {
    outcome: "ACCEPTED", decisionTime: TIME, quote: { closedStakeMinor: 400, returnMinor: 500 },
    financial: { originalStakeMinor: 1000, remainingStakeMinor: 600 },
  };
  await CashBackOperation.collection.insertOne({
    operationId: "receipt-test", operation: { slipId: bet.slipId, userId: bet.userId },
    outcome: { outcome: "ACCEPTED", receipt, receiptFingerprint: cashBackHash(receipt), accounting: partial.accounting }, __v: 0,
  });
  expect((await createAccountingSnapshot("receipt-ok", FROM)).coverage.unavailableHistories).toBe(0);
  const changed = { ...receipt, quote: { closedStakeMinor: 400, returnMinor: 999 } };
  await CashBackOperation.collection.updateOne({ operationId: "receipt-test" }, {
    $set: { "outcome.receipt": changed, "outcome.receiptFingerprint": cashBackHash(changed) },
  });
  const bad = await createAccountingSnapshot("receipt-conflict", FROM);
  expect(bad.coverage).toMatchObject({ openPositions: "UNAVAILABLE", unavailableHistories: 1 });
});

it("fails dark for an interrupted build, changed fence, oversized entry or orphan movement", async () => {
  await fixture("oversize");
  await AccountingSnapshot.create({ _id: "interrupted", requestedFrom: FROM, state: "BUILDING", token: "lost", __v: 0 });
  await expect(createAccountingSnapshot("interrupted", FROM)).rejects.toThrow("new snapshot identity");
  (fence.verifyAccountingSnapshotFence as jest.Mock).mockResolvedValueOnce(authority)
    .mockResolvedValueOnce({ ...authority, generation: "2" });
  await expect(createAccountingSnapshot("new-fence", FROM)).rejects.toThrow("fence changed");
  await Bet.updateOne({ slipId: "oversize" }, { $set: { "accountingScope.facts.eventIds": ["x".repeat(512 * 1024)] } });
  await expect(createAccountingSnapshot("oversize", FROM)).rejects.toThrow("page budget");
  await expect(readAccountingSnapshotPage("oversize")).rejects.toThrow("not sealed");
  await Bet.deleteMany({});
  const event = input("orphan");
  const state = accountingClosureState({ ...event.data, ...accountingPlacementState(event.data) }, "SETTLEMENT", 1000, 0, TIME);
  await retainAccountingHistory(undefined, state.accountingLastMovement);
  await expect(createAccountingSnapshot("orphan", FROM)).rejects.toThrow("Orphan");
});

it("the unmocked maintenance guard refuses missing authority without issuing subprocess/network calls", async () => {
  const saved = process.env.NAMESPACE;
  delete process.env.NAMESPACE;
  try {
    await expect(actualFenceCheck()).rejects.toThrow("verified held maintenance lease");
  } finally {
    if (saved !== undefined) process.env.NAMESPACE = saved;
  }
  expect(() => fence.assertDrainedAccountingQueue({
    name: "resulting_place_bet", vhost: "/", messages: 0, messages_ready: 0, messages_unacknowledged: 0, consumers: 0,
  }, "resulting_place_bet", "/")).not.toThrow();
});
