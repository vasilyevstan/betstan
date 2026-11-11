import {
  bindMarketParameters,
  bindScoreRule,
  compileScoreRule,
  MarketDefinition,
  marketNumber,
  marketObject,
  MarketValidationError,
  MAX_BUILDER_SELECTIONS,
  MAX_MARKET_SCORE,
  parseMarketDefinition,
  ScoreRule,
} from "./MarketRules";

export const MARKET_MARGIN = 1.07;
export const MIN_MARKET_ODDS = 1.01;
export const MAX_MARKET_ODDS = 1000;

export interface ScorePricingModel {
  version: 1;
  id: string;
  homeExpectedGoals: number;
  awayExpectedGoals: number;
}

export interface MarketOddsPreview {
  method: "SCORE_MODEL" | "EQUAL_CHANCE" | "PROBABILITIES" | "WEIGHTS";
  odds: Record<string, number>;
  probabilities?: Record<string, number>;
  logProbabilities?: Record<string, number>;
  unlistedProbability?: number;
  unlistedLogProbability?: number;
  modelId?: string;
}

export function parseScorePricingModel(value: unknown): ScorePricingModel {
  const model = marketObject(value, ["version", "id", "homeExpectedGoals", "awayExpectedGoals"], "Pricing model");
  if (model.version !== 1 || typeof model.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(model.id)) {
    throw new MarketValidationError("Unsupported pricing model identity");
  }
  const homeExpectedGoals = marketNumber(model.homeExpectedGoals, "Home expected goals");
  const awayExpectedGoals = marketNumber(model.awayExpectedGoals, "Away expected goals");
  if ([homeExpectedGoals, awayExpectedGoals].some(value => value < 0.6 || value > 2.6)) {
    throw new MarketValidationError("Expected goals must be within the supported 0.6-2.6 range");
  }
  return { version: 1, id: model.id, homeExpectedGoals, awayExpectedGoals };
}

const logAdd = (left: number, right: number) => {
  if (left === -Infinity) return right;
  if (right === -Infinity) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log1p(Math.exp(Math.min(left, right) - maximum));
};

const logGoalProbabilities = (lambda: number): number[] => {
  const values = [-lambda];
  for (let score = 1; score <= MAX_MARKET_SCORE; score++) {
    values.push(values[score - 1] + Math.log(lambda) - Math.log(score));
  }
  const normalizer = values.reduce(logAdd, -Infinity);
  return values.map(value => value - normalizer);
};

const oddsFromLogProbability = (logProbability: number): number => {
  if (!Number.isFinite(logProbability)) throw new MarketValidationError("The selection is impossible");
  const boundedLogOdds = Math.min(Math.log(MAX_MARKET_ODDS), -logProbability - Math.log(MARKET_MARGIN));
  const cents = Math.exp(boundedLogOdds) * 100;
  // Log/exp roundoff must not change a half-cent tie when weights change units.
  const halfCent = Math.floor(cents) + 0.5;
  const rounded = Math.abs(cents - halfCent) <= 1e-7 ? Math.ceil(cents) : Math.round(cents);
  return Math.min(MAX_MARKET_ODDS, Math.max(MIN_MARKET_ODDS, rounded / 100));
};

export function priceScoreCombination(modelValue: unknown, rules: readonly ScoreRule[]): number {
  const model = parseScorePricingModel(modelValue);
  if (!rules.length || rules.length > MAX_BUILDER_SELECTIONS) {
    throw new MarketValidationError(`Select 1-${MAX_BUILDER_SELECTIONS} modeled outcomes`);
  }
  const predicates = rules.map(compileScoreRule);
  const homeProbabilities = logGoalProbabilities(model.homeExpectedGoals);
  const awayProbabilities = logGoalProbabilities(model.awayExpectedGoals);
  let logProbability = -Infinity;
  let matchingScores = 0;
  for (let home = 0; home <= MAX_MARKET_SCORE; home++) {
    for (let away = 0; away <= MAX_MARKET_SCORE; away++) {
      if (predicates.every(predicate => predicate(home, away))) {
        matchingScores++;
        logProbability = logAdd(logProbability, homeProbabilities[home] + awayProbabilities[away]);
      }
    }
  }
  if (matchingScores === (MAX_MARKET_SCORE + 1) ** 2) {
    throw new MarketValidationError("The selection is already certain");
  }
  return oddsFromLogProbability(logProbability);
}

