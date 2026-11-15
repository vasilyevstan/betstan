import type { BetAccountingMovement } from "@betstan/common";
import type { Facts } from "./Policy";

/** Private v1 Resulting accountingSnapshot.ts DTO. Not a public API and not
 * receipt/turnover authority. Kept local until a shared transport is warranted. */
export interface SnapshotFence {
  namespace: string; operationId: string; sourceSha: string; generation: string; identityHash: string;
}
export interface SnapshotPosition {
  kind: "POSITION"; slipId: string; userId: string; sourceStatus: string;
  state: "PENDING" | "ACCEPTED" | "TERMINAL" | "DECLINED";
  facts: Facts | null; placementFingerprint: string | null;
  originalStakeMinor: number | null; remainingStakeMinor: number | null;
  maximumReturnMinor: number | null; expectedRevision: number | null;
  openExposure: "COMPLETE" | "UNAVAILABLE" | "NONE"; history: "COMPLETE" | "UNAVAILABLE";
}
export type SnapshotEntry = SnapshotPosition | { kind: "MOVEMENT"; movement: BetAccountingMovement };
export interface SnapshotPage {
  schemaVersion: 1; snapshotId: string; page: number; previousHash: string; entries: SnapshotEntry[]; hash: string;
}
export interface SnapshotManifest {
  schemaVersion: 1; source: "RESULTING"; snapshotId: string; status: "COMPLETE";
  cutAt: string; requestedFrom: string; fence: SnapshotFence; sourceDigest: string;
  pageCount: number; lastPageHash: string; positions: number; movements: number;
  coverage: {
    openPositions: "COMPLETE" | "UNAVAILABLE"; unavailableOpenPositions: number; unavailableHistories: number;
    realisedCompleteSince: string; through: string; submissionAndTurnoverReceipts: "NOT_OWNED";
  };
  handoff: "RECONCILE_RECEIVER_INTAKE_AND_LIVE_OVERLAP_BEFORE_RELEASE";
}
export interface SnapshotCompletion {
  schemaVersion: 1; snapshotId: string; manifestHash: string; lastPageHash: string; pageCount: number;
  fence: SnapshotFence; cutAt: string; status: "SOURCE_HANDOFF_COMPLETE";
}
