import { MarketDefinition, MarketMetric, ScoreRule } from "@betstan/common";

const compare = (metric: MarketMetric, comparison: "GT" | "LT" | "GTE" | "LTE", value: number): ScoreRule =>
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

export const marketStarters: Array<{ id: string; definition: MarketDefinition }> = [
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
];
