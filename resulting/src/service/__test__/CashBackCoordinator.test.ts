import {
  BetKind, BetStatus, BettingStatus, CashBackOperationIdentity, CashBackSourceReply,
  CashBackSourceRequest, CashBackSourceEvidence, EventPhase, EventStatus, EventVisibility,
  CashBackSelectionQuote, CashBackSourceDenialReason, CashBackUnavailableReason,
  ICashBackOutcomeEvent, messengerWrapper, ModerationStatus, ResultingStatus,
  LiveMarketStatus, LiveMarketType, LiveSettlementReason, TeamSide,
} from "@betstan/common";
import { Bet, BetArchive } from "../../model/Bet";
import { CashBackOperation } from "../../model/CashBackOperation";
import FinalScoreLedger from "../../model/FinalScoreLedger";
import { createFinalScoreEvent, createLiveRow, createModerationEvent, createPlaceBetEvent, createPreMatchRow } from "../../test/resultingTestUtils";
import SettleSlipPublisher from "../../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../event/publisher/SettleSlipRowPublisher";
import { applyModerationResult, processFinalScore, processLiveUpdate, upsertPlaceBet } from "../resulting";
import { CashBackCoordinator } from "../CashBackCoordinator";
import { cashBackHash } from "../cashBackState";

const publishers = () => ({
  settleSlipPublisher: new SettleSlipPublisher(messengerWrapper.connection),
  settleSlipRowPublisher: new SettleSlipRowPublisher(messengerWrapper.connection),
});

const setup = async (eventCount = 1, cutoffMs = 60_000, betKind = BetKind.PRE_MATCH) => {
  const cutoff = new Date(Date.now() + cutoffMs).toISOString();
  const kickoff = betKind === BetKind.LIVE ? new Date(Date.now() - 60_000).toISOString() : cutoff;
  const rows = Array.from({ length: eventCount }, (_, index) =>
    (betKind === BetKind.LIVE ? createLiveRow : createPreMatchRow)({
      eventId: `event-${index}`, eventTime: kickoff, oddsValue: 3,
    }));
  const place = createPlaceBetEvent({
    userId: "owner", slipId: "slip", wager: 100, betKind, rows,
  });
  const settlementPublishers = publishers();
  await upsertPlaceBet(place, settlementPublishers);
  await applyModerationResult(createModerationEvent("slip", ModerationStatus.APPROVED), settlementPublishers);
  const requests: CashBackSourceRequest[] = [];
  const outcomes: ICashBackOutcomeEvent["data"][] = [];
  const generations = new Map<string, number>();
  const source = jest.fn(async (event: { data: CashBackSourceRequest }) => { requests.push(event.data); });
  const outcome = jest.fn(async (event: ICashBackOutcomeEvent) => { outcomes.push(event.data); });
  const coordinator = new CashBackCoordinator(messengerWrapper.connection, {
    source: { initConfirmChannel: async () => {}, publishWithConfirm: source },
    outcome: { initConfirmChannel: async () => {}, publishWithConfirm: outcome },
  });
  await coordinator.init();
  const identity = (id: string): CashBackOperationIdentity => ({
    operationId: id, clientOperationId: `client-${id}`, fingerprint: `fingerprint-${id}`,
    userId: "owner", slipId: "slip", betKind,
  });
  const reply = (request: CashBackSourceRequest): CashBackSourceReply => {
    const key = `${request.participant.eventId}:${request.participant.owner}`;
    if (request.action === "SNAPSHOT") {
      const base = {
        eventId: request.participant.eventId, authorityFingerprint: key,
        occurredAt: new Date().toISOString(), kickoffAt: kickoff, cutoffAt: cutoff,
      };
      let quoteEvidence: Extract<CashBackSourceEvidence, { owner: "GAMEMASTER" }>["quoteEvidence"] = {
        kind: "PRE_MATCH_STATIC",
      };
      if (request.operation.betKind === BetKind.LIVE) {
        const quotes = request.selections.map((selection): Extract<CashBackSelectionQuote, { betKind: BetKind.LIVE }> => {
          if (selection.betKind !== BetKind.LIVE) throw new Error("Expected original live selection");
          return {
            ...selection, odds: "6", quoteFingerprint: `current-${selection.slipRowId}`,
            quoteVersion: 2, quoteValidUntil: cutoff, marketStatus: LiveMarketStatus.OPEN,
          };
        });
        const [first, ...rest] = quotes;
        if (!first) throw new Error("Missing live selection");
        quoteEvidence = { kind: "LIVE", quotes: [first, ...rest] };
      }
      const evidence: CashBackSourceEvidence = request.participant.owner === "BACKOFFICE"
        ? {
            ...base, owner: "BACKOFFICE" as const, cutoffAt: betKind === BetKind.LIVE ? null : cutoff,
            lifecycle: { status: EventStatus.NO_RESULT as const, visibility: EventVisibility.ONLINE },
            quoteEvidence: { kind: "LIFECYCLE_ONLY" as const },
          }
        : {
            ...base, owner: "GAMEMASTER" as const,
            lifecycle: { status: EventStatus.NO_RESULT as const,
              phase: betKind === BetKind.LIVE ? EventPhase.FIRST_HALF : EventPhase.PRE_MATCH,
              bettingStatus: BettingStatus.OPEN, sequence: 0 },
            quoteEvidence,
          };
      return {
        outcome: "SNAPSHOT", request,
        snapshot: { baseGeneration: generations.get(key) ?? 0, observedAt: new Date().toISOString(), evidence },
      };
    }
    if (request.action === "RESERVE") {
      generations.set(key, request.grantedGeneration);
      return {
        outcome: "GRANTED", request, grantedGeneration: request.grantedGeneration,
        decisionTime: new Date().toISOString(), evidence: request.expected.evidence,
      };
    }
    generations.set(key, Math.max(generations.get(key) ?? 0, request.baseGeneration + 2));
    return {
      outcome: "FENCED", request, fenceGeneration: request.baseGeneration + 2,
      observedGeneration: generations.get(key)!, observedAt: new Date().toISOString(),
    };
  };
  const pump = async (drop?: (request: CashBackSourceRequest) => boolean) => {
    for (let count = 0; requests.length; count++) {
      if (count > 100) throw new Error("Source protocol did not converge");
      const request = requests.shift()!;
      const response = reply(request);
      if (!drop?.(request)) await coordinator.receiveSourceReply(response);
    }
  };
  const quote = async (id: string, stakeMinor?: number) => {
    await coordinator.receiveRequest({
      action: "QUOTE", operation: identity(id), requestedAt: new Date().toISOString(),
      portion: stakeMinor === undefined ? { mode: "FULL" } : { mode: "PARTIAL", stakeMinor },
    });
    await pump();
    const record = await CashBackOperation.findOne({ operationId: id });
    if (!record?.quote) throw new Error("Missing quote");
    return record.quote;
  };
  const confirm = async (id: string, quoteId: string) => coordinator.receiveRequest({
    action: "CONFIRM", operation: identity(id), requestedAt: new Date().toISOString(), quoteId,
  });
  return { coordinator, requests, outcomes, source, outcome, generations, identity, reply, pump, quote, confirm, rows, place, settlementPublishers };
};

