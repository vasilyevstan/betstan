import mongoose from "mongoose";
import { AnalysisChoice, AnalysisPosition, analyseChoices, eventExposure } from "./ExposureAnalysis";
import { operatorExposure } from "./Evaluation";
import { key, parseRule, Policy, RiskError, validatePolicy } from "./Policy";
import { choiceId, liveOutcomeKey } from "./Selections";
import { readEventAuthority } from "./SourceVerifier";
import { getPolicy, readBook, readiness, riskEnabled, RiskState } from "./Store";
import { builtinMarketId } from "./BuiltinMarkets";

interface EventSummary { eventId: string; name: string; time: string; phase: string }
interface BookSnapshot {
  policy: Policy; positions?: AnalysisPosition[]; asOf: string;
  analysis: { ready: boolean; code: string };
}
const invalidSource = (): never => { throw new RiskError("EVENT_SOURCE_UNAVAILABLE", "Open-event information is incomplete; refresh and try again", 503); };
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidSource();
  return value as Record<string, unknown>;
};
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 512;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,95}$/.test(value);
function summary(value: unknown): EventSummary {
  const event = record(value);
  if (!identifier(event.eventId) || !text(event.name) || !text(event.time) || !Number.isFinite(Date.parse(event.time))
    || !["PRE_MATCH", "FIRST_HALF", "FIRST_HALF_STOPPAGE", "HALF_TIME", "SECOND_HALF", "SECOND_HALF_STOPPAGE"].includes(String(event.phase))) return invalidSource();
  return { eventId: event.eventId, name: event.name, time: event.time, phase: String(event.phase) };
}
function offer(value: unknown, eventId: string): AnalysisChoice {
  const choice = record(value);
  if (!["STANDARD", "TEMPLATE", "LIVE"].includes(String(choice.origin)) || !identifier(choice.marketId)
    || !text(choice.outcomeKey) || !text(choice.marketName) || !text(choice.label)
    || typeof choice.odds !== "number" || !Number.isFinite(choice.odds) || choice.odds < 1
    || typeof choice.sourceOpen !== "boolean"
    || choice.betKind !== (choice.origin === "LIVE" ? "LIVE" : "PRE_MATCH")) return invalidSource();
  const builtin = choice.origin === "TEMPLATE" ? undefined : builtinMarketId(String(choice.betKind), choice.marketType);
  if (choice.origin !== "TEMPLATE" && choice.marketType !== undefined && !builtin) return invalidSource();
  const base = {
    eventId, marketId: choice.marketId, marketName: choice.marketName, label: choice.label, odds: choice.odds, sourceOpen: choice.sourceOpen,
    ...(builtin ? { builtinMarketId: builtin } : {}),
  };
  if (choice.origin === "LIVE") {
    if (typeof choice.marketVersion !== "number" || !text(choice.selectionId) || choice.outcomeKey !== choice.selectionId) return invalidSource();
    const outcomeKey = liveOutcomeKey(choice.marketId, choice.marketVersion, choice.selectionId);
    if (!outcomeKey) return invalidSource();
    return { ...base, origin: "LIVE", betKind: "LIVE", outcomeKey, marketVersion: choice.marketVersion, selectionId: choice.selectionId };
  }
  if (choice.origin === "TEMPLATE") {
    if (!identifier(choice.templateId)) return invalidSource();
    return { ...base, origin: "TEMPLATE", betKind: "PRE_MATCH", outcomeKey: choice.outcomeKey, templateId: choice.templateId };
  }
  return { ...base, origin: "STANDARD", betKind: "PRE_MATCH", outcomeKey: choice.outcomeKey };
}
const projection: Record<string, 0 | 1> = {
  _id: 1, facts: 1, state: 1, reserved: 1, moneyReady: 1, stakeMinor: 1, remainingStakeMinor: 1, returnMinor: 1,
};
async function bookSnapshot(): Promise<BookSnapshot> {
  const asOf = new Date().toISOString();
  if (!riskEnabled()) {
    const current = await getPolicy();
    return {
      policy: { revision: current.revision, defaultsVersion: 1, rules: current.rules.map(parseRule) }, asOf,
      analysis: { ready: false, code: "RISK_DISABLED" },
    };
  }
  let result!: BookSnapshot;
  // Reporting reads a snapshot without contending on admission's serial document.
  await mongoose.connection.transaction(async session => {
    const state = await RiskState.findById("active").maxTimeMS(2000).session(session).lean<Record<string, unknown>>();
    if (!state || state.schemaVersion !== 1 || state.defaultsVersion !== 1
      || typeof state.revision !== "number" || !Number.isSafeInteger(state.revision) || state.revision < 1 || !Array.isArray(state.rules)) {
      throw new RiskError("POLICY_UNAVAILABLE", "Active policy is unavailable", 503);
    }
    const policy: Policy = { revision: state.revision, defaultsVersion: 1, rules: state.rules.map(parseRule) };
    validatePolicy(policy.rules);
    const ready = await readiness(true, session, new Date(asOf), 2000);
    result = { policy, asOf, analysis: { ready: false, code: ready.accounting.code } };
    if (!ready.accounting.openPositionsReady) return;
    const book = await readBook({ reserved: true, state: { $ne: "DECLINED" }, remainingStakeMinor: { $ne: 0 } },
      session, { projection, maxTimeMS: 2000 });
    if (book.capacityExceeded) { result.analysis.code = "EXPOSURE_READ_CAPACITY_UNAVAILABLE"; return; }
    const positions: AnalysisPosition[] = book.positions;
    if (positions.some(position => !position.moneyReady || operatorExposure(position) === undefined)) {
      result.analysis.code = "OPEN_AMOUNTS_UNAVAILABLE"; return;
    }
    result.positions = positions;
    result.analysis = { ready: true, code: "READY" };
  }, { readConcern: { level: "snapshot" }, maxCommitTimeMS: 2000 });
  return result;
}

