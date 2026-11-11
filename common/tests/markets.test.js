const assert = require("node:assert/strict");
const test = require("node:test");
const {
  bindMarketParameters,
  bindScoreRule,
  compileScoreRule,
  generateManualMarketOdds,
  generateScoreMarketOdds,
  evaluateMarketBetResult,
  marketWinningOutcomes,
  MarketValidationError,
  assertMarketSlipCompatibility,
  parseManualMarketDecision,
  parseEventMarketConfiguration,
  parseMarketBet,
  parseMarketDefinition,
  priceScoreCombination,
  validateManualWinningOutcomes,
} = require("../build");

const model = { version: 1, id: "retained-model", homeExpectedGoals: 1.8, awayExpectedGoals: 1.2 };
const compare = (metric, comparison, value) => ({ kind: "COMPARE", metric, comparison, value });
const totalOver = value => compare("TOTAL_GOALS", "GT", value);
const homeWin = compare("GOAL_DIFFERENCE", "GT", 0);
const homeScores = compare("HOME_GOALS", "GT", 0);
const totalDefinition = () => ({
  schemaVersion: 1,
  name: "Total goals",
  settlementMode: "FINAL_SCORE",
  outcomeMode: "EXCLUSIVE",
  coverage: "COMPLETE",
  terms: "",
  parameters: [{ key: "line", label: "Goals", minimum: 0.5, maximum: 197.5, defaultValue: 2.5 }],
  outcomes: [
    { key: "over", label: "Over", rule: totalOver({ parameter: "line" }) },
    { key: "under", label: "Under", rule: compare("TOTAL_GOALS", "LT", { parameter: "line" }) },
  ],
});
const manualDefinition = () => ({
  schemaVersion: 1,
  name: "Operator award",
  settlementMode: "MANUAL",
  outcomeMode: "EXCLUSIVE",
  coverage: "COMPLETE",
  terms: "The operator announces the winning nominee.",
  parameters: [],
  outcomes: [{ key: "a", label: "Nominee A" }, { key: "b", label: "Nominee B" }],
});

test("binding a reused template does not mutate its definition or another instance", () => {
  const source = totalDefinition();
  const definition = parseMarketDefinition(source);
  const earlier = bindScoreRule(definition.outcomes[0].rule, bindMarketParameters(definition, { line: 2.5 }));
  const later = bindScoreRule(definition.outcomes[0].rule, bindMarketParameters(definition, { line: 4.5 }));
  source.outcomes[0].rule.value.parameter = "changed";
  assert.equal(compileScoreRule(earlier)(2, 1), true);
  assert.equal(compileScoreRule(later)(2, 1), false);
  assert.deepEqual(definition.outcomes[0].rule.value, { parameter: "line" });
  assert.throws(() => bindMarketParameters(definition, {}), /finite number/);
  assert.throws(() => bindMarketParameters(definition, { line: 199 }), /bounds/);
  assert.throws(() => bindMarketParameters(definition, { line: 2.5, extra: 1 }), /unsupported fields/);
});

test("rule validation rejects executable data, unknown facts and unbounded trees", () => {
  const definition = totalDefinition();
  definition.outcomes[0].rule.metric = "PRIVATE_SIMULATION_SEED";
  assert.throws(() => parseMarketDefinition(definition), MarketValidationError);
  assert.throws(() => compileScoreRule({ ...homeWin, javascript: "return true" }), /unsupported fields/);
  assert.throws(() => compileScoreRule({ kind: "ALL", rules: [] }), /non-empty/);
  assert.throws(() => compileScoreRule({ kind: "ANY", rules: Array(129).fill(homeWin) }), /bounded/);
  let nested = homeWin;
  for (let index = 0; index < 10; index++) nested = { kind: "NOT", rule: nested };
  assert.throws(() => compileScoreRule(nested), /complexity/);
  assert.throws(() => compileScoreRule(totalOver({ parameter: "unbound" })), /Unknown parameter/);
});

test("template validation rejects duplicate keys, unsafe keys and manual automatic-rule claims", () => {
  const duplicate = manualDefinition();
  duplicate.outcomes[1].key = "a";
  assert.throws(() => parseMarketDefinition(duplicate), /unique/);
  duplicate.outcomes[1].key = "constructor";
  assert.throws(() => parseMarketDefinition(duplicate), /identifier/);
  const manual = manualDefinition();
  manual.outcomes[0].rule = homeWin;
  assert.throws(() => parseMarketDefinition(manual), /cannot claim/);
  manual.outcomes[0].rule = undefined;
  manual.terms = "";
  assert.throws(() => parseMarketDefinition(manual), /Settlement terms/);
});