const prepareTerminalRelease = async () => {
  const state = await setup();
  const quote = await state.quote("release");
  await state.confirm("release", quote.quoteId);
  await state.pump(request => request.action === "RELEASE" && request.participant.owner === "GAMEMASTER");
  const pending = (await Bet.findOne({ slipId: "slip" }))?.cashBackPending;
  const obligation = pending?.obligations.find(item => !item.released);
  if (!pending?.receipt || !obligation?.releaseRequest) throw new Error("Missing terminal release obligation");
  const request = obligation.releaseRequest;
  const reply: Extract<CashBackSourceReply, { outcome: "FENCED" }> = {
    outcome: "FENCED", request, fenceGeneration: request.baseGeneration + 2,
    observedGeneration: request.baseGeneration + 2, observedAt: new Date().toISOString(),
  };
  return { state, request, reply, receipt: pending.receipt };
};

it("coordinates both owners in deterministic event order and conserves repeated partial/full principal", async () => {
  const state = await setup(2);
  const first = await state.quote("first", 4000);
  expect(first.returnMinor).toBe(4000);
  const snapshotRequests = state.source.mock.calls.map(([event]) => event.data)
    .filter(request => request.action === "SNAPSHOT");
  expect(snapshotRequests.map(request => request.participant)).toEqual([
    { eventId: "event-0", owner: "BACKOFFICE" }, { eventId: "event-0", owner: "GAMEMASTER" },
    { eventId: "event-1", owner: "BACKOFFICE" }, { eventId: "event-1", owner: "GAMEMASTER" },
  ]);
  await state.confirm("first", first.quoteId);
  await state.pump();
  let bet = await Bet.findOne({ slipId: "slip" });
  expect(bet?.cashBackFinancial).toMatchObject({
    status: BetStatus.CONFIRMED, originalStakeMinor: 10000, remainingStakeMinor: 6000,
    cumulativeClosedStakeMinor: 4000, cumulativeReturnMinor: 4000,
  });
  expect(bet?.wager).toBe(100);
  expect(bet?.rows.every(row => row.oddsValue === 3 && row.result === ResultingStatus.ROW_NO_RESULT)).toBe(true);
  const second = await state.quote("second", 1000);
  await state.confirm("second", second.quoteId);
  await state.pump();
  const full = await state.quote("full");
  expect(full.closedStakeMinor).toBe(5000);
  await state.confirm("full", full.quoteId);
  await state.pump();
  bet = await BetArchive.findOne({ slipId: "slip" });
  expect(bet?.status).toBe(ResultingStatus.BET_CASH_BACK);
  expect(bet?.cashBackFinancial).toMatchObject({
    originalStakeMinor: 10000, remainingStakeMinor: 0, cumulativeClosedStakeMinor: 10000,
    cumulativeReturnMinor: 10000,
  });
  expect(await Bet.countDocuments()).toBe(0);
  expect(await CashBackOperation.countDocuments({ stage: "TERMINAL", "outcome.outcome": "ACCEPTED" })).toBe(3);
});

