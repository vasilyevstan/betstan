import mongoose, { ClientSession, Schema } from "mongoose";
import { catalogue, defaults, financial, fingerprint, key, object, parseRule, Policy, RiskError, Rule, validatePolicy, WINDOWS, windowStart } from "./Policy";

const document = (name: string, fields: Record<string, any>) =>
  mongoose.model<any>(name, new Schema({ _id: String, schemaVersion: { type: Number, default: 1 }, ...fields }, { strict: true, minimize: false }));
export const RiskState = document("RiskState", {
  revision: Number, defaultsVersion: Number, rules: Schema.Types.Mixed, serial: Number, lockTime: Date,
  accountingCoverage: Schema.Types.Mixed,
  activityCoverage: Schema.Types.Mixed,
});
export const RiskHistory = document("RiskHistory", {
  revision: { type: Number, unique: true }, defaultsVersion: Number, rules: Schema.Types.Mixed,
  occurredAt: String, requestId: String,
});
export const RiskOperation = document("RiskOperation", { fingerprint: String, result: Schema.Types.Mixed });
export const RiskPosition = document("RiskPosition", {
  fingerprint: String, accountingFingerprint: String, selectionFingerprint: String, event: Schema.Types.Mixed, facts: Schema.Types.Mixed,
  userId: String, receivedAt: String, submittedAt: String, decisionDueAt: String, evidenceDeadline: String,
  policy: Schema.Types.Mixed, state: String, reserved: Boolean, reason: String,
  receiptSequence: Number,
  recoveryAt: String,
  evidencePending: Boolean,
  stakeMinor: Number, returnMinor: Number, remainingStakeMinor: Number, accountingRevision: Number,
  moneyReady: Boolean, decisionAt: String,
});
RiskPosition.schema.index({ state: 1, decisionDueAt: 1 });
RiskPosition.schema.index({ reserved: 1, userId: 1, receivedAt: 1 });
RiskPosition.schema.index({ receivedAt: 1 });
export const RiskMovement = document("RiskMovement", {
  facts: Schema.Types.Mixed,
  schemaVersion: Number, movementId: String, source: String, originalStakeMinor: Number, placementFingerprint: String,
  fingerprint: String, slipId: String, userId: String, revision: Number, occurredAt: String,
  closedStakeMinor: Number, returnMinor: Number, remainingStakeMinor: Number,
});
RiskMovement.schema.index({ slipId: 1, revision: 1 }, { unique: true });
RiskMovement.schema.index({ userId: 1, occurredAt: 1 });
export const RiskAccountingInbox = document("RiskAccountingInbox", {
  slipId: String, evidence: Schema.Types.Mixed, applied: Boolean, receivedAt: String, nextAttemptAt: String,
});
// Baseline exposure is never a received submission and is never replayed as a
// moderation command. Financial readers deduplicate it against live receipts.
export const RiskBaseline = document("RiskBaseline", {
  userId: String, accountingFingerprint: String, facts: Schema.Types.Mixed,
  state: String, reserved: Boolean, moneyReady: Boolean, stakeMinor: Number,
  remainingStakeMinor: Number, returnMinor: Number, accountingRevision: Number,
});
export const RiskSnapshot = document("RiskSnapshot", {
  manifest: Schema.Types.Mixed, manifestHash: String, page: Number, lastHash: String, bytes: Number,
  completionHash: String, finalized: Boolean,
});
export const RiskSnapshotPage = document("RiskSnapshotPage", { snapshotId: String, page: Number, hash: String, entries: Schema.Types.Mixed });
RiskSnapshotPage.schema.index({ snapshotId: 1, page: 1 }, { unique: true });

