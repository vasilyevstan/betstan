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
  IModerationResultEvent,
  IPlaceBetEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  SlipRow,
} from "../../src";

declare const legacyEventOddsSelected: LegacyEventOddsSelectedEvent;
declare const legacyModerationResult: LegacyModerationResultEvent;
declare const legacyPlaceBet: LegacyPlaceBetEvent;
declare const legacySettleSlip: LegacySettleSlipEvent;
declare const legacySettleSlipRow: LegacySettleSlipRowEvent;
declare const legacySlipRow: LegacySlipRow;

const eventOddsSelected: IEventOddsSelectedEvent = legacyEventOddsSelected;
const moderationResult: IModerationResultEvent = legacyModerationResult;
const placeBet: IPlaceBetEvent = legacyPlaceBet;
const settleSlip: ISettleSlipEvent = legacySettleSlip;
const settleSlipRow: ISettleSlipRowEvent = legacySettleSlipRow;
const slipRow: SlipRow = legacySlipRow;

void [
  eventOddsSelected,
  moderationResult,
  placeBet,
  settleSlip,
  settleSlipRow,
  slipRow,
];
