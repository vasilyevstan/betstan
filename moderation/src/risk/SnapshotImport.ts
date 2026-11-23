import { assertBetAccountingEvidence, BetAccountingMovement, ModerationStatus } from "@betstan/common";
import { ClientSession } from "mongoose";
import { Bet } from "../model/Bet";
import { applyMovementPrefix, completeEvidence } from "./Accounting";
import { facts, money } from "./Evaluation";
import { canonical, fingerprint, RiskError } from "./Policy";
import { SnapshotCompletion, SnapshotEntry, SnapshotManifest, SnapshotPage, SnapshotPosition } from "./SnapshotContract";
import * as authority from "./SnapshotFence";
import { RiskAccountingInbox, RiskBaseline, riskEnabled, RiskMovement, RiskPosition, RiskSnapshot, RiskSnapshotPage, RiskState, transaction } from "./Store";

const MAX_POSITIONS = 10000, MAX_MOVEMENTS = 10000, MAX_IMPORT_BYTES = 16 * 1024 * 1024;
function fail(message: string): never { throw new RiskError("SNAPSHOT_INVALID", message, 409); }
const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256;
const safe = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const initialHash = (id: string) => fingerprint({ schemaVersion: 1, source: "RESULTING", snapshotId: id });
const inFlight = new Map<string, { hash: string; work: Promise<any> }>();
async function coalesced<T>(id: string, value: unknown, action: () => Promise<T>): Promise<T> {
  const contentHash = fingerprint(value);
  const old = inFlight.get(id);
  if (old) {
    if (old.hash !== contentHash) fail("Concurrent immutable import identity conflict");
    return old.work;
  }
  const work = action();
  inFlight.set(id, { hash: contentHash, work });
  try { return await work; } finally { if (inFlight.get(id)?.work === work) inFlight.delete(id); }
}
function bounded(value: unknown, bytes: number) {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > bytes) fail("Snapshot exceeds supported import bound");
}
function assertManifest(value: unknown): asserts value is SnapshotManifest {
  bounded(value, 16384);
  const m = value as SnapshotManifest;
  if (!m || m.schemaVersion !== 1 || m.source !== "RESULTING" || m.status !== "COMPLETE"
    || !text(m.snapshotId) || !/^[A-Za-z0-9_-]{1,128}$/.test(m.snapshotId) || !iso(m.cutAt) || !iso(m.requestedFrom) || m.requestedFrom > m.cutAt
    || !hash(m.sourceDigest) || !hash(m.lastPageHash) || !safe(m.pageCount) || !safe(m.positions) || !safe(m.movements)
    || m.positions > MAX_POSITIONS || m.movements > MAX_MOVEMENTS || m.pageCount > m.positions + m.movements
    || !m.fence || !text(m.fence.namespace) || !text(m.fence.operationId) || !/^[a-f0-9]{40}$/.test(m.fence.sourceSha)
    || !/^[1-9][0-9]*$/.test(m.fence.generation) || !hash(m.fence.identityHash)
    || m.handoff !== "RECONCILE_RECEIVER_INTAKE_AND_LIVE_OVERLAP_BEFORE_RELEASE") fail("Invalid source snapshot manifest");
  const c = m.coverage;
  if (!c || !["COMPLETE", "UNAVAILABLE"].includes(c.openPositions) || !safe(c.unavailableOpenPositions)
    || !safe(c.unavailableHistories) || c.unavailableOpenPositions > m.positions || c.unavailableHistories > m.positions
    || c.openPositions !== (c.unavailableOpenPositions ? "UNAVAILABLE" : "COMPLETE")
    || c.through !== m.cutAt || c.submissionAndTurnoverReceipts !== "NOT_OWNED"
    || c.realisedCompleteSince !== (c.unavailableHistories ? new Date(Date.parse(m.cutAt) + 1).toISOString() : m.requestedFrom)) fail("Invalid source coverage");
}
function validatePosition(p: SnapshotPosition) {
  const statuses: Record<string, string[]> = {
    PENDING: ["BET_PENDING"], ACCEPTED: ["BET_APPROVED"], TERMINAL: ["BET_WIN", "BET_LOSS", "BET_VOID", "BET_CASH_BACK"], DECLINED: ["BET_DECLINED"],
  };
  if (!text(p.slipId) || !text(p.userId) || !statuses[p.state]?.includes(p.sourceStatus)
    || !["COMPLETE", "UNAVAILABLE", "NONE"].includes(p.openExposure) || !["COMPLETE", "UNAVAILABLE"].includes(p.history)
    || (["PENDING", "ACCEPTED"].includes(p.state) ? p.openExposure === "NONE" : p.openExposure !== "NONE")) fail("Invalid source position");
  for (const amount of [p.originalStakeMinor, p.remainingStakeMinor, p.maximumReturnMinor, p.expectedRevision]) {
    if (amount !== null && !safe(amount)) fail("Invalid exact source amount");
  }
  if (p.placementFingerprint !== null && !hash(p.placementFingerprint)) fail("Invalid placement fingerprint");
  if (p.facts !== null) {
    if (!p.facts || !["PRE_MATCH", "LIVE"].includes(p.facts.betKind) || !["SINGLE", "ACCUMULATOR", "BUILDER"].includes(p.facts.structure)
      || !p.facts.eventIds?.length || !p.facts.productIds?.length) fail("Missing original scope");
    for (const field of ["eventIds", "productIds", "marketIds", "templateIds"] as const) {
      const ids = p.facts[field];
      if (!Array.isArray(ids) || ids.length > 10000 || !ids.every(text)
        || canonical(ids) !== canonical([...new Set(ids)].sort())) fail("Invalid original scoped IDs");
    }
  }
  if (p.openExposure === "COMPLETE" && (!p.facts || !p.placementFingerprint || !p.originalStakeMinor
    || !p.remainingStakeMinor || p.maximumReturnMinor === null || p.maximumReturnMinor < p.originalStakeMinor
    || p.remainingStakeMinor > p.originalStakeMinor || p.expectedRevision === null)) fail("Incomplete open exposure assertion");
}
function validateMovement(m: BetAccountingMovement) {
  if (!m || m.schemaVersion !== 1 || ![m.movementId, m.slipId, m.userId].every(text) || !hash(m.placementFingerprint)
    || ![m.revision, m.closedStakeMinor, m.returnMinor, m.remainingStakeMinor, m.originalStakeMinor].every(safe)
    || !m.revision || !m.closedStakeMinor || !m.originalStakeMinor || !iso(m.occurredAt)
    || !["SETTLEMENT", "CASH_BACK"].includes(m.source)
    || (m.source === "SETTLEMENT" && m.remainingStakeMinor !== 0)
    || BigInt(m.closedStakeMinor) + BigInt(m.remainingStakeMinor) > BigInt(m.originalStakeMinor)) fail("Invalid source movement");
}
function movementData(row: any): BetAccountingMovement {
  return { schemaVersion: row.schemaVersion, movementId: row.movementId, slipId: row.slipId, userId: row.userId,
    revision: row.revision, occurredAt: row.occurredAt, closedStakeMinor: row.closedStakeMinor, returnMinor: row.returnMinor,
    remainingStakeMinor: row.remainingStakeMinor, originalStakeMinor: row.originalStakeMinor,
    source: row.source, placementFingerprint: row.placementFingerprint };
}

