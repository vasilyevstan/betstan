import { IEvent } from "./IEvent";
import {
  CashBackAcceptedReceipt,
  CashBackOperationIdentity,
  CashBackOriginalManifest,
  CashBackQuote,
  CashBackRejectedReceipt,
  CashBackSelectionQuote,
  CashBackUnavailableReason,
} from "./CashBack";
import { CashBackSourceSnapshot } from "./ICashBackSourceEvent";

/** Internal offer proof; never forward this wholesale as a public HTTP DTO. */
export interface CashBackQuoteEvidence {
  readonly quoteFingerprint: string;
  readonly originalManifest: CashBackOriginalManifest;
  /** Validated against retained original selections AND monotonic resolved/void evidence. */
  readonly anySelectionResolved: false;
  readonly currentQuotes: readonly [CashBackSelectionQuote, ...CashBackSelectionQuote[]];
  /** Both owners for every selected event, ordered by (eventId, owner). */
  readonly sources: readonly [CashBackSourceSnapshot, ...CashBackSourceSnapshot[]];
}

/** Resulting -> Bet. Offers/unavailability cannot be mistaken for a durable decision. */
export interface ICashBackOutcomeEvent extends IEvent {
  data: { readonly operation: CashBackOperationIdentity } & (
    | {
        readonly outcome: "QUOTED";
        readonly quote: CashBackQuote;
        readonly evidence: CashBackQuoteEvidence;
        readonly receipt?: never;
      }
    | {
        readonly outcome: "UNAVAILABLE";
        readonly reason: CashBackUnavailableReason;
        readonly occurredAt: string;
        readonly quote?: never;
        readonly receipt?: never;
      }
    | {
        readonly outcome: "ACCEPTED";
        readonly receipt: CashBackAcceptedReceipt;
        readonly receiptFingerprint: string;
        readonly quote?: never;
      }
    | {
        readonly outcome: "REJECTED";
        readonly receipt: CashBackRejectedReceipt;
        readonly receiptFingerprint: string;
        readonly quote?: never;
      }
  );
}
