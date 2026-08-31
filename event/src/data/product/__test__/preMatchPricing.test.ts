import {
  buildPreMatchPricing,
  buildScoreGrid,
  CORRECT_SCORE_OPTION_COUNT,
  deriveOneCrossTwoProbabilities,
  expectedGoalsFromSeed,
  MAX_GOALS_PER_SIDE,
  oddsFromProbability,
  sampleExpectedGoals,
  selectTopCorrectScores,
} from "../preMatchPricing";

describe("sampleExpectedGoals", () => {
  it("samples a realistic, finite home/away expected-goal pair", () => {
    for (let i = 0; i < 20; i++) {
      const expectedGoals = sampleExpectedGoals();

      expect(Number.isFinite(expectedGoals.home)).toBe(true);
      expect(Number.isFinite(expectedGoals.away)).toBe(true);
      expect(expectedGoals.home).toBeGreaterThanOrEqual(0.6);
      expect(expectedGoals.home).toBeLessThanOrEqual(2.6);
      expect(expectedGoals.away).toBeGreaterThanOrEqual(0.6);
      expect(expectedGoals.away).toBeLessThanOrEqual(2.6);
    }
  });
});

describe("expectedGoalsFromSeed", () => {
  it("derives a stable, bounded pair without consuming random state", () => {
    const randomSpy = jest.spyOn(Math, "random");

    const first = expectedGoalsFromSeed("event-a");
    const second = expectedGoalsFromSeed("event-a");
    const other = expectedGoalsFromSeed("event-b");

    expect(first).toEqual(second);
    expect(other).not.toEqual(first);
    expect(randomSpy).not.toHaveBeenCalled();
    for (const value of [first.home, first.away, other.home, other.away]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0.6);
      expect(value).toBeLessThanOrEqual(2.6);
    }
    randomSpy.mockRestore();
  });

  it("builds a deterministic plausible board from the same seeded pair", () => {
    const pricing = buildPreMatchPricing(expectedGoalsFromSeed("legacy-event"));
    const labels = pricing.correctScoreOdds.map(
      (score) => `${score.homeGoals} - ${score.awayGoals}`
    );

    expect(pricing.correctScoreOdds).toHaveLength(CORRECT_SCORE_OPTION_COUNT);
    expect(new Set(labels).size).toBe(CORRECT_SCORE_OPTION_COUNT);
    pricing.correctScoreOdds.forEach((score) => {
      expect(score.homeGoals).toBeLessThanOrEqual(MAX_GOALS_PER_SIDE);
      expect(score.awayGoals).toBeLessThanOrEqual(MAX_GOALS_PER_SIDE);
      expect(score.odds).toBeGreaterThanOrEqual(1.01);
      expect(Number.isFinite(score.odds)).toBe(true);
    });
  });
});