export function verifyLegacySnapshotPlacement(
  original: { wager: number; rows: readonly unknown[]; betKind?: string | null; placementFingerprint?: string | null },
  source: SnapshotPosition
): void {
  validatePosition(source);
  const amount = money(original);
  const unknownClosed = source.state === "TERMINAL"
    && source.openExposure === "NONE" && source.history === "UNAVAILABLE";
  if (unknownClosed) {
    // A sealed closed-state assertion is not payout evidence. Check every
    // available original fact, but never fill missing history or create credit.
    if ((source.originalStakeMinor !== null && (!amount.moneyReady || source.originalStakeMinor !== amount.stakeMinor))
      || (source.maximumReturnMinor !== null && (!amount.moneyReady || source.maximumReturnMinor !== amount.returnMinor))
      || (source.facts !== null && fingerprint(source.facts) !== fingerprint(facts(original)))
      || (source.placementFingerprint !== null && original.placementFingerprint
        && source.placementFingerprint !== original.placementFingerprint)) {
      fail("Closed legacy receiver placement conflicts with available source evidence");
    }
    return;
  }
  if (!amount.moneyReady || source.originalStakeMinor !== amount.stakeMinor
    || source.maximumReturnMinor !== amount.returnMinor
    || fingerprint(source.facts) !== fingerprint(facts(original))
    || (source.placementFingerprint !== null && original.placementFingerprint
      && source.placementFingerprint !== original.placementFingerprint)) {
    fail("Legacy receiver placement lacks matching immutable source evidence");
  }
}

