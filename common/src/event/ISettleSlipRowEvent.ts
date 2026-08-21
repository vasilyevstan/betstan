import { IEvent } from "./IEvent";
import { BetKind } from "./status/BetKind";
import { LiveMarketType } from "./status/LiveMarketType";
import { LiveSettlementReason } from "./status/LiveSettlementReason";
import { TeamSide } from "./status/TeamSide";

export interface ISettleSlipRowEvent extends IEvent {
  data: {
    slipId: string;
    slipRowId: string;
    result: string;
    winningSelection?: string;
    winningSide?: TeamSide;
    betKind?: BetKind;
    marketId?: string;
    marketType?: LiveMarketType;
    marketVersion?: number;
    settlementReason?: LiveSettlementReason;
    settlementSequence?: number;
  };
}