it("replays one immutable terminal receipt on concurrent exact confirmation retries", async () => {
  const state = await setup();
  const quote = await state.quote("repeat", 1000);
  await Promise.all([state.confirm("repeat", quote.quoteId), state.confirm("repeat", quote.quoteId)]);
  await state.pump();
  const before = await CashBackOperation.findOne({ operationId: "repeat" });
  const financial = (await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial;
  await Promise.all([state.confirm("repeat", quote.quoteId), state.confirm("repeat", quote.quoteId)]);
  await state.pump();
  const after = await CashBackOperation.findOne({ operationId: "repeat" });
  expect(after?.outcome).toEqual(before?.outcome);
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial).toEqual(financial);
});

it("persists one unpredictable quote identity when two coordinators race and publishes only the CAS winner", async () => {
  const state = await setup();
  const request = {
    action: "QUOTE" as const, operation: state.identity("racing-quote"),
    requestedAt: new Date().toISOString(), portion: { mode: "PARTIAL" as const, stakeMinor: 1000 },
  };
  await state.coordinator.receiveRequest(request);
  const first = state.requests.shift();
  if (first?.action !== "SNAPSHOT") throw new Error("Missing first snapshot request");
  await state.coordinator.receiveSourceReply(state.reply(first));
  const last = state.requests.shift();
  if (last?.action !== "SNAPSHOT") throw new Error("Missing last snapshot request");
  await CashBackOperation.updateOne(
    { operationId: request.operation.operationId },
    { $push: { snapshotReplies: state.reply(last) } }
  );
  const competitor = new CashBackCoordinator(messengerWrapper.connection, {
    source: { initConfirmChannel: async () => {}, publishWithConfirm: state.source },
    outcome: { initConfirmChannel: async () => {}, publishWithConfirm: state.outcome },
  });
  const candidates: string[] = [];
  let reached!: () => void;
  let resume!: () => void;
  const bothReady = new Promise<void>(resolve => { reached = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const updateOne = CashBackOperation.updateOne.bind(CashBackOperation);
  const writes = jest.spyOn(CashBackOperation, "updateOne").mockImplementation((...args) => {
    const query = updateOne(...args);
    const update = args[1];
    if (update && !Array.isArray(update) && update.$set?.stage === "QUOTED") {
      const quote = update.$set.quote;
      const execute = query.exec.bind(query);
      jest.spyOn(query, "exec").mockImplementationOnce(async () => {
        if (!quote || typeof quote.quoteId !== "string") throw new Error("Missing candidate quote identity");
        candidates.push(quote.quoteId);
        if (candidates.length === 2) reached();
        await paused;
        return execute();
      });
    }
    return query;
  });
  const work = Promise.all([
    state.coordinator.advance(request.operation.operationId),
    competitor.advance(request.operation.operationId),
  ]);
  try {
    await Promise.race([bothReady, work.then(() => { throw new Error("Quote producers did not both reach the CAS"); })]);
    expect(new Set(candidates).size).toBe(2);
    expect((await CashBackOperation.findOne({ operationId: request.operation.operationId }))?.quote).toBeUndefined();
    expect(state.outcomes).toEqual([]);
  } finally {
    resume();
    try {
      await work;
    } finally {
      writes.mockRestore();
    }
  }
  const stored = await CashBackOperation.findOne({ operationId: request.operation.operationId });
  if (!stored?.quote) throw new Error("Missing winning quote");
  expect(candidates).toContain(stored.quote.quoteId);
  await Promise.all([state.coordinator.receiveRequest(request), competitor.receiveRequest(request)]);
  expect(await CashBackOperation.countDocuments({ operationId: request.operation.operationId })).toBe(1);
  expect((await CashBackOperation.findOne({ operationId: request.operation.operationId }))?.quote).toEqual(stored.quote);
  expect(state.outcomes.length).toBeGreaterThan(0);
  for (const outcome of state.outcomes) {
    expect(outcome.outcome).toBe("QUOTED");
    if (outcome.outcome === "QUOTED") expect(outcome.quote).toEqual(stored.quote);
  }
});

it("gives distinct operations opaque quote identities that cannot be derived from their public operation IDs", async () => {
  const state = await setup();
  const first = await state.quote("first-unpredictable", 1000);
  const second = await state.quote("second-unpredictable", 1000);
  for (const quote of [first, second]) {
    expect(quote.quoteId).toMatch(/^[a-f0-9]{64}$/);
    expect(quote.quoteId).not.toBe(cashBackHash([quote.operation.operationId, "quote"]));
  }
  expect(first.quoteId).not.toBe(second.quoteId);
});

it("replays a lost confirmation after quote expiry without replacing its persisted identity or closing twice", async () => {
  const state = await setup(1, 1000);
  const quote = await state.quote("late-confirmation", 1000);
  await state.confirm("late-confirmation", quote.quoteId);
  await state.pump();
  const before = await CashBackOperation.findOne({ operationId: "late-confirmation" });
  expect(before?.outcome?.outcome).toBe("ACCEPTED");
  const sourceCalls = state.source.mock.calls.length;
  const outcomeCalls = state.outcome.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(quote.expiresAt) - Date.now()) + 5));
  const restarted = new CashBackCoordinator(messengerWrapper.connection, {
    source: { initConfirmChannel: async () => {}, publishWithConfirm: state.source },
    outcome: { initConfirmChannel: async () => {}, publishWithConfirm: state.outcome },
  });
  await restarted.receiveRequest({
    action: "CONFIRM", operation: state.identity("late-confirmation"), quoteId: quote.quoteId,
    requestedAt: new Date().toISOString(),
  });
  await restarted.receiveRequest({
    action: "QUOTE", operation: state.identity("late-confirmation"), portion: { mode: "PARTIAL", stakeMinor: 1000 },
    requestedAt: new Date().toISOString(),
  });
  const after = await CashBackOperation.findOne({ operationId: "late-confirmation" });
  expect(after?.quote).toEqual(quote);
  expect(after?.outcome).toEqual(before?.outcome);
  expect(state.outcome.mock.calls.slice(outcomeCalls).map(([event]) => event.data))
    .toEqual([before?.outcome, before?.outcome]);
  expect(state.source.mock.calls.length).toBe(sourceCalls);
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial).toMatchObject({
    revision: 2, remainingStakeMinor: 9000, cumulativeClosedStakeMinor: 1000,
  });
});