export function generateScoreMarketOdds(
  definitionValue: unknown,
  parameterValues: unknown,
  modelValue: unknown,
): MarketOddsPreview {
  const definition = parseMarketDefinition(definitionValue);
  const model = parseScorePricingModel(modelValue);
  if (definition.settlementMode !== "FINAL_SCORE") {
    throw new MarketValidationError("Manual outcomes do not have modeled probabilities");
  }
  const parameters = bindMarketParameters(definition, parameterValues);
  const rules = definition.outcomes.map(outcome => bindScoreRule(outcome.rule, parameters));
  const predicates = rules.map(compileScoreRule);
  const homeProbabilities = logGoalProbabilities(model.homeExpectedGoals);
  const awayProbabilities = logGoalProbabilities(model.awayExpectedGoals);
  const logValues = predicates.map(() => -Infinity);
  const matchingScores = predicates.map(() => 0);
  let unlistedLogProbability = -Infinity;
  for (let home = 0; home <= MAX_MARKET_SCORE; home++) {
    for (let away = 0; away <= MAX_MARKET_SCORE; away++) {
      const logProbability = homeProbabilities[home] + awayProbabilities[away];
      let winners = 0;
      predicates.forEach((predicate, index) => {
        if (predicate(home, away)) {
          winners++;
          matchingScores[index]++;
          logValues[index] = logAdd(logValues[index], logProbability);
        }
      });
      if (definition.outcomeMode === "EXCLUSIVE" && winners > 1) {
        throw new MarketValidationError("Exclusive outcomes overlap");
      }
      if (definition.coverage === "COMPLETE" && winners === 0) {
        throw new MarketValidationError("Complete outcomes leave an uncovered score");
      }
      if (winners === 0) unlistedLogProbability = logAdd(unlistedLogProbability, logProbability);
    }
  }
  const odds: Record<string, number> = {};
  const probabilities: Record<string, number> = {};
  const logProbabilities: Record<string, number> = {};
  definition.outcomes.forEach((outcome, index) => {
    if (matchingScores[index] === (MAX_MARKET_SCORE + 1) ** 2) {
      throw new MarketValidationError(`Outcome ${outcome.key} is already certain`);
    }
    odds[outcome.key] = oddsFromLogProbability(logValues[index]);
    logProbabilities[outcome.key] = Math.min(0, logValues[index]);
    probabilities[outcome.key] = Math.exp(logProbabilities[outcome.key]);
  });
  return {
    method: "SCORE_MODEL", modelId: model.id, odds, probabilities, logProbabilities,
    unlistedProbability: Math.exp(Math.min(0, unlistedLogProbability)),
    ...(Number.isFinite(unlistedLogProbability) ? { unlistedLogProbability } : {}),
  };
}

export function generateManualMarketOdds(
  definitionValue: unknown,
  requestValue: unknown,
): MarketOddsPreview {
  const definition: MarketDefinition = parseMarketDefinition(definitionValue);
  const request = marketObject(requestValue, ["method", "values", "unlistedWeight"], "Odds generation");
  if (definition.settlementMode !== "MANUAL") {
    throw new MarketValidationError("Score-rule markets must use their retained model");
  }
  const method = request.method;
  if (method !== "EQUAL_CHANCE" && method !== "PROBABILITIES" && method !== "WEIGHTS") {
    throw new MarketValidationError("Select equal chances, probabilities or relative weights");
  }
  if (definition.outcomeMode === "INDEPENDENT" && method !== "PROBABILITIES") {
    throw new MarketValidationError("Overlapping outcomes require individual probabilities, not normalized weights");
  }
  const keys = definition.outcomes.map(outcome => outcome.key);
  const values = method === "EQUAL_CHANCE"
    ? marketObject(request.values ?? {}, [], "Equal-chance inputs")
    : marketObject(request.values, keys, "Outcome probabilities or weights");
  if (method !== "WEIGHTS" && request.unlistedWeight !== undefined) {
    throw new MarketValidationError("Unlisted weight applies only to relative weights");
  }
  const probabilities: Record<string, number> = {};
  const logProbabilities: Record<string, number> = {};
  let total = 0;
  let logTotal = -Infinity;
  for (const key of keys) {
    const value = method === "EQUAL_CHANCE" ? 1 : marketNumber(values[key], `Outcome ${key}`);
    if (!(value > 0) || (method === "PROBABILITIES" && value >= 1)) {
      throw new MarketValidationError("Each probability must be between 0 and 1; each weight must be positive");
    }
    probabilities[key] = value;
    logProbabilities[key] = Math.log(value);
    total += value;
    logTotal = logAdd(logTotal, Math.log(value));
  }
  let unlistedProbability: number | undefined;
  let unlistedLogProbability: number | undefined;
  let certain = keys.length === 1 && definition.coverage === "COMPLETE";
  if (method === "PROBABILITIES") {
    if (definition.coverage === "COMPLETE" && total < 1 - 1e-10) {
      throw new MarketValidationError("Probabilities do not match the declared outcome coverage");
    }
    if (definition.outcomeMode === "EXCLUSIVE") {
      if (total > 1 + 1e-10 || (definition.coverage === "COMPLETE" && Math.abs(1 - total) > 1e-10)) {
        throw new MarketValidationError("Probabilities do not match the declared outcome coverage");
      }
      unlistedProbability = Math.max(0, 1 - total);
      if (unlistedProbability > 0) unlistedLogProbability = Math.log(unlistedProbability);
    }
  } else {
    let unlistedWeight = 0;
    if (definition.coverage === "PARTIAL") {
      unlistedWeight = method === "EQUAL_CHANCE" ? 1 : marketNumber(request.unlistedWeight, "Unlisted-outcome weight");
      if (unlistedWeight < 0) throw new MarketValidationError("Unlisted-outcome weight cannot be negative");
    } else if (request.unlistedWeight !== undefined) {
      throw new MarketValidationError("Complete outcomes cannot have an unlisted-outcome weight");
    }
    certain = keys.length === 1 && unlistedWeight === 0;
    logTotal = logAdd(logTotal, Math.log(unlistedWeight));
    keys.forEach(key => {
      logProbabilities[key] -= logTotal;
      probabilities[key] = Math.exp(logProbabilities[key]);
    });
    unlistedProbability = Math.exp(Math.log(unlistedWeight) - logTotal);
    if (unlistedWeight > 0) unlistedLogProbability = Math.log(unlistedWeight) - logTotal;
  }
  const odds: Record<string, number> = {};
  for (const key of keys) {
    if (certain) {
      throw new MarketValidationError("Generation cannot offer an impossible or certain outcome");
    }
    odds[key] = oddsFromLogProbability(logProbabilities[key]);
  }
  return {
    method, odds, probabilities, logProbabilities,
    ...(unlistedProbability === undefined ? {} : { unlistedProbability }),
    ...(unlistedLogProbability === undefined ? {} : { unlistedLogProbability }),
  };
}
