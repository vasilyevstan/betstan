import {
  ISettleSlipEvent, ICashBackOutcomeEvent, BetAccountingEvidence,
  IModerationResultEvent, ModerationDecisionMetadata, ModerationDecisionReasonCode,
  ModerationDeclineReason,
} from "../../build";
import {
  ISettleSlipEvent as OldSettle, ICashBackOutcomeEvent as OldOutcome,
  IModerationResultEvent as OldModeration,
} from "predecessor-common";

const old: OldSettle = { data: { slipId: "ticket", result: "WIN" } };
const next: ISettleSlipEvent = old;
const evidence: BetAccountingEvidence = { schemaVersion: 1, status: "UNAVAILABLE", reason: "HISTORY_MISSING" };
const additive: ISettleSlipEvent = { data: { ...next.data, accounting: evidence } };
const rolling: OldSettle = additive;
function outcomes(oldOutcome: OldOutcome, newOutcome: ICashBackOutcomeEvent) {
  const newReader: ICashBackOutcomeEvent = oldOutcome;
  const oldReader: OldOutcome = newOutcome;
  return [newReader, oldReader, rolling];
}
void outcomes;

const oldModeration: OldModeration = { data: { slipId: "ticket", result: "APPROVED" } };
const compatibleModeration: IModerationResultEvent = oldModeration;
const decision: IModerationResultEvent["data"] & ModerationDecisionMetadata = {
  ...compatibleModeration.data,
  result: "DECLINED",
  declineReason: ModerationDeclineReason.RISK_POLICY,
  decisionId: "moderation:ticket",
  occurredAt: "2026-01-01T00:00:00.000Z",
  policyRevision: 1,
  placementFingerprint: "a".repeat(64),
  reasonCodes: ["RISK_MAX_STAKE"],
};
const supportedReason: ModerationDecisionReasonCode = "RISK_CURRENT_SOURCE_UNSAFE";
// @ts-expect-error Unknown reason values are not a compatible risk contract.
const unsupportedReason: ModerationDecisionReasonCode = "UNREVIEWED_POLICY_REASON";
void [decision, supportedReason, unsupportedReason];
