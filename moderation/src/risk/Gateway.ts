import { IModerationAffectedRow, IPlaceBetEvent, ModerationDecisionReasonCode, ModerationDeclineReason, ModerationStatus } from "@betstan/common";
import { ClientSession } from "mongoose";
import { Bet } from "../model/Bet";
import { ParkedPlaceBet, ParkedPlaceBetStatus } from "../model/ParkedPlaceBet";
import { facts, ledgerReason, matching, money, positionFilter, selectionFingerprint, staticReason } from "./Evaluation";
import { financial, fingerprint, RiskError, Rule, windowStart } from "./Policy";
import { accountingRuleReady, activityRuleReady, readBook, RiskBaseline, RiskMovement, RiskPosition, RiskState, transaction } from "./Store";
import { LiveEventMirror } from "../model/LiveEventMirror";
import { Resulted } from "../model/Resulted";
import { declineForRisk, ModerationDecision, parseDecisionReason } from "./Decision";
import { timingFailures } from "./Timing";

const identity = (data: any) => ({
  userId: data.userId, slipId: data.slipId, wager: data.wager,
  rows: data.rows, betKind: data.betKind, submittedAt: data.submittedAt,
});
export const placementFingerprint = (data: any) => fingerprint(JSON.parse(JSON.stringify(identity(data), (key, value) => {
  // Predecessor raw Mongo inserts serialized absent optional row fields as null.
  // That historical spelling is equivalent to omission, never a changed quote.
  const optional = ["submittedAt", "eventTime", "marketId", "marketType", "marketVersion", "quoteVersion", "selectionId", "side", "selectedAt", "quoteValidUntil"];
  return value === null && optional.includes(key) ? undefined : value;
})));
async function realisedFor(rules: Rule[], userId: string, now: Date, session: ClientSession): Promise<any[]> {
  const lossRules = rules.filter(r => r.type === "MAX_CUSTOMER_LOSS");
  if (!lossRules.length) return [];
  const oldest = Math.min(...lossRules.map(r => windowStart(r.parameters.window!, now).getTime()));
  return RiskMovement.find({
    userId, occurredAt: { $gte: new Date(oldest).toISOString(), $lte: now.toISOString() },
  }).limit(10001).session(session).lean();
}

export async function receiveRisk(event: IPlaceBetEvent, _now: Date, rawData: unknown = event.data): Promise<any> {
  return transaction(async (session, policy, now) => {
    const data: any = event.data;
    const hash = placementFingerprint(data);
    const previous = await RiskPosition.findById(data.slipId).session(session).lean() as any;
    if (previous) {
      if (previous.fingerprint !== hash) throw new RiskError("PLACEMENT_CONFLICT", "Immutable placement conflicts with first receipt", 409);
      return previous;
    }
    const stored = await Bet.findOne({ slipId: data.slipId }).session(session).lean();
    if (stored && placementFingerprint(stored) !== hash) throw new RiskError("PLACEMENT_CONFLICT", "Immutable placement conflicts with stored slip", 409);
    if (stored && stored.status !== ModerationStatus.RECEIVED) return undefined; // explicit historical terminal reader
    const baseline = await RiskBaseline.findById(data.slipId).session(session).lean() as any;
    if (baseline) {
      if (baseline.state !== "PENDING" || baseline.userId !== data.userId || baseline.accountingFingerprint !== fingerprint(rawData)) {
        throw new RiskError("HISTORICAL_PLACEMENT", "Source-owned historical placement cannot be admitted again", 409);
      }
      // A legacy source-pending placement can enter durable moderation once;
      // replace, never double-count, its imported full-principal reservation.
      await RiskBaseline.deleteOne({ _id: data.slipId, state: "PENDING" }, { session });
    }
    const rules = matching(policy, data);
    const delay = Math.max(0, ...rules.filter(r => r.type === "DELAY_MS").map(r => r.parameters.limit!));
    const receivedAt = now.toISOString();
    const state = await RiskState.findById("active").session(session).lean() as any;
    const position: any = {
      _id: data.slipId, fingerprint: hash, selectionFingerprint: selectionFingerprint(data),
      accountingFingerprint: fingerprint(rawData),
      receiptSequence: state.serial,
      event, userId: data.userId, facts: facts(data), receivedAt,
      // Legacy publisher timestamp is used only when original submittedAt is absent.
      submittedAt: data.submittedAt ?? stored?.submittedAt ?? event.timestamp ?? receivedAt,
      decisionDueAt: new Date(now.getTime() + delay).toISOString(),
      evidenceDeadline: new Date(now.getTime() + delay + 15 * 60000).toISOString(),
      policy, state: "PENDING", reserved: true, ...money(data), accountingRevision: 0, __v: 0,
    };
    position.reason = staticReason(rules, data);
    if (!position.reason && rules.some(r => financial(r.type) && !accountingRuleReady(r, state.accountingCoverage, now))) {
      position.reason = "RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE";
    }
    if (!position.reason && rules.some(r => !activityRuleReady(r, state.activityCoverage, now))) position.reason = "RISK_EVIDENCE_UNAVAILABLE";
    const needsLedger = rules.some(r => ["MAX_SUBMISSIONS", "MAX_TURNOVER", "REPEAT_BET_COOLDOWN_MS", "MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"].includes(r.type));
    if (!position.reason && needsLedger) {
      const book = await readBook(positionFilter(rules, position, now), session);
      const movements = await realisedFor(rules, position.userId, now, session);
      position.reason = book.capacityExceeded || movements.length > 10000 ? "RISK_EVIDENCE_CAPACITY_UNAVAILABLE"
        : ledgerReason(rules, position, book.positions, now, movements);
    }
    position.reserved = !position.reason;
    await RiskPosition.create([position], { session });
    if (!stored) {
      await Bet.create([{
        ...identity(data), timestamp: position.submittedAt, status: ModerationStatus.RECEIVED,
        riskPolicyRevision: policy.revision, decisionId: `moderation:${data.slipId}`,
        placementFingerprint: position.accountingFingerprint,
        moderationTimestamp: "", publishedAt: "", affectedRows: [], __v: 0,
      }], { session });
    } else {
      await Bet.updateOne({ slipId: data.slipId, status: ModerationStatus.RECEIVED }, {
        $set: { riskPolicyRevision: policy.revision, decisionId: `moderation:${data.slipId}`, placementFingerprint: position.accountingFingerprint },
      }, { session });
    }
    // Receipt and wake-up obligation are indivisible; no crash can strand a
    // received bet between inserting it and parking it.
    await ParkedPlaceBet.updateOne({ slipId: data.slipId }, {
      $set: { event, status: ParkedPlaceBetStatus.PENDING, nextAttemptAt: position.decisionDueAt, pendingEventIds: [], leaseOwner: "", leaseUntil: "" },
      $setOnInsert: { attemptCount: 0, lastError: "", exhaustedAt: "", __v: 0 },
    }, { upsert: true, session });
    return position;
  });
}

