import {
  CashBackOperationIdentity, CashBackQuote, CashBackReceipt,
  CashBackUnavailableReason, ICashBackRequestEvent,
} from "@betstan/common";
import { Schema, model } from "mongoose";

export interface CashBackOperationRecord {
  operationId: string;
  operation: CashBackOperationIdentity;
  quoteRequest: Extract<ICashBackRequestEvent["data"], { action: "QUOTE" }>;
  confirmRequest?: Extract<ICashBackRequestEvent["data"], { action: "CONFIRM" }>;
  state: "QUOTE_PENDING" | "QUOTED" | "UNAVAILABLE" | "CONFIRM_PENDING" | "ACCEPTED" | "REJECTED";
  quote?: CashBackQuote;
  receipt?: CashBackReceipt;
  receiptFingerprint?: string;
  reason?: CashBackUnavailableReason;
  projectionPending: boolean;
  createdAt: Date;
}

const schema = new Schema<CashBackOperationRecord>({
  operationId: { type: String, required: true },
  operation: { type: Schema.Types.Mixed, required: true },
  quoteRequest: { type: Schema.Types.Mixed, required: true },
  confirmRequest: { type: Schema.Types.Mixed, required: false },
  state: {
    type: String, required: true,
    enum: ["QUOTE_PENDING", "QUOTED", "UNAVAILABLE", "CONFIRM_PENDING", "ACCEPTED", "REJECTED"],
  },
  quote: { type: Schema.Types.Mixed, required: false },
  receipt: { type: Schema.Types.Mixed, required: false },
  receiptFingerprint: { type: String, required: false },
  reason: { type: String, required: false },
  projectionPending: { type: Boolean, required: true, default: false },
  createdAt: { type: Date, required: true },
});
schema.index({ operationId: 1 }, { unique: true });
schema.index({ state: 1, createdAt: 1 });
schema.index({ projectionPending: 1, createdAt: 1 });
schema.index({ "operation.userId": 1, "operation.slipId": 1, state: 1, "receipt.decisionTime": -1, operationId: -1 });

export const CashBackOperation = model<CashBackOperationRecord>("CashBackOperation", schema);