test("same-match pricing uses the joint probability and applies the margin once", () => {
  // Independent oracle: sum the Poisson probabilities directly, not the pricing implementation.
  const factorial = n => n <= 1 ? 1 : n * factorial(n - 1);
  const poisson = (lambda, n) => Math.exp(-lambda) * lambda ** n / factorial(n);
  let probability = 0;
  for (let home = 0; home < 40; home++) {
    for (let away = 0; away < 40; away++) {
      if (home > away && home + away > 2.5) probability += poisson(1.8, home) * poisson(1.2, away);
    }
  }
  const expected = Math.round(100 / (1.07 * probability)) / 100;
  const actual = priceScoreCombination(model, [homeWin, totalOver(2.5)]);
  assert.equal(actual, expected);
  assert.notEqual(actual, priceScoreCombination(model, [homeWin]) * priceScoreCombination(model, [totalOver(2.5)]));
  assert.equal(actual, priceScoreCombination(model, [totalOver(2.5), homeWin]));
});

test("redundant picks do not boost a price; impossible and certain combinations cannot be offered", () => {
  assert.equal(priceScoreCombination(model, [homeWin, homeScores]), priceScoreCombination(model, [homeWin]));
  assert.equal(priceScoreCombination(model, [homeWin, homeWin]), priceScoreCombination(model, [homeWin]));
  assert.throws(() => priceScoreCombination(model, [totalOver(2.5), compare("TOTAL_GOALS", "LT", 1.5)]), /impossible/);
  assert.throws(() => priceScoreCombination(model, [compare("TOTAL_GOALS", "GTE", 0)]), /certain/);
  assert.throws(() => priceScoreCombination(model, Array(11).fill(homeWin)), /1-10/);
  assert.equal(priceScoreCombination(model, Array(10).fill(homeWin)), priceScoreCombination(model, [homeWin]));
});

test("the full 0-99 score domain remains possible even below floating-point probability precision", () => {
  const rareScore = { kind: "ALL", rules: [compare("HOME_GOALS", "EQ", 99), compare("AWAY_GOALS", "EQ", 99)] };
  assert.equal(priceScoreCombination({ ...model, homeExpectedGoals: 0.6, awayExpectedGoals: 0.6 }, [rareScore]), 1000);
  const definition = totalDefinition();
  const preview = generateScoreMarketOdds(definition, { line: 197.5 }, model);
  assert.equal(preview.odds.over, 1000);
  assert.ok(Number.isFinite(preview.logProbabilities.over));
  assert.deepEqual(marketWinningOutcomes(parseMarketDefinition(definition), { line: 197.5 }, 99, 99), ["over"]);
  assert.throws(() => marketWinningOutcomes(parseMarketDefinition(definition), { line: 2.5 }, 100, 0), /0 to 99/);
  assert.throws(() => priceScoreCombination(model, [compare("HOME_GOALS", "GT", 99)]), /impossible/);
});

test("score generation proves coverage and exclusivity, while overlapping double chance is supported", () => {
  const incomplete = totalDefinition();
  assert.throws(() => generateScoreMarketOdds(incomplete, { line: 2 }, model), /uncovered/);
  incomplete.outcomes[1].rule = compare("TOTAL_GOALS", "GTE", 0);
  assert.throws(() => generateScoreMarketOdds(incomplete, { line: 2.5 }, model), /overlap/);
  const doubleChance = {
    ...totalDefinition(), parameters: [], outcomeMode: "INDEPENDENT",
    outcomes: [
      { key: "home_draw", label: "Home or draw", rule: compare("GOAL_DIFFERENCE", "GTE", 0) },
      { key: "away_draw", label: "Away or draw", rule: compare("GOAL_DIFFERENCE", "LTE", 0) },
      { key: "no_draw", label: "Either team", rule: { kind: "NOT", rule: compare("GOAL_DIFFERENCE", "EQ", 0) } },
    ],
  };
  const preview = generateScoreMarketOdds(doubleChance, {}, model);
  assert.ok(Math.abs(Object.values(preview.probabilities).reduce((a, b) => a + b, 0) - 2) < 1e-10);
  assert.equal(preview.unlistedProbability, 0);
  assert.equal(preview.modelId, model.id);
});

