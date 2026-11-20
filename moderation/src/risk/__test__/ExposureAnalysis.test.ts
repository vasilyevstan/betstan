import { facts, matching } from "../Evaluation";
import { analyseChoices, AnalysisChoice, AnalysisPosition, eventExposure } from "../ExposureAnalysis";
import { parseRule, Policy, RiskError, Rule } from "../Policy";
import { choiceId, placementChoices } from "../Selections";

const choice: AnalysisChoice = {
  eventId: "event-a", origin: "STANDARD", marketId: "result", outcomeKey: "home",
  marketName: "1X2", label: "Home", odds: 3, betKind: "PRE_MATCH", sourceOpen: true,
};
const row = (eventId = "event-a", oddsId = "home") => ({
  eventId, productId: "result", oddsId, oddsValue: 3, betKind: "PRE_MATCH",
});
const policy = (rules: Rule[] = []): Policy => ({ revision: 1, defaultsVersion: 1, rules });
const position = (eventId: string, exposure: number): AnalysisPosition => ({
  facts: facts({ rows: [row(eventId)] }), state: "ACCEPTED", reserved: true, moneyReady: true,
  stakeMinor: 100, remainingStakeMinor: 100, returnMinor: exposure + 100,
});
const limit = (amount: number, scope = {}, perCustomer = false): Rule => ({
  id: "exposure", type: "MAX_OPERATOR_EXPOSURE", enabled: true, scope, parameters: { limit: amount, perCustomer },
});
const block = (): Rule => ({
  id: `choice:${choiceId(choice)}`, type: "DENY", enabled: true,
  scope: { betKind: "PRE_MATCH", eventIds: ["event-a"], selectionIds: [choiceId(choice)] }, parameters: {},
});

it("matches the complete event/market/choice identity, including nested Builder and accumulator selections", () => {
  const rule = parseRule(block());
  expect(matching(policy([rule]), { rows: [row("event-a", "away"), row("event-b", "home")] })).toEqual([]);
  expect(matching(policy([rule]), { rows: [row("event-b"), row()] })).toEqual([rule]);
  const embedded = { eventId: "event-a", productId: "event-a-builder", oddsValue: 4, marketBet: {
    kind: "BUILDER", selections: [{ origin: "STANDARD", marketId: "result", outcomeKey: "home" }],
  } };
  expect(matching(policy([rule]), { rows: [embedded, row("event-b")] })).toEqual([rule]);
  expect(() => parseRule({ ...rule, type: "MAX_OPERATOR_EXPOSURE", parameters: { limit: 100, perCustomer: false } })).toThrow();
  expect(() => parseRule({ ...rule, scope: { ...rule.scope, eventIds: ["event-a", "event-b"] } })).toThrow();
});

it("keeps live choice switches stable across market and quote revisions without merging score choices sharing NONE", () => {
  const live = (version: number, key: string) => ({
    eventId: "event-a", productId: "event-a:SECOND_HALF_SCORE", marketId: "event-a:SECOND_HALF_SCORE",
    marketVersion: version, quoteVersion: version + 1, selectionId: `event-a:SECOND_HALF_SCORE:${version}:${key}`,
    oddsValue: 4, betKind: "LIVE", side: "NONE",
  });
  const first = placementChoices({ rows: [live(1, "SCORE_1_0")], betKind: "LIVE" });
  const next = placementChoices({ rows: [live(2, "SCORE_1_0")], betKind: "LIVE" });
  const different = placementChoices({ rows: [live(2, "SCORE_0_1")], betKind: "LIVE" });
  expect([...first.choices.keys()]).toEqual([...next.choices.keys()]);
  expect([...first.choices.keys()]).not.toEqual([...different.choices.keys()]);
  const rule = parseRule({ ...block(), scope: { betKind: "LIVE", eventIds: ["event-a"], selectionIds: [...first.choices.keys()] } });
  expect(matching(policy([rule]), { rows: [live(2, "SCORE_1_0")], betKind: "LIVE" })).toEqual([rule]);
  expect(matching(policy([rule]), { rows: [live(2, "SCORE_0_1")], betKind: "LIVE" })).toEqual([]);
  expect(matching(policy([rule]), { rows: [live(2, "SCORE_1_0")] })).toEqual([rule]);
  expect(matching(policy([rule]), { rows: [{ ...live(2, "SCORE_0_1"), selectionId: undefined }], betKind: "LIVE" })).toEqual([rule]);
});

it.each(["a".repeat(64), [], [123], {}])("rejects malformed choice identifiers as typed policy errors: %j", selectionIds => {
  expect(() => parseRule({ ...block(), scope: { ...block().scope, selectionIds } })).toThrow(RiskError);
});

it("retains full partial-closure bounds and pending principal, counting a multi-selection ticket once per event", () => {
  const accepted = { ...position("event-a", 900), remainingStakeMinor: 20 };
  const pending = { ...position("event-a", 400), state: "PENDING" };
  accepted.facts = facts({ rows: [{
    eventId: "event-a", productId: "builder", oddsValue: 10,
    marketBet: { kind: "BUILDER", selections: [
      { origin: "STANDARD", marketId: "result", outcomeKey: "home" },
      { origin: "TEMPLATE", marketId: "goals", outcomeKey: "over" },
    ] },
  }] });
  expect(eventExposure("event-a", [accepted, pending])).toEqual({ openTickets: 2, pendingTickets: 1, exposureMinor: "1400" });
});

it("uses complete scoped-book usage, not the event subtotal, and reserves the tested ticket's pending payout", () => {
  const book = [position("event-a", 100), position("event-b", 850)];
  const [analysis] = analyseChoices(policy([limit(1200)]), book, "event-a", [choice], 100);
  expect(analysis).toMatchObject({ headroomMinor: "250", stressReturnMinor: "300", advice: "LOWER_ODDS", suggestedOdds: 2.5 });
  expect(analyseChoices(policy([limit(1050)]), book, "event-a", [choice], 100)[0])
    .toMatchObject({ headroomMinor: "100", advice: "TURN_OFF", suggestedOdds: null });
  expect(analyseChoices(policy([limit(1200, { eventIds: ["event-a"] })]), book, "event-a", [choice], 100)[0])
    .toMatchObject({ headroomMinor: "1100", advice: "WITHIN_CEILING", suggestedOdds: null });
});

it("never substitutes disabled or customer-specific ceilings, or missing accounting, for available book capacity", () => {
  for (const rule of [{ ...limit(1000), enabled: false }, limit(1000, {}, true)]) {
    expect(analyseChoices(policy([rule]), [], "event-a", [choice], 100)[0])
      .toMatchObject({ advice: "NO_LIMIT", headroomMinor: null });
  }
  expect(analyseChoices(policy([limit(1000)]), undefined, "event-a", [choice], 100)[0]).toMatchObject({
    advice: "UNAVAILABLE", headroomMinor: null,
  });
  expect(eventExposure("event-a", undefined)).toBeNull();
});

it("removes only the owned choice restriction and retains broader denies", () => {
  const broader: Rule = { id: "all", type: "DENY", enabled: true, scope: {}, parameters: {} };
  expect(analyseChoices(policy([block(), broader]), [], "event-a", [choice], 100)[0])
    .toMatchObject({ off: true, singleBlockedByOtherRule: true });
  expect(analyseChoices(policy([broader]), [], "event-a", [choice], 100)[0])
    .toMatchObject({ off: false, singleBlockedByOtherRule: true });
});
