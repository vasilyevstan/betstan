import type * as Predecessor from "predecessor-common";
import {
  IEventOddsSelectedEvent,
  MarketBet,
  MarketSelectionSnapshot,
  SlipRow,
  ScoreRule,
} from "../../src";

declare const oldRow: Predecessor.SlipRow;
declare const oldSelection: Predecessor.IEventOddsSelectedEvent["data"];
declare const quote: MarketBet;

const newReader: SlipRow = oldRow;
const newRow: SlipRow = { ...oldRow, marketBet: quote };
const oldReader: Predecessor.SlipRow = newRow;
const selected: IEventOddsSelectedEvent["data"] = { ...oldSelection, marketBet: quote };
const oldSelectionReader: Predecessor.IEventOddsSelectedEvent["data"] = selected;

declare const details: Omit<MarketSelectionSnapshot, "settlementMode" | "pricingMethod" | "rule">;
const manual: MarketSelectionSnapshot = {
  ...details, settlementMode: "MANUAL", pricingMethod: "OPERATOR",
};
// @ts-expect-error Generated operator probabilities do not establish modeled settlement.
const falseModel: MarketSelectionSnapshot = { ...details, settlementMode: "MANUAL", pricingMethod: "SCORE_MODEL" };
// @ts-expect-error Untracked player facts cannot be compiled into automatic rules.
const unsupported: ScoreRule = { kind: "COMPARE", metric: "PLAYER_GOALS", comparison: "GT", value: 0 };

void [newReader, oldReader, oldSelectionReader, manual, falseModel, unsupported];
