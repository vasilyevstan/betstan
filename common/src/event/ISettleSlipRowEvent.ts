import { IEvent } from "./IEvent";
import { BetKind } from "./status/BetKind";
import { LiveMarketType } from "./status/LiveMarketType";
import { LiveSettlementReason } from "./status/LiveSettlementReason";

export interface ISettleSlipRowEvent extends IEvent {
  data: {
    slipId: string;
    slipRowId: string;
    result: string;
    winningSelection?: string;
    betKind?: BetKind;
    marketId?: string;
    marketType?: LiveMarketType;
    marketVersion?: number;
    settlementReason?: LiveSettlementReason;
    settlementSequence?: number;
  };
}
