import { Facts, fingerprint, matches, Policy, Rule, windowStart } from "./Policy";
import { fixedOddsReturnMinor, ModerationDecisionReasonCode, nominalStakeMinor, realisedLossMinor } from "@betstan/common";
import { ruleReason } from "./Decision";

const ZERO = BigInt(0);
const ONE = BigInt(1);
const HUNDRED = BigInt(100);
export interface Fraction { numerator: bigint; denominator: bigint }
// Convert the exact decimal representation, including exponents; never round an
// unsupported stake to cents. Unsupported precision only blocks enabled controls
// which need it, not otherwise valid legacy placements.
export function decimal(value: number): Fraction | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const [mantissa, exponent = "0"] = String(value).toLowerCase().split("e");
  const [whole, part = ""] = mantissa.split(".");
  const scale = part.length - Number(exponent);
  if (Math.abs(scale) > 324) return undefined;
  return scale >= 0
    ? { numerator: BigInt(whole + part), denominator: BigInt(10) ** BigInt(scale) }
    : { numerator: BigInt(whole + part) * BigInt(10) ** BigInt(-scale), denominator: ONE };
}
export function exactMinor(value: number): number | undefined {
  try { return nominalStakeMinor(value); } catch { return undefined; }
}
export function price(rows: any[]): Fraction | undefined {
  let result: Fraction = { numerator: ONE, denominator: ONE };
  for (const row of rows) {
    const odds = decimal(row.oddsValue);
    if (!odds || odds.numerator < odds.denominator) return undefined;
    result = { numerator: result.numerator * odds.numerator, denominator: result.denominator * odds.denominator };
    if (result.numerator.toString().length > 4096 || result.denominator.toString().length > 4096) return undefined;
  }
  return result;
}
export function money(data: any) {
  const stakeMinor = exactMinor(data.wager);
  const odds = price(data.rows);
  if (stakeMinor === undefined || !odds) return { moneyReady: false };
  try {
    const upper = fixedOddsReturnMinor(stakeMinor, data.rows.map((row: any) => String(row.oddsValue)));
    return { moneyReady: true, stakeMinor, remainingStakeMinor: stakeMinor, returnMinor: upper };
  } catch { return { moneyReady: false }; }
}
export function facts(data: any): Facts {
  const rows: any[] = data.rows;
  const unique = (values: string[]) => [...new Set(values.filter(v => typeof v === "string"))].sort();
  return {
    betKind: data.betKind ?? "PRE_MATCH",
    structure: rows.length === 1 ? rows[0].marketBet?.kind === "BUILDER" ? "BUILDER" : "SINGLE" : "ACCUMULATOR",
    eventIds: unique(rows.map(r => r.eventId)), productIds: unique(rows.map(r => r.productId)),
    marketIds: unique(rows.flatMap(r => [r.marketId, ...(r.marketBet?.selections ?? []).map((s: any) => s.marketId)])),
    templateIds: unique(rows.flatMap(r => (r.marketBet?.selections ?? []).map((s: any) => s.templateId))),
  };
}
export function selectionFingerprint(data: any): string {
  return fingerprint(data.rows.map((r: any) => ({
    eventId: r.eventId, productId: r.productId, marketId: r.marketId, marketVersion: r.marketVersion,
    selectionId: r.selectionId ?? r.oddsId,
    selections: r.marketBet?.selections?.map((s: any) => ({ marketId: s.marketId, rulesRevision: s.rulesRevision, outcomeKey: s.outcomeKey }))
      .sort((a: any, b: any) => fingerprint(a).localeCompare(fingerprint(b))),
  })).sort((a: any, b: any) => fingerprint(a).localeCompare(fingerprint(b))));
}
export function matching(policy: Policy, data: any): Rule[] {
  const values = facts(data);
  // A Builder combined with other selections is still a Builder ticket for
  // admission, so adding a leg cannot avoid a Builder-scoped rule. The stored
  // scope facts keep their contract shape (ACCUMULATOR) for history totals.
  const builder = data.rows.some((r: any) => r.marketBet?.kind === "BUILDER") ? { ...values, structure: "BUILDER" } : undefined;
  return policy.rules.filter(r => r.enabled && (matches(r.scope, values)
    || (builder !== undefined && r.scope.structure === "BUILDER" && matches(r.scope, builder))));
}
export function staticReason(rules: Rule[], data: any): ModerationDecisionReasonCode | undefined {
  if (!Number.isFinite(data.wager) || data.wager <= 0 || !data.rows.length
    || data.rows.some((r: any) => !Number.isFinite(r.oddsValue) || r.oddsValue < 1)) return "INPUT_INTEGRITY";
  const stake = decimal(data.wager)!;
  const odds = price(data.rows);
  const values = facts(data);
  for (const rule of rules) {
    const limit = rule.parameters.limit!;
    let exceeds = false;
    switch (rule.type) {
      case "DENY": exceeds = true; break;
      case "MIN_STAKE": exceeds = stake.numerator * HUNDRED < BigInt(limit) * stake.denominator; break;
      case "MAX_STAKE": exceeds = stake.numerator * HUNDRED > BigInt(limit) * stake.denominator; break;
      case "MAX_RETURN":
      case "MAX_NET_WIN":
        if (exactMinor(data.wager) === undefined || !odds) return "RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE";
        // Nominal settlement floors once after the exact product. This is the
        // authoritative payout rule, not rounding a submitted stake into cents.
        try {
          const payout = fixedOddsReturnMinor(exactMinor(data.wager)!, data.rows.map((row: any) => String(row.oddsValue)));
          exceeds = (rule.type === "MAX_NET_WIN" ? Math.max(0, payout - exactMinor(data.wager)!) : payout) > limit;
        }
        catch { return "RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE"; }
        break;
      case "MIN_ODDS":
      case "MAX_ODDS": {
        const bound = decimal(limit)!;
        exceeds = !odds || (rule.type === "MIN_ODDS"
          ? odds.numerator * bound.denominator < bound.numerator * odds.denominator
          : odds.numerator * bound.denominator > bound.numerator * odds.denominator);
        break;
      }
      case "MAX_LEGS": exceeds = data.rows.length > limit; break;
      case "MAX_EVENTS": exceeds = values.eventIds.length > limit; break;
      case "MAX_BUILDER_SELECTIONS":
        exceeds = data.rows.some((r: any) => r.marketBet?.kind === "BUILDER" && r.marketBet.selections.length > limit); break;
    }
    if (exceeds) return ruleReason[rule.type];
  }
  return undefined;
}

