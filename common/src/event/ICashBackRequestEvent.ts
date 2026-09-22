import { IEvent } from "./IEvent";
import {
  CashBackConfirmRequest,
  CashBackOperationIdentity,
  CashBackQuoteRequest,
} from "./CashBack";

/** Bet -> Resulting; QUOTE is non-reserving, CONFIRM targets one stored offer. */
export interface ICashBackRequestEvent extends IEvent {
  data: {
    readonly operation: CashBackOperationIdentity;
    /** Immutable authenticated ingress time; not permission for late acceptance. */
    readonly requestedAt: string;
  } & (
    | Omit<CashBackQuoteRequest, "clientOperationId">
    | Omit<CashBackConfirmRequest, "clientOperationId">
  );
}