it("checks the result ledger after exact grants, before deciding acceptance", async () => {
  const state = await setup();
  const quote = await state.quote("ledger", 1000);
  await state.confirm("ledger", quote.quoteId);
  await FinalScoreLedger.create({
    eventId: "event-0", occurredAt: new Date().toISOString(), homeScore: 1, awayScore: 0,
    home: "Home", away: "Away", correctScoreResult: "1 - 0", oneCrossTwoResult: "Home",
  });
  await state.pump();
  const operation = await CashBackOperation.findOne({ operationId: "ledger" });
  expect(operation?.outcome).toMatchObject({ outcome: "REJECTED", receipt: { reason: "SELECTION_RESOLVED" } });
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial?.remainingStakeMinor).toBe(10000);
});

it("normal result mutation consumes the same undecided slot and releases every requested participant", async () => {
  const state = await setup(2);
  const quote = await state.quote("result-first", 1000);
  await state.confirm("result-first", quote.quoteId);
  await processFinalScore(createFinalScoreEvent({
    eventId: "event-0", home: "Home", away: "Away", homeScore: 0, awayScore: 1,
  }), state.settlementPublishers);
  const decided = await Bet.findOne({ slipId: "slip" });
  expect(decided?.cashBackPending).toMatchObject({
    state: "REJECTED", receipt: { outcome: "REJECTED", reason: "SELECTION_RESOLVED" },
  });
  await state.coordinator.runOnce();
  await state.pump();
  expect(state.source.mock.calls.filter(([event]) => event.data.action === "RELEASE")
    .map(([event]) => event.data.participant)
    .filter((value, index, all) => all.findIndex(candidate => JSON.stringify(candidate) === JSON.stringify(value)) === index)
  ).toHaveLength(4);
});

