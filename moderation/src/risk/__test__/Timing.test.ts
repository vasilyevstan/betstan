import { catalogue, defaults, parseRule } from "../Policy";
import { timingFailures } from "../Timing";

const now = new Date("2026-11-15T12:00:00.000Z");
const at = (delta: number) => new Date(now.getTime() + delta).toISOString();
const rule = (type: string, limit: number) => parseRule({
  id: `test:${type}`, type, enabled: true, scope: {}, parameters: { limit },
});
const row = { id: "exact-row", eventId: "event", betKind: "PRE_MATCH" };
const quote = { ...row, marketBet: { issuedAt: at(-1000), expiresAt: at(5000) } };

it.each(["PRE_KICKOFF_CUTOFF_MS", "MAX_QUOTE_AGE_MS", "MAX_NET_WIN"])("%s has explicit disabled defaults and bounded integer parameters", type => {
  const entry = catalogue().find(item => item.type === type)!;
  const factory = defaults().find(item => item.type === type)!;
  expect(entry).toMatchObject({ locked: false, defaultEnabled: false, defaultScope: {} });
  expect(factory).toMatchObject({ id: `default:${type}`, enabled: false, parameters: entry.defaultParameters });
  expect(() => rule(type, -1)).toThrow();
  expect(() => rule(type, 0.1)).toThrow();
  const parameter = entry.parameterDefinitions.find(item => item.name === "limit")!;
  expect(parameter).toMatchObject({ type: "number", required: true, unit: type === "MAX_NET_WIN" ? "minor units" : "milliseconds" });
  expect(() => rule(type, 2592000000001)).toThrow();
});

it.each([-1, 0, 1])("cutoff uses authoritative kickoff with an exclusive closing boundary (%i ms)", offset => {
  const evaluated = new Date(now.getTime() + offset);
  const result = timingFailures([rule("PRE_KICKOFF_CUTOFF_MS", 1000)], { rows: [row] }, evaluated, { kickoffs: { event: at(1000) } });
  expect(result).toEqual(offset < 0 ? [] : [{ rowId: row.id, reason: "RISK_PRE_KICKOFF_CUTOFF_MS" }]);
});

it("does not apply the prematch cutoff to live or substitute placement/envelope time", () => {
  const rules = [rule("PRE_KICKOFF_CUTOFF_MS", 1000)];
  expect(timingFailures(rules, { rows: [{ ...row, betKind: "LIVE" }] }, now, { kickoffs: {} })).toEqual([]);
  expect(timingFailures(rules, { timestamp: at(999999), rows: [{ ...row, eventTime: at(999999), timestamp: at(999999) }] }, now, { kickoffs: {} }))
    .toEqual([{ rowId: row.id, reason: "RISK_EVIDENCE_UNAVAILABLE" }]);
});

it.each([-1, 0, 1])("quote age permits the exact maximum, not a later decision (%i ms)", offset => {
  const result = timingFailures([rule("MAX_QUOTE_AGE_MS", 1000)], { rows: [quote] }, new Date(now.getTime() + offset), { kickoffs: {} });
  expect(result).toEqual(offset <= 0 ? [] : [{ rowId: row.id, reason: "RISK_MAX_QUOTE_AGE_MS" }]);
});

it("cannot renew expiry with a relaxed age limit or infer issue time from legacy evidence", () => {
  const rules = [rule("MAX_QUOTE_AGE_MS", 30000)];
  expect(timingFailures(rules, { rows: [quote] }, new Date(at(5000)), { kickoffs: {} }))
    .toEqual([{ rowId: row.id, reason: "RISK_STALE_QUOTE" }]);
  expect(timingFailures(rules, { rows: [{ ...row, selectedAt: at(0), timestamp: at(0), quoteValidUntil: at(30000) }] }, now, { kickoffs: {} }))
    .toEqual([{ rowId: row.id, reason: "RISK_EVIDENCE_UNAVAILABLE" }]);
  expect(timingFailures(rules, { rows: [{ ...quote, marketBet: { issuedAt: at(1), expiresAt: at(30000) } }] }, now, { kickoffs: {} }))
    .toEqual([{ rowId: row.id, reason: "RISK_EVIDENCE_UNAVAILABLE" }]);
});

it("disabled timing controls require no new evidence and every matching restriction applies", () => {
  const loose = rule("MAX_QUOTE_AGE_MS", 5000);
  const strict = rule("MAX_QUOTE_AGE_MS", 999);
  expect(timingFailures([{ ...strict, enabled: false }], { rows: [row] }, now, { kickoffs: {} })).toEqual([]);
  expect(timingFailures([loose, strict], { rows: [{ ...quote, id: "first" }, { ...quote, id: "second" }] }, now, { kickoffs: {} }))
    .toEqual([{ rowId: "first", reason: "RISK_MAX_QUOTE_AGE_MS" }, { rowId: "second", reason: "RISK_MAX_QUOTE_AGE_MS" }]);
});