test("partial modeled markets report actual unlisted probability without renormalizing offered outcomes", () => {
  const definition = { ...totalDefinition(), parameters: [], coverage: "PARTIAL", outcomes: [
    { key: "home", label: "Home", rule: homeWin },
  ] };
  const preview = generateScoreMarketOdds(definition, {}, model);
  assert.equal(preview.odds.home, priceScoreCombination(model, [homeWin]));
  assert.ok(preview.unlistedProbability > 0);
  assert.ok(Math.abs(preview.probabilities.home + preview.unlistedProbability - 1) < 1e-10);
});

test("no retained pricing evidence is inferred from old event prices", () => {
  assert.throws(() => generateScoreMarketOdds(totalDefinition(), { line: 2.5 }, undefined), /Pricing model/);
  assert.throws(() => priceScoreCombination({ ...model, version: 2 }, [homeWin]), /Unsupported/);
  assert.throws(() => priceScoreCombination({ ...model, homeExpectedGoals: NaN }, [homeWin]), /finite/);
  assert.throws(() => priceScoreCombination({ ...model, awayExpectedGoals: 0 }, [homeWin]), /0.6-2.6/);
});

test("manual generation distinguishes equal assumptions, probabilities and normalized relative weights", () => {
  const definition = manualDefinition();
  const equal = generateManualMarketOdds(definition, { method: "EQUAL_CHANCE" });
  assert.deepEqual(equal.odds, { a: 1.87, b: 1.87 });
  assert.deepEqual(equal.probabilities, { a: 0.5, b: 0.5 });
  const supplied = generateManualMarketOdds(definition, { method: "PROBABILITIES", values: { a: 0.8, b: 0.2 } });
  const weights = generateManualMarketOdds(definition, { method: "WEIGHTS", values: { a: 80, b: 20 } });
  assert.deepEqual(supplied.odds, weights.odds);
  assert.equal(supplied.method, "PROBABILITIES");
  assert.equal(weights.method, "WEIGHTS");
  assert.throws(() => generateManualMarketOdds(definition, { method: "PROBABILITIES", values: { a: 80, b: 20 } }), /between 0 and 1/);
  assert.throws(() => generateManualMarketOdds(definition, { method: "PROBABILITIES", values: { a: 0.6, b: 0.2 } }), /coverage/);
});

test("partial manual markets include the unlisted outcome explicitly", () => {
  const definition = { ...manualDefinition(), coverage: "PARTIAL" };
  const equal = generateManualMarketOdds(definition, { method: "EQUAL_CHANCE" });
  assert.ok(Math.abs(equal.unlistedProbability - 1 / 3) < 1e-12);
  assert.equal(equal.odds.a, 2.8);
  const supplied = generateManualMarketOdds(definition, { method: "PROBABILITIES", values: { a: 0.5, b: 0.2 } });
  assert.ok(Math.abs(supplied.unlistedProbability - 0.3) < 1e-12);
  assert.throws(() => generateManualMarketOdds(definition, { method: "WEIGHTS", values: { a: 2, b: 1 } }), /Unlisted-outcome weight/);
  const weighted = generateManualMarketOdds(definition, { method: "WEIGHTS", values: { a: 2, b: 1 }, unlistedWeight: 1 });
  assert.deepEqual(weighted.odds, { a: 1.87, b: 3.74 });
});

test("manual generation rejects missing, nonpositive and incompatible inputs without random fallbacks", () => {
  const definition = manualDefinition();
  for (const bad of [0, -1, NaN, Infinity, "1"]) {
    assert.throws(() => generateManualMarketOdds(definition, { method: "WEIGHTS", values: { a: bad, b: 1 } }), MarketValidationError);
  }
  assert.throws(() => generateManualMarketOdds(definition, { method: "WEIGHTS", values: { a: 1 } }), /finite/);
  assert.throws(() => generateManualMarketOdds(definition, { method: "EQUAL_CHANCE", values: { a: 0.7 } }), /unsupported fields/);
  assert.throws(() => generateManualMarketOdds(definition, { method: "EQUAL_CHANCE", unlistedWeight: 1 }), /only to relative weights/);
  assert.throws(() => generateManualMarketOdds(totalDefinition(), { method: "EQUAL_CHANCE" }), /retained model/);
  assert.throws(() => generateScoreMarketOdds(definition, {}, model), /do not have modeled/);
  assert.throws(() => marketWinningOutcomes(definition, {}, 2, 1), /explicit manual result/);
});