it("settles only the remainder and keeps the original selection manifest", async () => {
  const state = await setup();
  const quote = await state.quote("partial", 4000);
  await state.confirm("partial", quote.quoteId);
  await state.pump();
  await processFinalScore(createFinalScoreEvent({
    eventId: "event-0", home: "Home", away: "Away", homeScore: 1, awayScore: 0,
  }), state.settlementPublishers);
  const archive = await BetArchive.findOne({ slipId: "slip" });
  expect(archive?.status).toBe(ResultingStatus.BET_WIN);
  expect(archive?.cashBackFinancial?.remainingStakeMinor).toBe(6000);
  expect(archive?.cashBackOriginalManifest?.selections).toHaveLength(1);
  expect(state.settlementPublishers.settleSlipPublisher.publishWithConfirm).toHaveBeenCalledWith({
    data: expect.objectContaining({ cashBack: expect.objectContaining({ settlementBasisStakeMinor: 6000 }) }),
  });
});

it("expires a held operation canonically and cancels the participant whose grant ACK was lost", async () => {
  const state = await setup(1, 1_000);
  const quote = await state.quote("lost-ack", 1000);
  await state.confirm("lost-ack", quote.quoteId);
  await state.pump(request => request.action === "RESERVE" && request.participant.owner === "GAMEMASTER");
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackPending?.state).toBe("UNDECIDED");
  await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(quote.expiresAt) - Date.now()) + 5));
  await state.coordinator.runOnce();
  await state.pump();
  const record = await CashBackOperation.findOne({ operationId: "lost-ack" });
  expect(record?.outcome).toMatchObject({ outcome: "REJECTED", receipt: { reason: "QUOTE_EXPIRED" } });
  expect([...state.generations.values()]).toEqual([2, 2]);
});

it.each<[string, "FENCED" | "RELEASED", string, unknown]>([
  ["missing observed generation", "FENCED", "observedGeneration", undefined],
  ["nonnumeric observed generation", "FENCED", "observedGeneration", "not-a-generation"],
  ["string observed generation", "FENCED", "observedGeneration", "2"],
  ["fractional observed generation", "FENCED", "observedGeneration", 2.5],
  ["unsafe observed generation", "FENCED", "observedGeneration", Number.MAX_SAFE_INTEGER + 1],
  ["observed generation below the fence", "FENCED", "observedGeneration", 1],
  ["missing fence generation", "FENCED", "fenceGeneration", undefined],
  ["fractional fence generation", "FENCED", "fenceGeneration", 2.5],
  ["unsafe fence generation", "RELEASED", "fenceGeneration", Number.MAX_SAFE_INTEGER + 1],
  ["string fence generation", "RELEASED", "fenceGeneration", "2"],
  ["missing observation time", "FENCED", "observedAt", undefined],
  ["invalid observation time", "FENCED", "observedAt", "not-a-time"],
  ["nonstring observation time", "FENCED", "observedAt", 0],
  ["normalized invalid observation date", "FENCED", "observedAt", "2026-02-30T00:00:00.000Z"],
  ["missing release decision time", "RELEASED", "decisionTime", undefined],
  ["invalid release decision time", "RELEASED", "decisionTime", "not-a-time"],
  ["nonstring release decision time", "RELEASED", "decisionTime", 0],
  ["normalized invalid release decision date", "RELEASED", "decisionTime", "2026-02-30T00:00:00.000Z"],
])("rejects a serialized release ACK with %s and retains durable recovery", async (_name, outcome, field, value) => {
  const { state, request, reply, receipt } = await prepareTerminalRelease();
  const valid: CashBackSourceReply = outcome === "FENCED" ? reply : {
    outcome: "RELEASED", request, fenceGeneration: reply.fenceGeneration, decisionTime: reply.observedAt,
  };
  const malformed = JSON.parse(JSON.stringify({ ...valid, [field]: value }));
  await expect(state.coordinator.receiveSourceReply(malformed)).rejects.toThrow("Invalid source cancellation fence");
  const pending = (await Bet.findOne({ slipId: "slip" }))?.cashBackPending;
  expect(pending).toMatchObject({ state: "ACCEPTED", receipt });
  expect(pending?.obligations.find(item => item.releaseRequest?.requestId === request.requestId)?.released).toBe(false);
  expect(await BetArchive.countDocuments()).toBe(0);
  const sent = state.source.mock.calls.length;
  await state.coordinator.runOnce();
  expect(state.source.mock.calls.slice(sent).map(([event]) => event.data)).toEqual([request]);
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackPending?.receipt).toEqual(receipt);
  expect(await BetArchive.countDocuments()).toBe(0);
  await state.coordinator.receiveSourceReply(JSON.parse(JSON.stringify(valid)));
  expect(await Bet.countDocuments()).toBe(0);
  expect(await BetArchive.countDocuments()).toBe(1);
  expect((await CashBackOperation.findOne({ operationId: "release" }))?.outcome)
    .toMatchObject({ outcome: "ACCEPTED", receipt });
});

