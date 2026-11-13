import { MarketDefinition, MarketMetric, ScoreRule } from "@betstan/common";
import { gridLayout, MarketLayout } from "./MarketLayout";

const compare = (metric: MarketMetric, comparison: "EQ" | "GT" | "LT" | "GTE" | "LTE", value: number): ScoreRule =>
  ({ kind: "COMPARE", metric, comparison, value });

const total = (metric: MarketMetric, name: string, maximum: number): MarketDefinition => ({
  schemaVersion: 1, name, settlementMode: "FINAL_SCORE", outcomeMode: "EXCLUSIVE", coverage: "COMPLETE",
  terms: "Settled from the full-time score. Use a half-goal line.",
  parameters: [{ key: "line", label: "Half-goal line", minimum: 0.5, maximum, defaultValue: 2.5 }],
  outcomes: [
    { key: "over", label: "Over", rule: { kind: "COMPARE", metric, comparison: "GT", value: { parameter: "line" } } },
    { key: "under", label: "Under", rule: { kind: "COMPARE", metric, comparison: "LT", value: { parameter: "line" } } },
  ],
});

const bothScore: ScoreRule = {
  kind: "ALL", rules: [compare("HOME_GOALS", "GT", 0), compare("AWAY_GOALS", "GT", 0)],
};

const starters: Array<{ id: string; definition: MarketDefinition }> = [
  { id: "total-goals", definition: total("TOTAL_GOALS", "Total goals", 197.5) },
  { id: "home-total", definition: total("HOME_GOALS", "Home team total", 98.5) },
  { id: "away-total", definition: total("AWAY_GOALS", "Away team total", 98.5) },
  { id: "both-score", definition: {
    schemaVersion: 1, name: "Both teams to score", settlementMode: "FINAL_SCORE", outcomeMode: "EXCLUSIVE",
    coverage: "COMPLETE", terms: "Settled from the full-time score.", parameters: [],
    outcomes: [{ key: "yes", label: "Yes", rule: bothScore }, { key: "no", label: "No", rule: { kind: "NOT", rule: bothScore } }],
  } },
  { id: "double-chance", definition: {
    schemaVersion: 1, name: "Double chance", settlementMode: "FINAL_SCORE", outcomeMode: "INDEPENDENT",
    coverage: "COMPLETE", terms: "Settled from the full-time score; these outcomes overlap.", parameters: [],
    outcomes: [
      { key: "home-draw", label: "Home or draw", rule: compare("GOAL_DIFFERENCE", "GTE", 0) },
      { key: "away-draw", label: "Away or draw", rule: compare("GOAL_DIFFERENCE", "LTE", 0) },
      { key: "either", label: "Either team wins", rule: { kind: "ANY", rules: [
        compare("GOAL_DIFFERENCE", "GT", 0), compare("GOAL_DIFFERENCE", "LT", 0),
      ] } },
    ],
  } },
  { id: "home-win-total", definition: {
    ...total("TOTAL_GOALS", "Home win and total goals", 197.5), coverage: "PARTIAL",
    outcomes: [{ key: "home-over", label: "Home win and over", rule: {
      kind: "ALL", rules: [
        compare("GOAL_DIFFERENCE", "GT", 0),
        { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: { parameter: "line" } },
      ],
    } }],
  } },
  { id: "result-both-score", definition: {
    schemaVersion: 1, name: "Match result & both teams to score", settlementMode: "FINAL_SCORE",
    outcomeMode: "EXCLUSIVE", coverage: "COMPLETE", terms: "Full-time match result and whether both teams score.", parameters: [],
    outcomes: [
      { key: "home", label: "Home", rule: compare("GOAL_DIFFERENCE", "GT", 0) },
      { key: "draw", label: "Draw", rule: compare("GOAL_DIFFERENCE", "EQ", 0) },
      { key: "away", label: "Away", rule: compare("GOAL_DIFFERENCE", "LT", 0) },
    ].flatMap(result => [
      { key: `${result.key}-yes`, label: `${result.label} & Yes`, rule: { kind: "ALL" as const, rules: [result.rule, bothScore] } },
      { key: `${result.key}-no`, label: `${result.label} & No`, rule: {
        kind: "ALL" as const, rules: [result.rule, { kind: "NOT" as const, rule: bothScore }],
      } },
    ]),
  } },
  { id: "winning-margin", definition: {
    schemaVersion: 1, name: "Winning margin", settlementMode: "FINAL_SCORE", outcomeMode: "EXCLUSIVE",
    coverage: "COMPLETE", terms: "Full-time winning team and goal margin. A draw is a separate outcome.", parameters: [],
    outcomes: [
      { key: "home-one", label: "Home by 1", rule: compare("GOAL_DIFFERENCE", "EQ", 1) },
      { key: "away-one", label: "Away by 1", rule: compare("GOAL_DIFFERENCE", "EQ", -1) },
      { key: "home-two", label: "Home by 2+", rule: compare("GOAL_DIFFERENCE", "GTE", 2) },
      { key: "away-two", label: "Away by 2+", rule: compare("GOAL_DIFFERENCE", "LTE", -2) },
      { key: "draw", label: "Draw", rule: compare("GOAL_DIFFERENCE", "EQ", 0) },
    ],
  } },
  { id: "total-goals-bands", definition: {
    schemaVersion: 1, name: "Total goals bands", settlementMode: "FINAL_SCORE", outcomeMode: "EXCLUSIVE",
    coverage: "COMPLETE", terms: "Full-time combined goals, grouped into non-overlapping bands.", parameters: [],
    outcomes: [
      { key: "zero-one", label: "0-1 goals", rule: compare("TOTAL_GOALS", "LTE", 1) },
      { key: "two-three", label: "2-3 goals", rule: { kind: "ALL", rules: [
        compare("TOTAL_GOALS", "GTE", 2), compare("TOTAL_GOALS", "LTE", 3),
      ] } },
      { key: "four-five", label: "4-5 goals", rule: { kind: "ALL", rules: [
        compare("TOTAL_GOALS", "GTE", 4), compare("TOTAL_GOALS", "LTE", 5),
      ] } },
      { key: "six-plus", label: "6+ goals", rule: compare("TOTAL_GOALS", "GTE", 6) },
    ],
  } },
];

export const marketStarters: Array<{ id: string; definition: MarketDefinition; layout: MarketLayout }> = starters.map(starter => {
  const layout = gridLayout(starter.definition, starter.id === "double-chance" ? 3 : starter.id === "total-goals-bands" ? 1 : 2);
  if (starter.id === "winning-margin") layout.tiles[4].width = 2;
  return { ...starter, layout };
});
