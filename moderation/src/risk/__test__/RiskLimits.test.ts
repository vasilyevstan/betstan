import { IModerationResultEvent, ModerationDecisionMetadata, ModerationDeclineReason, ModerationStatus } from "@betstan/common";
import { parseRule } from "../Policy";
import { matching, staticReason } from "../Evaluation";
import { decisionMetadata, declineForRisk, ruleReason } from "../Decision";

const rule = (type: string, limit: number) => parseRule({
  id: `test:${type}`, type, enabled: true, scope: {}, parameters: { limit },
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
