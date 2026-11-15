import {
  assertBetAccountingEvidence, BetAccountingMovement, fixedOddsReturnMinor, nominalStakeMinor, ResultingStatus,
} from "@betstan/common";
import { createHash, randomUUID } from "crypto";
import { model, Schema } from "mongoose";
import { Bet, BetArchive } from "../model/Bet";
import { CashBackOperation } from "../model/CashBackOperation";
import PendingModerationResult from "../model/PendingModerationResult";
import RetryRecord from "../model/RetryRecord";
import { AccountingMovement, assertAccountingMovement } from "./accountingHistory";
import { AccountingScope, accountingScopeForBet } from "./accountingScope";
import { AccountingSnapshotFence, verifyAccountingSnapshotFence } from "./accountingSnapshotFence";
import { cashBackHash } from "./cashBackIdentity";

/** Private Resulting -> reconciliation receiver DTO; not a public Risk API.
 * Position facts seed the receiver's book, NOT a submission/turnover receipt.
 * TERMINAL is exposure state, never a zero-return or newly dated payout credit.
 * Only MOVEMENT entries may populate the realised-money ledger.
 */
export interface AccountingSnapshotPosition {
  kind: "POSITION";
  slipId: string;
  userId: string;
  sourceStatus: string;
  state: "PENDING" | "ACCEPTED" | "TERMINAL" | "DECLINED";
  facts: AccountingScope | null;
  placementFingerprint: string | null;
  originalStakeMinor: number | null;
  remainingStakeMinor: number | null;
  maximumReturnMinor: number | null;
  expectedRevision: number | null;
  openExposure: "COMPLETE" | "UNAVAILABLE" | "NONE";
  history: "COMPLETE" | "UNAVAILABLE";
}
export type AccountingSnapshotEntry = AccountingSnapshotPosition
  | { kind: "MOVEMENT"; movement: BetAccountingMovement };
export interface AccountingSnapshotPage {
  schemaVersion: 1;
  snapshotId: string;
  page: number;
  previousHash: string;
  entries: AccountingSnapshotEntry[];
  hash: string;
}
export interface AccountingSnapshotManifest {
  schemaVersion: 1;
  source: "RESULTING";
  snapshotId: string;
  status: "COMPLETE";
  cutAt: string;
  requestedFrom: string;
  fence: AccountingSnapshotFence;
  sourceDigest: string;
  pageCount: number;
  lastPageHash: string;
  positions: number;
  movements: number;
  coverage: {
    openPositions: "COMPLETE" | "UNAVAILABLE";
    unavailableOpenPositions: number;
    unavailableHistories: number;
    /** Inclusive lower boundary, through cutAt. With unknown history this is
     * cutAt+1ms: no past window is certified, but future windows can recover
     * with an uninterrupted, validated live/reconciliation continuation.
     */
    realisedCompleteSince: string;
    through: string;
    submissionAndTurnoverReceipts: "NOT_OWNED";
  };
  /** Source completeness alone cannot prove that an upstream accepted placement
   * was ever delivered here. Receiver MUST join its own durable approved receipts,
   * account for pending outboxes/inboxes, and commit the exact final marker under
   * the same maintenance lease before activation. No remote DB read by Resulting.
   */
  handoff: "RECONCILE_RECEIVER_INTAKE_AND_LIVE_OVERLAP_BEFORE_RELEASE";
}
const jobSchema = new Schema({
  _id: String, requestedFrom: String, token: String, state: String, cutAt: Date,
  manifest: Schema.Types.Mixed, manifestHash: String, acknowledgedPage: Number, completion: Schema.Types.Mixed,
});
export const AccountingSnapshot = model<any>("AccountingSnapshot", jobSchema);
const itemSchema = new Schema({
  snapshotId: String, kind: String, identity: String, slipId: String, revision: Number,
  fingerprint: String, data: Schema.Types.Mixed, validation: Schema.Types.Mixed,
});
itemSchema.index({ snapshotId: 1, kind: 1, identity: 1 }, { unique: true });
itemSchema.index({ snapshotId: 1, kind: 1, slipId: 1, revision: 1 });
export const AccountingSnapshotItem = model<any>("AccountingSnapshotItem", itemSchema);
const pageSchema = new Schema({ snapshotId: String, page: Number, data: Schema.Types.Mixed });
pageSchema.index({ snapshotId: 1, page: 1 }, { unique: true });
export const AccountingSnapshotPageRecord = model<any>("AccountingSnapshotPage", pageSchema);

