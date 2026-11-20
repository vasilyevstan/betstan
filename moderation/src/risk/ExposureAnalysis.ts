import { MAX_MARKET_ODDS, MIN_MARKET_ODDS } from "@betstan/common";
import { matching, money, operatorExposure, Position } from "./Evaluation";
import { canonical, matches, Policy, RiskError, Rule } from "./Policy";
import { choiceId, ChoiceIdentity } from "./Selections";

export type AnalysisPosition = Pick<Position,
  "facts" | "state" | "reserved" | "moneyReady" | "stakeMinor" | "remainingStakeMinor" | "returnMinor">;
export interface AnalysisChoice extends ChoiceIdentity {
  marketName: string; label: string; odds: number; betKind: "PRE_MATCH" | "LIVE"; sourceOpen: boolean;
  templateId?: string; marketVersion?: number; selectionId?: string;
}
const ZERO = BigInt(0);
const HUNDRED = BigInt(100);
export function totalExposure(positions: AnalysisPosition[]): bigint {
  return positions.reduce((sum, position) => {
    const exposure = operatorExposure(position);
    if (!position.moneyReady || exposure === undefined) throw new RiskError("ACCOUNTING_UNAVAILABLE", "Open-position amounts are incomplete", 503);
    return sum + exposure;
  }, ZERO);
}
export function eventExposure(eventId: string, positions: AnalysisPosition[] | undefined) {
  if (!positions) return null;
  const relevant = positions.filter(position => position.facts.eventIds.includes(eventId));
  return {
    openTickets: relevant.length, pendingTickets: relevant.filter(position => position.state === "PENDING").length,
    exposureMinor: totalExposure(relevant).toString(),
  };
}
function single(choice: AnalysisChoice) {
  return { betKind: choice.betKind, rows: [{
    eventId: choice.eventId, productId: choice.marketId, oddsId: choice.outcomeKey, oddsValue: choice.odds,
    betKind: choice.betKind,
    ...(choice.origin === "LIVE" ? {
      marketId: choice.marketId, marketVersion: choice.marketVersion, selectionId: choice.selectionId,
    } : choice.origin === "TEMPLATE" ? { marketBet: { kind: "SINGLE", selections: [{
      origin: choice.origin, marketId: choice.marketId, outcomeKey: choice.outcomeKey, templateId: choice.templateId,
    }] } } : {}),
  }] };
}
export function analyseChoices(policy: Policy, positions: AnalysisPosition[] | undefined,
  eventId: string, choices: AnalysisChoice[], stakeMinor: number) {
  const limits = policy.rules.filter(rule => rule.enabled && rule.type === "MAX_OPERATOR_EXPOSURE" && !rule.parameters.perCustomer);
  const usage = new Map(limits.map(rule => [rule.id, positions
    ? totalExposure(positions.filter(position => matches(rule.scope, position.facts))) : ZERO]));
  return choices.map(choice => {
    const id = choiceId(choice);
    const switchRule: Rule = {
      id: `choice:${id}`, type: "DENY", enabled: true,
      scope: { betKind: choice.betKind, eventIds: [eventId], selectionIds: [id] }, parameters: {},
    };
    const owned = policy.rules.find(rule => rule.id === switchRule.id);
    const switchConflict = Boolean(owned && (owned.type !== "DENY"
      || canonical(owned.scope) !== canonical(switchRule.scope) || canonical(owned.parameters) !== "{}"));
    const off = Boolean(owned?.enabled && !switchConflict);
    const rules = matching(policy, single(choice));
    const applicable = limits.filter(rule => rules.some(candidate => candidate.id === rule.id));
    const headrooms = positions ? applicable.map(rule => BigInt(rule.parameters.limit!) - usage.get(rule.id)!) : [];
    const headroom = headrooms.length ? headrooms.reduce((least, value) => value < least ? value : least) : undefined;
    const stress = money({ ...single(choice), wager: stakeMinor / 100 });
    const stressReturn = stress.moneyReady && stress.returnMinor !== undefined ? BigInt(stress.returnMinor) : undefined;
    let advice: "OFF" | "UNAVAILABLE" | "NO_LIMIT" | "WITHIN_CEILING" | "TURN_OFF" | "LOWER_ODDS";
    let suggestedOdds: number | null = null;
    if (off) advice = "OFF";
    else if (!positions || stressReturn === undefined) advice = "UNAVAILABLE";
    else if (headroom === undefined) advice = "NO_LIMIT";
    else if (stressReturn <= headroom) advice = "WITHIN_CEILING";
    else {
      const ceiling = headroom * HUNDRED / BigInt(stakeMinor);
      advice = ceiling < BigInt(Math.round(MIN_MARKET_ODDS * 100)) ? "TURN_OFF" : "LOWER_ODDS";
      if (advice === "LOWER_ODDS") suggestedOdds = Math.min(MAX_MARKET_ODDS, Number(ceiling) / 100);
    }
    return {
      ...choice, id, switchConflict, off,
      singleBlockedByOtherRule: rules.some(rule => rule.type === "DENY" && rule.id !== switchRule.id),
      stressReturnMinor: stressReturn?.toString() ?? null,
      headroomMinor: headroom?.toString() ?? null, advice,
      suggestedOdds,
    };
  });
}
