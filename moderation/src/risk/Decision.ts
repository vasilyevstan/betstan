import {
  BetKind, IModerationAffectedRow, ModerationDecisionMetadata,
  ModerationDecisionReasonCode, ModerationDeclineReason, ModerationStatus,
} from "@betstan/common";
import { RiskError, RuleType } from "./Policy";
import type { TimingEvidence } from "./Timing";

export interface ModerationDecision {
  status: ModerationStatus;
  betKind?: BetKind;
  declineReason?: ModerationDeclineReason;
  affectedRows: IModerationAffectedRow[];
  moderationTimestamp: string;
  riskReason?: ModerationDecisionReasonCode;
  timingEvidence?: TimingEvidence;
}
export const ruleReason: Record<RuleType, ModerationDecisionReasonCode> = {
  MIN_STAKE: "RISK_MIN_STAKE", MAX_STAKE: "RISK_MAX_STAKE", DELAY_MS: ModerationDeclineReason.RISK_POLICY,
  MIN_ODDS: "RISK_MIN_ODDS", MAX_ODDS: "RISK_MAX_ODDS", MAX_RETURN: "RISK_MAX_RETURN",
  MAX_LEGS: "RISK_MAX_LEGS", MAX_EVENTS: "RISK_MAX_EVENTS", MAX_BUILDER_SELECTIONS: "RISK_MAX_BUILDER_SELECTIONS",
  DENY: "RISK_DENY", MAX_SUBMISSIONS: "RISK_MAX_SUBMISSIONS", MAX_TURNOVER: "RISK_MAX_TURNOVER",
  MAX_OPEN_STAKE: "RISK_MAX_OPEN_STAKE", MAX_OPEN_RETURN: "RISK_MAX_OPEN_RETURN",
  MAX_OPERATOR_EXPOSURE: "RISK_MAX_OPERATOR_EXPOSURE", MAX_CUSTOMER_LOSS: "RISK_MAX_CUSTOMER_LOSS",
  REPEAT_BET_COOLDOWN_MS: "RISK_REPEAT_BET_COOLDOWN_MS",
  PRE_KICKOFF_CUTOFF_MS: "RISK_PRE_KICKOFF_CUTOFF_MS",
  MAX_QUOTE_AGE_MS: "RISK_MAX_QUOTE_AGE_MS", MAX_NET_WIN: "RISK_MAX_NET_WIN",
};
const reasonCodes: readonly ModerationDecisionReasonCode[] = [
  ...Object.values(ModerationDeclineReason), ...Object.values(ruleReason), "INPUT_INTEGRITY",
  "RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE", "RISK_EVIDENCE_CAPACITY_UNAVAILABLE", "RISK_EVIDENCE_UNAVAILABLE",
  "RISK_EVENT_RESULTED", "RISK_STALE_QUOTE", "RISK_EVENT_STARTED", "RISK_CURRENT_SOURCE_UNSAFE",
];
export function parseDecisionReason(value: unknown): ModerationDecisionReasonCode {
  const code = reasonCodes.find(code => code === value);
  if (!code) throw new RiskError("DECISION_EVIDENCE_UNAVAILABLE", "Unknown stored decision reason", 503);
  return code;
}
export function declineForRisk(code: ModerationDecisionReasonCode): ModerationDeclineReason {
  switch (code) {
    case "INPUT_INTEGRITY": return ModerationDeclineReason.INVALID_SELECTION;
    case "RISK_EVENT_RESULTED": return ModerationDeclineReason.EVENT_RESULTED;
    case "RISK_EVENT_STARTED": return ModerationDeclineReason.EVENT_STARTED;
    case "RISK_STALE_QUOTE": return ModerationDeclineReason.STALE_QUOTE;
    case "RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE":
    case "RISK_EVIDENCE_CAPACITY_UNAVAILABLE":
    case "RISK_EVIDENCE_UNAVAILABLE": return ModerationDeclineReason.RISK_EVIDENCE_UNAVAILABLE;
    default: return ModerationDeclineReason.RISK_POLICY;
  }
}
export function decisionMetadata(bet: {
  slipId: string; decisionId?: string; moderationTimestamp: string;
  riskPolicyRevision?: number; placementFingerprint?: string; riskReason?: unknown;
  declineReason?: ModerationDeclineReason;
}): ModerationDecisionMetadata {
  const revision = bet.riskPolicyRevision;
  const hash = bet.placementFingerprint;
  if (bet.decisionId !== `moderation:${bet.slipId}` || revision === undefined || !Number.isSafeInteger(revision) || revision < 1
    || !hash || !/^[a-f0-9]{64}$/.test(hash) || !Number.isFinite(Date.parse(bet.moderationTimestamp))
    || new Date(bet.moderationTimestamp).toISOString() !== bet.moderationTimestamp) {
    throw new RiskError("DECISION_EVIDENCE_UNAVAILABLE", "Stored risk decision metadata is incomplete", 503);
  }
  return {
    decisionId: bet.decisionId, occurredAt: bet.moderationTimestamp, policyRevision: revision,
    placementFingerprint: hash,
    reasonCodes: bet.riskReason ? [parseDecisionReason(bet.riskReason)] : bet.declineReason ? [bet.declineReason] : [],
  };
}
