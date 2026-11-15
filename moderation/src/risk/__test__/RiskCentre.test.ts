import { BetKind, ModerationStatus } from "@betstan/common";
import { Bet } from "../../model/Bet";
import { ParkedPlaceBet } from "../../model/ParkedPlaceBet";
import ModerationService from "../../service/ModerationService";
import { createPlaceBetEvent } from "../../event/listener/__test__/helpers";
import { defaults, matches, parseRule, validatePolicy, windowStart } from "../Policy";
import { exactMinor, ledgerReason, money, staticReason } from "../Evaluation";
import { receiveRisk, terminalRisk } from "../Gateway";
import { getHistory, getOperation, getPolicy, initializeRisk, mutatePolicy, RiskAccountingInbox, RiskMovement, RiskPosition, RiskState } from "../Store";
import { applyAccountingInbox, completeEvidence, receiveAccounting, replayAccounting } from "../Accounting";
import { verifyRiskSource } from "../SourceVerifier";
jest.mock("../SourceVerifier", () => ({ verifyRiskSource: jest.fn() }));

beforeEach(async () => {
  process.env.RISK_CENTRE_ENABLED = "true";
  await initializeRisk();
  // Isolated policy/counter fixtures use an established receiver interval.
  // Actual fenced start, unavailable windows and feature-off gaps are exercised
  // by SnapshotImport.test.ts against the real source export.
  await RiskState.updateOne({ _id: "active" }, { $set: { activityCoverage: { tracking: true, since: "2019-01-01T00:00:00.000Z" } } });
  (verifyRiskSource as jest.Mock).mockImplementation(async () => ({
    kickoffAt: new Date(Date.now() + 600000).toISOString(), affectedRows: [],
  }));
});
afterEach(() => { delete process.env.RISK_CENTRE_ENABLED; });

const rule = (type: any, limit = 100, extra: any = {}) => parseRule({
  id: `test:${type}`, type, enabled: true, scope: {},
  parameters: { limit, ...extra },
});
const event = () => {
  const value = createPlaceBetEvent({ data: { betKind: BetKind.PRE_MATCH }, row: {
    eventTime: new Date(Date.now() + 600000).toISOString(),
    betKind: BetKind.PRE_MATCH, oddsValue: 2,
  } });
  return { ...value, data: { ...value.data, betKind: BetKind.PRE_MATCH,
    rows: value.data.rows.map(r => ({ ...r, betKind: BetKind.PRE_MATCH })) } };
};

