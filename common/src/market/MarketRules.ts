export const MAX_BUILDER_SELECTIONS = 10;
export const MAX_MARKET_OUTCOMES = 64;
export const MAX_MARKET_RULE_NODES = 128;
export const MAX_MARKET_RULE_DEPTH = 8;
export const MAX_MARKET_SCORE = 99;

export type MarketMetric = "HOME_GOALS" | "AWAY_GOALS" | "TOTAL_GOALS" | "GOAL_DIFFERENCE";
export type MarketComparison = "EQ" | "GT" | "GTE" | "LT" | "LTE";
export type MarketOperand = number | { parameter: string };
export type ScoreRule<T extends MarketOperand = MarketOperand> =
  | { kind: "COMPARE"; metric: MarketMetric; comparison: MarketComparison; value: T }
  | { kind: "ALL" | "ANY"; rules: ScoreRule<T>[] }
  | { kind: "NOT"; rule: ScoreRule<T> };
export type BoundScoreRule = ScoreRule<number>;

export interface MarketParameter {
  key: string;
  label: string;
  minimum: number;
  maximum: number;
  defaultValue: number;
}

export interface MarketOutcomeDefinition {
  key: string;
  label: string;
  rule?: ScoreRule;
}

export interface MarketDefinition {
  schemaVersion: 1;
  name: string;
  settlementMode: "FINAL_SCORE" | "MANUAL";
  outcomeMode: "EXCLUSIVE" | "INDEPENDENT";
  coverage: "COMPLETE" | "PARTIAL";
  terms: string;
  parameters: MarketParameter[];
  outcomes: MarketOutcomeDefinition[];
}

export class MarketValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MarketValidationError";
    Object.setPrototypeOf(this, MarketValidationError.prototype);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export const marketObject = (value: unknown, fields: readonly string[], label: string) => {
  if (!isRecord(value) || Object.keys(value).some(key => fields.indexOf(key) < 0)) {
    throw new MarketValidationError(`${label} contains unsupported fields or is not an object`);
  }
  return value;
};

export const marketNumber = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MarketValidationError(`${label} must be a finite number`);
  }
  return value;
};

export const marketText = (value: unknown, label: string, maximum: number, allowEmpty = false): string => {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && !value.trim())) {
    throw new MarketValidationError(`${label} must be ${allowEmpty ? "0" : "1"}-${maximum} characters`);
  }
  return value.trim();
};

export const marketKey = (value: unknown, label: string): string => {
  const key = marketText(value, label, 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(key)
    || ["constructor", "prototype", "__proto__"].indexOf(key) >= 0) {
    throw new MarketValidationError(`${label} is not a supported identifier`);
  }
  return key;
};

const choice = <T extends string>(value: unknown, choices: readonly T[], label: string): T => {
  for (const candidate of choices) {
    if (value === candidate) return candidate;
  }
  throw new MarketValidationError(`${label} is unsupported`);
};

