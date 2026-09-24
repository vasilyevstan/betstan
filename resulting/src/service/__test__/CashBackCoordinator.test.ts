import {
  BetKind, BetStatus, BettingStatus, CashBackOperationIdentity, CashBackSourceReply,
  CashBackSourceRequest, CashBackSourceEvidence, EventPhase, EventStatus, EventVisibility,
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

const publishers = () => ({
  settleSlipPublisher: new SettleSlipPublisher(messengerWrapper.connection),
  settleSlipRowPublisher: new SettleSlipRowPublisher(messengerWrapper.connection),
});

const setup = async (eventCount = 1, cutoffMs = 60_000) => {
  const kickoff = new Date(Date.now() + cutoffMs).toISOString();
  const rows = Array.from({ length: eventCount }, (_, index) => createPreMatchRow({
    eventId: `event-${index}`, eventTime: kickoff, oddsValue: 3,
  }));
  const place = createPlaceBetEvent({
    userId: "owner", slipId: "slip", wager: 100, betKind: BetKind.PRE_MATCH, rows,
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
    userId: "owner", slipId: "slip", betKind: BetKind.PRE_MATCH,
  });
  const reply = (request: CashBackSourceRequest): CashBackSourceReply => {
    const key = `${request.participant.eventId}:${request.participant.owner}`;
    if (request.action === "SNAPSHOT") {
      const base = {
        eventId: request.participant.eventId, authorityFingerprint: key,
        occurredAt: new Date().toISOString(), kickoffAt: kickoff, cutoffAt: kickoff,
      };
      const evidence: CashBackSourceEvidence = request.participant.owner === "BACKOFFICE"
        ? {
            ...base, owner: "BACKOFFICE" as const,
            lifecycle: { status: EventStatus.NO_RESULT as const, visibility: EventVisibility.ONLINE },
            quoteEvidence: { kind: "LIFECYCLE_ONLY" as const },
          }
        : {
            ...base, owner: "GAMEMASTER" as const,
            lifecycle: { status: EventStatus.NO_RESULT as const, phase: EventPhase.PRE_MATCH as const,
              bettingStatus: BettingStatus.OPEN, sequence: 0 },
            quoteEvidence: { kind: "PRE_MATCH_STATIC" as const },
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
