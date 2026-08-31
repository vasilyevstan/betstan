import { faker } from "@faker-js/faker";
import { createHash } from "crypto";

/**
 * Pure, dependency-free pre-match pricing model. Given a realistic home/away expected-goal
 * pair, it enumerates a bounded Poisson score grid and derives coherent 1X2 and correct-score
 * prices from that *same* distribution, so the two markets never disagree with each other.
 * Nothing here talks to gamemaster, a database, or any other service -- it is a plain function
 * of its inputs, used once per generated event by `EventTemplate`.
 */

export interface ExpectedGoals {
  home: number;
  away: number;
}

export interface ScoreProbability {
  homeGoals: number;
  awayGoals: number;
  probability: number;
}

export interface OneCrossTwoProbabilities {
  home: number;
  draw: number;
  away: number;
}

export interface PricedOneCrossTwo {
  home: number;
  draw: number;
  away: number;
}

export interface PricedCorrectScore {
  homeGoals: number;
  awayGoals: number;
  odds: number;
}

export interface PreMatchPricing {
  expectedGoals: ExpectedGoals;
  oneCrossTwoOdds: PricedOneCrossTwo;
  correctScoreOdds: PricedCorrectScore[];
}

/** Bounds the score grid to a plausible low-score support: no generated correct score can ever
 * be an implausible value like `7 - 10` because the grid itself never contains such a cell. */
export const MAX_GOALS_PER_SIDE = 6;

/** How many distinct highest-probability exact scores make up the Correct Score board. */
export const CORRECT_SCORE_OPTION_COUNT = 10;

/** Typical realistic single-team expected-goals range for a football match. */
const MIN_EXPECTED_GOALS = 0.6;
const MAX_EXPECTED_GOALS = 2.6;

/** Modest, consistent bookmaker overround applied identically to every market derived here. */
const BOOKMAKER_MARGIN = 1.07;

const MIN_ODDS = 1.01;
const MAX_ODDS = 1000;

/** Poisson probability mass function, computed iteratively to stay numerically stable for the
 * small (<= MAX_GOALS_PER_SIDE) counts used here without needing a separate factorial helper. */
const poissonPmf = (count: number, lambda: number): number => {
  let pmf = Math.exp(-lambda);
  for (let i = 1; i <= count; i++) {
    pmf = (pmf * lambda) / i;
  }
  return pmf;
};

/** Samples a realistic home/away expected-goal pair. Callers that need determinism (tests,
 * or an explicit pricing scenario) can bypass this entirely by passing their own pair to
 * `buildPreMatchPricing`. */
export const sampleExpectedGoals = (): ExpectedGoals => ({
  home: faker.number.float({ min: MIN_EXPECTED_GOALS, max: MAX_EXPECTED_GOALS, precision: 0.01 }),
  away: faker.number.float({ min: MIN_EXPECTED_GOALS, max: MAX_EXPECTED_GOALS, precision: 0.01 }),
});

const seededExpectedGoals = (seed: string): number => {
  const unitValue = createHash("sha256")
    .update(seed)
    .digest()
    .readUInt32BE(0) / 0xffffffff;
  return Math.round(
    (MIN_EXPECTED_GOALS + unitValue * (MAX_EXPECTED_GOALS - MIN_EXPECTED_GOALS))
      * 100
  ) / 100;
};

/** Produces a stable realistic expected-goal pair for compatibility repairs. Unlike generated
 * events, a dry-run/apply/verify backfill must derive the same board on every invocation. */
export const expectedGoalsFromSeed = (seed: string): ExpectedGoals => ({
  home: seededExpectedGoals(`${seed}:home`),
  away: seededExpectedGoals(`${seed}:away`),
});

/** Builds the bounded, normalized joint score-probability grid for a given expected-goal pair.
 * Normalizing the (necessarily truncated) grid to sum to exactly 1 means every probability
 * derived from it afterwards -- both 1X2 and correct-score -- is drawn from the same coherent
 * distribution instead of silently leaking probability mass to scores outside the grid. */