export async function readBook(filter: Record<string, unknown>, session: ClientSession): Promise<any[]> {
  const live = await RiskPosition.find(filter).limit(10001).session(session).lean();
  const baseline = await RiskBaseline.find(filter).limit(10001).session(session).lean();
  // Exclude baseline even when its live counterpart no longer matches the
  // filter (e.g. already fully closed): stale baseline must not resurrect it.
  const shadows = await RiskPosition.find({ _id: { $in: baseline.map(p => p._id) } }).select({ _id: 1 }).session(session).lean();
  const ids = new Set(shadows.map(p => p._id));
  return [...live, ...baseline.filter(p => !ids.has(p._id))];
}
export function accountingRuleReady(rule: Rule, coverage: any, now: Date): boolean {
  return Boolean(coverage?.valid && coverage.openPositionsReady
    && (rule.type !== "MAX_CUSTOMER_LOSS" || (coverage.lossAvailable
      && typeof coverage.realisedCompleteSince === "string"
      && windowStart(rule.parameters.window!, now).toISOString() >= coverage.realisedCompleteSince)));
}
export function activityRuleReady(rule: Rule, coverage: any, now: Date): boolean {
  if (!["MAX_SUBMISSIONS", "MAX_TURNOVER", "REPEAT_BET_COOLDOWN_MS"].includes(rule.type)) return true;
  if (rule.type === "REPEAT_BET_COOLDOWN_MS" && rule.parameters.limit === 0) return true;
  if (!coverage?.tracking || typeof coverage.since !== "string") return false;
  const from = rule.type === "REPEAT_BET_COOLDOWN_MS"
    ? new Date(now.getTime() - rule.parameters.limit!).toISOString() : windowStart(rule.parameters.window!, now).toISOString();
  return coverage.since <= from;
}

// One persisted contention document deliberately serializes the complete book.
// This is conservative and slower than sharding scopes, but overlapping scopes
// cannot write-skew. Policy activation, receipt, movement and terminal admission
// all acquire it before reading their snapshot. No network calls in callbacks.
export async function transaction<T>(action: (session: ClientSession, policy: Policy, clock: Date) => Promise<T>): Promise<T> {
  let result!: T;
  await mongoose.connection.transaction(async session => {
    const state = await RiskState.findOneAndUpdate({ _id: "active" }, [
      { $set: { serial: { $add: [{ $ifNull: ["$serial", 0] }, 1] },
        lockTime: { $max: [{ $ifNull: ["$lockTime", "$$NOW"] }, "$$NOW"] } } },
    ], { new: true, session }).lean() as any;
    if (!state) throw new RiskError("POLICY_UNAVAILABLE", "Active policy is unavailable", 503);
    if (state.schemaVersion !== 1 || state.defaultsVersion !== 1 || !Number.isSafeInteger(state.revision) || !Array.isArray(state.rules)) {
      throw new RiskError("POLICY_UNAVAILABLE", "Active policy is invalid", 503);
    }
    const rules = state.rules.map(parseRule);
    validatePolicy(rules);
    result = await action(session, { revision: state.revision, defaultsVersion: 1, rules }, new Date(state.lockTime));
  });
  return result;
}

export async function initializeRisk(): Promise<void> {
  await Promise.all([RiskState.init(), RiskHistory.init(), RiskOperation.init(), RiskPosition.init(), RiskMovement.init(), RiskAccountingInbox.init(),
    RiskBaseline.init(), RiskSnapshot.init(), RiskSnapshotPage.init()]);
  // Only explicit startup can create the factory baseline, never an API read or
  // admission fallback. Surviving history prevents accidental permissive repair.
  if (!await RiskState.exists({ _id: "active" })) {
    try {
      await mongoose.connection.transaction(async session => {
        if (await RiskState.exists({ _id: "active" }).session(session)) return;
        if (await RiskHistory.exists({}).session(session)) throw new RiskError("POLICY_UNAVAILABLE", "Active pointer is missing; recovery required", 503);
        const rules = defaults();
        await RiskState.create([{ _id: "active", revision: 1, defaultsVersion: 1, rules, serial: 0, __v: 0 }], { session });
        await RiskHistory.create([{ _id: "1", revision: 1, defaultsVersion: 1, rules, occurredAt: new Date().toISOString(), requestId: "factory", __v: 0 }], { session });
      });
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
    }
  }
  // Prove transaction availability even when the active pointer already exists.
  await transaction(async () => undefined);
}

