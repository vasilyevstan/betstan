import {
  CashBackOperationIdentity, CashBackQuote, CashBackQuoteEvidence, CashBackReceipt,
  CashBackSourceReleaseRequest, CashBackSourceReply, CashBackSourceReserveRequest,
  CashBackSourceSnapshotRequest, ICashBackOutcomeEvent, ICashBackRequestEvent,
} from "@betstan/common";
import { Schema, model } from "mongoose";

export interface CashBackObligation {
  request: CashBackSourceReserveRequest;
  grant?: Extract<CashBackSourceReply, { outcome: "GRANTED" }>;
  releaseRequest?: CashBackSourceReleaseRequest;
  released: boolean;
}

export interface CashBackPending {
  state: "UNDECIDED" | "ACCEPTED" | "REJECTED";
  operation: CashBackOperationIdentity;
  quote: CashBackQuote;
  evidence: CashBackQuoteEvidence;
  obligations: CashBackObligation[];
  receipt?: CashBackReceipt;
  receiptFingerprint?: string;
  historyPersisted: boolean;
  outcomePublished: boolean;
}

const obligationSchema = new Schema<CashBackObligation>({
  request: { type: Schema.Types.Mixed, required: true },
  grant: { type: Schema.Types.Mixed, required: false },
  releaseRequest: { type: Schema.Types.Mixed, required: false },
  released: { type: Boolean, required: true, default: false },
}, { _id: false });

export const cashBackPendingSchema = new Schema<CashBackPending>({
  state: { type: String, enum: ["UNDECIDED", "ACCEPTED", "REJECTED"], required: true },
  operation: { type: Schema.Types.Mixed, required: true },
  quote: { type: Schema.Types.Mixed, required: true },
  evidence: { type: Schema.Types.Mixed, required: true },
  obligations: { type: [obligationSchema], required: true },
  receipt: { type: Schema.Types.Mixed, required: false },
  receiptFingerprint: { type: String, required: false },
  historyPersisted: { type: Boolean, required: true, default: false },
  outcomePublished: { type: Boolean, required: true, default: false },
}, { _id: false });

export interface CashBackOperationRecord {
  operationId: string;
  operation: CashBackOperationIdentity;
  request: Extract<ICashBackRequestEvent["data"], { action: "QUOTE" }>;
  stage: "SNAPSHOTS" | "QUOTED" | "CONFIRMING" | "UNAVAILABLE" | "TERMINAL";
  snapshotRequests: CashBackSourceSnapshotRequest[];
  snapshotReplies: CashBackSourceReply[];
  quote?: CashBackQuote;
  evidence?: CashBackQuoteEvidence;
  outcome?: ICashBackOutcomeEvent["data"];
  outcomePending: boolean;
  confirmRequested: boolean;
  createdAt: Date;
}

const schema = new Schema<CashBackOperationRecord>({
  operationId: { type: String, required: true },
  operation: { type: Schema.Types.Mixed, required: true },
  request: { type: Schema.Types.Mixed, required: true },
  stage: { type: String, enum: ["SNAPSHOTS", "QUOTED", "CONFIRMING", "UNAVAILABLE", "TERMINAL"], required: true },
  snapshotRequests: { type: Schema.Types.Mixed, required: true, default: () => [], validate: Array.isArray },
  snapshotReplies: { type: Schema.Types.Mixed, required: true, default: () => [], validate: Array.isArray },
  quote: { type: Schema.Types.Mixed, required: false },
  evidence: { type: Schema.Types.Mixed, required: false },
  outcome: { type: Schema.Types.Mixed, required: false },
  outcomePending: { type: Boolean, required: true, default: false },
  confirmRequested: { type: Boolean, required: true, default: false },
  createdAt: { type: Date, required: true },
});
schema.index({ operationId: 1 }, { unique: true });
schema.index({ stage: 1, outcomePending: 1, createdAt: 1 });

export const CashBackOperation = model<CashBackOperationRecord>("CashBackOperation", schema);