test("overlapping manual outcomes need explicit individual probabilities, not fictitious normalization", () => {
  const definition = { ...manualDefinition(), outcomeMode: "INDEPENDENT", coverage: "PARTIAL" };
  assert.throws(() => generateManualMarketOdds(definition, { method: "EQUAL_CHANCE" }), /individual probabilities/);
  const preview = generateManualMarketOdds(definition, { method: "PROBABILITIES", values: { a: 0.8, b: 0.8 } });
  assert.deepEqual(preview.odds, { a: 1.17, b: 1.17 });
  assert.equal(preview.unlistedProbability, undefined);
});

test("extreme positive weights remain numerically stable instead of becoming impossible outcomes", () => {
  const definition = manualDefinition();
  assert.deepEqual(generateManualMarketOdds(definition, {
    method: "WEIGHTS", values: { a: 1e308, b: 1e308 },
  }).odds, { a: 1.87, b: 1.87 });
  const preview = generateManualMarketOdds(definition, { method: "WEIGHTS", values: { a: 1e-300, b: 1e300 } });
  assert.equal(preview.odds.a, 1000);
  assert.ok(Number.isFinite(preview.logProbabilities.a));
});

test("equivalent weight units and probabilities share stable half-cent rounding", () => {
  const definition = manualDefinition();
  for (const scale of [1, 10, 1e-100, 1e100, 1e305]) {
    const preview = generateManualMarketOdds(definition, {
      method: "WEIGHTS", values: { a: 160 * scale, b: 161 * scale },
    });
    assert.equal(preview.odds.a, 1.88);
  }
  const probabilities = generateManualMarketOdds(definition, {
    method: "PROBABILITIES", values: { a: 160 / 321, b: 161 / 321 },
  });
  assert.equal(probabilities.odds.a, 1.88);
  const belowTie = 1 / (1.07 * 1.87499999);
  assert.equal(generateManualMarketOdds(definition, {
    method: "PROBABILITIES", values: { a: belowTie, b: 1 - belowTie },
  }).odds.a, 1.87);
  const aboveTie = 1 / (1.07 * 1.87500001);
  assert.equal(generateManualMarketOdds(definition, {
    method: "PROBABILITIES", values: { a: aboveTie, b: 1 - aboveTie },
  }).odds.a, 1.88);
});

const frozenSelection = (marketId = "market-a") => ({
  origin: "TEMPLATE", marketId, outcomeKey: "home", rulesRevision: 1, quoteRevision: 3,
  templateId: "template-a", templateVersion: 2, marketName: "Home result",
  label: "Home wins", terms: "", settlementMode: "FINAL_SCORE",
  pricingMethod: "SCORE_MODEL", rule: homeWin,
});
const frozenBet = () => ({
  schemaVersion: 1, kind: "SINGLE", eventId: "event-a", quoteId: "quote-a",
  issuedAt: "2026-01-01T10:00:00.000Z", expiresAt: "2026-01-01T10:00:30.000Z",
  odds: 2.5, modelId: model.id, selections: [frozenSelection()],
});
const manualBet = () => {
  const bet = frozenBet();
  delete bet.modelId;
  delete bet.selections[0].rule;
  Object.assign(bet.selections[0], {
    marketName: "1X2", settlementMode: "MANUAL", pricingMethod: "OPERATOR",
    terms: "Operator declares the award, not the match score.",
  });
  return bet;
};

