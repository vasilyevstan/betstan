import { IModerationResultEvent, ModerationDecisionMetadata, ModerationDeclineReason, ModerationStatus } from "@betstan/common";
import { parseRule, Rule, validatePolicy } from "../Policy";
import { facts, ledgerReason, matching, money, Position, selectionFingerprint, staticReason } from "../Evaluation";
import { decisionMetadata, declineForRisk, ruleReason } from "../Decision";

const rule = (type: string, limit: number, parameters: Rule["parameters"] = {}) => parseRule({
  id: `test:${type}`, type, enabled: true, scope: {}, parameters: { limit, ...parameters },
});
it("uses exact ticket net win, not gross payout or portfolio exposure, and never changes input", () => {
  const data = { wager: 0.51, rows: [{ id: "one", eventId: "event", oddsValue: 1.02 }] };
  const before = JSON.stringify(data);
  expect(staticReason([rule("MAX_NET_WIN", 1)], data)).toBeUndefined(); // floor(51 * 1.02) - 51 = 1
  expect(staticReason([rule("MAX_NET_WIN", 0)], data)).toBe("RISK_MAX_NET_WIN");
  expect(staticReason([rule("MAX_RETURN", 1)], data)).toBe("RISK_MAX_RETURN");
  expect(staticReason([rule("MAX_NET_WIN", 300)], { wager: 1, rows: [{ oddsValue: 2 }, { oddsValue: 2 }] })).toBeUndefined();
  expect(staticReason([rule("MAX_NET_WIN", 299)], { wager: 1, rows: [{ oddsValue: 2 }, { oddsValue: 2 }] })).toBe("RISK_MAX_NET_WIN");
  expect(JSON.stringify(data)).toBe(before);
});
it("fails unavailable exact cents only when the matching net-win control is enabled", () => {
  const data = { wager: 0.001, rows: [{ eventId: "event", oddsValue: 2 }] };
  expect(staticReason([rule("MAX_NET_WIN", 1000)], data)).toBe("RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE");
  const policy = { revision: 1, defaultsVersion: 1 as const, rules: [{ ...rule("MAX_NET_WIN", 1000), enabled: false }] };
  expect(staticReason(matching(policy, data), data)).toBeUndefined();
  policy.rules[0].enabled = true;
  policy.rules[0].scope = { eventIds: ["other-event"] };
  expect(staticReason(matching(policy, data), data)).toBeUndefined();
});
it("adopts canonical reasons and emits all five immutable metadata fields without changing legacy shape", () => {
  const legacy: IModerationResultEvent = { data: { slipId: "ticket", result: ModerationStatus.APPROVED } };
  expect(Object.keys(legacy.data).sort()).toEqual(["result", "slipId"]);
  expect(ModerationDeclineReason.RISK_POLICY).toBe("RISK_POLICY");
  expect(ModerationDeclineReason.RISK_EVIDENCE_UNAVAILABLE).toBe("RISK_EVIDENCE_UNAVAILABLE");
  for (const type of ["PRE_KICKOFF_CUTOFF_MS", "MAX_QUOTE_AGE_MS", "MAX_NET_WIN"] as const) {
    const code = ruleReason[type];
    expect(code).toBe(`RISK_${type}`);
    expect(declineForRisk(code)).toBe(ModerationDeclineReason.RISK_POLICY);
    expect(decisionMetadata({
      slipId: "ticket", decisionId: "moderation:ticket", moderationTimestamp: "2026-11-15T12:00:00.000Z",
      riskPolicyRevision: 7, placementFingerprint: "a".repeat(64), riskReason: code,
    })).toEqual({
      decisionId: "moderation:ticket", occurredAt: "2026-11-15T12:00:00.000Z", policyRevision: 7,
      placementFingerprint: "a".repeat(64), reasonCodes: [code],
    });
  }
  expect(() => decisionMetadata({ slipId: "ticket", moderationTimestamp: "" })).toThrow();
});