it("ships zero delay, disabled optional rules, bounded typed predicates and exact money", () => {
  expect(defaults().filter(r => r.enabled).map(r => [r.type, r.parameters.limit])).toEqual([["DELAY_MS", 0]]);
  expect(() => parseRule({ ...rule("MAX_STAKE"), scope: { eval: "true" } })).toThrow();
  expect(() => parseRule({ ...rule("MAX_STAKE"), parameters: { limit: 0.1 } })).toThrow();
  expect(() => validatePolicy([rule("MIN_STAKE", 101), rule("MAX_STAKE", 100)])).toThrow();
  expect(matches({ eventIds: ["one", "two"], betKind: "LIVE" }, {
    betKind: "LIVE", structure: "SINGLE", eventIds: ["two"], productIds: [], marketIds: [], templateIds: [],
  })).toBe(true);
  expect(exactMinor(0.01)).toBe(1);
  expect(exactMinor(0.001)).toBeUndefined();
  expect(money({ wager: 0.001, rows: [{ oddsValue: 2 }] }).moneyReady).toBe(false);
  expect(staticReason([], { wager: 0.001, rows: [{ oddsValue: 2 }] })).toBeUndefined();
  expect(staticReason([rule("MAX_STAKE", 100)], { wager: 1, rows: [{ oddsValue: 2 }] })).toBeUndefined();
  expect(staticReason([rule("MAX_STAKE", 100)], { wager: 1.001, rows: [{ oddsValue: 2 }] })).toBe("RISK_MAX_STAKE");
  expect(staticReason([rule("MAX_RETURN", 51)], { wager: 0.51, rows: [{ oddsValue: 1.01 }] })).toBeUndefined();
  expect(staticReason([rule("MAX_RETURN", 51)], { wager: 0.51, rows: [{ oddsValue: 1.02 }] })).toBe("RISK_MAX_RETURN");
  expect(staticReason([rule("MAX_RETURN", 51)], { wager: 0.001, rows: [{ oddsValue: 2 }] })).toBe("RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE");
  expect(windowStart("UTC_WEEK", new Date("2026-11-15T23:59:59.000Z")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
});

it("commits one revision under parallel Save and replays stable operation results", async () => {
  const request = { expectedRevision: 1, requestId: "save-one", rule: rule("MAX_STAKE") };
  const outcomes = await Promise.allSettled([
    mutatePolicy("CREATE", request),
    mutatePolicy("CREATE", { ...request, requestId: "save-two" }),
  ]);
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const winner = outcomes.find(r => r.status === "fulfilled") as PromiseFulfilledResult<any>;
  const operation = await getOperation(winner.value.requestId);
  expect(await mutatePolicy("CREATE", { ...request, requestId: winner.value.requestId })).toEqual(operation);
  await expect(mutatePolicy("CREATE", { ...request, requestId: winner.value.requestId, rule: rule("MAX_STAKE", 101) })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  expect((await getHistory()).items.map(r => r.revision)).toEqual([2, 1]);
  expect(JSON.stringify(await getPolicy())).not.toContain("userId");
  const loserId = winner.value.requestId === "save-one" ? "save-two" : "save-one";
  await expect(getOperation(loserId)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  await expect(mutatePolicy("CREATE", { ...request, requestId: loserId, expectedRevision: 2 })).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
});

it("pins cutoff policy and rechecks authoritative time in the terminal transaction with exact affected IDs", async () => {
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "cutoff", rule: rule("PRE_KICKOFF_CUTOFF_MS", 300000) });
  const input = event();
  input.data.rows.push({ ...input.data.rows[0], id: "unaffected-row", eventId: "unaffected-event" });
  const receipt = await receiveRisk(input, new Date());
  await mutatePolicy("RESET", { expectedRevision: 2, requestId: "remove-cutoff" });
  const decision = {
    status: ModerationStatus.APPROVED, affectedRows: [], moderationTimestamp: new Date().toISOString(),
    timingEvidence: { kickoffs: {
      [input.data.rows[0].eventId]: new Date(Date.parse(receipt.receivedAt) + 1000).toISOString(),
      "unaffected-event": new Date(Date.parse(receipt.receivedAt) + 600000).toISOString(),
    } },
  };
  const stored = await terminalRisk(input.data.slipId, decision, new Date());
  expect(stored).toMatchObject({ status: ModerationStatus.DECLINED, declineReason: "RISK_POLICY",
    riskReason: "RISK_PRE_KICKOFF_CUTOFF_MS", riskPolicyRevision: 2,
    affectedRows: [{ rowId: input.data.rows[0].id, declineReason: "RISK_POLICY" }], publishedAt: "" });
  expect((await terminalRisk(input.data.slipId, decision, new Date())).moderationTimestamp).toBe(stored.moderationTimestamp);
  expect((await RiskPosition.findById(input.data.slipId).lean() as any).reserved).toBe(false);
});

it("publishes typed whole-ticket net-win declines without reducing wager or payout", async () => {
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "net-win", rule: rule("MAX_NET_WIN", 1) });
  const input = event();
  input.data.wager = 10;
  const publisher = { publishWithConfirm: jest.fn(async (_event: unknown) => undefined) };
  await new ModerationService(publisher).handlePlaceBet(input);
  const stored = await Bet.findOne({ slipId: input.data.slipId }).lean();
  expect(stored).toMatchObject({ wager: 10, status: ModerationStatus.DECLINED, declineReason: "RISK_POLICY", riskReason: "RISK_MAX_NET_WIN" });
  expect(publisher.publishWithConfirm.mock.calls[0][0]).toMatchObject({ data: {
    slipId: input.data.slipId, policyRevision: 2, declineReason: "RISK_POLICY", reasonCodes: ["RISK_MAX_NET_WIN"],
    occurredAt: stored!.moderationTimestamp, decisionId: `moderation:${input.data.slipId}`,
  } });
});

