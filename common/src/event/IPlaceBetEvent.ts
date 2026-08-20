import { IEvent } from "./IEvent";
import { BetKind } from "./status/BetKind";
import { LiveMarketType } from "./status/LiveMarketType";
import { TeamSide } from "./status/TeamSide";

export interface SlipRow {
  eventId: string;
  eventName: string;
  oddsId: string;
  oddsValue: number;
  oddsName: string;
  productName: string;
  productId: string;
  timestamp: string;
  id: string;
  eventTime?: string;
  betKind?: BetKind;
  marketId?: string;
  marketType?: LiveMarketType;
  marketVersion?: number;
  quoteVersion?: number;
  selectionId?: string;
  side?: TeamSide;
  selectionSide?: TeamSide;
  selectedAt?: string;
  quoteValidUntil?: string;
}

export interface IPlaceBetEvent extends IEvent {
  data: {
    userId: string;
    userName: string;
    slipId: string;
    wager: number;
    rows: SlipRow[];
    betKind?: BetKind;
  };
}