const terminal = new Set<string>([
  ResultingStatus.BET_WIN, ResultingStatus.BET_LOSS, ResultingStatus.BET_VOID, ResultingStatus.BET_CASH_BACK,
]);
const PAGE_BYTES = 512 * 1024;
const PAGE_ENTRIES = 50;
const initialHash = (id: string) => cashBackHash({ schemaVersion: 1, source: "RESULTING", snapshotId: id });
const serializable = (value: any) => JSON.parse(JSON.stringify(value));
const safe = (value: any): value is number => Number.isSafeInteger(value) && value >= 0;
const iso = (value: string) => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function identity(id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid accounting snapshot identity");
}

function positionFor(bet: any): { data: AccountingSnapshotPosition; validation: any } {
  if (!bet.slipId || !bet.userId) throw new Error("Accounting source owner missing");
  const state = terminal.has(bet.status) ? "TERMINAL"
    : bet.status === ResultingStatus.BET_APPROVED ? "ACCEPTED"
      : bet.status === ResultingStatus.BET_PENDING ? "PENDING"
        : bet.status === ResultingStatus.BET_DECLINED ? "DECLINED" : undefined;
  if (!state) throw new Error("Unknown accounting source state");
  const data: AccountingSnapshotPosition = {
    kind: "POSITION", slipId: bet.slipId, userId: bet.userId, sourceStatus: bet.status, state,
    facts: accountingScopeForBet(bet) ?? null, placementFingerprint: null,
    originalStakeMinor: null, remainingStakeMinor: null, maximumReturnMinor: null, expectedRevision: null,
    openExposure: state === "PENDING" || state === "ACCEPTED" ? "UNAVAILABLE" : "NONE",
    history: "UNAVAILABLE",
  };
  let validation: any = { readable: state === "DECLINED", cumulativeReturn: 0, lastHash: null };
  try {
    const basis = bet.accountingBasis;
    if (!basis || !safe(basis.originalStakeMinor) || basis.originalStakeMinor === 0
      || nominalStakeMinor(bet.wager) !== basis.originalStakeMinor
      || !/^[0-9a-f]{64}$/.test(basis.placementFingerprint)
      || !Array.isArray(basis.rows) || !basis.rows.length
      || new Set(basis.rows.map((row: any) => row.id)).size !== basis.rows.length
      || basis.rows.some((row: any) => typeof row.id !== "string" || !row.id)) throw new Error("Missing placement basis");
    const maximumReturnMinor = fixedOddsReturnMinor(basis.originalStakeMinor, basis.rows.map((row: any) => row.odds));
    const bound = bet.accountingPayoutBound;
    if (bound?.schemaVersion !== 1 || bound.method !== "STANDALONE_FIXED_ODDS"
      || bound.placementFingerprint !== basis.placementFingerprint || bound.originalStakeMinor !== basis.originalStakeMinor
      || bound.maximumReturnMinor !== maximumReturnMinor) throw new Error("Missing payout bound");
    data.placementFingerprint = basis.placementFingerprint;
    data.originalStakeMinor = basis.originalStakeMinor;
    data.maximumReturnMinor = maximumReturnMinor;
    const complete = bet.accounting?.status === "COMPLETE";
    const last = bet.accountingLastMovement ?? (complete ? bet.accounting.movements[bet.accounting.movements.length - 1] : undefined);
    const revision = bet.accountingRevision ?? (complete ? bet.accounting.movements.length : undefined);
    const cumulativeReturn = bet.accountingCumulativeReturnMinor ?? (complete
      ? Number(bet.accounting.movements.reduce((sum: bigint, m: BetAccountingMovement) => sum + BigInt(m.returnMinor), BigInt(0))) : undefined);
    if (!safe(revision) || !safe(cumulativeReturn) || revision !== (last?.revision ?? 0)) throw new Error("Missing accounting counters");
    if (last) {
      assertAccountingMovement(last);
      if (last.slipId !== bet.slipId || last.userId !== bet.userId
        || last.placementFingerprint !== basis.placementFingerprint || last.originalStakeMinor !== basis.originalStakeMinor) {
        throw new Error("Accounting identity mismatch");
      }
    }
    const remaining = last?.remainingStakeMinor ?? basis.originalStakeMinor;
    // Cash-back financial snapshots are checked only for OPEN exposure. Normal
    // settlement deliberately retains the old cash-back basis, NOT final payout.
    if (state === "ACCEPTED" || state === "PENDING") {
      const financial = bet.cashBackFinancial;
      if (remaining === 0 || (financial && (financial.originalStakeMinor !== basis.originalStakeMinor
        || financial.remainingStakeMinor !== remaining
        || financial.cumulativeClosedStakeMinor !== basis.originalStakeMinor - remaining
        || financial.cumulativeReturnMinor !== cumulativeReturn))) throw new Error("Open source counters disagree");
      if (data.facts) data.openExposure = "COMPLETE";
    }
    data.expectedRevision = revision;
    data.remainingStakeMinor = remaining;
    validation = {
      readable: (complete || bet.accountingPrefixTruncated === true)
        && (state !== "TERMINAL" || (remaining === 0 && !bet.accountingTimeUnavailable)),
      cumulativeReturn, lastHash: last ? cashBackHash(last) : null,
    };
  } catch {
    // Keep explicit nulls/unavailability; never round or synthesize old history.
  }
  return { data, validation };
}