it("requires quote-age authority only for enabled matching controls; legacy selection time does not qualify", async () => {
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "quote-age", rule: rule("MAX_QUOTE_AGE_MS", 10000) });
  const input = event();
  const publisher = { publishWithConfirm: jest.fn(async () => undefined) };
  await new ModerationService(publisher).handlePlaceBet(input);
  expect(await Bet.findOne({ slipId: input.data.slipId }).lean()).toMatchObject({
    status: ModerationStatus.DECLINED, declineReason: "RISK_EVIDENCE_UNAVAILABLE", riskReason: "RISK_EVIDENCE_UNAVAILABLE",
  });
  await mutatePolicy("RESET", { expectedRevision: 2, requestId: "disable-age" });
  const next = event();
  await new ModerationService(publisher).handlePlaceBet(next);
  expect(await Bet.findOne({ slipId: next.data.slipId }).lean()).toMatchObject({ status: ModerationStatus.APPROVED });
});

it("resets configuration without resetting receipts and rejects activation with incomplete financial history", async () => {
  const receipt = event();
  await receiveRisk(receipt, new Date());
  await mutatePolicy("RESET", { expectedRevision: 1, requestId: "reset" });
  expect(await RiskPosition.countDocuments()).toBe(1);
  await expect(mutatePolicy("CREATE", { expectedRevision: 2, requestId: "loss",
    rule: rule("MAX_CUSTOMER_LOSS", 1000, { window: "UTC_DAY" }),
  })).rejects.toMatchObject({ code: "ACCOUNTING_NOT_READY" });
  expect((await getPolicy()).revision).toBe(2);
});

it("pins policy, receipt, immutable principal and fixed due time across replay and feature-off", async () => {
  await mutatePolicy("UPDATE", { expectedRevision: 1, requestId: "delay",
    rule: { ...rule("DELAY_MS", 60000), id: "default:DELAY_MS" },
  }, "default:DELAY_MS");
  const input = event();
  const start = new Date();
  const first = await receiveRisk(input, start);
  await mutatePolicy("RESET", { expectedRevision: 2, requestId: "reset-delay" });
  const replay = await receiveRisk({ ...input, timestamp: new Date(start.getTime() + 1000).toISOString() }, new Date(start.getTime() + 1000));
  expect(replay.receivedAt).toBe(first.receivedAt);
  expect(replay.policy.revision).toBe(2);
  expect(replay.decisionDueAt).toBe(new Date(Date.parse(first.receivedAt) + 60000).toISOString());
  expect(await ParkedPlaceBet.countDocuments()).toBe(1);
  await expect(receiveRisk({ ...input, data: { ...input.data, wager: input.data.wager + 1 } }, start)).rejects.toMatchObject({ code: "PLACEMENT_CONFLICT" });
  delete process.env.RISK_CENTRE_ENABLED;
  const publisher = { publishWithConfirm: jest.fn(async () => undefined) };
  expect(await new ModerationService(publisher).handlePlaceBet(input)).toMatchObject({ type: "park" });
  expect(publisher.publishWithConfirm).not.toHaveBeenCalled();
});

