import { fingerprint, RiskError } from "./Policy";
import { RiskAccountingInbox, RiskBaseline, RiskMovement, RiskPosition, RiskState, transaction } from "./Store";
import { assertBetAccountingEvidence, BetAccountingEvidence, BetAccountingMovement } from "@betstan/common";
import { ClientSession, Model } from "mongoose";

export function completeEvidence(value: unknown): Extract<BetAccountingEvidence, { status: "COMPLETE" }> | undefined {
  if (value === undefined) return undefined; // explicit legacy reader: absence never releases principal
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new Error("Bound");
    assertBetAccountingEvidence(value);
    if (value.status === "UNAVAILABLE") return undefined;
    if (value.movements.length > 1000 || value.movements.some(m =>
      [m.movementId, m.slipId, m.userId, m.placementFingerprint].some(text => text.length > 256))) throw new Error("Bound");
    return value;
  } catch { throw new RiskError("INVALID_ACCOUNTING", "Invalid complete accounting prefix"); }
}

export async function receiveAccounting(slipId: string, evidence: unknown): Promise<void> {
  let complete: ReturnType<typeof completeEvidence>;
  try { complete = completeEvidence(evidence); }
  catch (error) {
    await RiskState.updateOne({ _id: "active", accountingCoverage: { $exists: true } },
      { $set: { "accountingCoverage.lossAvailable": false } });
    throw error;
  }
  if (!complete || complete.movements.length === 0) {
    // A legacy/unavailable close is not a zero loss. Retain full exposure and
    // withdraw window completeness until a new authoritative reconciliation.
    await RiskState.updateOne({ _id: "active", accountingCoverage: { $exists: true } },
      { $set: { "accountingCoverage.lossAvailable": false } });
    return;
  }
  if (complete.movements.some(m => m.slipId !== slipId)) throw new RiskError("ACCOUNTING_CONFLICT", "Accounting slip identity mismatch", 409);
  if (Buffer.byteLength(JSON.stringify(complete)) > 512 * 1024) throw new RiskError("ACCOUNTING_TOO_LARGE", "Accounting prefix exceeds bound");
  const id = fingerprint(complete);
  await RiskAccountingInbox.updateOne({ _id: id }, { $setOnInsert: {
    slipId, evidence: complete, applied: false, receivedAt: new Date().toISOString(), nextAttemptAt: "", __v: 0,
  } }, { upsert: true });
}

export async function applyMovementPrefix(position: any, model: Model<any>, movements: readonly BetAccountingMovement[], session: ClientSession, clock: Date) {
  assertBetAccountingEvidence({ schemaVersion: 1, status: "COMPLETE", movements });
  let revision = position.accountingRevision;
  let remaining = position.remainingStakeMinor;
  for (const movement of movements) {
    if (movement.occurredAt > clock.toISOString()) throw new RiskError("ACCOUNTING_FUTURE", "Movement economic time has not occurred", 409);
    if (movement.userId !== position.userId || movement.slipId !== position._id
      || movement.originalStakeMinor !== position.stakeMinor || movement.placementFingerprint !== position.accountingFingerprint) {
      throw new RiskError("ACCOUNTING_CONFLICT", "Movement does not match immutable placement", 409);
    }
    const previous = await RiskMovement.findById(movement.movementId).session(session).lean() as any;
    if (previous && (previous.fingerprint !== fingerprint(movement) || fingerprint(previous.facts) !== fingerprint(position.facts))) {
      throw new RiskError("ACCOUNTING_CONFLICT", "Immutable movement identity or scope changed", 409);
    }
    if (movement.revision <= revision) {
      if (!previous) throw new RiskError("ACCOUNTING_GAP", "Applied monetary evidence is missing", 409);
      continue;
    }
    if (movement.revision !== revision + 1 || BigInt(remaining) !== BigInt(movement.closedStakeMinor) + BigInt(movement.remainingStakeMinor)) {
      throw new RiskError("ACCOUNTING_GAP", "Accounting prefix is not contiguous", 409);
    }
    if (!previous) await RiskMovement.create([{ _id: movement.movementId, ...movement, facts: position.facts, fingerprint: fingerprint(movement), __v: 0 }], { session });
    revision = movement.revision;
    remaining = movement.remainingStakeMinor;
  }
  await model.updateOne({ _id: position._id, accountingRevision: position.accountingRevision }, {
    $set: { accountingRevision: revision, remainingStakeMinor: remaining },
  }, { session });
}

export async function applyAccountingInbox(id: string): Promise<boolean> {
  return transaction(async (session, _policy, clock) => {
    const inbox = await RiskAccountingInbox.findById(id).session(session).lean() as any;
    if (!inbox || inbox.applied) return true;
    const evidence = completeEvidence(inbox.evidence)!;
    const live = await RiskPosition.findById(inbox.slipId).session(session).lean() as any;
    const position = live ?? await RiskBaseline.findById(inbox.slipId).session(session).lean() as any;
    if (!position || position.state !== "ACCEPTED" || !position.moneyReady) return false;
    await applyMovementPrefix(position, live ? RiskPosition : RiskBaseline, evidence.movements, session, clock);
    await RiskAccountingInbox.updateOne({ _id: id }, { $set: { applied: true } }, { session });
    return true;
  });
}
export async function replayAccounting(limit = 25): Promise<number> {
  const entries = await RiskAccountingInbox.find({ applied: false, nextAttemptAt: { $lte: new Date().toISOString() } })
    .sort({ nextAttemptAt: 1, receivedAt: 1 }).limit(limit).lean() as any[];
  let applied = 0;
  for (const entry of entries) {
    try { if (await applyAccountingInbox(entry._id)) { applied++; continue; } }
    catch (error) {
      // Full reserves and the inbox remain durable. Contradictory/unavailable
      // economic evidence cannot continue advertising complete loss windows.
      if (error instanceof RiskError && error.code !== "ACCOUNTING_FUTURE") await RiskState.updateOne({ _id: "active", accountingCoverage: { $exists: true } },
        { $set: { "accountingCoverage.lossAvailable": false } });
    }
    await RiskAccountingInbox.updateOne({ _id: entry._id, applied: false }, { $set: { nextAttemptAt: new Date(Date.now() + 60000).toISOString() } });
  }
  return applied;
}