/** Read-only intake checks shared by preflight and the transactional finalizer. */
export async function verifySnapshotIntake(
  positions: ReadonlyMap<string, SnapshotPosition>, session?: ClientSession
) {
  const live = await RiskPosition.find({}).select({
    userId: 1, accountingFingerprint: 1, state: 1, moneyReady: 1, facts: 1,
    accountingRevision: 1, remainingStakeMinor: 1, stakeMinor: 1, returnMinor: 1,
  }).limit(MAX_POSITIONS + 1).session(session ?? null).lean() as any[];
  const baselines = await RiskBaseline.find({}).limit(MAX_POSITIONS + 1).session(session ?? null).lean() as any[];
  const local = await Bet.find({ status: { $in: [ModerationStatus.APPROVED, ModerationStatus.RECEIVED] } })
    .select({ slipId: 1, userId: 1, placementFingerprint: 1, status: 1 })
    .limit(MAX_POSITIONS + 1).session(session ?? null).lean() as any[];
  if (live.length > MAX_POSITIONS || baselines.length > MAX_POSITIONS || local.length > MAX_POSITIONS) {
    fail("Receiver reconciliation exceeds supported bound");
  }
  const liveById = new Map(live.map(p => [p._id, p]));
  const baselineById = new Map(baselines.map(p => [p._id, p]));
  if (new Set([...positions.keys(), ...liveById.keys()]).size > MAX_POSITIONS) fail("Merged receiver book exceeds supported position bound");
  if (baselines.some(p => !text(p._id) || (!positions.has(p._id) && !liveById.has(p._id)))) fail("Previously imported exposure is absent from the new source cut");
  for (const prior of baselines) {
    const p = positions.get(prior._id);
    if (!p) continue; // An immutable live receipt may have replaced source-pending exposure.
    if (p.userId !== prior.userId || (p.placementFingerprint && prior.accountingFingerprint && p.placementFingerprint !== prior.accountingFingerprint)
      || (p.originalStakeMinor !== null && prior.stakeMinor != null && p.originalStakeMinor !== prior.stakeMinor)
      || (p.maximumReturnMinor !== null && prior.returnMinor != null && p.maximumReturnMinor !== prior.returnMinor)
      || (p.facts && prior.facts && fingerprint(p.facts) !== fingerprint(prior.facts))
      || (prior.state === "ACCEPTED" && ["PENDING", "DECLINED"].includes(p.state))) fail("Imported immutable placement or terminal state regressed");
  }
  for (const p of live) {
    const source = positions.get(p._id);
    if (source && (source.userId !== p.userId || (source.placementFingerprint && source.placementFingerprint !== p.accountingFingerprint)
      || (p.state === "DECLINED" && !["DECLINED", "PENDING"].includes(source.state))
      || (p.state === "PENDING" && ["ACCEPTED", "TERMINAL"].includes(source.state))
      || (p.state === "ACCEPTED" && source.state === "DECLINED"))) fail("Receiver/source placement conflict");
    if (p.state === "ACCEPTED" && !local.some(b => b.slipId === p._id && b.status === ModerationStatus.APPROVED)) fail("Accepted receipt lacks its terminal outbox");
  }
  for (const bet of local) {
    const receipt = liveById.get(bet.slipId);
    const source = positions.get(bet.slipId);
    if (receipt) {
      if (receipt.userId !== bet.userId || bet.placementFingerprint !== receipt.accountingFingerprint
        || (bet.status === ModerationStatus.APPROVED && receipt.state !== "ACCEPTED")) fail("Terminal receipt/outbox identity conflict");
      continue; // Own immutable full reserves also cover not-yet-published approvals.
    }
    if (!source || source.userId !== bet.userId
      || (bet.status === ModerationStatus.APPROVED && !["ACCEPTED", "TERMINAL"].includes(source.state))) fail("Receiver historical intake is absent from source cut");
    const original = await Bet.findById(bet._id).session(session ?? null).lean();
    if (!original) fail("Legacy receiver original placement is missing");
    verifyLegacySnapshotPlacement(original, source);
  }
  return { liveById, baselineById };
}