const parseRule = (
  value: unknown,
  parameterKeys: Set<string>,
  budget: { remaining: number },
  depth: number,
): ScoreRule => {
  if (depth > MAX_MARKET_RULE_DEPTH || --budget.remaining < 0) {
    throw new MarketValidationError("Market rules exceed the supported complexity");
  }
  if (!isRecord(value)) throw new MarketValidationError("A score rule must be an object");
  if (value.kind === "COMPARE") {
    const node = marketObject(value, ["kind", "metric", "comparison", "value"], "Comparison");
    let operand: MarketOperand;
    if (typeof node.value === "number") {
      operand = marketNumber(node.value, "Comparison value");
    } else {
      const reference = marketObject(node.value, ["parameter"], "Parameter reference");
      const key = marketKey(reference.parameter, "Parameter reference");
      if (!parameterKeys.has(key)) throw new MarketValidationError(`Unknown parameter: ${key}`);
      operand = { parameter: key };
    }
    return {
      kind: "COMPARE",
      metric: choice(node.metric, ["HOME_GOALS", "AWAY_GOALS", "TOTAL_GOALS", "GOAL_DIFFERENCE"], "Score metric"),
      comparison: choice(node.comparison, ["EQ", "GT", "GTE", "LT", "LTE"], "Comparison"),
      value: operand,
    };
  }
  if (value.kind === "NOT") {
    const node = marketObject(value, ["kind", "rule"], "NOT rule");
    return { kind: "NOT", rule: parseRule(node.rule, parameterKeys, budget, depth + 1) };
  }
  const node = marketObject(value, ["kind", "rules"], "Rule group");
  const kind = choice(node.kind, ["ALL", "ANY"], "Rule group");
  if (!Array.isArray(node.rules) || !node.rules.length || node.rules.length > MAX_MARKET_RULE_NODES) {
    throw new MarketValidationError("A rule group needs a bounded, non-empty list of rules");
  }
  return { kind, rules: node.rules.map(rule => parseRule(rule, parameterKeys, budget, depth + 1)) };
};

export function parseMarketDefinition(value: unknown): MarketDefinition {
  const input = marketObject(value, [
    "schemaVersion", "name", "settlementMode", "outcomeMode", "coverage", "terms", "parameters", "outcomes",
  ], "Market definition");
  if (input.schemaVersion !== 1) throw new MarketValidationError("Unsupported market definition version");
  const settlementMode = choice(input.settlementMode, ["FINAL_SCORE", "MANUAL"], "Settlement mode");
  if (!Array.isArray(input.parameters) || input.parameters.length > 16) {
    throw new MarketValidationError("A market supports at most 16 numeric parameters");
  }
  const parameterKeys = new Set<string>();
  const parameters = input.parameters.map(value => {
    const item = marketObject(value, ["key", "label", "minimum", "maximum", "defaultValue"], "Parameter");
    const key = marketKey(item.key, "Parameter key");
    if (parameterKeys.has(key)) throw new MarketValidationError("Parameter keys must be unique");
    parameterKeys.add(key);
    const minimum = marketNumber(item.minimum, "Parameter minimum");
    const maximum = marketNumber(item.maximum, "Parameter maximum");
    const defaultValue = marketNumber(item.defaultValue, "Parameter default");
    if (minimum > maximum || defaultValue < minimum || defaultValue > maximum) {
      throw new MarketValidationError(`Parameter ${key} has invalid bounds or default`);
    }
    return { key, label: marketText(item.label, "Parameter label", 80), minimum, maximum, defaultValue };
  });
  if (!Array.isArray(input.outcomes) || !input.outcomes.length || input.outcomes.length > MAX_MARKET_OUTCOMES) {
    throw new MarketValidationError(`A market needs 1-${MAX_MARKET_OUTCOMES} outcomes`);
  }
  const outcomeKeys = new Set<string>();
  const budget = { remaining: MAX_MARKET_RULE_NODES };
  const outcomes = input.outcomes.map(value => {
    const item = marketObject(value, ["key", "label", "rule"], "Outcome");
    const key = marketKey(item.key, "Outcome key");
    if (outcomeKeys.has(key)) throw new MarketValidationError("Outcome keys must be unique");
    outcomeKeys.add(key);
    const outcome: MarketOutcomeDefinition = { key, label: marketText(item.label, "Outcome label", 120) };
    if (settlementMode === "FINAL_SCORE") {
      outcome.rule = parseRule(item.rule, parameterKeys, budget, 0);
    } else if (item.rule !== undefined) {
      throw new MarketValidationError("Manual outcomes cannot claim an automatic score rule");
    }
    return outcome;
  });
  return {
    schemaVersion: 1,
    name: marketText(input.name, "Market name", 120),
    settlementMode,
    outcomeMode: choice(input.outcomeMode, ["EXCLUSIVE", "INDEPENDENT"], "Outcome mode"),
    coverage: choice(input.coverage, ["COMPLETE", "PARTIAL"], "Outcome coverage"),
    terms: marketText(input.terms, "Settlement terms", 2000, settlementMode === "FINAL_SCORE"),
    parameters,
    outcomes,
  };
}