it.each<[string, "FENCED" | "RELEASED", number]>([
  ["released hold", "RELEASED", 0],
  ["exact fence", "FENCED", 0],
  ["newer generation belonging to another hold", "FENCED", 1],
])("drains a valid %s ACK and replays it without another release", async (_name, outcome, generationOffset) => {
  const { state, request, reply, receipt } = await prepareTerminalRelease();
  const observedGeneration = reply.fenceGeneration + generationOffset;
  const sourceKey = `${request.participant.eventId}:${request.participant.owner}`;
  state.generations.set(sourceKey, observedGeneration);
  const valid: CashBackSourceReply = outcome === "RELEASED"
    ? { outcome: "RELEASED", request, fenceGeneration: reply.fenceGeneration, decisionTime: reply.observedAt }
    : { ...reply, observedGeneration };
  const sent = state.source.mock.calls.length;
  await state.coordinator.receiveSourceReply(JSON.parse(JSON.stringify(valid)));
  await state.coordinator.receiveSourceReply(JSON.parse(JSON.stringify(valid)));
  expect(await Bet.countDocuments()).toBe(0);
  expect(await BetArchive.countDocuments()).toBe(1);
  expect((await BetArchive.findOne({ slipId: "slip" }))?.cashBackPending).toBeUndefined();
  expect((await CashBackOperation.findOne({ operationId: "release" }))?.outcome)
    .toMatchObject({ outcome: "ACCEPTED", receipt });
  expect(state.source.mock.calls.length).toBe(sent);
  expect(state.generations.get(sourceKey)).toBe(observedGeneration);
});

it("rejects valid fence evidence when its serialized request differs from the persisted terminal decision", async () => {
  const { state, request, reply, receipt } = await prepareTerminalRelease();
  const changed = JSON.parse(JSON.stringify(reply));
  changed.request.decision.receiptFingerprint = "different-terminal-receipt";
  await expect(state.coordinator.receiveSourceReply(changed)).rejects.toThrow("Release reply binding mismatch");
  const pending = (await Bet.findOne({ slipId: "slip" }))?.cashBackPending;
  expect(pending?.receipt).toEqual(receipt);
  expect(pending?.obligations.find(item => item.releaseRequest?.requestId === request.requestId)?.released).toBe(false);
  expect(await BetArchive.countDocuments()).toBe(0);
});

it("recovers publication from the canonical winner after a failed confirm send", async () => {
  const state = await setup();
  const quote = await state.quote("publication", 1000);
  await state.confirm("publication", quote.quoteId);
  state.outcome.mockRejectedValueOnce(new Error("outcome unavailable"));
  await expect(state.pump()).rejects.toThrow("outcome unavailable");
  const canonical = (await Bet.findOne({ slipId: "slip" }))?.cashBackPending?.receipt;
  expect(canonical?.outcome).toBe("ACCEPTED");
  const restarted = new CashBackCoordinator(messengerWrapper.connection, {
    source: { initConfirmChannel: async () => {}, publishWithConfirm: state.source },
    outcome: { initConfirmChannel: async () => {}, publishWithConfirm: state.outcome },
  });
  await restarted.runOnce();
  await state.pump();
  expect((await CashBackOperation.findOne({ operationId: "publication" }))?.outcome)
    .toMatchObject({ outcome: "ACCEPTED", receipt: canonical });
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial?.remainingStakeMinor).toBe(9000);
});

