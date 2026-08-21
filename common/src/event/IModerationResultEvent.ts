import { IEvent } from "./IEvent";
import { BetKind } from "./status/BetKind";
import { LiveMarketStatus } from "./status/LiveMarketStatus";
import { ModerationDeclineReason } from "./status/ModerationDeclineReason";

export interface IModerationAffectedRow {
  rowId: string;
  declineReason: ModerationDeclineReason;
  marketId?: string;
  marketVersion?: number;
  quoteVersion?: number;
  currentOdds?: number;
  marketStatus?: LiveMarketStatus;
  selectionId?: string;
}

export interface IModerationResultEvent extends IEvent {
  data: {
    slipId: string;
    result: string;
    betKind?: BetKind;
    declineReason?: ModerationDeclineReason;
    affectedRows?: IModerationAffectedRow[];
  };
}