test("frozen selections retain typed manual identity even when a label resembles a legacy product", () => {
  const snapshot = parseMarketBet(manualBet());
  assert.equal(snapshot.selections[0].settlementMode, "MANUAL");
  assert.equal(snapshot.selections[0].marketName, "1X2");
  assert.equal(snapshot.selections[0].templateVersion, 2);
  assert.equal(snapshot.selections[0].quoteRevision, 3);
  assert.deepEqual(parseMarketBet(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test("Builder manifests canonicalize selection order, reject duplicates and exclude manual or overridden prices", () => {
  const bet = { ...frozenBet(), kind: "BUILDER", selections: [frozenSelection("b"), frozenSelection("a")] };
  assert.deepEqual(parseMarketBet(bet), parseMarketBet({ ...bet, selections: [...bet.selections].reverse() }));
  assert.equal(bet.selections[0].marketId, "b");
  assert.throws(() => parseMarketBet({ ...bet, selections: [frozenSelection(), frozenSelection()] }), /twice/);
  assert.throws(() => parseMarketBet({ ...bet, selections: [manualBet().selections[0], frozenSelection("b")] }), /cannot enter/);
  assert.throws(() => parseMarketBet({
    ...bet, selections: [{ ...frozenSelection(), pricingMethod: "OPERATOR" }, frozenSelection("b")],
  }), /cannot enter/);
  assert.throws(() => parseMarketBet({ ...bet, selections: [frozenSelection()] }), /2-10/);
  assert.throws(() => parseMarketBet({ ...bet, selections: Array.from({ length: 11 }, (_, i) => frozenSelection(`m${i}`)) }), /2-10/);
});

test("market quotes require exact model identity, finite canonical odds and bounded immutable validity", () => {
  const bet = frozenBet();
  assert.throws(() => parseMarketBet({ ...bet, modelId: undefined }), /model identity/);
  assert.throws(() => parseMarketBet({ ...bet, modelId: "not a model" }), /model identity/);
  assert.throws(() => parseMarketBet({ ...manualBet(), modelId: model.id }), /model identity/);
  for (const odds of [NaN, Infinity, 1, 1001, 2.555]) {
    assert.throws(() => parseMarketBet({ ...bet, odds }), MarketValidationError);
  }
  assert.throws(() => parseMarketBet({ ...bet, expiresAt: "2026-01-01T10:00:31.000Z" }), /validity/);
  assert.throws(() => parseMarketBet({ ...bet, expiresAt: bet.issuedAt }), /validity/);
  assert.throws(() => parseMarketBet({ ...bet, schemaVersion: 99 }), /Unsupported/);
  assert.doesNotThrow(() => parseMarketBet(bet));
});

test("same-event bypass is blocked in either row order while legacy slips and different-event accumulators stay valid", () => {
  const custom = { eventId: "event-a", marketBet: manualBet() };
  const legacy = { eventId: "event-a" };
  assert.throws(() => assertMarketSlipCompatibility([custom, legacy]), /other matches/);
  assert.throws(() => assertMarketSlipCompatibility([legacy, custom]), /other matches/);
  assert.doesNotThrow(() => assertMarketSlipCompatibility([legacy, legacy]));
  assert.doesNotThrow(() => assertMarketSlipCompatibility([custom, { eventId: "event-b" }]));
  assert.throws(() => assertMarketSlipCompatibility([{ eventId: "event-b", marketBet: frozenBet() }]), /does not match/);
  assert.throws(() => assertMarketSlipCompatibility([{ eventId: "event-a", marketBet: null }]), /Market bet/);
});

test("manual settlement validates declared outcome semantics and exact revision-bound decision data", () => {
  const definition = manualDefinition();
  assert.deepEqual(validateManualWinningOutcomes(definition, "SETTLED", ["a"]), ["a"]);
  assert.throws(() => validateManualWinningOutcomes(definition, "SETTLED", ["a", "b"]), /semantics/);
  assert.throws(() => validateManualWinningOutcomes(definition, "SETTLED", []), /semantics/);
  assert.throws(() => validateManualWinningOutcomes(definition, "SETTLED", ["invented"]), /declared/);
  assert.throws(() => validateManualWinningOutcomes(definition, "VOID", ["a"]), /cannot declare/);
  assert.deepEqual(validateManualWinningOutcomes({ ...definition, coverage: "PARTIAL" }, "SETTLED", []), []);
  assert.deepEqual(validateManualWinningOutcomes({ ...definition, outcomeMode: "INDEPENDENT" }, "SETTLED", ["b", "a"]), ["a", "b"]);
  assert.throws(() => validateManualWinningOutcomes(totalDefinition(), "VOID", []), /final scores/);
  const decision = {
    schemaVersion: 1, decisionId: "decision-a", eventId: "event-a", marketId: "market-a",
    rulesRevision: 1, reviewedRevision: 3, decidedAt: "2026-01-01T12:00:00.000Z",
    result: "SETTLED", winningOutcomeKeys: ["a"],
  };
  assert.deepEqual(parseManualMarketDecision(decision, definition), decision);
  assert.throws(() => parseManualMarketDecision({ ...decision, reviewedRevision: 0 }, definition), /positive safe integer/);
});

test("a single partial outcome needs positive unlisted probability rather than certain generated odds", () => {
  const definition = { ...manualDefinition(), coverage: "PARTIAL", outcomes: [{ key: "a", label: "A" }] };
  assert.throws(() => generateManualMarketOdds(definition, { method: "WEIGHTS", values: { a: 1 }, unlistedWeight: 0 }), /certain/);
  assert.equal(generateManualMarketOdds(definition, { method: "EQUAL_CHANCE" }).odds.a, 1.87);
  assert.throws(() => generateManualMarketOdds({
    ...manualDefinition(), outcomeMode: "INDEPENDENT",
  }, { method: "PROBABILITIES", values: { a: 0.1, b: 0.2 } }), /coverage/);
});

test("a completed match never substitutes a score for an awaited manual decision", () => {
  const quote = manualBet();
  assert.equal(evaluateMarketBetResult(quote, { eventId: "event-a", finalScore: { home: 3, away: 1 } }), null);
  const decision = {
    schemaVersion: 1, decisionId: "decision", eventId: "event-a", marketId: "market-a",
    rulesRevision: 1, reviewedRevision: 3, decidedAt: "2026-01-01T12:00:00.000Z",
    result: "SETTLED", winningOutcomeKeys: ["home"],
  };
  assert.equal(evaluateMarketBetResult(quote, { eventId: "event-a", manualDecision: decision }), "WIN");
  assert.equal(evaluateMarketBetResult(quote, {
    eventId: "event-a", manualDecision: { ...decision, winningOutcomeKeys: [] },
  }), "LOSS");
  assert.throws(() => evaluateMarketBetResult(quote, {
    eventId: "event-a", manualDecision: { ...decision, rulesRevision: 2 },
  }), /frozen market revision/);
});

test("a Builder settles against frozen conditions as a whole and never reprices a partially voided group", () => {
  const bet = { ...frozenBet(), kind: "BUILDER", selections: [
    frozenSelection(), { ...frozenSelection("total"), rule: totalOver(2.5) },
  ] };
  const original = JSON.stringify(bet);
  assert.equal(evaluateMarketBetResult(bet, { eventId: "event-a", finalScore: { home: 2, away: 1 } }), "WIN");
  assert.equal(evaluateMarketBetResult(bet, { eventId: "event-a", finalScore: { home: 1, away: 0 } }), "LOSS");
  assert.equal(evaluateMarketBetResult(bet, { eventId: "event-a" }), null);
  assert.equal(evaluateMarketBetResult(bet, { eventId: "event-a", voidEvent: true }), "VOID");
  assert.throws(() => evaluateMarketBetResult(bet, { eventId: "other-event", voidEvent: true }), /another event/);
  assert.equal(JSON.stringify(bet), original);
});

test("event market configuration preserves template bindings and distinguishes generated input from an override", () => {
  const configuration = {
    schemaVersion: 1, marketId: "market-a", eventId: "event-a", revision: 3, rulesRevision: 1,
    template: {
      id: "template-a", version: 2, definition: totalDefinition(), publishedAt: "2026-01-01T10:00:00.000Z",
    },
    parameters: { line: 2.5 }, availability: "OPEN", pricing: { method: "SCORE_MODEL" },
    configuredAt: "2026-01-01T10:01:00.000Z",
  };
  const parsed = parseEventMarketConfiguration(configuration);
  configuration.template.definition.name = "Changed later";
  assert.equal(parsed.template.definition.name, "Total goals");
  const overridden = parseEventMarketConfiguration({
    ...configuration, pricing: { method: "OPERATOR", odds: { over: 2.3, under: 1.7 }, generatedFrom: { method: "SCORE_MODEL" } },
  });
  assert.equal(overridden.pricing.method, "OPERATOR");
  assert.equal(overridden.pricing.generatedFrom.method, "SCORE_MODEL");
  assert.throws(() => parseEventMarketConfiguration({ ...configuration, rulesRevision: 4 }), /future/);
  assert.throws(() => parseEventMarketConfiguration({ ...configuration, pricing: {
    method: "OPERATOR", odds: { over: 2.3 },
  } }), /finite number/);
  assert.throws(() => parseEventMarketConfiguration({ ...configuration, pricing: {
    method: "SCORE_MODEL", odds: { over: 999, under: 999 },
  } }), /unsupported fields/);
  const manual = { ...configuration, parameters: {}, template: { ...configuration.template, definition: manualDefinition() } };
  assert.throws(() => parseEventMarketConfiguration(manual), /cannot claim/);
  const assumed = parseEventMarketConfiguration({ ...manual, pricing: {
    method: "OPERATOR", odds: { a: 2.5, b: 1.5 },
    generatedFrom: { method: "WEIGHTS", values: { a: 1, b: 2 } },
  } });
  assert.deepEqual(assumed.pricing.generatedFrom, { method: "WEIGHTS", values: { a: 1, b: 2 } });
  assert.equal(assumed.pricing.method, "OPERATOR");
});