export const buildScoreGrid = (expectedGoals: ExpectedGoals): ScoreProbability[] => {
  const rawGrid: ScoreProbability[] = [];
  let total = 0;

  for (let homeGoals = 0; homeGoals <= MAX_GOALS_PER_SIDE; homeGoals++) {
    for (let awayGoals = 0; awayGoals <= MAX_GOALS_PER_SIDE; awayGoals++) {
      const probability = poissonPmf(homeGoals, expectedGoals.home) * poissonPmf(awayGoals, expectedGoals.away);
      rawGrid.push({ homeGoals, awayGoals, probability });
      total += probability;
    }
  }

  if (!(total > 0)) {
    return rawGrid;
  }

  return rawGrid.map((cell) => ({ ...cell, probability: cell.probability / total }));
};

/** Sums the normalized grid into home/draw/away probabilities. */
export const deriveOneCrossTwoProbabilities = (scoreGrid: ScoreProbability[]): OneCrossTwoProbabilities => (
  scoreGrid.reduce(
    (accumulator, cell) => {
      if (cell.homeGoals > cell.awayGoals) {
        accumulator.home += cell.probability;
      } else if (cell.homeGoals === cell.awayGoals) {
        accumulator.draw += cell.probability;
      } else {
        accumulator.away += cell.probability;
      }
      return accumulator;
    },
    { home: 0, draw: 0, away: 0 },
  )
);

/** Picks the `count` distinct highest-probability exact scores from the grid's plausible
 * low-score support. Since the grid itself is bounded (`MAX_GOALS_PER_SIDE`) and every cell is
 * a distinct `(homeGoals, awayGoals)` pair, the result can never contain duplicates or an
 * implausible outcome such as `7 - 10`. */
export const selectTopCorrectScores = (
  scoreGrid: ScoreProbability[],
  count: number = CORRECT_SCORE_OPTION_COUNT,
): ScoreProbability[] => (
  [...scoreGrid]
    .sort((left, right) => right.probability - left.probability)
    .slice(0, count)
);

/** Converts a fair probability into a finite decimal price, applying a modest, consistent
 * bookmaker margin (overround) and the same rounding policy used elsewhere for odds. */
export const oddsFromProbability = (probability: number, margin: number = BOOKMAKER_MARGIN): number => {
  const safeProbability = Number.isFinite(probability) && probability > 0 ? probability : Number.EPSILON;
  const impliedProbability = Math.min(safeProbability * margin, 1);
  const fairOdds = 1 / impliedProbability;
  const roundedOdds = Math.round((fairOdds + Number.EPSILON) * 100) / 100;

  return Math.min(Math.max(roundedOdds, MIN_ODDS), MAX_ODDS);
};

/** Builds a single coherent pre-match pricing model: one score distribution, priced once, and
 * shared by both the 1X2 and Correct Score products. `expectedGoals` defaults to a realistic
 * random sample but can be supplied explicitly (e.g. by tests) for deterministic pricing. */
export const buildPreMatchPricing = (expectedGoals: ExpectedGoals = sampleExpectedGoals()): PreMatchPricing => {
  const scoreGrid = buildScoreGrid(expectedGoals);
  const oneCrossTwoProbabilities = deriveOneCrossTwoProbabilities(scoreGrid);
  const topCorrectScores = selectTopCorrectScores(scoreGrid);

  return {
    expectedGoals,
    oneCrossTwoOdds: {
      home: oddsFromProbability(oneCrossTwoProbabilities.home),
      draw: oddsFromProbability(oneCrossTwoProbabilities.draw),
      away: oddsFromProbability(oneCrossTwoProbabilities.away),
    },
    correctScoreOdds: topCorrectScores.map((cell) => ({
      homeGoals: cell.homeGoals,
      awayGoals: cell.awayGoals,
      odds: oddsFromProbability(cell.probability),
    })),
  };
};