export async function listEventRisk(after: string | undefined, limit: number) {
  if (after !== undefined) key(after);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new RiskError("INVALID_QUERY", "Choose 1-25 events per page");
  const query = new URLSearchParams({ limit: String(limit) });
  if (after !== undefined) query.set("after", after);
  const source = record(await readEventAuthority(`/api/event/risk-events?${query}`));
  if (!Array.isArray(source.events) || source.events.length > limit) return invalidSource();
  const events = source.events.map(summary);
  let previous = after ?? "";
  for (const event of events) {
    if (event.eventId <= previous) return invalidSource();
    previous = event.eventId;
  }
  if (source.nextAfter !== null && (!identifier(source.nextAfter) || !events.length
    || source.nextAfter !== events[events.length - 1].eventId)) return invalidSource();
  const snapshot = await bookSnapshot();
  return {
    asOf: snapshot.asOf, policyRevision: snapshot.policy.revision, analysis: snapshot.analysis,
    events: events.map(event => ({ ...event, metrics: eventExposure(event.eventId, snapshot.positions) })),
    nextAfter: source.nextAfter,
  };
}
export async function getEventRisk(eventId: string, stakeMinor: number) {
  key(eventId);
  if (!Number.isSafeInteger(stakeMinor) || stakeMinor < 1 || stakeMinor > 1000000000000) {
    throw new RiskError("INVALID_QUERY", "Stress stake must be 1-1000000000000 minor units");
  }
  const source = await readEventAuthority(`/api/event/risk-events/${encodeURIComponent(eventId)}`);
  if (source === null) throw new RiskError("EVENT_NOT_OPEN", "This event is no longer open for betting; refresh the event list", 404);
  const catalogue = record(source);
  const event = summary(catalogue.event);
  if (event.eventId !== eventId || !Array.isArray(catalogue.choices)) return invalidSource();
  if (catalogue.choices.length > 1000) throw new RiskError("EVENT_VIEW_CAPACITY_UNAVAILABLE", "This event exceeds the bounded 1000-choice view; no partial analysis is shown", 503);
  const choices = catalogue.choices.map(value => offer(value, eventId));
  if (new Set(choices.map(choiceId)).size !== choices.length) return invalidSource();
  const snapshot = await bookSnapshot();
  if (choices.some(choice => choice.origin !== "TEMPLATE" && !choice.builtinMarketId
    && snapshot.policy.rules.some(rule => rule.enabled && rule.scope.marketTypes?.some(id => id.startsWith(`${choice.betKind}:`))))) {
    return invalidSource();
  }
  return {
    event, asOf: snapshot.asOf, policyRevision: snapshot.policy.revision, analysis: snapshot.analysis, stakeMinor,
    metrics: eventExposure(eventId, snapshot.positions),
    choices: analyseChoices(snapshot.policy, snapshot.positions, eventId, choices, stakeMinor),
  };
}
