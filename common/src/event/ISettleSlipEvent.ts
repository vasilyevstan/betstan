import { IEvent } from "./IEvent";
import { BetKind } from "./status/BetKind";
import { CashBackSettlementEvidence } from "./CashBack";

export interface ISettleSlipEvent extends IEvent {
  data: {
    slipId: string;
    result: string;
    betKind?: BetKind;
    /**
     * Complete additive snapshot for cash-back-aware settlement. Absence is
     * legacy evidence, never permission to reset an already reduced remainder.
     */
    cashBack?: CashBackSettlementEvidence;
  };
}
