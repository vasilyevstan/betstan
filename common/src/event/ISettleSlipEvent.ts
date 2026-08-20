import { IEvent } from "./IEvent";
import { BetKind } from "./status/BetKind";

export interface ISettleSlipEvent extends IEvent {
  data: {
    slipId: string;
    result: string;
    betKind?: BetKind;
  };
}