export interface Position {
  _id: string; userId: string; facts: Facts; receivedAt: string; selectionFingerprint: string;
  state: string; reserved: boolean; moneyReady: boolean; stakeMinor?: number;
  remainingStakeMinor?: number; returnMinor?: number;
  receiptSequence?: number;
}
/** Query only the union of applicable books/windows; historical closed receipts
 * remain readable without eventually making every enabled rule hit a lifetime
 * scan limit. Scope clauses are composed, never spread over another $or.
 */
export function positionFilter(rules: Rule[], candidate: Position, now: Date): Record<string, unknown> {
  const filters = rules.filter(r => ["MAX_SUBMISSIONS", "MAX_TURNOVER", "REPEAT_BET_COOLDOWN_MS", "MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"].includes(r.type)).map(rule => {
    const clauses: Record<string, unknown>[] = Object.entries(rule.scope).map(([field, value]) => ({
      [`facts.${field}`]: Array.isArray(value) ? { $in: value } : value,
    }));
    if (rule.parameters.perCustomer || rule.type === "MAX_CUSTOMER_LOSS") clauses.push({ userId: candidate.userId });
    if (rule.type === "MAX_SUBMISSIONS" || rule.type === "MAX_TURNOVER") {
      clauses.push({ receivedAt: { $gte: windowStart(rule.parameters.window!, now).toISOString(), $lte: now.toISOString() } });
    } else if (rule.type === "REPEAT_BET_COOLDOWN_MS") {
      clauses.push({ receivedAt: { $gt: new Date(now.getTime() - rule.parameters.limit!).toISOString(), $lte: now.toISOString() },
        selectionFingerprint: candidate.selectionFingerprint });
    }
    if (!["MAX_SUBMISSIONS", "REPEAT_BET_COOLDOWN_MS"].includes(rule.type)) clauses.push({ reserved: true, state: { $ne: "DECLINED" } });
    if (["MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"].includes(rule.type)) clauses.push({ remainingStakeMinor: { $ne: 0 } });
    return { $and: clauses.length ? clauses : [{}] };
  });
  return filters.length ? { $or: filters } : { _id: { $in: [] } };
}
export function ledgerReason(rules: Rule[], candidate: Position, positions: Position[], now: Date,
  realised: Array<{ slipId?: string; facts?: Facts; userId: string; occurredAt: string; closedStakeMinor: number; returnMinor: number }> = []): ModerationDecisionReasonCode | undefined {
  for (const rule of rules) {
    if (!["MAX_SUBMISSIONS", "MAX_TURNOVER", "REPEAT_BET_COOLDOWN_MS", "MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"].includes(rule.type)) continue;
    const start = rule.parameters.window ? windowStart(rule.parameters.window, now).toISOString() : undefined;
    const inWindow = (time: string) => (!start || time >= start) && time <= now.toISOString();
    const perCustomer = rule.parameters.perCustomer || rule.type === "MAX_CUSTOMER_LOSS";
    const scoped = positions.filter(p => p._id !== candidate._id && matches(rule.scope, p.facts) && (!perCustomer || p.userId === candidate.userId));
    const peers = scoped.filter(p => p.reserved && p.state !== "DECLINED");
    let sum = ZERO;
    let incomplete = false;
    const add = (value: number | undefined) => {
      if (value === undefined || !Number.isSafeInteger(value)) incomplete = true;
      else sum += BigInt(value);
    };
    const earlier = (p: Position) => p.receiptSequence === undefined || candidate.receiptSequence === undefined || p.receiptSequence < candidate.receiptSequence;
    if (rule.type === "MAX_SUBMISSIONS") sum = BigInt(scoped.filter(p => earlier(p) && inWindow(p.receivedAt)).length + (inWindow(candidate.receivedAt) ? 1 : 0));
    else if (rule.type === "REPEAT_BET_COOLDOWN_MS") {
      if (scoped.some(p => earlier(p) && p.selectionFingerprint === candidate.selectionFingerprint
        && Date.parse(p.receivedAt) > now.getTime() - rule.parameters.limit!
        && Date.parse(p.receivedAt) <= now.getTime())) return ruleReason[rule.type];
      continue;
    } else if (rule.type === "MAX_TURNOVER") {
      peers.filter(p => inWindow(p.receivedAt)).forEach(p => add(p.stakeMinor));
      if (inWindow(candidate.receivedAt)) add(candidate.stakeMinor);
    } else if (rule.type === "MAX_CUSTOMER_LOSS") {
      // Credits are historical domain-time facts, not their delivery times.
      realised.filter(m => m.userId === candidate.userId && inWindow(m.occurredAt)).forEach(m => {
        if (Object.keys(rule.scope).length > 0) {
          const sourceFacts = m.facts ?? positions.find(p => p._id === m.slipId)?.facts;
          if (!sourceFacts) { incomplete = true; return; }
          if (!matches(rule.scope, sourceFacts)) return;
        }
        try { sum += realisedLossMinor(m.closedStakeMinor, m.returnMinor); }
        catch { incomplete = true; }
      });
      peers.forEach(p => add(p.remainingStakeMinor)); add(candidate.stakeMinor);
      if (sum < ZERO) sum = ZERO;
    } else if (rule.type === "MAX_OPEN_STAKE") {
      peers.forEach(p => add(p.remainingStakeMinor)); add(candidate.stakeMinor);
    } else if (rule.type === "MAX_OPEN_RETURN") {
      // Partial closures retain the full standalone return bound until fully closed.
      peers.filter(p => p.remainingStakeMinor !== 0).forEach(p => add(p.returnMinor)); add(candidate.returnMinor);
    } else {
      // No outcome-domain authority exists here yet. Never infer a common domain
      // from event names or opposing sides: sum standalone upper bounds.
      peers.filter(p => p.remainingStakeMinor !== 0).forEach(p => {
        if (p.returnMinor === undefined || p.stakeMinor === undefined || p.remainingStakeMinor === undefined) incomplete = true;
        else add(Math.max(0, p.returnMinor - p.stakeMinor) + (p.state === "PENDING" ? p.remainingStakeMinor : 0));
      });
      if (candidate.returnMinor === undefined || candidate.stakeMinor === undefined) incomplete = true;
      else add(Math.max(0, candidate.returnMinor - candidate.stakeMinor) + (candidate.state === "PENDING" ? candidate.stakeMinor : 0));
    }
    if (incomplete) return "RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE";
    if (sum > BigInt(rule.parameters.limit!)) return ruleReason[rule.type];
  }
  return undefined;
}
