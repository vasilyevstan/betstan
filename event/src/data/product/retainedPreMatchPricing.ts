import { BoundScoreRule, parseScorePricingModel, priceScoreCombination, ScorePricingModel } from "@betstan/common";
import { randomUUID } from "crypto";
import {
  buildScoreGrid,
  ExpectedGoals,
  PreMatchPricing,
  sampleExpectedGoals,
  selectTopCorrectScores,
} from "./preMatchPricing";

export interface RetainedSelectionRule {
  productId: string;
  oddsId: string;
  rule: BoundScoreRule;
}

interface RetainedPreMatchPricing extends PreMatchPricing {
  pricingModel: ScorePricingModel;
  rules: { oneCrossTwo: BoundScoreRule[]; correctScore: BoundScoreRule[] };
}

export function buildRetainedPreMatchPricing(
  expectedGoals: ExpectedGoals = sampleExpectedGoals(),
): RetainedPreMatchPricing {
  const pricingModel = parseScorePricingModel({
    version: 1, id: randomUUID(),
    homeExpectedGoals: expectedGoals.home, awayExpectedGoals: expectedGoals.away,
  });
  const oneCrossTwo: BoundScoreRule[] = [
    { kind: "COMPARE", metric: "GOAL_DIFFERENCE", comparison: "GT", value: 0 },
    { kind: "COMPARE", metric: "GOAL_DIFFERENCE", comparison: "EQ", value: 0 },
    { kind: "COMPARE", metric: "GOAL_DIFFERENCE", comparison: "LT", value: 0 },
  ];
  const scores = selectTopCorrectScores(buildScoreGrid(expectedGoals));
  const correctScore: BoundScoreRule[] = scores.map(score => ({
    kind: "ALL",
    rules: [
      { kind: "COMPARE", metric: "HOME_GOALS", comparison: "EQ", value: score.homeGoals },
      { kind: "COMPARE", metric: "AWAY_GOALS", comparison: "EQ", value: score.awayGoals },
    ],
  }));
  return {
    expectedGoals,
    pricingModel,
    rules: { oneCrossTwo, correctScore },
    oneCrossTwoOdds: {
      home: priceScoreCombination(pricingModel, [oneCrossTwo[0]]),
      draw: priceScoreCombination(pricingModel, [oneCrossTwo[1]]),
      away: priceScoreCombination(pricingModel, [oneCrossTwo[2]]),
    },
    correctScoreOdds: scores.map((score, index) => ({
      homeGoals: score.homeGoals, awayGoals: score.awayGoals,
      odds: priceScoreCombination(pricingModel, [correctScore[index]]),
    })),
  };
}