export const riskEnabled = () => process.env.RISK_CENTRE_ENABLED === "true";
export async function readiness(ready = true, session?: ClientSession, now = new Date()) {
  const state = await RiskState.findById("active").session(session ?? null).lean() as any;
  const coverage = state?.accountingCoverage;
  const unsupported = await RiskPosition.exists({ reserved: true, moneyReady: { $ne: true } }).session(session ?? null);
  const open = Boolean(ready && coverage?.valid && coverage.openPositionsReady && !unsupported);
  const readyLossWindows = open ? WINDOWS.filter(window => accountingRuleReady({
    id: "readiness", type: "MAX_CUSTOMER_LOSS", enabled: true, scope: {}, parameters: { window },
  }, coverage, now)) : [];
  const activity = state?.activityCoverage;
  const readyActivityWindows = WINDOWS.filter(window => activityRuleReady({
    id: "readiness", type: "MAX_SUBMISSIONS", enabled: true, scope: {}, parameters: { window },
  }, ready ? activity : undefined, now));
  const allWindows = readyLossWindows.length === WINDOWS.length;
  return {
    transactions: ready ? "READY" as const : "UNAVAILABLE" as const,
    accounting: { ready: open && allWindows, openPositionsReady: open, readyLossWindows,
      code: !open ? "HISTORICAL_RECONCILIATION_REQUIRED" : allWindows ? "READY" : "HISTORY_WINDOW_UNAVAILABLE",
      ...(coverage?.valid ? { realisedCompleteSince: coverage.realisedCompleteSince } : {}) },
    capabilities: { extensibleMarkets: process.env.EXTENSIBLE_MARKETS_ENABLED === "true" },
    activity: { tracking: Boolean(ready && activity?.tracking), readyWindows: readyActivityWindows,
      ...(activity?.since ? { trackedSince: activity.since } : {}),
      readyCooldownMs: ready && activity?.tracking
        ? Math.max(0, Math.min(2592000000, now.getTime() - Date.parse(activity.since))) : 0 },
  };
}
const publicRevision = (record: any) => ({
  requestId: record.requestId, revision: record.revision, defaultsVersion: record.defaultsVersion,
  rules: record.rules, occurredAt: record.occurredAt,
});
export async function getPolicy() {
  if (!riskEnabled()) {
    const stored = await RiskState.findById("active").lean() as any;
    return {
      revision: stored?.revision ?? 1, defaultsVersion: stored?.defaultsVersion ?? 1,
      rules: stored?.rules ?? defaults(), catalogue: catalogue(), readiness: await readiness(false),
    };
  }
  // Transactional read also detects an unavailable/standalone database.
  return transaction(async (session, policy, clock) => ({ ...policy, catalogue: catalogue(), readiness: await readiness(true, session, clock) }));
}
export type Mutation = "CREATE" | "UPDATE" | "DELETE" | "RESET";
const operationsInFlight = new Map<string, { hash: string; work: Promise<any> }>();
async function coalescedOperation(id: string, hash: string, action: () => Promise<any>) {
  const existing = operationsInFlight.get(id);
  if (existing) {
    if (existing.hash !== hash) throw new RiskError("OPERATION_CONFLICT", "Request id already used with different content", 409);
    return existing.work;
  }
  const work = action();
  operationsInFlight.set(id, { hash, work });
  try { return await work; } finally { operationsInFlight.delete(id); }
}
export async function mutatePolicy(action: Mutation, value: unknown, pathId?: string) {
  if (!riskEnabled()) throw new RiskError("RISK_DISABLED", "Risk Centre activation requires transaction-capable storage", 503);
  const body = object(value, ["expectedRevision", "requestId", ...(action === "CREATE" || action === "UPDATE" ? ["rule"] : []), ...(action === "RESET" ? ["ruleId"] : [])]);
  const requestId = key(body.requestId);
  if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) throw new RiskError("INVALID_REVISION", "expectedRevision must be a positive safe integer");
  if (pathId !== undefined) key(pathId);
  if (body.ruleId !== undefined) key(body.ruleId);
  const hash = fingerprint({ action, pathId, body });
  const outcome = await coalescedOperation(requestId, hash, () => transaction(async (session, policy, clock) => {
    const previous = await RiskOperation.findById(requestId).session(session).lean() as any;
    if (previous) {
      if (previous.fingerprint !== hash) throw new RiskError("OPERATION_CONFLICT", "Request id already used with different content", 409);
      return previous.result;
    }
    try {
    if (policy.revision !== body.expectedRevision) throw new RiskError("REVISION_CONFLICT", "Policy changed; reload before saving", 409);
    if (policy.revision === Number.MAX_SAFE_INTEGER) throw new RiskError("REVISION_EXHAUSTED", "Policy revision exhausted", 409);
    let rules: Rule[] = policy.rules;
    const current = pathId ? rules.find(r => r.id === pathId) : undefined;
    if ((action === "UPDATE" || action === "DELETE") && !current) {
      if (catalogue().some(c => c.locked && c.type === pathId)) throw new RiskError("LOCKED_RULE", "Integrity safeguards cannot be changed", 409);
      throw new RiskError("NOT_FOUND", "Rule not found", 404);
    }
    if (action === "CREATE" || action === "UPDATE") {
      const rule = parseRule(body.rule);
      if (action === "UPDATE" && (rule.id !== pathId || rule.type !== current!.type)) throw new RiskError("RULE_IDENTITY_CONFLICT", "Rule identity and type are immutable", 409);
      if (action === "CREATE" && rules.some(r => r.id === rule.id)) throw new RiskError("RULE_EXISTS", "Rule already exists", 409);
      rules = action === "CREATE" ? [...rules, rule] : rules.map(r => r.id === pathId ? rule : r);
    } else if (action === "DELETE") {
      if (pathId!.startsWith("default:")) throw new RiskError("DEFAULT_RULE", "Factory rules can be disabled or reset, not removed", 409);
      rules = rules.filter(r => r.id !== pathId);
    } else if (body.ruleId !== undefined) {
      const factory = defaults().find(r => r.id === body.ruleId);
      if (!factory) throw new RiskError("NOT_FOUND", "No factory default for this rule; use Remove", 404);
      rules = rules.map(r => r.id === factory.id ? factory : r);
    } else rules = defaults();
    validatePolicy(rules);
    const coverage = (await RiskState.findById("active").session(session).lean() as any)?.accountingCoverage;
    const activity = (await RiskState.findById("active").session(session).lean() as any)?.activityCoverage;
    if (rules.some(r => r.enabled && !activityRuleReady(r, activity, clock))) {
      throw new RiskError("ACTIVITY_NOT_READY", "The rule window extends before uninterrupted durable receiver intake coverage", 503);
    }
    if (rules.some(r => r.enabled && financial(r.type) && !accountingRuleReady(r, coverage, clock))
      || (rules.some(r => r.enabled && financial(r.type))
        && await RiskPosition.exists({ reserved: true, moneyReady: { $ne: true } }).session(session))) {
      throw new RiskError("ACCOUNTING_NOT_READY", "Complete authoritative accounting history is required before enabling this control", 503);
    }
    const result = { requestId, revision: policy.revision + 1, defaultsVersion: 1, rules, occurredAt: clock.toISOString() };
    await RiskState.updateOne({ _id: "active", revision: policy.revision }, { $set: { revision: result.revision, rules } }, { session });
    await RiskHistory.create([{ _id: String(result.revision), ...result, __v: 0 }], { session });
    await RiskOperation.create([{ _id: requestId, fingerprint: hash, result, __v: 0 }], { session });
    return result;
    } catch (error) {
      if (!(error instanceof RiskError)) throw error;
      const failure = { requestId, error: { code: error.code, message: error.message, status: error.status } };
      await RiskOperation.create([{ _id: requestId, fingerprint: hash, result: failure, __v: 0 }], { session });
      return failure;
    }
  }));
  if (outcome.error) throw new RiskError(outcome.error.code, outcome.error.message, outcome.error.status);
  return outcome;
}
export async function getOperation(id: string) {
  const operation = await RiskOperation.findById(key(id)).lean() as any;
  if (!operation) throw new RiskError("NOT_FOUND", "Operation not found", 404);
  if (operation.result.error) throw new RiskError(operation.result.error.code, operation.result.error.message, operation.result.error.status);
  return operation.result;
}
export async function getHistory(before = Number.MAX_SAFE_INTEGER, limit = 20) {
  if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RiskError("INVALID_QUERY", "Invalid history bounds");
  const records = await RiskHistory.find({ revision: { $lt: before } }).sort({ revision: -1 }).limit(limit + 1).lean();
  const items = records.slice(0, limit).map(publicRevision);
  return { items, ...(records.length > limit ? { nextBeforeRevision: items[items.length - 1].revision } : {}) };
}