it("recovers published-but-unarchived full closure without republishing or reopening it", async () => {
  const state = await setup();
  const quote = await state.quote("archive");
  await state.confirm("archive", quote.quoteId);
  const archiveFailure = jest.spyOn(BetArchive, "updateOne").mockRejectedValueOnce(new Error("archive unavailable"));
  await expect(state.pump()).rejects.toThrow("archive unavailable");
  archiveFailure.mockRestore();
  const active = await Bet.findOne({ slipId: "slip" });
  expect(active?.status).toBe(ResultingStatus.BET_CASH_BACK);
  expect(active?.cashBackPending).toBeUndefined();
  const sent = state.outcome.mock.calls.length;
  await state.coordinator.runOnce();
  expect(state.outcome.mock.calls.length).toBe(sent);
  expect(await Bet.countDocuments()).toBe(0);
  const archived = await BetArchive.findOne({ slipId: "slip" });
  expect(archived?.cashBackFinancial?.remainingStakeMinor).toBe(0);
  expect(archived?.cashBackArchiving).toBeUndefined();
});

it("retains removed-void original legs and denies a new offer despite surviving unresolved rows", async () => {
  const state = await setup();
  await Bet.deleteMany({});
  const one = createLiveRow({ eventId: "live-one", marketType: LiveMarketType.NEXT_CORNER });
  const two = createLiveRow({ eventId: "live-two", marketType: LiveMarketType.NEXT_CORNER });
  const placed = createPlaceBetEvent({ userId: "owner", slipId: "slip", wager: 100, betKind: BetKind.LIVE, rows: [one, two] });
  await upsertPlaceBet(placed, state.settlementPublishers);
  await applyModerationResult(createModerationEvent("slip"), state.settlementPublishers);
  await processLiveUpdate({ data: {
    eventId: one.eventId, sequence: 1, occurredAt: new Date().toISOString(),
    kickoffAt: new Date(Date.now() - 1000).toISOString(), minute: 1,
    phase: EventPhase.FIRST_HALF, homeScore: 0, awayScore: 0, bettingStatus: BettingStatus.OPEN,
    markets: [{
      marketId: one.marketId!, marketType: LiveMarketType.NEXT_CORNER, marketVersion: 1,
      quoteVersion: 1, status: LiveMarketStatus.SETTLED,
      selections: [{ selectionId: one.selectionId!, side: TeamSide.HOME, odds: 2.2 }],
    }],
    settlements: [{
      marketId: one.marketId!, marketVersion: 1, settlementSequence: 1,
      settlementReason: LiveSettlementReason.MANUAL_VOID, winningSide: TeamSide.NONE,
    }],
  } }, state.settlementPublishers);
  const bet = await Bet.findOne({ slipId: "slip" });
  expect(bet?.rows).toHaveLength(1);
  expect(bet?.cashBackOriginalManifest?.selections).toHaveLength(2);
  expect(bet?.cashBackAnySelectionResolved).toBe(true);
  await state.coordinator.receiveRequest({
    action: "QUOTE", operation: { ...state.identity("removed"), betKind: BetKind.LIVE },
    requestedAt: new Date().toISOString(), portion: { mode: "FULL" },
  });
  expect((await CashBackOperation.findOne({ operationId: "removed" }))?.outcome)
    .toMatchObject({ outcome: "UNAVAILABLE", reason: "SELECTION_RESOLVED" });
});

