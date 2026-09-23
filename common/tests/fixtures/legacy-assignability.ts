import type {
  IEventOddsSelectedEvent as LegacyEventOddsSelectedEvent,
  IModerationResultEvent as LegacyModerationResultEvent,
  IPlaceBetEvent as LegacyPlaceBetEvent,
  ISettleSlipEvent as LegacySettleSlipEvent,
  ISettleSlipRowEvent as LegacySettleSlipRowEvent,
  SlipRow as LegacySlipRow,
} from "legacy-common";
import type * as PublishedRc1 from "predecessor-common";
import type * as Candidate from "../../src";
import type {
  IEventOddsSelectedEvent,
  ILiveEventUpdateEvent,
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

// The real immediate published predecessor, not an Omit<> of candidate source.
declare const publishedRc1: {
  event: PublishedRc1.IEvent;
  oddsSelected: PublishedRc1.IEventOddsSelectedEvent;
  eventResult: PublishedRc1.IEventResultEvent;
  visibility: PublishedRc1.IEventVibibilityEvent;
  newEvent: PublishedRc1.INewEventEvent;
  placement: PublishedRc1.IPlaceBetEvent;
  row: PublishedRc1.SlipRow;
  moderation: PublishedRc1.IModerationResultEvent;
  affectedRow: PublishedRc1.IModerationAffectedRow;
  settlement: PublishedRc1.ISettleSlipEvent;
  rowSettlement: PublishedRc1.ISettleSlipRowEvent;
  live: PublishedRc1.ILiveEventUpdateEvent;
  incident: PublishedRc1.ILiveIncident;
  market: PublishedRc1.ILiveMarketSnapshot;
  selection: PublishedRc1.ILiveMarketSelection;
  marketSettlement: PublishedRc1.ILiveMarketSettlement;
};

const current: {
  event: Candidate.IEvent;
  oddsSelected: Candidate.IEventOddsSelectedEvent;
  eventResult: Candidate.IEventResultEvent;
  visibility: Candidate.IEventVibibilityEvent;
  newEvent: Candidate.INewEventEvent;
  placement: Candidate.IPlaceBetEvent;
  row: Candidate.SlipRow;
  moderation: Candidate.IModerationResultEvent;
  affectedRow: Candidate.IModerationAffectedRow;
  settlement: Candidate.ISettleSlipEvent;
  rowSettlement: Candidate.ISettleSlipRowEvent;
  live: ILiveEventUpdateEvent;
  incident: Candidate.ILiveIncident;
  market: Candidate.ILiveMarketSnapshot;
  selection: Candidate.ILiveMarketSelection;
  marketSettlement: Candidate.ILiveMarketSettlement;
} = publishedRc1;

// The new optional settlement evidence is ignorable on the old string-result
// wire surface. This does NOT authorize feature-unaware writers after activation.
declare const settlementWithEvidence: ISettleSlipEvent;
const predecessorSettlement: PublishedRc1.ISettleSlipEvent = settlementWithEvidence;
const legacySettlement: LegacySettleSlipEvent = settlementWithEvidence;
const legacyResultString: ISettleSlipEvent["data"]["result"] = "legacy-result-string";

void [
  eventOddsSelected,
  moderationResult,
  placeBet,
  settleSlip,
  settleSlipRow,
  slipRow,
  current,
  predecessorSettlement,
  legacySettlement,
  legacyResultString,
];