export function bindMarketParameters(
  definition: MarketDefinition,
  values: unknown,
): Record<string, number> {
  const input = marketObject(values, definition.parameters.map(item => item.key), "Parameter values");
  const bound: Record<string, number> = {};
  for (const parameter of definition.parameters) {
    const value = marketNumber(input[parameter.key], `Parameter ${parameter.key}`);
    if (value < parameter.minimum || value > parameter.maximum) {
      throw new MarketValidationError(`Parameter ${parameter.key} is outside its supported bounds`);
    }
    bound[parameter.key] = value;
  }
  return bound;
}

function bindParsedScoreRule(rule: ScoreRule, parameters: Record<string, number>): BoundScoreRule {
  if (rule.kind === "COMPARE") {
    const value = typeof rule.value === "number"
      ? rule.value : marketNumber(parameters[rule.value.parameter], `Parameter ${rule.value.parameter}`);
    return { ...rule, value };
  }
  if (rule.kind === "NOT") return { kind: "NOT", rule: bindParsedScoreRule(rule.rule, parameters) };
  return { kind: rule.kind, rules: rule.rules.map(item => bindParsedScoreRule(item, parameters)) };
}

export function bindScoreRule(value: unknown, parameters: Record<string, number>): BoundScoreRule {
  return bindParsedScoreRule(
    parseRule(value, new Set(Object.keys(parameters)), { remaining: MAX_MARKET_RULE_NODES }, 0),
    parameters,
  );
}

export function compileScoreRule(value: unknown): (home: number, away: number) => boolean {
  const rule = parseRule(value, new Set(), { remaining: MAX_MARKET_RULE_NODES }, 0);
  const compile = (node: ScoreRule): ((home: number, away: number) => boolean) => {
    if (node.kind === "ALL" || node.kind === "ANY") {
      const children = node.rules.map(compile);
      return node.kind === "ALL"
        ? (home, away) => children.every(child => child(home, away))
        : (home, away) => children.some(child => child(home, away));
    }
    if (node.kind === "NOT") {
      const child = compile(node.rule);
      return (home, away) => !child(home, away);
    }
    if (node.kind !== "COMPARE" || typeof node.value !== "number") {
      throw new MarketValidationError("Unbound score rule");
    }
    const threshold = node.value;
    return (home, away) => {
      const actual = node.metric === "HOME_GOALS" ? home
        : node.metric === "AWAY_GOALS" ? away
          : node.metric === "TOTAL_GOALS" ? home + away : home - away;
      switch (node.comparison) {
        case "EQ": return actual === threshold;
        case "GT": return actual > threshold;
        case "GTE": return actual >= threshold;
        case "LT": return actual < threshold;
        case "LTE": return actual <= threshold;
      }
    };
  };
  return compile(rule);
}

export function marketWinningOutcomes(
  definition: MarketDefinition,
  parameters: Record<string, number>,
  home: number,
  away: number,
): string[] {
  definition = parseMarketDefinition(definition);
  if (definition.settlementMode !== "FINAL_SCORE") {
    throw new MarketValidationError("This market requires an explicit manual result");
  }
  assertMarketScore(home, away);
  const bound = bindMarketParameters(definition, parameters);
  return definition.outcomes.filter(outcome =>
    compileScoreRule(bindScoreRule(outcome.rule, bound))(home, away),
  ).map(outcome => outcome.key);
}

export function assertMarketScore(home: number, away: number): void {
  if (![home, away].every(score => Number.isInteger(score) && score >= 0 && score <= MAX_MARKET_SCORE)) {
    throw new MarketValidationError(`Scores must be whole numbers from 0 to ${MAX_MARKET_SCORE}`);
  }
}