export async function terminalRisk(slipId: string, decision: ModerationDecision, _now: Date): Promise<any> {
  return transaction(async (session, _policy, now) => {
    const position = await RiskPosition.findById(slipId).session(session).lean() as any;
    const stored = await Bet.findOne({ slipId }).session(session).lean() as any;
    if (!position || !stored) throw new RiskError("RECEIPT_UNAVAILABLE", "Durable receipt is missing", 503);
    if (position.state !== "PENDING" || stored.status !== ModerationStatus.RECEIVED) return stored;
    if (now.toISOString() < position.decisionDueAt) throw new RiskError("DECISION_NOT_DUE", "Fixed delay has not elapsed", 409);
    let reason: ModerationDecisionReasonCode | undefined = position.reason ? parseDecisionReason(position.reason) : undefined;
    const rules = matching(position.policy, position.event.data);
    if (decision.status === ModerationStatus.APPROVED && !reason) {
      // Always re-evaluate cutoff-independent static rules and dynamic windows
      // under the same contended transaction as conversion of reservations.
      reason = staticReason(rules, position.event.data);
      const coverage = (await RiskState.findById("active").session(session).lean() as any)?.accountingCoverage;
      if (!reason && rules.some(r => financial(r.type) && !accountingRuleReady(r, coverage, now))) reason = "RISK_ACCOUNTING_EVIDENCE_UNAVAILABLE";
      const activity = (await RiskState.findById("active").session(session).lean() as any)?.activityCoverage;
      if (!reason && rules.some(r => !activityRuleReady(r, activity, now))) reason = "RISK_EVIDENCE_UNAVAILABLE";
      if (!reason && rules.some((r: any) => ["MAX_SUBMISSIONS", "MAX_TURNOVER", "REPEAT_BET_COOLDOWN_MS", "MAX_OPEN_STAKE", "MAX_OPEN_RETURN", "MAX_OPERATOR_EXPOSURE", "MAX_CUSTOMER_LOSS"].includes(r.type))) {
        const book = await readBook(positionFilter(rules, position, now), session);
        const movements = await realisedFor(rules, position.userId, now, session);
        reason = book.capacityExceeded || movements.length > 10000 ? "RISK_EVIDENCE_CAPACITY_UNAVAILABLE"
          : ledgerReason(rules, { ...position, state: "ACCEPTED" }, book.positions, now, movements);
      }
    }
    const affectedRows: IModerationAffectedRow[] = reason
      ? position.event.data.rows.map((row: any) => ({ rowId: row.id, declineReason: declineForRisk(reason!) }))
      : [...decision.affectedRows];
    const veto = (rowId: string, code: ModerationDecisionReasonCode, declineReason = declineForRisk(code)) => {
      reason = reason ?? code;
      if (!affectedRows.some(row => row.rowId === rowId)) affectedRows.push({ rowId, declineReason });
    };
    if (decision.status === ModerationStatus.APPROVED && !reason) {
      const rows = position.event.data.rows as any[];
      const resulted = await Resulted.find({ eventId: { $in: rows.map(r => r.eventId) } }).session(session).lean();
      const ended = new Set(resulted.map(item => item.eventId));
      const timingEvidence = { kickoffs: { ...decision.timingEvidence?.kickoffs } };
      for (const row of rows) {
        if (ended.has(row.eventId)) veto(row.id, "RISK_EVENT_RESULTED");
        const mirror = await LiveEventMirror.findOne({ eventId: row.eventId }).session(session).lean() as any;
        if (mirror) {
          // Touch each mirror read: a concurrent current-state/history update
          // conflicts and retries this transaction rather than committing stale safety.
          await LiveEventMirror.updateOne({ _id: mirror._id }, { $inc: { riskAdmissionRevision: 1 } }, { session });
          if (Number.isFinite(Date.parse(mirror.kickoffAt))
            && (!timingEvidence.kickoffs[row.eventId] || Date.parse(mirror.kickoffAt) < Date.parse(timingEvidence.kickoffs[row.eventId]))) {
            timingEvidence.kickoffs[row.eventId] = mirror.kickoffAt;
          }
        }
        if (row.marketBet) {
          if (!Number.isFinite(Date.parse(row.marketBet.expiresAt))) veto(row.id, "RISK_EVIDENCE_UNAVAILABLE");
          else if (now.getTime() >= Date.parse(row.marketBet.expiresAt)) veto(row.id, "RISK_STALE_QUOTE");
        } else if (row.betKind !== "LIVE") {
          const kickoff = Date.parse(mirror?.kickoffAt ?? row.eventTime ?? row.timestamp);
          if (!Number.isFinite(kickoff) || now.getTime() >= kickoff) veto(row.id, "RISK_EVENT_STARTED");
        } else {
          const market = mirror?.markets?.find((m: any) => m.marketId === row.marketId && m.marketVersion === row.marketVersion);
          const selections = market?.selections?.filter((s: any) => row.selectionId ? s.selectionId === row.selectionId : s.side === row.side) ?? [];
          const eligible = mirror && (["FIRST_HALF", "FIRST_HALF_STOPPAGE", "HALF_TIME", "SECOND_HALF", "SECOND_HALF_STOPPAGE"].includes(mirror.phase)
            || (mirror.phase === "PRE_MATCH" && ["KICKOFF_TEAM", "FIRST_MINUTE_GOAL"].includes(market?.marketType)));
          if (!eligible) veto(row.id, "RISK_CURRENT_SOURCE_UNSAFE", ModerationDeclineReason.EVENT_NOT_LIVE);
          else if (mirror.bettingStatus !== "OPEN" || market?.status === "SUSPENDED") veto(row.id, "RISK_CURRENT_SOURCE_UNSAFE", ModerationDeclineReason.MARKET_SUSPENDED);
          else if (market?.status !== "OPEN") veto(row.id, "RISK_CURRENT_SOURCE_UNSAFE", ModerationDeclineReason.MARKET_CLOSED);
          else if (selections.length !== 1) veto(row.id, "INPUT_INTEGRITY", ModerationDeclineReason.INVALID_SELECTION);
          else if (selections[0].odds !== row.oddsValue || !Number.isFinite(Date.parse(row.quoteValidUntil))
            || now.getTime() >= Date.parse(row.quoteValidUntil)) veto(row.id, "RISK_STALE_QUOTE");
        }
      }
      // Recheck on every transaction retry at Mongo's contended decision clock.
      // A slow final commit cannot cross an optional deadline and still approve.
      for (const failure of timingFailures(rules, position.event.data, now, timingEvidence)) veto(failure.rowId, failure.reason);
    }
    affectedRows.sort((a, b) => position.event.data.rows.findIndex((row: any) => row.id === a.rowId)
      - position.event.data.rows.findIndex((row: any) => row.id === b.rowId));
    const status = reason ? ModerationStatus.DECLINED : decision.status;
    const update = {
      status, moderationTimestamp: now.toISOString(),
      affectedRows, declineReason: reason ? affectedRows[0]?.declineReason ?? declineForRisk(reason) : decision.declineReason,
      riskReason: reason ?? decision.riskReason, decisionId: `moderation:${slipId}`, riskPolicyRevision: position.policy.revision,
      // An empty publication marker in this atomic terminal write is the outbox.
      publishedAt: "", publishToken: "", publishLeaseOwner: "", publishLeaseUntil: "",
    };
    await Bet.updateOne({ slipId, status: ModerationStatus.RECEIVED }, { $set: update }, { session });
    await RiskPosition.updateOne({ _id: slipId, state: "PENDING" }, { $set: {
      state: status === ModerationStatus.APPROVED ? "ACCEPTED" : "DECLINED",
      reserved: status === ModerationStatus.APPROVED, reason: update.riskReason, decisionAt: update.moderationTimestamp,
    } }, { session });
    return { ...stored, ...update };
  });
}