export async function beginSnapshotImport(value: unknown) {
  if (!riskEnabled()) throw new RiskError("RISK_DISABLED", "Enable durable intake before the fenced snapshot handoff", 503);
  assertManifest(value);
  const manifest = JSON.parse(JSON.stringify(value)) as SnapshotManifest;
  return coalesced(`manifest:${manifest.snapshotId}`, manifest, () => transaction(async session => {
    const old = await RiskSnapshot.findById(manifest.snapshotId).session(session).lean() as any;
    const manifestHash = fingerprint(manifest);
    if (old) {
      if (old.manifestHash !== manifestHash) fail("Snapshot identity conflicts with retained manifest");
      return { snapshotId: manifest.snapshotId, manifestHash };
    }
    await RiskSnapshot.create([{ _id: manifest.snapshotId, manifest, manifestHash, page: 0,
      lastHash: initialHash(manifest.snapshotId), bytes: 0, finalized: false, __v: 0 }], { session });
    await RiskState.updateOne({ _id: "active" }, { $set: { "accountingCoverage.valid": false } }, { session });
    return { snapshotId: manifest.snapshotId, manifestHash };
  }));
}
export async function importSnapshotPage(value: unknown) {
  bounded(value, 512 * 1024);
  const p = JSON.parse(JSON.stringify(value)) as SnapshotPage;
  if (!p || p.schemaVersion !== 1 || !text(p.snapshotId) || !safe(p.page) || p.page < 1
    || !hash(p.previousHash) || !hash(p.hash) || !Array.isArray(p.entries) || !p.entries.length || p.entries.length > 50) fail("Invalid snapshot page");
  const { hash: pageHash, ...payload } = p;
  if (fingerprint(payload) !== pageHash) fail("Snapshot page hash mismatch");
  for (const entry of p.entries) {
    if (entry?.kind === "POSITION") validatePosition(entry);
    else if (entry?.kind === "MOVEMENT") validateMovement(entry.movement);
    else fail("Unknown snapshot entry");
  }
  return coalesced(`page:${p.snapshotId}:${p.page}`, p, () => transaction(async session => {
    const job = await RiskSnapshot.findById(p.snapshotId).session(session).lean() as any;
    if (!job || p.page > job.manifest.pageCount) fail("Unregistered snapshot page");
    const old = await RiskSnapshotPage.findById(`${p.snapshotId}:${p.page}`).session(session).lean() as any;
    if (old) { if (old.hash !== p.hash) fail("Conflicting snapshot page"); }
    else {
      if (job.finalized || job.page + 1 !== p.page || job.lastHash !== p.previousHash) fail("Snapshot page gap or changed predecessor");
      const bytes = job.bytes + Buffer.byteLength(JSON.stringify(p));
      if (!safe(bytes) || bytes > MAX_IMPORT_BYTES) fail("Snapshot exceeds 16 MiB receiver budget");
      await RiskSnapshotPage.create([{ _id: `${p.snapshotId}:${p.page}`, snapshotId: p.snapshotId, page: p.page, hash: p.hash, entries: p.entries, __v: 0 }], { session });
      await RiskSnapshot.updateOne({ _id: p.snapshotId, page: job.page }, { $set: { page: p.page, lastHash: p.hash, bytes } }, { session });
    }
    return { snapshotId: p.snapshotId, page: p.page, hash: p.hash };
  }));
}