it.each([
  ["MIN_STAKE", 100, { wager: 0.99, rows: [{ oddsValue: 2 }] }, { wager: 1, rows: [{ oddsValue: 2 }] }],
  ["MIN_ODDS", 2, { wager: 1, rows: [{ oddsValue: 1.99 }] }, { wager: 1, rows: [{ oddsValue: 2 }] }],
  ["MAX_ODDS", 2, { wager: 1, rows: [{ oddsValue: 2.01 }] }, { wager: 1, rows: [{ oddsValue: 2 }] }],
  ["MAX_LEGS", 1, { wager: 1, rows: [{ oddsValue: 2 }, { oddsValue: 2 }] }, { wager: 1, rows: [{ oddsValue: 2 }] }],
  ["MAX_EVENTS", 1, { wager: 1, rows: [{ oddsValue: 2, eventId: "a" }, { oddsValue: 2, eventId: "b" }] },
    { wager: 1, rows: [{ oddsValue: 2, eventId: "a" }, { oddsValue: 2, eventId: "a" }] }],
  ["MAX_BUILDER_SELECTIONS", 2,
    { wager: 1, rows: [{ oddsValue: 2, marketBet: { kind: "BUILDER", selections: [{}, {}, {}] } }] },
    { wager: 1, rows: [{ oddsValue: 2, marketBet: { kind: "BUILDER", selections: [{}, {}] } }] }],
] as const)("enforces inclusive %s boundaries on the complete ticket", (type, limit, rejected, accepted) => {
  expect(staticReason([rule(type, limit)], accepted)).toBeUndefined();
  expect(staticReason([rule(type, limit)], rejected)).toBe(`RISK_${type}`);
});

it.each([
  { wager: 0, rows: [{ oddsValue: 2 }] },
  { wager: NaN, rows: [{ oddsValue: 2 }] },
  { wager: 1, rows: [] },
  { wager: 1, rows: [{ oddsValue: Infinity }] },
  { wager: 1, rows: [{ oddsValue: 0.99 }] },
])("rejects invalid placement shape before optional rules", data => {
  expect(staticReason([], data)).toBe("INPUT_INTEGRITY");
});

it("does not turn unsupported precision or overflowing returns into monetary capacity", () => {
  expect(staticReason([rule("MIN_STAKE", 1)], { wager: 1e-7, rows: [{ oddsValue: 2 }] })).toBe("RISK_MIN_STAKE");
  expect(staticReason([rule("MAX_STAKE", 100)], { wager: 1e21, rows: [{ oddsValue: 2 }] })).toBe("RISK_MAX_STAKE");
  const oversized = { wager: 1, rows: Array.from({ length: 20 }, () => ({ oddsValue: 1e308 })) };
  expect(staticReason([rule("MAX_RETURN", 100)], oversized)).toBe("RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE");
  expect(money(oversized).moneyReady).toBe(false);
  expect(money({ wager: 1, rows: [{ oddsValue: -1 }] }).moneyReady).toBe(false);
  expect(money({ wager: 1, rows: [{ oddsValue: 1e100 }] }).moneyReady).toBe(false);
});

it("matches Builder scope and repeat identity from selections, independently of row or selection order", () => {
  const selections = [
    { marketId: "market-b", templateId: "template-b", rulesRevision: 1, outcomeKey: "away" },
    { marketId: "market-a", templateId: "template-a", rulesRevision: 1, outcomeKey: "home" },
  ];
  const row = { eventId: "event", productId: "product", marketBet: { kind: "BUILDER", selections } };
  const data = { rows: [row] };
  const scoped = { ...rule("MAX_STAKE", 100), scope: { structure: "BUILDER" as const, templateIds: ["template-a"] } };
  expect(matching({ revision: 1, defaultsVersion: 1, rules: [scoped] }, data)).toEqual([scoped]);
  expect(facts(data)).toMatchObject({ structure: "BUILDER", marketIds: ["market-a", "market-b"] });
  const ordinary = { eventId: "other", oddsId: "selection" };
  expect(selectionFingerprint({ rows: [ordinary, row] })).toBe(selectionFingerprint({
    rows: [{ ...row, marketBet: { ...row.marketBet, selections: [...selections].reverse() } }, ordinary],
  }));
  expect(selectionFingerprint(data)).not.toBe(selectionFingerprint({
    rows: [{ ...row, marketBet: { ...row.marketBet, selections: [{ ...selections[0], rulesRevision: 2 }] } }],
  }));
});

