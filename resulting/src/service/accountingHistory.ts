import { assertBetAccountingEvidence, BetAccountingEvidence, BetAccountingMovement } from "@betstan/common";
import { model, Schema } from "mongoose";
import { cashBackHash } from "./cashBackIdentity";

interface MovementRecord {
  movementId: string; slipId: string; revision: number; fingerprint: string;
  movement: BetAccountingMovement;
}
const schema = new Schema<MovementRecord>({
  movementId: { type: String, required: true },
  slipId: { type: String, required: true },
  revision: { type: Number, required: true },
  fingerprint: { type: String, required: true },
  movement: { type: Schema.Types.Mixed, required: true },
});
schema.index({ movementId: 1 }, { unique: true });
schema.index({ slipId: 1, revision: 1 }, { unique: true });
export const AccountingMovement = model<MovementRecord>("AccountingMovement", schema);

/** A single retained delta is NOT a complete prefix. Consumers must join revisions. */
export function assertAccountingMovement(value: BetAccountingMovement): void {
  if (!value || value.schemaVersion !== 1
    || ![value.slipId, value.userId, value.placementFingerprint].every(text => typeof text === "string" && text.length > 0)
    || ![value.revision, value.originalStakeMinor, value.closedStakeMinor, value.returnMinor, value.remainingStakeMinor]
      .every(amount => Number.isSafeInteger(amount) && amount >= 0)
    || value.revision < 1 || value.originalStakeMinor < 1 || value.closedStakeMinor < 1
    || value.movementId !== `${value.slipId}:accounting:${value.revision}`
    || !["SETTLEMENT", "CASH_BACK"].includes(value.source)
    || (value.source === "SETTLEMENT" && value.remainingStakeMinor !== 0)
    || (value.source === "CASH_BACK" && value.returnMinor === 0)
    || BigInt(value.closedStakeMinor) + BigInt(value.remainingStakeMinor) > BigInt(value.originalStakeMinor)
    || typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt))
    || new Date(value.occurredAt).toISOString() !== value.occurredAt) {
    throw new Error("Invalid source accounting movement");
  }
}

const writes = new Map<string, { fingerprint: string; work: Promise<void> }>();
async function retain(movement: BetAccountingMovement): Promise<void> {
  assertAccountingMovement(movement);
  const fingerprint = cashBackHash(movement);
  const inFlight = writes.get(movement.movementId);
  if (inFlight) {
    if (inFlight.fingerprint !== fingerprint) throw new Error("Conflicting immutable accounting movement");
    return inFlight.work;
  }
  const work = (async () => {
    await AccountingMovement.init();
    try {
      await AccountingMovement.updateOne({ movementId: movement.movementId }, { $setOnInsert: {
        movementId: movement.movementId, slipId: movement.slipId,
        revision: movement.revision, fingerprint, movement, __v: 0,
      } }, { upsert: true });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === 11000)) throw error;
    }
    const stored = await AccountingMovement.findOne({ movementId: movement.movementId }).lean();
    if (!stored || stored.fingerprint !== fingerprint || cashBackHash(stored.movement) !== fingerprint) {
      throw new Error("Conflicting immutable accounting movement");
    }
  })();
  writes.set(movement.movementId, { fingerprint, work });
  try { await work; } finally {
    if (writes.get(movement.movementId)?.work === work) writes.delete(movement.movementId);
  }
}

/**
 * Projection, not a second financial authority. Called before confirmed outbox
 * publication. Until it succeeds, the canonical Bet/receipt retains the movement
 * and its publication obligation. No transaction or remote closure permission.
 */
export async function retainAccountingHistory(
  evidence?: BetAccountingEvidence, last?: BetAccountingMovement
): Promise<void> {
  if (evidence) assertBetAccountingEvidence(evidence);
  const movements = last ? [last] : evidence?.status === "COMPLETE" ? evidence.movements : [];
  for (const movement of movements) await retain(movement);
}
