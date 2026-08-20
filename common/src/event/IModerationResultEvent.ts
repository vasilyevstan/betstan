import { IEvent } from "./IEvent";
import { BetKind } from "./status/BetKind";
import { ModerationDeclineReason } from "./status/ModerationDeclineReason";

export interface IModerationResultEvent extends IEvent {
  data: {
    slipId: string;
    result: string;
    betKind?: BetKind;
    declineReason?: ModerationDeclineReason;
    affectedRowIds?: string[];
    currentMarketVersion?: number;
    currentQuoteVersion?: number;
  };
}