async function stageMovement(snapshotId: string, movement: BetAccountingMovement) {
  assertAccountingMovement(movement);
  const fingerprint = cashBackHash(movement);
  const filter = { snapshotId, kind: "MOVEMENT", identity: movement.movementId };
  await AccountingSnapshotItem.updateOne(filter, { $setOnInsert: {
    ...filter, slipId: movement.slipId, revision: movement.revision, fingerprint,
    data: { kind: "MOVEMENT", movement }, __v: 0,
  } }, { upsert: true });
  const previous = await AccountingSnapshotItem.findOne(filter).lean() as any;
  if (previous?.fingerprint !== fingerprint) throw new Error("Conflicting accounting snapshot movement");
}

async function stageEvidence(snapshotId: string, evidence: any) {
  if (!evidence) return;
  assertBetAccountingEvidence(evidence);
  if (evidence.status === "COMPLETE") for (const movement of evidence.movements) await stageMovement(snapshotId, movement);
}

async function stageBet(snapshotId: string, bet: any) {
  const economic = { ...serializable(bet), __v: bet.__v ?? 0 };
  delete economic._id;
  delete economic.cashBackArchiving; // archive copy intentionally omits this lock.
  const fingerprint = cashBackHash(economic);
  const filter = { snapshotId, kind: "POSITION", identity: bet.slipId };
  const previous = await AccountingSnapshotItem.findOne(filter).lean() as any;
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new Error("Active/archive accounting snapshot conflict");
    return;
  }
  const { data, validation } = positionFor(bet);
  await AccountingSnapshotItem.create({ ...filter, slipId: bet.slipId, revision: 0, fingerprint, data, validation, __v: 0 });
  await stageEvidence(snapshotId, bet.accounting);
  for (const movement of [bet.accountingLastMovement, bet.cashBackPending?.accountingMovement]) {
    if (movement) await stageMovement(snapshotId, movement);
  }
}