describe("buildScoreGrid", () => {
  it("normalizes the bounded grid so probabilities sum to (approximately) 1", () => {
    const grid = buildScoreGrid({ home: 1.4, away: 1.1 });
    const total = grid.reduce((sum, cell) => sum + cell.probability, 0);

    expect(total).toBeCloseTo(1, 6);
  });

  it("never produces an implausible score cell outside a bounded low-score support", () => {
    const grid = buildScoreGrid({ home: 1.4, away: 1.1 });

    grid.forEach((cell) => {
      expect(cell.homeGoals).toBeGreaterThanOrEqual(0);
      expect(cell.awayGoals).toBeGreaterThanOrEqual(0);
      expect(cell.homeGoals).toBeLessThanOrEqual(MAX_GOALS_PER_SIDE);
      expect(cell.awayGoals).toBeLessThanOrEqual(MAX_GOALS_PER_SIDE);
    });
  });

  it("has no duplicate (homeGoals, awayGoals) cells", () => {
    const grid = buildScoreGrid({ home: 1.4, away: 1.1 });
    const keys = grid.map((cell) => `${cell.homeGoals}-${cell.awayGoals}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("deriveOneCrossTwoProbabilities", () => {
  it("derives home/draw/away probabilities that sum to 1 from the same grid", () => {
    const grid = buildScoreGrid({ home: 1.6, away: 0.9 });
    const oneCrossTwo = deriveOneCrossTwoProbabilities(grid);

    expect(oneCrossTwo.home + oneCrossTwo.draw + oneCrossTwo.away).toBeCloseTo(1, 6);
    expect(oneCrossTwo.home).toBeGreaterThan(0);
    expect(oneCrossTwo.draw).toBeGreaterThan(0);
    expect(oneCrossTwo.away).toBeGreaterThan(0);
  });

  it("favors the side with the higher expected goals", () => {
    const grid = buildScoreGrid({ home: 2.4, away: 0.7 });
    const oneCrossTwo = deriveOneCrossTwoProbabilities(grid);

    expect(oneCrossTwo.home).toBeGreaterThan(oneCrossTwo.away);
  });
});

describe("selectTopCorrectScores", () => {
  it("selects the requested number of distinct, highest-probability scores", () => {
    const grid = buildScoreGrid({ home: 1.4, away: 1.1 });
    const topScores = selectTopCorrectScores(grid, CORRECT_SCORE_OPTION_COUNT);

    expect(topScores).toHaveLength(CORRECT_SCORE_OPTION_COUNT);

    const keys = topScores.map((score) => `${score.homeGoals}-${score.awayGoals}`);
    expect(new Set(keys).size).toBe(CORRECT_SCORE_OPTION_COUNT);

    for (let i = 1; i < topScores.length; i++) {
      expect(topScores[i - 1].probability).toBeGreaterThanOrEqual(topScores[i].probability);
    }
  });

  it("never selects an implausible score such as 7 - 10", () => {
    const grid = buildScoreGrid({ home: 1.4, away: 1.1 });
    const topScores = selectTopCorrectScores(grid, CORRECT_SCORE_OPTION_COUNT);

    const hasImplausibleScore = topScores.some(
      (score) => score.homeGoals > MAX_GOALS_PER_SIDE
        || score.awayGoals > MAX_GOALS_PER_SIDE
    );
    expect(hasImplausibleScore).toBe(false);
  });
});

describe("oddsFromProbability", () => {
  it("converts a fair probability into a finite decimal price with a modest overround", () => {
    const odds = oddsFromProbability(0.5);

    // Fair odds for p=0.5 would be exactly 2.00; the modest margin nudges it down slightly.
    expect(odds).toBeLessThan(2);
    expect(odds).toBeGreaterThan(1.8);
    expect(Number.isFinite(odds)).toBe(true);
  });

  it("never returns a non-finite or implausibly small/large price for edge-case probabilities", () => {
    expect(Number.isFinite(oddsFromProbability(0))).toBe(true);
    expect(Number.isFinite(oddsFromProbability(1))).toBe(true);
    expect(Number.isFinite(oddsFromProbability(Number.NaN))).toBe(true);
    expect(oddsFromProbability(0)).toBeGreaterThanOrEqual(1.01);
    expect(oddsFromProbability(1)).toBeGreaterThanOrEqual(1.01);
  });
});

describe("buildPreMatchPricing", () => {
  it("derives coherent, finite 1X2 and correct-score prices from a single shared distribution", () => {
    const pricing = buildPreMatchPricing({ home: 1.5, away: 1.2 });

    expect(Number.isFinite(pricing.oneCrossTwoOdds.home)).toBe(true);
    expect(Number.isFinite(pricing.oneCrossTwoOdds.draw)).toBe(true);
    expect(Number.isFinite(pricing.oneCrossTwoOdds.away)).toBe(true);

    expect(pricing.correctScoreOdds).toHaveLength(CORRECT_SCORE_OPTION_COUNT);
    pricing.correctScoreOdds.forEach((score) => {
      expect(Number.isFinite(score.odds)).toBe(true);
      expect(score.homeGoals).toBeLessThanOrEqual(MAX_GOALS_PER_SIDE);
      expect(score.awayGoals).toBeLessThanOrEqual(MAX_GOALS_PER_SIDE);
    });

    const scoreKeys = pricing.correctScoreOdds.map((score) => `${score.homeGoals}-${score.awayGoals}`);
    expect(new Set(scoreKeys).size).toBe(scoreKeys.length);
  });

  it("samples its own realistic expected goals when none are supplied", () => {
    const pricing = buildPreMatchPricing();

    expect(Number.isFinite(pricing.expectedGoals.home)).toBe(true);
    expect(Number.isFinite(pricing.expectedGoals.away)).toBe(true);
  });

  it("is deterministic for the same explicit expected-goal pair", () => {
    const expectedGoals = { home: 1.3, away: 1.1 };

    const first = buildPreMatchPricing(expectedGoals);
    const second = buildPreMatchPricing(expectedGoals);

    expect(first).toEqual(second);
  });
});
