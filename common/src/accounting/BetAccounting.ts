/** Nominal Stanbucks cents, not wallet transfers. All numbers must be safe integers. */
export interface BetAccountingMovement {
  readonly schemaVersion: 1;
  readonly movementId: string;
  readonly slipId: string;
  readonly userId: string;
  /** Contiguous accounting sequence, independent of cash-back decision revisions. */
  readonly revision: number;
  readonly occurredAt: string;
  readonly closedStakeMinor: number;
  readonly returnMinor: number;
  readonly remainingStakeMinor: number;
  readonly originalStakeMinor: number;
  readonly source: "SETTLEMENT" | "CASH_BACK";
  readonly placementFingerprint: string;
}

export type BetAccountingUnavailableReason =
  | "LEGACY_PRECISION_UNSUPPORTED" | "HISTORY_MISSING" | "AUTHORITY_UNAVAILABLE"
  | "AMOUNT_UNSUPPORTED";

/** COMPLETE describes this ticket's entire movement prefix, NOT book completeness.
 * Apply each unseen movement once; a later prefix recovers reordered partial closes.
 * Absence (old producer) is unavailable, never zero loss or permission to release principal.
 */
export type BetAccountingEvidence =
  | { readonly schemaVersion: 1; readonly status: "COMPLETE"; readonly movements: readonly BetAccountingMovement[] }
  | { readonly schemaVersion: 1; readonly status: "UNAVAILABLE"; readonly reason: BetAccountingUnavailableReason };

/** No hedge/domain identity is inferred from product names or outcome labels. */
export interface BetPayoutBound {
  readonly schemaVersion: 1;
  readonly method: "STANDALONE_FIXED_ODDS";
  readonly originalStakeMinor: number;
  readonly maximumReturnMinor: number;
  readonly placementFingerprint: string;
}

export function assertBetAccountingEvidence(value: unknown): asserts value is BetAccountingEvidence {
  const fail = (): never => { throw new Error("Invalid bet accounting evidence"); };
  if (!value || typeof value !== "object") fail();
  const evidence = value as BetAccountingEvidence;
  if (evidence.schemaVersion !== 1) fail();
  if (evidence.status === "UNAVAILABLE") {
    if (!["LEGACY_PRECISION_UNSUPPORTED", "HISTORY_MISSING", "AUTHORITY_UNAVAILABLE", "AMOUNT_UNSUPPORTED"].includes(evidence.reason)) fail();
    return;
  }
  if (evidence.status !== "COMPLETE" || !Array.isArray(evidence.movements)) fail();
  let previous: BetAccountingMovement | undefined;
  const ids = new Set<string>();
  let returns = BigInt(0);
  for (const movement of evidence.movements) {
    if (!movement || movement.schemaVersion !== 1
      || ![movement.movementId, movement.slipId, movement.userId, movement.placementFingerprint]
        .every(text => typeof text === "string" && text.length > 0)
      || ![movement.revision, movement.closedStakeMinor, movement.returnMinor, movement.remainingStakeMinor, movement.originalStakeMinor]
        .every(amount => Number.isSafeInteger(amount) && amount >= 0)
      || movement.closedStakeMinor === 0 || movement.originalStakeMinor === 0
      || movement.revision !== (previous?.revision ?? 0) + 1
      || !["SETTLEMENT", "CASH_BACK"].includes(movement.source)
      || (movement.source === "SETTLEMENT" && movement.remainingStakeMinor !== 0)
      || typeof movement.occurredAt !== "string" || !Number.isFinite(Date.parse(movement.occurredAt))
      || new Date(movement.occurredAt).toISOString() !== movement.occurredAt
      || ids.has(movement.movementId)) fail();
    if (previous && (previous.slipId !== movement.slipId || previous.userId !== movement.userId
      || previous.placementFingerprint !== movement.placementFingerprint
      || previous.originalStakeMinor !== movement.originalStakeMinor
      || previous.remainingStakeMinor === 0)) fail();
    if (BigInt(movement.closedStakeMinor) + BigInt(movement.remainingStakeMinor)
      !== BigInt(previous?.remainingStakeMinor ?? movement.originalStakeMinor)) fail();
    returns += BigInt(movement.returnMinor);
    if (returns > BigInt(Number.MAX_SAFE_INTEGER)) fail();
    ids.add(movement.movementId);
    previous = movement;
  }
}