const now = new Date("2026-11-15T12:00:00.000Z");
const candidate: Position = {
  _id: "candidate", userId: "customer", facts: facts({ rows: [{ eventId: "event" }] }),
  receivedAt: now.toISOString(), receiptSequence: 2, selectionFingerprint: "selection",
  state: "PENDING", reserved: true, moneyReady: true, stakeMinor: 100, remainingStakeMinor: 100, returnMinor: 200,
};
const peer = (changes: Partial<Position> = {}): Position => ({
  ...candidate, _id: "peer", receiptSequence: 1, receivedAt: "2026-11-15T11:59:59.001Z", ...changes,
});

it("counts distinct earlier submissions, including declined attempts, without counting future receipts or transport duplicates", () => {
  const count = rule("MAX_SUBMISSIONS", 1, { window: "UTC_DAY", perCustomer: true });
  const ignored = [candidate, peer({ userId: "other" }), peer({ receiptSequence: 3 }),
    peer({ receivedAt: "2026-11-16T00:00:00.000Z" }), peer({ receivedAt: "2026-11-14T23:59:59.999Z" })];
  expect(ledgerReason([count], candidate, ignored, now)).toBeUndefined();
  expect(ledgerReason([count], candidate, [peer({ reserved: false, state: "DECLINED" })], now)).toBe("RISK_MAX_SUBMISSIONS");
  expect(ledgerReason([count], { ...candidate, receivedAt: "2026-11-14T23:59:59.999Z" }, [], now)).toBeUndefined();
});

it("enforces repeat cooldown only on matching earlier submissions inside the exact time boundary", () => {
  const cooldown = rule("REPEAT_BET_COOLDOWN_MS", 1000, { perCustomer: true });
  expect(ledgerReason([cooldown], candidate, [peer()], now)).toBe("RISK_REPEAT_BET_COOLDOWN_MS");
  for (const ignored of [
    peer({ receivedAt: "2026-11-15T11:59:59.000Z" }),
    peer({ receivedAt: "2026-11-15T12:00:00.001Z" }),
    peer({ selectionFingerprint: "different" }), peer({ receiptSequence: 3 }),
  ]) expect(ledgerReason([cooldown], candidate, [ignored], now)).toBeUndefined();
  expect(ledgerReason([rule("REPEAT_BET_COOLDOWN_MS", 0, { perCustomer: false })], candidate, [peer()], now)).toBeUndefined();
});

it.each([
  ["MAX_TURNOVER", { window: "UTC_DAY", perCustomer: false }, { stakeMinor: undefined }],
  ["MAX_OPEN_STAKE", { perCustomer: false }, { remainingStakeMinor: undefined }],
  ["MAX_OPEN_RETURN", { perCustomer: false }, { returnMinor: undefined }],
  ["MAX_OPERATOR_EXPOSURE", { perCustomer: false }, { stakeMinor: undefined }],
] as const)("fails %s closed when a relevant position lacks authoritative money", (type, parameters, missing) => {
  const cap = rule(type, 1000, parameters);
  expect(ledgerReason([cap], candidate, [peer(missing)], now)).toBe("RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE");
  expect(ledgerReason([cap], candidate, [peer({ ...missing, state: "DECLINED" })], now)).toBeUndefined();
});

it("applies scoped realised credits only with matching authoritative position identity", () => {
  const loss: Rule = { ...rule("MAX_CUSTOMER_LOSS", 0, { window: "UTC_DAY" }), scope: { eventIds: ["event"] } };
  const credit = { slipId: "closed", userId: candidate.userId, occurredAt: now.toISOString(), closedStakeMinor: 100, returnMinor: 300 };
  expect(ledgerReason([loss], candidate, [], now, [credit])).toBe("RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE");
  expect(ledgerReason([loss], candidate, [peer({ _id: "closed", remainingStakeMinor: 0 })], now, [credit])).toBeUndefined();
  expect(ledgerReason([loss], candidate, [], now, [{ ...credit, facts: facts({ rows: [{ eventId: "other" }] }) }])).toBe("RISK_MAX_CUSTOMER_LOSS");
  expect(ledgerReason([loss], candidate, [], now, [{ ...credit, facts: candidate.facts, closedStakeMinor: -1 }])).toBe("RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE");
  expect(ledgerReason([loss], candidate, [], now, [{ ...credit, facts: candidate.facts }])).toBeUndefined();
});