async function stageReceipt(snapshotId: string, operation: any, cutAt: string) {
  const position = await AccountingSnapshotItem.findOne({
    snapshotId, kind: "POSITION", slipId: operation.operation?.slipId,
  }).lean() as any;
  if (!position) throw new Error("Orphan accepted cash-back receipt");
  const outcome = operation.outcome;
  await stageEvidence(snapshotId, outcome.accounting);
  const receipt = outcome.receipt;
  if (receipt && iso(receipt.decisionTime) && receipt.decisionTime > cutAt) {
    throw new Error("Source receipt has future economic time");
  }
  const readable = receipt?.outcome === "ACCEPTED" && iso(receipt.decisionTime)
    && outcome.receiptFingerprint === cashBackHash(receipt)
    && safe(receipt.quote?.closedStakeMinor) && safe(receipt.quote?.returnMinor)
    && safe(receipt.financial?.remainingStakeMinor) && safe(receipt.financial?.originalStakeMinor);
  // Receipt evidence alone cannot invent an accounting revision/identity. It
  // must join an actual source-owned movement from the canonical prefix/history.
  const matched = readable && await AccountingSnapshotItem.exists({
    snapshotId, kind: "MOVEMENT", slipId: position.slipId,
    "data.movement.userId": position.data.userId, "data.movement.source": "CASH_BACK",
    "data.movement.occurredAt": receipt.decisionTime,
    "data.movement.closedStakeMinor": receipt.quote.closedStakeMinor,
    "data.movement.returnMinor": receipt.quote.returnMinor,
    "data.movement.remainingStakeMinor": receipt.financial.remainingStakeMinor,
    "data.movement.originalStakeMinor": receipt.financial.originalStakeMinor,
  });
  if (!matched) {
    const data = position.data as AccountingSnapshotPosition;
    if (data.openExposure !== "NONE") data.openExposure = "UNAVAILABLE";
    await AccountingSnapshotItem.updateOne({ _id: position._id }, {
      $set: { "validation.readable": false, data }, $inc: { __v: 1 },
    });
  }
}

async function validatePositions(snapshotId: string, cutAt: string) {
  let positions = 0, unavailableOpenPositions = 0, unavailableHistories = 0;
  for await (const record of AccountingSnapshotItem.find({ snapshotId, kind: "POSITION" }).lean().cursor({ batchSize: 50 })) {
    const position = record.data as AccountingSnapshotPosition;
    let revision = 0, remaining = position.originalStakeMinor, total = BigInt(0), lastHash: string | null = null;
    let valid = record.validation.readable && position.facts !== null;
    for await (const row of AccountingSnapshotItem.find({ snapshotId, kind: "MOVEMENT", slipId: position.slipId })
      .sort({ revision: 1 }).lean().cursor({ batchSize: 50 })) {
      const m = row.data.movement as BetAccountingMovement;
      if (m.occurredAt > cutAt) throw new Error("Source movement has future economic time");
      if (m.userId !== position.userId || m.originalStakeMinor !== position.originalStakeMinor
        || m.placementFingerprint !== position.placementFingerprint || m.revision !== revision + 1
        || remaining === null || BigInt(m.closedStakeMinor) + BigInt(m.remainingStakeMinor) !== BigInt(remaining)) valid = false;
      revision = m.revision;
      remaining = m.remainingStakeMinor;
      total += BigInt(m.returnMinor);
      lastHash = row.fingerprint;
    }
    if (position.state === "DECLINED" && revision !== 0) throw new Error("Declined placement has accounting movements");
    valid = position.state === "DECLINED" || (valid
      && position.expectedRevision === revision && position.remainingStakeMinor === remaining
      && lastHash === record.validation.lastHash && total === BigInt(record.validation.cumulativeReturn ?? -1));
    position.history = valid ? "COMPLETE" : "UNAVAILABLE";
    if (!valid) unavailableHistories++;
    if (position.openExposure === "UNAVAILABLE") unavailableOpenPositions++;
    positions++;
    await AccountingSnapshotItem.updateOne({ _id: record._id }, { $set: { data: position }, $inc: { __v: 1 } });
  }
  // A retained payment without its canonical aggregate is not an empty book.
  for await (const row of AccountingSnapshotItem.find({ snapshotId, kind: "MOVEMENT" }).lean().cursor({ batchSize: 50 })) {
    if (!await AccountingSnapshotItem.exists({ snapshotId, kind: "POSITION", slipId: row.slipId })) {
      throw new Error("Orphan source accounting movement");
    }
  }
  return { positions, unavailableOpenPositions, unavailableHistories };
}

