import type {
  IEventOddsSelectedEvent as LegacyEventOddsSelectedEvent,
  IModerationResultEvent as LegacyModerationResultEvent,
  IPlaceBetEvent as LegacyPlaceBetEvent,
  ISettleSlipEvent as LegacySettleSlipEvent,
  ISettleSlipRowEvent as LegacySettleSlipRowEvent,
  SlipRow as LegacySlipRow,
} from "legacy-common";
import type {
  IEventOddsSelectedEvent,
  ILiveEventUpdateEvent,
  IModerationResultEvent,
  IPlaceBetEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  SlipRow,
} from "../../src";

type PublishedRc1LiveEventUpdateEvent =
  Omit<ILiveEventUpdateEvent, "data"> & {
    data: Omit<ILiveEventUpdateEvent["data"], "incidentsComplete">;
  };

declare const legacyEventOddsSelected: LegacyEventOddsSelectedEvent;
declare const publishedRc1LiveEventUpdate: PublishedRc1LiveEventUpdateEvent;
declare const legacyModerationResult: LegacyModerationResultEvent;
declare const legacyPlaceBet: LegacyPlaceBetEvent;
declare const legacySettleSlip: LegacySettleSlipEvent;
declare const legacySettleSlipRow: LegacySettleSlipRowEvent;
declare const legacySlipRow: LegacySlipRow;

const eventOddsSelected: IEventOddsSelectedEvent = legacyEventOddsSelected;
const liveEventUpdate: ILiveEventUpdateEvent = publishedRc1LiveEventUpdate;
const moderationResult: IModerationResultEvent = legacyModerationResult;
const placeBet: IPlaceBetEvent = legacyPlaceBet;
const settleSlip: ISettleSlipEvent = legacySettleSlip;
const settleSlipRow: ISettleSlipRowEvent = legacySettleSlipRow;
const slipRow: SlipRow = legacySlipRow;
const publishedRc1CompatibleLiveEventUpdate: PublishedRc1LiveEventUpdateEvent =
  liveEventUpdate;

void [
  eventOddsSelected,
  liveEventUpdate,
  moderationResult,
  placeBet,
  settleSlip,
  settleSlipRow,
  slipRow,
  publishedRc1CompatibleLiveEventUpdate,
];
