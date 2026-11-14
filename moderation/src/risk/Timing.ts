import type { ModerationDecisionReasonCode } from "@betstan/common";
import { Rule } from "./Policy";

export interface TimingEvidence {
  /** Read from Event's validated current catalogue, never the placement envelope. */
  kickoffs: Record<string, string>;
}
export interface TimingFailure { rowId: string; reason: ModerationDecisionReasonCode }
const instant = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
};

/** Additional restrictions only. Existing quote validation remains mandatory.
 * Legacy ordinary/live rows have no explicit, authenticated quote issuedAt.
 * Their selectedAt, quote expiry and transport timestamps cannot supply it.
 */
export function timingFailures(rules: Rule[], data: any, now: Date, evidence: TimingEvidence): TimingFailure[] {
  const failures: TimingFailure[] = [];
  for (const row of data.rows) {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      let reason: ModerationDecisionReasonCode | undefined;
      if (rule.type === "PRE_KICKOFF_CUTOFF_MS" && (row.betKind ?? data.betKind ?? "PRE_MATCH") === "PRE_MATCH") {
        const kickoff = instant(evidence.kickoffs[row.eventId]);
        reason = kickoff === undefined || !Number.isFinite(now.getTime()) ? "RISK_EVIDENCE_UNAVAILABLE"
          : now.getTime() >= kickoff - rule.parameters.limit! ? "RISK_PRE_KICKOFF_CUTOFF_MS" : undefined;
      } else if (rule.type === "MAX_QUOTE_AGE_MS") {
        const issued = instant(row.marketBet?.issuedAt);
        const expiry = instant(row.marketBet?.expiresAt);
        reason = issued === undefined || expiry === undefined || expiry <= issued || issued > now.getTime() || !Number.isFinite(now.getTime())
          ? "RISK_EVIDENCE_UNAVAILABLE"
          : now.getTime() >= expiry ? "RISK_STALE_QUOTE"
            : now.getTime() - issued > rule.parameters.limit! ? "RISK_MAX_QUOTE_AGE_MS" : undefined;
      }
      if (reason) { failures.push({ rowId: row.id, reason }); break; }
    }
  }
  return failures;
}