/** Full source scan uses bounded cursors, not an in-memory whole book. A second
 * digest rejects accidental canonical writes even if an operator mismanages the
 * physical fence. No financial source record is mutated by this transport.
 */
async function scanSource(visit?: (collection: string, value: any) => Promise<void>) {
  const digest = createHash("sha256");
  for (const source of [Bet, BetArchive, AccountingMovement, CashBackOperation, RetryRecord, PendingModerationResult]) {
    digest.update(`${source.collection.name}\n`);
    for await (const value of source.collection.find({}).sort({ _id: 1 }).batchSize(50)) {
      digest.update(cashBackHash(serializable(value)));
      if (visit) await visit(source.collection.name, value);
    }
  }
  return digest.digest("hex");
}

async function materializePages(snapshotId: string) {
  let page = 0, previousHash = initialHash(snapshotId);
  let entries: AccountingSnapshotEntry[] = [], bytes = 0;
  const flush = async () => {
    if (!entries.length) return;
    const payload = { schemaVersion: 1 as const, snapshotId, page: ++page, previousHash, entries };
    const hash = cashBackHash(payload);
    await AccountingSnapshotPageRecord.create({ snapshotId, page, data: { ...payload, hash }, __v: 0 });
    previousHash = hash;
    entries = []; bytes = 0;
  };
  // Placement identities precede movement revisions; no public presentation order.
  for (const kind of ["POSITION", "MOVEMENT"]) {
    for await (const record of AccountingSnapshotItem.find({ snapshotId, kind }).sort({ slipId: 1, revision: 1 }).lean().cursor({ batchSize: 50 })) {
      const size = Buffer.byteLength(JSON.stringify(record.data));
      if (size > PAGE_BYTES - 1024) throw new Error("Accounting snapshot entry exceeds page budget");
      if (entries.length >= PAGE_ENTRIES || bytes + size > PAGE_BYTES - 1024) await flush();
      entries.push(record.data);
      bytes += size;
    }
  }
  await flush();
  return { pageCount: page, lastPageHash: previousHash };
}

const builds = new Map<string, { from: string; work: Promise<AccountingSnapshotManifest> }>();
export async function createAccountingSnapshot(snapshotId: string, requestedFrom: string): Promise<AccountingSnapshotManifest> {
  identity(snapshotId);
  if (!iso(requestedFrom)) throw new Error("Invalid accounting coverage boundary");
  const existing = builds.get(snapshotId);
  if (existing) {
    if (existing.from !== requestedFrom) throw new Error("Accounting snapshot request conflict");
    return existing.work;
  }
  const work = buildSnapshot(snapshotId, requestedFrom);
  builds.set(snapshotId, { from: requestedFrom, work });
  try { return await work; } finally { if (builds.get(snapshotId)?.work === work) builds.delete(snapshotId); }
}