it("contends on persisted scope state for the last turnover allowance, not process-local locks", async () => {
  await mutatePolicy("CREATE", { expectedRevision: 1, requestId: "turnover",
    rule: rule("MAX_TURNOVER", 1000, { window: "UTC_DAY", perCustomer: false }),
  });
  const inputs = [event(), event()];
  inputs.forEach(input => { input.data.wager = 10; });
  await Promise.all(inputs.map(input => receiveRisk(input, new Date())));
  const positions = await RiskPosition.find({}).lean() as any[];
  expect(positions.filter(p => p.reserved)).toHaveLength(1);
  expect(positions.filter(p => p.reason === "RISK_MAX_TURNOVER")).toHaveLength(1);
  const publisher = { publishWithConfirm: jest.fn(async () => undefined) };
  await Promise.all(inputs.map(input => new ModerationService(publisher).handlePlaceBet(input)));
  expect(await Bet.countDocuments({ status: ModerationStatus.APPROVED })).toBe(1);
  expect(await Bet.countDocuments({ status: ModerationStatus.DECLINED })).toBe(1);
  expect((await RiskState.findById("active").lean() as any).serial).toBeGreaterThan(3);
});

it("terminal CAS wins once and recovers confirmation loss without parking records", async () => {
  const input = event();
  const publisher = { publishWithConfirm: jest.fn(async () => { throw new Error("broker unavailable"); }) };
  await expect(new ModerationService(publisher).handlePlaceBet(input)).rejects.toThrow("broker unavailable");
  const first = await Bet.findOne({ slipId: input.data.slipId }).lean();
  await terminalRisk(input.data.slipId, {
    status: ModerationStatus.DECLINED, moderationTimestamp: new Date().toISOString(), affectedRows: [],
  }, new Date());
  expect((await Bet.findOne({ slipId: input.data.slipId }).lean())?.status).toBe(first!.status);
  await ParkedPlaceBet.deleteMany({});
  const recovered = { publishWithConfirm: jest.fn(async () => undefined) };
  await new ModerationService(recovered).recoverDecisionsAndReceipts();
  expect(recovered.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect((await Bet.findOne({ slipId: input.data.slipId }).lean())?.publishedAt).not.toBe("");
});

it("retains conservative pending bounds and expires signed win credits by domain time", () => {
  const now = new Date("2026-11-15T12:00:00.000Z");
  const base: any = { _id: "candidate", userId: "synthetic", facts: { betKind: "PRE_MATCH", structure: "SINGLE", eventIds: [], productIds: [], marketIds: [], templateIds: [] },
    receivedAt: now.toISOString(), selectionFingerprint: "selection", reserved: true, state: "PENDING", moneyReady: true, stakeMinor: 100, remainingStakeMinor: 100, returnMinor: 200 };
  expect(ledgerReason([rule("MAX_OPERATOR_EXPOSURE", 299, { perCustomer: false })], base, [{ ...base, _id: "accepted", state: "ACCEPTED" }], now)).toBe("RISK_MAX_OPERATOR_EXPOSURE");
  const loss = rule("MAX_CUSTOMER_LOSS", 50, { window: "UTC_DAY" });
  expect(ledgerReason([loss], base, [], now, [{ userId: base.userId, occurredAt: "2026-11-15T01:00:00.000Z", closedStakeMinor: 100, returnMinor: 200 }])).toBeUndefined();
  expect(ledgerReason([loss], base, [], now, [{ userId: base.userId, occurredAt: "2026-11-14T23:59:59.000Z", closedStakeMinor: 100, returnMinor: 200 }])).toBe("RISK_MAX_CUSTOMER_LOSS");
});

it("feature-off rejects writes, while missing active policy is never permissive", async () => {
  delete process.env.RISK_CENTRE_ENABLED;
  expect((await getPolicy()).readiness.transactions).toBe("UNAVAILABLE");
  await expect(mutatePolicy("RESET", { expectedRevision: 1, requestId: "off" })).rejects.toMatchObject({ code: "RISK_DISABLED" });
  process.env.RISK_CENTRE_ENABLED = "true";
  await RiskState.deleteMany({});
  await expect(initializeRisk()).rejects.toMatchObject({ code: "POLICY_UNAVAILABLE" });
  await expect(receiveRisk(event(), new Date())).rejects.toMatchObject({ code: "POLICY_UNAVAILABLE" });
});

it("atomically applies a complete reordered partial-close prefix once, with historical signed returns", async () => {
  const input = event();
  input.data.wager = 10;
  const publisher = { publishWithConfirm: jest.fn(async () => undefined) };
  await new ModerationService(publisher).handlePlaceBet(input);
  const position = await RiskPosition.findById(input.data.slipId).lean() as any;
  const first = {
    schemaVersion: 1, movementId: "movement-1", slipId: input.data.slipId, userId: input.data.userId, revision: 1,
    occurredAt: "2026-10-01T01:00:00.000Z", closedStakeMinor: 400, returnMinor: 800,
    remainingStakeMinor: 600, originalStakeMinor: 1000, source: "CASH_BACK", placementFingerprint: position.accountingFingerprint,
  };
  const second = { ...first, movementId: "movement-2", revision: 2, occurredAt: "2026-10-02T01:00:00.000Z",
    closedStakeMinor: 600, returnMinor: 0, remainingStakeMinor: 0, source: "SETTLEMENT" };
  const prefix = { schemaVersion: 1, status: "COMPLETE", movements: [first, second] };
  await receiveAccounting(input.data.slipId, prefix);
  const inbox = await RiskAccountingInbox.findOne({}).lean() as any;
  await Promise.all([applyAccountingInbox(inbox._id), applyAccountingInbox(inbox._id)]);
  expect(await RiskMovement.countDocuments()).toBe(2);
  expect((await RiskPosition.findById(input.data.slipId).lean() as any).remainingStakeMinor).toBe(0);
  await receiveAccounting(input.data.slipId, { ...prefix, movements: [first] });
  await replayAccounting();
  expect(await RiskMovement.countDocuments()).toBe(2);
  expect((await RiskMovement.findById("movement-1").lean() as any).occurredAt).toBe(first.occurredAt);
  expect((await RiskPosition.findById(input.data.slipId).lean() as any).accountingRevision).toBe(2);
});

it("retains full reserves for absent, incomplete, conflicting or unbound movements", async () => {
  const input = event();
  input.data.wager = 10;
  await new ModerationService({ publishWithConfirm: async () => undefined }).handlePlaceBet(input);
  await receiveAccounting(input.data.slipId, undefined);
  await receiveAccounting(input.data.slipId, { schemaVersion: 1, status: "UNAVAILABLE", reason: "HISTORY_MISSING" });
  expect(await RiskMovement.countDocuments()).toBe(0);
  const invalid = { schemaVersion: 1, movementId: "bad", slipId: input.data.slipId, userId: input.data.userId, revision: 2,
    occurredAt: "2026-10-01T01:00:00.000Z", closedStakeMinor: 1000, returnMinor: 1000,
    remainingStakeMinor: 0, originalStakeMinor: 1000, source: "SETTLEMENT", placementFingerprint: "wrong" };
  expect(() => completeEvidence({ schemaVersion: 1, status: "COMPLETE", movements: [invalid] })).toThrow();
  await receiveAccounting(input.data.slipId, { schemaVersion: 1, status: "COMPLETE", movements: [{ ...invalid, revision: 1 }] });
  await replayAccounting();
  expect(await RiskMovement.countDocuments()).toBe(0);
  expect((await RiskPosition.findById(input.data.slipId).lean() as any).remainingStakeMinor).toBe(1000);
});

it.each(["MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"])(
  "arbitrates actual %s reservations transactionally, with no duplicate spend",
  async type => {
    // Management activation is separately proven to fail without history.
    // Inject an already-authorized policy only in this isolated book fixture to
    // exercise the admission transaction, not to invent production readiness.
    const limit = type === "MAX_OPEN_RETURN" || type === "MAX_OPERATOR_EXPOSURE" ? 2000 : 1000;
    const parameters = type === "MAX_CUSTOMER_LOSS" ? { window: "UTC_DAY" } : { perCustomer: false };
    await RiskState.updateOne({ _id: "active" }, { $set: { rules: [...defaults(), rule(type, limit, parameters)],
      accountingCoverage: { valid: true, openPositionsReady: true, lossAvailable: true, realisedCompleteSince: "2019-01-01T00:00:00.000Z" } } });
    const first = event(), second = event();
    second.data.userId = first.data.userId;
    first.data.wager = second.data.wager = 10;
    const receipts = await Promise.all([receiveRisk(first, new Date()), receiveRisk(second, new Date())]);
    expect(receipts.filter(r => r.reserved)).toHaveLength(1);
    const winner = receipts.find(r => r.reserved)!;
    const replay = await receiveRisk(winner.event, new Date());
    expect(replay._id).toBe(winner._id);
    expect(await RiskPosition.countDocuments()).toBe(2);
    const publisher = { publishWithConfirm: jest.fn(async () => undefined) };
    await Promise.all([new ModerationService(publisher).handlePlaceBet(first), new ModerationService(publisher).handlePlaceBet(second)]);
    expect(await Bet.countDocuments({ status: ModerationStatus.APPROVED })).toBe(1);
    expect(await Bet.countDocuments({ status: ModerationStatus.DECLINED })).toBe(1);
  }
);

it("rechecks current safety after a pinned delay, and durably rejects bounded missing evidence", async () => {
  const input = event();
  const publisher = { publishWithConfirm: jest.fn(async () => undefined) };
  (verifyRiskSource as jest.Mock).mockRejectedValue(new Error("source unavailable"));
  const service = new ModerationService(publisher);
  expect(await service.handlePlaceBet(input)).toMatchObject({ type: "park" });
  const receipt = await RiskPosition.findById(input.data.slipId).lean() as any;
  await RiskPosition.updateOne({ _id: input.data.slipId }, { $set: { evidenceDeadline: new Date(Date.now() - 1).toISOString() } });
  (verifyRiskSource as jest.Mock).mockImplementation(async () => ({
    kickoffAt: new Date(Date.now() + 600000).toISOString(), affectedRows: [],
  }));
  expect(await service.handlePlaceBet(input)).toMatchObject({ type: "decision" });
  const bet = await Bet.findOne({ slipId: input.data.slipId }).lean();
  expect(bet?.status).toBe(ModerationStatus.DECLINED);
  expect(bet?.riskReason).toBe("RISK_EVIDENCE_UNAVAILABLE");
  const message = publisher.publishWithConfirm.mock.calls[0] as any;
  expect(message[0].data.occurredAt).toBe(bet?.moderationTimestamp);
  expect((await RiskPosition.findById(input.data.slipId).lean() as any).receivedAt).toBe(receipt.receivedAt);
});

it("uses confirmed signed realised win credit during actual receipt reservation without double credit", async () => {
  const original = event();
  original.data.wager = 10;
  await new ModerationService({ publishWithConfirm: async () => undefined }).handlePlaceBet(original);
  const position = await RiskPosition.findById(original.data.slipId).lean() as any;
  await receiveAccounting(original.data.slipId, { schemaVersion: 1, status: "COMPLETE", movements: [{
    schemaVersion: 1, movementId: "confirmed-win", slipId: original.data.slipId, userId: original.data.userId,
    revision: 1, occurredAt: new Date().toISOString(), closedStakeMinor: 1000, returnMinor: 2000,
    remainingStakeMinor: 0, originalStakeMinor: 1000, source: "SETTLEMENT", placementFingerprint: position.accountingFingerprint,
  }] });
  await replayAccounting();
  await RiskState.updateOne({ _id: "active" }, { $set: { rules: [...defaults(), rule("MAX_CUSTOMER_LOSS", 500, { window: "UTC_DAY" })],
    accountingCoverage: { valid: true, openPositionsReady: true, lossAvailable: true, realisedCompleteSince: "2019-01-01T00:00:00.000Z" } } });
  const first = event(), second = event();
  first.data.userId = second.data.userId = original.data.userId;
  first.data.wager = 15;
  second.data.wager = 1;
  expect((await receiveRisk(first, new Date())).reserved).toBe(true); // -1000 + 1500 = 500
  expect((await receiveRisk(second, new Date())).reason).toBe("RISK_MAX_CUSTOMER_LOSS");
  expect(await RiskMovement.countDocuments()).toBe(1);
});
