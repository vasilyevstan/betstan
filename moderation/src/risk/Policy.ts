import { createHash } from "crypto";
import {
  MARKET_QUOTE_MAX_AGE_MS, MAX_BUILDER_SELECTIONS, MAX_MARKET_ODDS, MIN_MARKET_ODDS,
  MAX_MARKET_PLACEMENT_BYTES, MAX_MARKET_OUTCOMES, MAX_MARKET_RULE_NODES, MAX_MARKET_RULE_DEPTH, MAX_MARKET_SCORE,
} from "@betstan/common";

export const TYPES = [
  "MIN_STAKE", "MAX_STAKE", "DELAY_MS", "MIN_ODDS", "MAX_ODDS", "MAX_RETURN",
  "MAX_LEGS", "MAX_EVENTS", "MAX_BUILDER_SELECTIONS", "DENY", "MAX_SUBMISSIONS",
  "MAX_TURNOVER", "MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE",
  "MAX_CUSTOMER_LOSS", "REPEAT_BET_COOLDOWN_MS",
  "PRE_KICKOFF_CUTOFF_MS", "MAX_QUOTE_AGE_MS", "MAX_NET_WIN",
] as const;
export type RuleType = typeof TYPES[number];
export const WINDOWS = ["UTC_DAY", "UTC_WEEK", "UTC_MONTH", "ROLLING_1H", "ROLLING_24H", "ROLLING_7D", "ROLLING_30D"] as const;
export type Window = typeof WINDOWS[number];
export interface Scope {
  betKind?: "PRE_MATCH" | "LIVE";
  structure?: "SINGLE" | "ACCUMULATOR" | "BUILDER";
  eventIds?: string[];
  productIds?: string[];
  marketIds?: string[];
  templateIds?: string[];
  selectionIds?: string[];
}
export interface Rule {
  id: string;
  type: RuleType;
  enabled: boolean;
  scope: Scope;
  parameters: { limit?: number; window?: Window; perCustomer?: boolean };
}
export interface Policy { revision: number; defaultsVersion: 1; rules: Rule[] }
export class RiskError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export const fail = (message: string): never => { throw new RiskError("INVALID_POLICY", message); };
export const object = (value: unknown, keys: readonly string[]): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) return fail("Unknown fields or invalid object");
  return value as Record<string, any>;
};
export const key = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,95}$/.test(value)) return fail("Invalid stable identifier");
  return value;
};
export const canonical = (value: any): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
};
export const fingerprint = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
export const financial = (type: RuleType) => ["MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"].includes(type);
export const windowed = (type: RuleType) => ["MAX_SUBMISSIONS", "MAX_TURNOVER", "MAX_CUSTOMER_LOSS"].includes(type);
const customerOption = (type: RuleType) => ["MAX_SUBMISSIONS", "MAX_TURNOVER", "MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "REPEAT_BET_COOLDOWN_MS"].includes(type);
const monetary = (type: RuleType) => ["MIN_STAKE", "MAX_STAKE", "MAX_RETURN", "MAX_NET_WIN", "MAX_TURNOVER", "MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"].includes(type);
const ranges = (type: RuleType): [number, number, string] => {
  if (type.includes("ODDS")) return [MIN_MARKET_ODDS, MAX_MARKET_ODDS, "decimal odds"];
  if (type === "DELAY_MS") return [0, 300000, "milliseconds"];
  if (type === "PRE_KICKOFF_CUTOFF_MS" || type === "MAX_QUOTE_AGE_MS") return [0, 2592000000, "milliseconds"];
  if (type === "REPEAT_BET_COOLDOWN_MS") return [0, 2592000000, "milliseconds"];
  if (type === "MAX_BUILDER_SELECTIONS") return [2, MAX_BUILDER_SELECTIONS, "selections"];
  if (type === "MAX_LEGS" || type === "MAX_EVENTS") return [1, 1000, "count"];
  return [0, 1000000000000, monetary(type) ? "minor units" : "count"];
};
export const defaultParameters = (type: RuleType): Rule["parameters"] => type === "DENY" ? {} : {
  limit: type === "DELAY_MS" || type === "REPEAT_BET_COOLDOWN_MS" || type === "PRE_KICKOFF_CUTOFF_MS" ? 0
    : type === "MIN_ODDS" ? MIN_MARKET_ODDS : type === "MAX_ODDS" ? MAX_MARKET_ODDS
    : type === "MAX_BUILDER_SELECTIONS" ? MAX_BUILDER_SELECTIONS : type === "MAX_LEGS" || type === "MAX_EVENTS" ? 1000 : 10000,
  ...(windowed(type) ? { window: "UTC_DAY" as Window } : {}),
  ...(customerOption(type) ? { perCustomer: false } : {}),
};
export const defaults = (): Rule[] => TYPES.map(type => ({
  id: `default:${type}`, type, enabled: type === "DELAY_MS", scope: {}, parameters: defaultParameters(type),
}));
export const catalogue = () => [
  ...TYPES.map(type => {
    const [min, max, unit] = ranges(type);
    return {
      type, label: type.toLowerCase().replace(/_/g, " "),
      description: type === "MAX_OPERATOR_EXPOSURE"
        ? "Closure-safe bound; unsupported outcome domains use standalone upper bounds. Exact hedge credit is not admission capacity."
        : type === "PRE_KICKOFF_CUTOFF_MS"
          ? "Close pre-match betting before kickoff by the configured interval. The existing cutoff is kickoff itself (zero offset); live tickets are unaffected."
        : type === "MAX_QUOTE_AGE_MS"
          ? "Maximum age from authenticated quote issue time; never extends expiry. Legacy quotes without issue-time authority are unavailable."
        : type === "MAX_NET_WIN"
          ? "Reject when exact fixed-odds maximum return minus stake exceeds this minor-unit limit. Never reduces payout."
        : type === "MAX_CUSTOMER_LOSS"
          ? "Signed confirmed closed principal minus returns in the window, plus all outstanding and pending principal."
          : "Every matching rule that is on applies to the whole ticket.",
      category: financial(type) ? "accounting" : windowed(type) || type === "REPEAT_BET_COOLDOWN_MS" ? "activity" : "admission",
      defaultParameters: defaultParameters(type),
      defaultEnabled: type === "DELAY_MS", defaultScope: {},
      parameterDefinitions: [
        ...(type === "DENY" ? [] : [{ name: "limit", label: "Limit", type: "number", required: true, min, max, unit }]),
        ...(windowed(type) ? [{ name: "window", label: "Window", type: "select", required: true, options: [...WINDOWS] }] : []),
        ...(customerOption(type) ? [{ name: "perCustomer", label: "Per customer", type: "boolean", required: true }] : []),
      ], locked: false,
    };
  }),
  ...[
    ["IDENTITY_BOARD", "Owner and board", "Authenticated owner, immutable attempt, board revision and fingerprint."],
    ["INPUT_INTEGRITY", "Input integrity", "Positive finite stake, nonempty rows and exact selection identity."],
    ["KIND_SEPARATION", "Separate bet kinds", "No mixed pre-match/live tickets."],
    ["PRE_MATCH_WINDOW", "Pre-match closes at kickoff", "The existing cutoff is kickoff itself: zero offset. Use Pre-match betting cutoff to close earlier; it cannot permit a pre-match bet after kickoff."],
    ["EVENT_RESULT_GATE", "Resulted events reject bets", "Resulted events cannot accept bets. The active Risk Centre also rechecks current live phase and open market state at acceptance. There is no configurable grace period after an event ends."],
    ["QUOTE_AUTHORITY", "Quote authority", `Original consent, unchanged quote integrity and current source safety. Custom quotes expire within ${MARKET_QUOTE_MAX_AGE_MS / 1000}s; accepted custom odds ${MIN_MARKET_ODDS}-${MAX_MARKET_ODDS}, at most 2 decimal places.`],
    ["MARKET_CAPABILITY", "Market compatibility", `Supported settlement and enabled writer capability required. Builder: 2-${MAX_BUILDER_SELECTIONS} selections; manual-settlement selections are ineligible. Same-event compatibility remains locked.`],
    ["RESOURCE_BOUNDS", "Resource limits", `Custom placement payload at most ${MAX_MARKET_PLACEMENT_BYTES / 1024}KiB. Definition: 16 parameters, ${MAX_MARKET_OUTCOMES} outcomes, ${MAX_MARKET_RULE_NODES} rule nodes, depth ${MAX_MARKET_RULE_DEPTH}; scores 0-${MAX_MARKET_SCORE}.`],
    ["WHOLE_TICKET", "Whole-ticket decision", "No adverse-price acceptance, stake reduction or partial approval."],
    ["TERMINAL_DECISION", "Immutable decision", "Immutable receipt and one terminal decision."],
  ].map(([type, label, description]) => ({ type, label, description, category: "integrity", defaultParameters: {}, defaultEnabled: true, defaultScope: {}, parameterDefinitions: [], locked: true })),
  ...[
    ["WALLET_LIMITS_UNAVAILABLE", "Wallet, balance, deposit and withdrawal authority is not available"],
    ["IDENTITY_CONTROLS_UNAVAILABLE", "KYC, AML, self-exclusion, geolocation and multi-account authority is not available"],
    ["UNSUPPORTED_PRODUCTS", "System and banker products are unsupported"],
  ].map(([type, description]) => ({ type, label: description, description, category: "unavailable", defaultParameters: {}, defaultEnabled: false, defaultScope: {}, parameterDefinitions: [], locked: true })),
];

export function parseRule(value: unknown): Rule {
  const r = object(value, ["id", "type", "enabled", "scope", "parameters"]);
  const id = key(r.id);
  if (!TYPES.includes(r.type) || typeof r.enabled !== "boolean") return fail("Unsupported rule type or enabled value");
  const type = r.type as RuleType;
  if (id.startsWith("default:") && id !== `default:${type}`) return fail("Factory identity cannot change type");
  const scope = object(r.scope, ["betKind", "structure", "eventIds", "productIds", "marketIds", "templateIds", "selectionIds"]);
  if (scope.betKind !== undefined && !["PRE_MATCH", "LIVE"].includes(scope.betKind)) return fail("Unsupported bet kind");
  if (scope.structure !== undefined && !["SINGLE", "ACCUMULATOR", "BUILDER"].includes(scope.structure)) return fail("Unsupported structure");
  for (const field of ["eventIds", "productIds", "marketIds", "templateIds", "selectionIds"]) {
    if (scope[field] !== undefined) {
      if (!Array.isArray(scope[field]) || scope[field].length < 1 || scope[field].length > 32) return fail("Scope requires 1-32 identifiers");
      scope[field] = [...new Set(scope[field].map(key))].sort();
    }
  }
  if (scope.selectionIds !== undefined && (type !== "DENY" || scope.eventIds?.length !== 1 || !scope.betKind
    || Object.keys(scope).some(field => !["betKind", "eventIds", "selectionIds"].includes(field))
    || scope.selectionIds.some((id: string) => !/^[a-f0-9]{64}$/.test(id)))) {
    return fail("Choice switches require Block bets, one event, a bet kind and exact selection keys");
  }
  const parameters = object(r.parameters, [
    ...(type === "DENY" ? [] : ["limit"]), ...(windowed(type) ? ["window"] : []), ...(customerOption(type) ? ["perCustomer"] : []),
  ]);
  if (type !== "DENY") {
    const [min, max] = ranges(type);
    if (typeof parameters.limit !== "number" || !Number.isFinite(parameters.limit)
      || parameters.limit < min || parameters.limit > max
      || (!type.includes("ODDS") && !Number.isSafeInteger(parameters.limit))
      || (type.includes("ODDS") && !/^\d+(\.\d{1,2})?$/.test(String(parameters.limit)))) return fail("Limit outside supported range or precision");
  }
  if (windowed(type) && !WINDOWS.includes(parameters.window)) return fail("An explicit supported window is required");
  if (customerOption(type) && typeof parameters.perCustomer !== "boolean") return fail("perCustomer must be boolean");
  return { id, type, enabled: r.enabled, scope, parameters };
}
export function validatePolicy(rules: Rule[]): void {
  if (rules.length > 128 || new Set(rules.map(r => r.id)).size !== rules.length) fail("Too many or duplicate rules");
  if (Buffer.byteLength(canonical(rules)) > 48 * 1024) fail("Policy exceeds 48 KiB");
  for (const floor of rules.filter(r => r.enabled && ["MIN_STAKE", "MIN_ODDS"].includes(r.type))) {
    for (const ceiling of rules.filter(r => r.enabled && r.type === floor.type.replace("MIN", "MAX"))) {
      // A global restriction and an identical scope are statically provable overlaps.
      if ((canonical(floor.scope) === canonical(ceiling.scope) || Object.keys(floor.scope).length === 0 || Object.keys(ceiling.scope).length === 0)
        && floor.parameters.limit! > ceiling.parameters.limit!) fail("Minimum exceeds matching maximum");
    }
  }
}
export interface Facts {
  betKind: string; structure: string; eventIds: string[]; productIds: string[]; marketIds: string[]; templateIds: string[];
}
export function matches(scope: Scope, facts: Facts): boolean {
  // Accounting snapshots deliberately keep their original aggregate Facts shape.
  // Choice restrictions require immutable rows and are matched at admission.
  if (scope.selectionIds) return false;
  return Object.entries(scope).every(([field, value]) => Array.isArray(value)
    ? value.some(id => (facts as any)[field].includes(id)) : (facts as any)[field] === value);
}
export function windowStart(window: Window, now: Date): Date {
  const rolling: Partial<Record<Window, number>> = { ROLLING_1H: 3600000, ROLLING_24H: 86400000, ROLLING_7D: 604800000, ROLLING_30D: 2592000000 };
  if (rolling[window]) return new Date(now.getTime() - rolling[window]!);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (window === "UTC_WEEK") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
  if (window === "UTC_MONTH") start.setUTCDate(1);
  return start;
}