async function buildSnapshot(snapshotId: string, requestedFrom: string): Promise<AccountingSnapshotManifest> {
  await Promise.all([AccountingSnapshot.init(), AccountingSnapshotItem.init(), AccountingSnapshotPageRecord.init()]);
  const old = await AccountingSnapshot.findById(snapshotId).lean() as any;
  if (old) {
    if (old.requestedFrom !== requestedFrom) throw new Error("Accounting snapshot request conflict");
    if (old.state === "SEALED") return readAccountingSnapshotManifest(snapshotId);
    throw new Error("Snapshot build incomplete; reverify maintenance and use a new snapshot identity");
  }
  const fence = await verifyAccountingSnapshotFence();
  if (await RetryRecord.exists({ status: { $ne: "COMPLETED" } }) || await PendingModerationResult.exists({})) {
    throw new Error("Source parked/dead-letter ingress must be reconciled before snapshot");
  }
  const token = randomUUID();
  // Including the new token prevents a concurrent creator from changing cutAt
  // on an already-created job; the unique _id rejects that attempted insert.
  await AccountingSnapshot.updateOne({ _id: snapshotId, token }, {
    $setOnInsert: { requestedFrom, token, state: "BUILDING", acknowledgedPage: 0, __v: 0 },
    $currentDate: { cutAt: true },
  }, { upsert: true });
  const job = await AccountingSnapshot.findById(snapshotId).lean() as any;
  if (job.token !== token) throw new Error("Concurrent accounting snapshot build");
  const cutAt = new Date(job.cutAt).toISOString();
  try {
    if (requestedFrom > cutAt) throw new Error("Accounting coverage begins after source cut");
    let lastCheck = Date.now();
    const checkFence = async () => {
      if (cashBackHash(await verifyAccountingSnapshotFence()) !== cashBackHash(fence)) throw new Error("Accounting snapshot fence changed");
      lastCheck = Date.now();
    };
    const sourceDigest = await scanSource(async (collection, value) => {
      if (Date.now() - lastCheck > 10000) await checkFence();
      if (collection === Bet.collection.name || collection === BetArchive.collection.name) await stageBet(snapshotId, value);
      else if (collection === AccountingMovement.collection.name) {
        if (cashBackHash(value.movement) !== value.fingerprint) throw new Error("Source movement fingerprint mismatch");
        await stageMovement(snapshotId, value.movement);
      } else if (collection === CashBackOperation.collection.name && value.outcome?.outcome === "ACCEPTED") {
        await stageReceipt(snapshotId, value, cutAt);
      }
    });
    const counts = await validatePositions(snapshotId, cutAt);
    const pages = await materializePages(snapshotId);
    await checkFence();
    if (await scanSource() !== sourceDigest) throw new Error("Canonical accounting source changed during snapshot");
    await checkFence();
    const manifest: AccountingSnapshotManifest = {
      schemaVersion: 1, source: "RESULTING", snapshotId, status: "COMPLETE", cutAt, requestedFrom,
      fence, sourceDigest, ...pages, positions: counts.positions,
      movements: await AccountingSnapshotItem.countDocuments({ snapshotId, kind: "MOVEMENT" }),
      coverage: {
        openPositions: counts.unavailableOpenPositions ? "UNAVAILABLE" : "COMPLETE",
        unavailableOpenPositions: counts.unavailableOpenPositions, unavailableHistories: counts.unavailableHistories,
        realisedCompleteSince: counts.unavailableHistories ? new Date(Date.parse(cutAt) + 1).toISOString() : requestedFrom,
        through: cutAt, submissionAndTurnoverReceipts: "NOT_OWNED",
      },
      handoff: "RECONCILE_RECEIVER_INTAKE_AND_LIVE_OVERLAP_BEFORE_RELEASE",
    };
    const saved = await AccountingSnapshot.updateOne({ _id: snapshotId, token, state: "BUILDING" }, {
      $set: { state: "SEALED", manifest, manifestHash: cashBackHash(manifest) }, $inc: { __v: 1 },
    });
    if (saved.modifiedCount !== 1) throw new Error("Accounting snapshot sealing conflict");
    return manifest;
  } catch (error) {
    await AccountingSnapshot.updateOne({ _id: snapshotId, token, state: "BUILDING" }, { $set: { state: "FAILED" }, $inc: { __v: 1 } });
    throw error;
  }
}