it("does not resurrect exposure when a duplicate placement races canonical archival", async () => {
  const state = await setup();
  let reached!: () => void;
  let resume!: () => void;
  const observed = new Promise<void>(resolve => { reached = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const exists = BetArchive.exists.bind(BetArchive);
  const archiveRead = jest.spyOn(BetArchive, "exists").mockImplementationOnce(filter => {
    const query = exists(filter);
    const execute = query.exec.bind(query);
    jest.spyOn(query, "exec").mockImplementationOnce(async () => {
      const value = await execute();
      reached();
      await paused;
      return value;
    });
    return query;
  });
  const duplicate = upsertPlaceBet(state.place, state.settlementPublishers);
  await observed;
  try {
    const quote = await state.quote("retirement");
    await state.confirm("retirement", quote.quoteId);
    await state.pump();
    expect(await Bet.countDocuments()).toBe(0);
  } finally {
    resume();
  }
  await duplicate;
  archiveRead.mockRestore();
  expect(await Bet.countDocuments()).toBe(0);
  expect((await BetArchive.findOne({ slipId: "slip" }))?.status).toBe(ResultingStatus.BET_CASH_BACK);
});

it("prices original live selections from exact current quote identities without changing accepted odds", async () => {
  const state = await setup(2, 60_000, BetKind.LIVE);
  const quote = await state.quote("live", 4000);
  expect(quote).toMatchObject({
    acceptedCombinedOdds: "9", currentCombinedOdds: "36", returnMinor: 1000,
    closedStakeMinor: 4000, remainingStakeMinorAfter: 6000,
  });
  const stored = await CashBackOperation.findOne({ operationId: "live" });
  expect(stored?.evidence?.currentQuotes.map(selection => ({
    slipRowId: selection.slipRowId, oddsId: selection.oddsId, odds: selection.odds,
  }))).toEqual(state.rows.map(row => ({ slipRowId: row.id, oddsId: row.oddsId, odds: "6" })));
  await state.confirm("live", quote.quoteId);
  await state.pump();
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackFinancial).toMatchObject({
    status: BetStatus.CONFIRMED, remainingStakeMinor: 6000,
    cumulativeClosedStakeMinor: 4000, cumulativeReturnMinor: 1000,
  });
  expect((await Bet.findOne({ slipId: "slip" }))?.rows.map(row => row.oddsValue)).toEqual([3, 3]);
});

it.each<[CashBackSourceDenialReason, CashBackUnavailableReason]>([
  ["RESOLVED", "SELECTION_RESOLVED"],
  ["DEADLINE_REACHED", "PRE_MATCH_CUTOFF"],
  ["SUSPENDED", "MARKET_UNAVAILABLE"],
  ["QUOTE_CHANGED", "MARKET_UNAVAILABLE"],
  ["UNKNOWN_AUTHORITY", "AUTHORITY_UNAVAILABLE"],
])("reports a %s snapshot as %s without registering an undecided operation", async (reason, expected) => {
  const state = await setup();
  await state.coordinator.receiveRequest({
    action: "QUOTE", operation: state.identity("unavailable"),
    requestedAt: new Date().toISOString(), portion: { mode: "FULL" },
  });
  const snapshot = state.requests.shift();
  if (snapshot?.action !== "SNAPSHOT") throw new Error("Missing snapshot obligation");
  await state.coordinator.receiveSourceReply({
    outcome: "DENIED", request: snapshot, reason, observedAt: new Date().toISOString(),
  });
  expect((await CashBackOperation.findOne({ operationId: "unavailable" }))?.outcome)
    .toMatchObject({ outcome: "UNAVAILABLE", reason: expected });
  const bet = await Bet.findOne({ slipId: "slip" });
  expect(bet?.cashBackPending).toBeUndefined();
  expect(bet?.cashBackFinancial).toMatchObject({ revision: 1, remainingStakeMinor: 10000, cumulativeClosedStakeMinor: 0 });
  expect(state.source.mock.calls.every(([event]) => event.data.action === "SNAPSHOT")).toBe(true);
});

it.each<[CashBackSourceDenialReason, CashBackUnavailableReason]>([
  ["DEADLINE_REACHED", "QUOTE_CHANGED"],
  ["AUTHORITY_CHANGED", "QUOTE_CHANGED"],
  ["RESOLVED", "SELECTION_RESOLVED"],
  ["SUSPENDED", "MARKET_UNAVAILABLE"],
  ["MISSING", "AUTHORITY_UNAVAILABLE"],
  ["CONTENDED", "RESERVATION_DENIED"],
])("canonically rejects %s reservation denial as %s and drains every cancellation", async (reason, expected) => {
  const state = await setup();
  const quote = await state.quote("denied", 1000);
  await state.confirm("denied", quote.quoteId);
  const reserve = state.requests.shift();
  if (reserve?.action !== "RESERVE") throw new Error("Missing durable reservation request");
  await state.coordinator.receiveSourceReply({
    outcome: "DENIED", request: reserve, reason, observedAt: new Date().toISOString(),
  });
  const bet = await Bet.findOne({ slipId: "slip" });
  expect(bet?.cashBackPending).toMatchObject({
    state: "REJECTED", receipt: { outcome: "REJECTED", reason: expected },
  });
  expect(bet?.cashBackFinancial).toMatchObject({
    revision: 2, remainingStakeMinor: 10000, cumulativeClosedStakeMinor: 0, cumulativeReturnMinor: 0,
  });
  const receipt = bet?.cashBackPending?.receipt;
  await state.pump();
  expect((await Bet.findOne({ slipId: "slip" }))?.cashBackPending).toBeUndefined();
  expect((await CashBackOperation.findOne({ operationId: "denied" }))?.outcome)
    .toMatchObject({ outcome: "REJECTED", receipt });
  expect([...state.generations.values()]).toEqual([2, 2]);
});