it("does not reserve fully closed returns but retains pending operator principal and unknown candidate bounds", () => {
  const cap = rule("MAX_OPEN_RETURN", 200, { perCustomer: false });
  expect(ledgerReason([cap], candidate, [peer({ remainingStakeMinor: 0, returnMinor: undefined })], now)).toBeUndefined();
  const exposure = rule("MAX_OPERATOR_EXPOSURE", 200, { perCustomer: false });
  expect(ledgerReason([exposure], candidate, [peer()], now)).toBe("RISK_MAX_OPERATOR_EXPOSURE");
  expect(ledgerReason([exposure], { ...candidate, state: "ACCEPTED" }, [], now)).toBeUndefined();
  expect(ledgerReason([exposure], { ...candidate, returnMinor: undefined }, [], now)).toBe("RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE");
});

it.each([
  { id: "invalid identifier" },
  { id: "default:MAX_ODDS" },
  { type: "WALLET_LIMITS_UNAVAILABLE" },
  { enabled: "true" },
  { scope: { betKind: "MIXED" } },
  { scope: { structure: "SYSTEM" } },
  { scope: { eventIds: "event" } },
  { scope: { eventIds: [] } },
  { scope: { eventIds: Array.from({ length: 33 }, (_, index) => `event-${index}`) } },
  { parameters: { limit: Infinity } },
  { parameters: { limit: -1 } },
  { parameters: { limit: 1000000000001 } },
])("rejects unsupported policy shapes without coercing their values: %j", invalid => {
  expect(() => parseRule({ ...rule("MAX_STAKE", 100), ...invalid })).toThrow();
});

it("requires explicit activity windows and customer scope, and rejects contradictory overlapping policies", () => {
  expect(() => parseRule({ ...rule("MAX_STAKE", 100), type: "MAX_TURNOVER" })).toThrow("window");
  expect(() => parseRule({ ...rule("MAX_STAKE", 100), type: "MAX_OPEN_STAKE" })).toThrow("perCustomer");
  expect(() => rule("MAX_ODDS", 1.001)).toThrow();
  const floor = { ...rule("MIN_STAKE", 200), scope: { eventIds: ["event"] } };
  const ceiling = { ...rule("MAX_STAKE", 100), scope: { eventIds: ["other"] } };
  expect(() => validatePolicy([floor, ceiling])).not.toThrow();
  expect(() => validatePolicy([floor, { ...ceiling, scope: {} }])).toThrow("Minimum");
  expect(() => validatePolicy([floor, floor])).toThrow("duplicate");
});

it("rejects unknown stored reason codes and retains predecessor decline evidence in complete decision metadata", () => {
  const stored = {
    slipId: "ticket", decisionId: "moderation:ticket", moderationTimestamp: now.toISOString(),
    riskPolicyRevision: 1, placementFingerprint: "a".repeat(64),
  };
  expect(() => decisionMetadata({ ...stored, riskReason: "UNKNOWN_RISK_REASON" })).toThrow("Unknown stored");
  expect(decisionMetadata({ ...stored, declineReason: ModerationDeclineReason.STALE_QUOTE }).reasonCodes).toEqual(["STALE_QUOTE"]);
});

// Compile-only compatibility checks against the actual package declaration.
// New writers are complete; predecessor envelopes remain accepted above.
function decisionWireTypes(metadata: ModerationDecisionMetadata): void {
  // @ts-expect-error reasonCodes must remain immutable
  metadata.reasonCodes.push("RISK_MAX_NET_WIN");
  // @ts-expect-error all five new-writer metadata fields are mandatory
  const incomplete: ModerationDecisionMetadata = { decisionId: "moderation:ticket" };
  // @ts-expect-error arbitrary reason strings must not cross the shared wire
  const unknown: ModerationDecisionMetadata = { ...metadata, reasonCodes: ["UNKNOWN_RISK_REASON"] };
  void incomplete; void unknown;
}
void decisionWireTypes;