/** Trusted private handoff only. The source completion is historical evidence;
 * a NEW finalization also needs CURRENT receiver-side lease/physical/queue proof.
 * Exact repeats return the retained acknowledgement, never reset readiness. */
export async function finalizeSnapshotImport(value: unknown) {
  bounded(value, 16384);
  const completion = JSON.parse(JSON.stringify(value)) as SnapshotCompletion;
  if (!completion || !text(completion.snapshotId)) fail("Missing source completion");
  return coalesced(`completion:${completion.snapshotId}`, completion, () => finishSnapshotImport(completion));
}
async function finishSnapshotImport(completion: SnapshotCompletion) {
  const old = await RiskSnapshot.findById(completion.snapshotId).lean() as any;
  if (old?.finalized) {
    if (old.completionHash !== fingerprint(completion)) fail("Conflicting source completion");
    return { snapshotId: completion.snapshotId, manifestHash: old.manifestHash, finalized: true };
  }
  if (!riskEnabled()) throw new RiskError("RISK_DISABLED", "Durable risk intake must be enabled", 503);
  const verified = await authority.verifyReceiverFence();
  return transaction(async (session, _policy, clock) => {
    const job = await RiskSnapshot.findById(completion.snapshotId).session(session).lean() as any;
    if (!job) fail("Snapshot manifest missing");
    const manifest: SnapshotManifest = job.manifest;
    assertManifest(manifest);
    if (job.manifestHash !== fingerprint(manifest) || fingerprint(completion) !== fingerprint({
      schemaVersion: 1, snapshotId: manifest.snapshotId, manifestHash: job.manifestHash, lastPageHash: manifest.lastPageHash,
      pageCount: manifest.pageCount, fence: manifest.fence, cutAt: manifest.cutAt, status: "SOURCE_HANDOFF_COMPLETE",
    }) || fingerprint(verified.fence) !== fingerprint(manifest.fence)) fail("Source completion or current fence does not match");
    if (job.finalized) return { snapshotId: manifest.snapshotId, manifestHash: job.manifestHash, finalized: true };
    if (job.page !== manifest.pageCount || job.lastHash !== manifest.lastPageHash || clock.toISOString() < manifest.cutAt) fail("Snapshot is incomplete");
    const pages = await RiskSnapshotPage.find({ snapshotId: manifest.snapshotId }).sort({ page: 1 }).session(session).lean() as any[];
    let predecessor = initialHash(manifest.snapshotId);
    let retainedBytes = 0;
    const entries: SnapshotEntry[] = [];
    for (const [index, page] of pages.entries()) {
      if (page.page !== index + 1 || page.hash !== fingerprint({
        schemaVersion: 1, snapshotId: manifest.snapshotId, page: page.page, previousHash: predecessor, entries: page.entries,
      })) fail("Retained page chain is corrupt");
      retainedBytes += Buffer.byteLength(JSON.stringify({
        schemaVersion: 1, snapshotId: manifest.snapshotId, page: page.page, previousHash: predecessor, entries: page.entries, hash: page.hash,
      }));
      if (retainedBytes > MAX_IMPORT_BYTES) fail("Retained snapshot exceeds byte budget");
      predecessor = page.hash; entries.push(...page.entries);
    }
    if (pages.length !== manifest.pageCount || predecessor !== manifest.lastPageHash) fail("Retained page chain is incomplete");
    const positions = new Map<string, SnapshotPosition>();
    const sourceMoves = new Map<string, BetAccountingMovement[]>();
    const ids = new Map<string, string>();
    const join = (m: BetAccountingMovement, target: Map<string, BetAccountingMovement[]>) => {
      validateMovement(m);
      const existingId = ids.get(m.movementId);
      if (existingId && existingId !== fingerprint(m)) fail("Conflicting immutable movement ID");
      ids.set(m.movementId, fingerprint(m));
      const list = target.get(m.slipId) ?? [];
      const same = list.find(old => old.revision === m.revision);
      if (same && fingerprint(same) !== fingerprint(m)) fail("Conflicting monetary revision");
      if (!same) list.push(m);
      target.set(m.slipId, list);
    };
    for (const entry of entries) {
      if (entry.kind === "POSITION") {
        validatePosition(entry);
        if (positions.has(entry.slipId)) fail("Duplicate snapshot position");
        positions.set(entry.slipId, entry);
      } else {
        if (entry.movement.occurredAt > manifest.cutAt || ids.has(entry.movement.movementId)) fail("Invalid source movement inventory");
        join(entry.movement, sourceMoves);
      }
    }
    if (positions.size !== manifest.positions || ids.size !== manifest.movements
      || [...positions.values()].filter(p => p.openExposure === "UNAVAILABLE").length !== manifest.coverage.unavailableOpenPositions
      || [...positions.values()].filter(p => p.history === "UNAVAILABLE").length !== manifest.coverage.unavailableHistories
      || [...sourceMoves.keys()].some(id => !positions.has(id))) fail("Snapshot coverage/count mismatch");
    for (const p of positions.values()) {
      const list = (sourceMoves.get(p.slipId) ?? []).sort((a, b) => a.revision - b.revision);
      if (p.state === "PENDING" && list.length) fail("Pending source placement cannot have paid movements");
      if (p.history === "COMPLETE") {
        assertBetAccountingEvidence({ schemaVersion: 1, status: "COMPLETE", movements: list });
        if (p.state === "DECLINED") { if (list.length) fail("Declined ticket has movements"); continue; }
        if (!p.facts || !p.originalStakeMinor || p.maximumReturnMinor === null || p.maximumReturnMinor < p.originalStakeMinor
          || !p.placementFingerprint || p.expectedRevision !== list.length
          || p.remainingStakeMinor !== (list[list.length - 1]?.remainingStakeMinor ?? p.originalStakeMinor)
          || (p.state === "TERMINAL" && p.remainingStakeMinor !== 0)) fail("Claimed source history is incomplete");
      }
      for (const m of list) if (m.userId !== p.userId
        || (p.originalStakeMinor !== null && m.originalStakeMinor !== p.originalStakeMinor)
        || (p.placementFingerprint !== null && m.placementFingerprint !== p.placementFingerprint)) fail("Movement/position identity mismatch");
    }
    const { liveById, baselineById } = await verifySnapshotIntake(positions, session);
    const inboxSize = await RiskAccountingInbox.aggregate([
      { $match: { applied: false } }, { $group: { _id: null, bytes: { $sum: { $bsonSize: "$$ROOT" } } } },
    ]).session(session);
    if ((inboxSize[0]?.bytes ?? 0) > MAX_IMPORT_BYTES) fail("Receiver accounting inbox exceeds 16 MiB reconciliation budget");
    const inboxes = await RiskAccountingInbox.find({ applied: false }).limit(MAX_MOVEMENTS + 1).session(session).lean() as any[];
    const retained = await RiskMovement.find({}).select({
      schemaVersion: 1, movementId: 1, slipId: 1, userId: 1, revision: 1, occurredAt: 1,
      closedStakeMinor: 1, returnMinor: 1, remainingStakeMinor: 1, originalStakeMinor: 1,
      source: 1, placementFingerprint: 1, fingerprint: 1,
    }).limit(MAX_MOVEMENTS + 1).session(session).lean() as any[];
    if (inboxes.length > MAX_MOVEMENTS || retained.length > MAX_MOVEMENTS) fail("Receiver reconciliation exceeds supported bound");
    const joined = new Map([...sourceMoves].map(([id, list]) => [id, [...list]]));
    for (const row of retained) {
      const m = movementData(row);
      if (row.fingerprint !== fingerprint(m)) fail("Retained monetary evidence is corrupt");
      join(m, joined);
    }
    for (const inbox of inboxes) {
      const evidence = completeEvidence(inbox.evidence);
      if (!evidence) fail("Accounting inbox has unavailable evidence");
      for (const m of evidence.movements) {
        if (m.slipId !== inbox.slipId) fail("Accounting inbox owner conflict");
        join(m, joined);
      }
    }
    if (ids.size > MAX_MOVEMENTS) fail("Merged monetary history exceeds supported bound");
    if ([...joined.keys()].some(id => !positions.has(id) && !liveById.has(id))) fail("Receiver has an orphan accounting movement");
    await RiskBaseline.deleteMany({}, { session });
    for (const p of positions.values()) {
      if (liveById.has(p.slipId) || p.state === "DECLINED") continue;
      const supported = Boolean(p.facts && p.originalStakeMinor && p.maximumReturnMinor !== null && p.placementFingerprint);
      // Unknown terminal history produces NO money credit. A supported ticket
      // starts with full principal; only a contiguous movement prefix releases it.
      if (p.state === "TERMINAL" && !supported) {
        const previous = baselineById.get(p.slipId);
        if (previous) await RiskBaseline.create([{ ...previous, __v: 0 }], { session });
        continue;
      }
      await RiskBaseline.create([{ _id: p.slipId, userId: p.userId, facts: p.facts, accountingFingerprint: p.placementFingerprint,
        state: p.state === "PENDING" ? "PENDING" : "ACCEPTED", reserved: true, moneyReady: supported,
        stakeMinor: p.originalStakeMinor, remainingStakeMinor: p.originalStakeMinor,
        returnMinor: p.maximumReturnMinor, accountingRevision: 0, __v: 0 }], { session });
    }
    let incompleteOverlap = false;
    for (const [slipId, items] of joined) {
      const receipt = liveById.get(slipId);
      const position = receipt ?? await RiskBaseline.findById(slipId).session(session).lean() as any;
      const sorted = items.sort((a, b) => a.revision - b.revision);
      const prefix: BetAccountingMovement[] = [];
      for (const m of sorted) { if (m.revision !== prefix.length + 1) break; prefix.push(m); }
      if (position?.accountingRevision > prefix.length) fail("Previously applied accounting history is missing");
      const addsLiveEvidence = sorted.some(m => !(sourceMoves.get(slipId) ?? []).some(source => source.movementId === m.movementId));
      if (addsLiveEvidence && (!position?.moneyReady || position.state !== "ACCEPTED" || prefix.length !== sorted.length)) incompleteOverlap = true;
      if (position?.moneyReady && position.state === "ACCEPTED") {
        await applyMovementPrefix(position, receipt ? RiskPosition : RiskBaseline, prefix, session, clock);
      }
    }
    // Only fully validated live prefixes are acknowledged. Gaps stay durable.
    for (const inbox of inboxes) {
      const evidence = completeEvidence(inbox.evidence)!;
      const applied = await RiskMovement.countDocuments({ _id: { $in: evidence.movements.map(m => m.movementId) } }).session(session);
      if (applied === evidence.movements.length) await RiskAccountingInbox.updateOne({ _id: inbox._id }, { $set: { applied: true } }, { session });
    }
    if (Date.now() + 30000 >= verified.leaseUntilEpoch * 1000) fail("Maintenance lease too close to expiry; renew and retry");
    const currentState = await RiskState.findById("active").session(session).lean() as any;
    await RiskState.updateOne({ _id: "active" }, { $set: { accountingCoverage: {
      valid: true, snapshotId: manifest.snapshotId, manifestHash: job.manifestHash, completionHash: fingerprint(completion),
      openPositionsReady: manifest.coverage.openPositions === "COMPLETE",
      realisedCompleteSince: manifest.coverage.realisedCompleteSince, lossAvailable: !incompleteOverlap,
      finalizedAt: clock.toISOString(), fence: manifest.fence,
    }, activityCoverage: currentState.activityCoverage?.tracking ? currentState.activityCoverage
      : { tracking: true, since: clock.toISOString() } } }, { session });
    await RiskSnapshot.updateOne({ _id: manifest.snapshotId, finalized: false }, {
      $set: { finalized: true, completionHash: fingerprint(completion) },
    }, { session });
    return { snapshotId: manifest.snapshotId, manifestHash: job.manifestHash, finalized: true };
  });
}