export async function readAccountingSnapshotManifest(snapshotId: string): Promise<AccountingSnapshotManifest> {
  identity(snapshotId);
  const job = await AccountingSnapshot.findById(snapshotId).lean() as any;
  if (job?.state !== "SEALED" || !job.manifest || job.manifestHash !== cashBackHash(job.manifest)) {
    throw new Error("Accounting snapshot is not sealed");
  }
  return job.manifest;
}

export async function readAccountingSnapshotPage(snapshotId: string, requestedPage?: number): Promise<AccountingSnapshotPage | null> {
  const manifest = await readAccountingSnapshotManifest(snapshotId);
  const job = await AccountingSnapshot.findById(snapshotId).lean() as any;
  const page = requestedPage ?? job.acknowledgedPage + 1;
  if (!Number.isSafeInteger(page) || page < 1 || page > manifest.pageCount + 1) throw new Error("Invalid accounting snapshot page");
  if (page === manifest.pageCount + 1) return null;
  const stored = await AccountingSnapshotPageRecord.findOne({ snapshotId, page }).lean() as any;
  if (!stored?.data) throw new Error("Missing sealed accounting snapshot page");
  const { hash, ...payload } = stored.data;
  if (hash !== cashBackHash(payload) || payload.snapshotId !== snapshotId || payload.page !== page) {
    throw new Error("Accounting snapshot page integrity failure");
  }
  return stored.data;
}

/** Exact hash-bound durable receiver acknowledgement. Never acknowledges gaps. */
export async function acknowledgeAccountingSnapshotPage(snapshotId: string, page: number, hash: string): Promise<void> {
  const payload = await readAccountingSnapshotPage(snapshotId, page);
  if (!payload || payload.hash !== hash) throw new Error("Accounting snapshot acknowledgement conflict");
  const updated = await AccountingSnapshot.updateOne({ _id: snapshotId, state: "SEALED", acknowledgedPage: page - 1 }, {
    $set: { acknowledgedPage: page }, $inc: { __v: 1 },
  });
  if (!updated.modifiedCount) {
    const job = await AccountingSnapshot.findById(snapshotId).lean() as any;
    if (!job || job.acknowledgedPage < page) throw new Error("Accounting snapshot acknowledgement gap");
  }
}

/** Final source-side handoff. Receiver readiness is a separate, receiver-owned
 * atomic commit, requiring its receipt reconciliation and this exact completion.
 * This does not certify submission/turnover history or enable any policy.
 */
export async function completeAccountingSnapshot(snapshotId: string, manifestHash: string) {
  const manifest = await readAccountingSnapshotManifest(snapshotId);
  if (cashBackHash(manifest) !== manifestHash) throw new Error("Accounting snapshot manifest acknowledgement conflict");
  const job = await AccountingSnapshot.findById(snapshotId).lean() as any;
  if (job.acknowledgedPage !== manifest.pageCount) throw new Error("Accounting snapshot pages are not acknowledged");
  // Repeated completion remains a historical receipt, not a fresh readiness claim.
  if (job.completion) return job.completion;
  const fence = await verifyAccountingSnapshotFence();
  if (cashBackHash(fence) !== cashBackHash(manifest.fence) || await scanSource() !== manifest.sourceDigest
    || cashBackHash(await verifyAccountingSnapshotFence()) !== cashBackHash(fence)) {
    throw new Error("Accounting snapshot cut is no longer held");
  }
  const completion = { schemaVersion: 1, snapshotId, manifestHash, lastPageHash: manifest.lastPageHash,
    pageCount: manifest.pageCount, fence, cutAt: manifest.cutAt, status: "SOURCE_HANDOFF_COMPLETE" };
  await AccountingSnapshot.updateOne({ _id: snapshotId, state: "SEALED", completion: { $exists: false } }, {
    $set: { completion }, $inc: { __v: 1 },
  });
  return completion;
}
