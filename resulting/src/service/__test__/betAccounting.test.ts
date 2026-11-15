import { assertBetAccountingEvidence, BetKind, BetAccountingEvidence, LiveMarketType, LiveSettlementReason, MarketBet, messengerWrapper, ResultingStatus, TeamSide } from "@betstan/common";
import { Bet, BetArchive } from "../../model/Bet";
import FinalScoreLedger from "../../model/FinalScoreLedger";
import SettleSlipPublisher from "../../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../event/publisher/SettleSlipRowPublisher";
import {
  createFinalScoreEvent, createLiveRow, createLiveSettlement, createLiveUpdateEvent,
  createModerationEvent, createPlaceBetEvent, createPreMatchRow, setupPublisherSpies,
} from "../../test/resultingTestUtils";
import { accountingClosureState, accountingPlacementState, appendAccountingMovement, terminalAccounting, terminalAccountingState } from "../betAccounting";
import { AccountingMovement, retainAccountingHistory } from "../accountingHistory";
import { applyModerationResult, processFinalScore, processLiveUpdate, reconcileSlip, upsertPlaceBet } from "../resulting";
import { runAccountingExportCommand } from "../../scripts/exportAccounting";
import {
  acknowledgeAccountingExportPage, AccountingExport, beginAccountingExport, readAccountingExportPage,
} from "../accountingExport";

const publishers = () => ({
  settleSlipPublisher: new SettleSlipPublisher(messengerWrapper.connection),
  settleSlipRowPublisher: new SettleSlipRowPublisher(messengerWrapper.connection),
});
const time = "2026-01-02T00:00:00.000Z";
const movements = (value: BetAccountingEvidence) => {
  expect(value.status).toBe("COMPLETE");
  if (value.status !== "COMPLETE") throw new Error("Expected complete accounting");
  return value.movements;
};
setupPublisherSpies();
afterEach(() => jest.restoreAllMocks());
beforeAll(async () => { await AccountingExport.init(); });

it("closes one principal after all rows; floors once and uses source economic time across retries", async () => {
  const rows = ["a", "b"].map(eventId => createPreMatchRow({ eventId, oddsName: "Home", oddsValue: 1.5 }));
  const input = createPlaceBetEvent({ wager: 0.01, rows });
  const pub = publishers();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  await processFinalScore({ data: { ...createFinalScoreEvent({ eventId: "a", home: "Home" }).data, occurredAt: time } }, pub);
  expect(movements((await Bet.findOne({ slipId: input.data.slipId }))!.accounting)).toHaveLength(0);
  const event = { data: { ...createFinalScoreEvent({ eventId: "b", home: "Home" }).data, occurredAt: time } };
  await processFinalScore(event, pub);
  await processFinalScore({ ...event, timestamp: "2099-01-01T00:00:00.000Z" }, pub);
  const archived = await BetArchive.findOne({ slipId: input.data.slipId });
  expect(movements(archived!.accounting)).toEqual([expect.objectContaining({
    revision: 1, closedStakeMinor: 1, returnMinor: 2, remainingStakeMinor: 0,
    originalStakeMinor: 1, source: "SETTLEMENT", occurredAt: time,
  })]);
  expect(archived!.wager).toBe(0.01);
  expect(archived!.rows.map(row => row.oddsValue)).toEqual([1.5, 1.5]);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(2);
});

it("persists exact movement with terminal transition/outbox before ambiguous confirmation; replay archives unchanged", async () => {
  const input = createPlaceBetEvent({ rows: [createPreMatchRow({ eventId: "a", oddsName: "Away" })] });
  const pub = publishers();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  const publish = SettleSlipPublisher.prototype.publishWithConfirm as jest.Mock;
  publish.mockRejectedValueOnce(new Error("confirm lost after broker accepted"));
  const event = { data: { ...createFinalScoreEvent({ eventId: "a", home: "Home" }).data, occurredAt: time } };
  await expect(processFinalScore(event, pub)).rejects.toThrow("confirm lost");
  const persisted = await Bet.findOne({ slipId: input.data.slipId });
  expect(persisted!.status).toBe(ResultingStatus.BET_LOSS);
  expect(persisted!.terminalPublicationState).toBe("PENDING");
  const accounting = persisted!.accounting;
  expect(movements(accounting)).toEqual([expect.objectContaining({
    closedStakeMinor: 1000, returnMinor: 0, remainingStakeMinor: 0, occurredAt: time,
  })]);
  await Promise.all([reconcileSlip(input.data.slipId, publishers()), reconcileSlip(input.data.slipId, publishers())]);
  expect(publish).toHaveBeenCalledTimes(2); // ambiguous delivery can duplicate identical evidence
  expect(publish.mock.calls[0][0].data).toEqual(publish.mock.calls[1][0].data);
  expect((await BetArchive.findOne({ slipId: input.data.slipId }))!.accounting).toEqual(accounting);
});

it("retains legacy high-precision decisions, explicitly unavailable instead of rounded zero history", async () => {
  process.env.CASH_BACK_ENABLED = "false";
  const input = createPlaceBetEvent({ wager: 1.001, rows: [createPreMatchRow({ eventId: "a", oddsName: "Home" })] });
  const pub = publishers();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  await processFinalScore(createFinalScoreEvent({ eventId: "a", home: "Home" }), pub);
  const archived = await BetArchive.findOne({ slipId: input.data.slipId });
  expect(archived!.status).toBe(ResultingStatus.BET_WIN);
  expect(archived!.wager).toBe(1.001);
  expect(archived!.accounting).toEqual({
    schemaVersion: 1, status: "UNAVAILABLE", reason: "LEGACY_PRECISION_UNSUPPORTED",
  });
  const ledger = await FinalScoreLedger.findOne({ eventId: "a" });
  expect(ledger!.timeBasis).toBe("SOURCE");
  const originalTime = ledger!.occurredAt;
  await processFinalScore({ ...createFinalScoreEvent({ eventId: "a", home: "Home" }), timestamp: "2099-01-01T00:00:00.000Z" }, pub);
  expect((await FinalScoreLedger.findOne({ eventId: "a" }))!.occurredAt).toBe(originalTime);
});

it("missing old economic time never becomes a newly dated credit, even after delayed republication", async () => {
  const pub = publishers();
  const input = createPlaceBetEvent({ rows: [createPreMatchRow({ eventId: "legacy-time", oddsName: "Home" })] });
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  const event = createFinalScoreEvent({ eventId: "legacy-time", home: "Home" });
  delete event.data.occurredAt;
  event.timestamp = "2099-01-01T00:00:00.000Z";
  await processFinalScore(event, pub);
  const archived = await BetArchive.findOne({ slipId: input.data.slipId });
  expect(archived!.status).toBe(ResultingStatus.BET_WIN); // legacy decision preserved
  expect(archived!.accounting).toEqual({ schemaVersion: 1, status: "UNAVAILABLE", reason: "HISTORY_MISSING" });
  expect(await AccountingMovement.countDocuments()).toBe(0);
  expect((await FinalScoreLedger.findOne({ eventId: "legacy-time" }))!.timeBasis).toBe("LEGACY_FIRST_RECEIPT");
  await processFinalScore({ data: { ...event.data, occurredAt: time } }, pub);
  expect((await BetArchive.findOne({ slipId: input.data.slipId }))!.accounting).toEqual(archived!.accounting);
  expect(await AccountingMovement.countDocuments()).toBe(0);
});

it.each([ResultingStatus.BET_WIN, ResultingStatus.BET_LOSS, ResultingStatus.BET_VOID])(
  "partial movement plus terminal %s closes only the remainder and preserves signed returns", status => {
    const input = createPlaceBetEvent({ userId: "owner", slipId: "ticket", wager: 10,
      rows: [createPreMatchRow({ id: "row", oddsValue: 3 })] });
    const state = { ...accountingPlacementState(input.data), slipId: "ticket", userId: "owner" };
    const partial = appendAccountingMovement(state, "CASH_BACK", 400, 600, time);
    const after = { ...state, accounting: partial };
    const terminal = terminalAccounting(after, status, [{
      id: "row", oddsValue: 3,
      result: status === ResultingStatus.BET_WIN ? ResultingStatus.ROW_WIN
        : status === ResultingStatus.BET_LOSS ? ResultingStatus.ROW_LOSS : ResultingStatus.ROW_VOID,
    }], "2026-01-03T00:00:00.000Z");
    const items = movements(terminal);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual(movements(partial)[0]);
    expect(items[1]).toMatchObject({
      revision: 2, closedStakeMinor: 600, remainingStakeMinor: 0,
      returnMinor: status === ResultingStatus.BET_WIN ? 1800 : status === ResultingStatus.BET_LOSS ? 0 : 600,
    });
  }
);

it("whole Builder void removes only its composite factor, preserves independent row and rejects unexplained disappearance", () => {
  const quote: MarketBet = {
    schemaVersion: 1, kind: "BUILDER", eventId: "builder-event", quoteId: "quote", odds: 3.75,
    modelId: "model", issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T00:00:30.000Z",
    selections: ["one", "two"].map(marketId => ({
      origin: "TEMPLATE", marketId, outcomeKey: "yes", rulesRevision: 1, quoteRevision: 1,
      templateId: "template", templateVersion: 1, marketName: "Misleading 1X2", label: "Home",
      terms: "", settlementMode: "FINAL_SCORE", pricingMethod: "SCORE_MODEL",
      rule: { kind: "COMPARE", metric: "TOTAL_GOALS", comparison: "GT", value: 0.5 },
    })) as MarketBet["selections"],
  };
  const input = createPlaceBetEvent({
    slipId: "ticket", userId: "owner", rows: [
      { ...createPreMatchRow({ id: "builder", eventId: quote.eventId, oddsValue: quote.odds }), marketBet: quote },
      createPreMatchRow({ id: "independent", eventId: "another-event", oddsValue: 2 }),
    ],
  });
  const state = { ...accountingPlacementState(input.data), slipId: "ticket", userId: "owner" };
  expect(state.accountingPayoutBound!.maximumReturnMinor).toBe(7500);
  const rows = [
    { id: "builder", oddsValue: 3.75, result: ResultingStatus.ROW_VOID },
    { id: "independent", oddsValue: 2, result: ResultingStatus.ROW_WIN },
  ];
  expect(movements(terminalAccounting(state, ResultingStatus.BET_WIN, rows, time))[0].returnMinor).toBe(2000);
  expect(input.data.rows[0].marketBet!.selections).toHaveLength(2);
  expect(terminalAccounting(state, ResultingStatus.BET_WIN, rows.slice(1), time)).toMatchObject({
    status: "UNAVAILABLE", reason: "AUTHORITY_UNAVAILABLE",
  });
});

it("source-owned export persists the same page across restart/active archive changes, ack is idempotent", async () => {
  const pub = publishers();
  const first = createPlaceBetEvent({ slipId: "first", rows: [createPreMatchRow({ eventId: "a", oddsName: "Home" })] });
  await upsertPlaceBet(first, pub);
  // A historical record without accounting must remain visible as missing, not omitted.
  await BetArchive.create({
    slipId: "legacy", userId: "owner", wager: 1, timestamp: time,
    betKind: BetKind.PRE_MATCH, status: ResultingStatus.BET_LOSS, rows: [],
  });
  await Promise.all([beginAccountingExport("reconciliation"), beginAccountingExport("reconciliation")]);
  const [page, concurrentPage] = await Promise.all([
    readAccountingExportPage("reconciliation"), readAccountingExportPage("reconciliation"),
  ]);
  expect(page).toEqual(concurrentPage);
  expect(page!.page).toBe(1);
  expect(page!.entries.map(item => item.slipId)).toEqual(["first"]);
  await applyModerationResult(createModerationEvent("first"), pub);
  await processFinalScore(createFinalScoreEvent({ eventId: "a", home: "Home" }), pub);
  expect(await readAccountingExportPage("reconciliation")).toEqual(page);
  await acknowledgeAccountingExportPage("reconciliation", 1);
  await acknowledgeAccountingExportPage("reconciliation", 1);
  const archivePage = await readAccountingExportPage("reconciliation");
  expect(archivePage!.watermark).toEqual(page!.watermark);
  expect(archivePage!.bookCompleteness).toBe("NOT_ATTESTED");
  expect(archivePage!.entries.find(item => item.slipId === "legacy")!.accounting).toMatchObject({
    status: "UNAVAILABLE", reason: "HISTORY_MISSING",
  });
  expect(archivePage!.scanFinished).toBe(true);
  await acknowledgeAccountingExportPage("reconciliation", 2);
  expect(await readAccountingExportPage("reconciliation")).toBeNull();
});

it("a manual void followed by a loss in one source update still archives one monetary closure", async () => {
  const first = createLiveRow({ eventId: "live", marketType: LiveMarketType.NEXT_CORNER });
  const second = createLiveRow({ eventId: "live", marketType: LiveMarketType.NEXT_FREE_KICK });
  const input = createPlaceBetEvent({ rows: [first, second] });
  const pub = publishers();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  await processLiveUpdate(createLiveUpdateEvent({
    eventId: "live", occurredAt: time, settlements: [
      createLiveSettlement({ eventId: "live", marketId: first.marketId, settlementReason: LiveSettlementReason.MANUAL_VOID }),
      createLiveSettlement({ eventId: "live", marketId: second.marketId, winningSide: TeamSide.AWAY }),
    ],
  }), pub);
  const archived = await BetArchive.findOne({ slipId: input.data.slipId });
  expect(archived!.status).toBe(ResultingStatus.BET_LOSS);
  expect(archived!.rows.map(row => row.id)).toEqual([second.id]);
  expect(archived!.accountingRemovedVoidRowIds).toEqual([first.id]);
  expect(movements(archived!.accounting)).toEqual([expect.objectContaining({
    closedStakeMinor: 1000, returnMinor: 0, remainingStakeMinor: 0, source: "SETTLEMENT",
  })]);
});

it("bounded inline prefixes spill to immutable paged history without a partial-operation cap or principal undercount", async () => {
  const input = createPlaceBetEvent({
    slipId: "many-partials", userId: "owner", wager: 10,
    rows: [createPreMatchRow({ id: "row", oddsValue: 2 })],
  });
  let state: Parameters<typeof accountingClosureState>[0] = {
    ...accountingPlacementState(input.data), slipId: input.data.slipId, userId: input.data.userId,
  };
  for (let index = 0; index < 600; index++) {
    const update = accountingClosureState(state, "CASH_BACK", 1, 1, time);
    expect(update.accountingLastMovement!.revision).toBe(index + 1);
    await retainAccountingHistory(update.accounting, update.accountingLastMovement);
    state = { ...state, ...update };
  }
  expect(state.accountingPrefixTruncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(4096);
  const terminal = terminalAccountingState(state, ResultingStatus.BET_WIN, [
    { id: "row", result: ResultingStatus.ROW_WIN, oddsValue: 2 },
  ], time);
  expect(terminal.accountingLastMovement).toMatchObject({
    revision: 601, closedStakeMinor: 400, returnMinor: 800, remainingStakeMinor: 0,
  });
  await retainAccountingHistory(terminal.accounting, terminal.accountingLastMovement);
  await BetArchive.create({
    slipId: input.data.slipId, userId: input.data.userId, wager: 10, timestamp: time,
    status: ResultingStatus.BET_WIN, rows: [], ...terminal, accountingBasis: state.accountingBasis,
  });
  await beginAccountingExport("paged-history");
  const seen = new Map<string, NonNullable<typeof terminal.accountingLastMovement>>();
  let count = 0;
  for (;;) {
    const page = await readAccountingExportPage("paged-history");
    if (!page) break;
    expect(page.bookCompleteness).toBe("NOT_ATTESTED");
    for (const entry of page.entries) {
      if (entry.history) expect(entry.history).toMatchObject({ expectedRevision: 601, representation: "PAGED" });
      for (const movement of [...(entry.canonicalMovements ?? []), ...(entry.movement ? [entry.movement] : [])]) {
        if (seen.has(movement.movementId)) expect(seen.get(movement.movementId)).toEqual(movement);
        seen.set(movement.movementId, movement);
      }
    }
    expect(await readAccountingExportPage("paged-history")).toEqual(page);
    await acknowledgeAccountingExportPage("paged-history", page.page);
    if (++count > 20) throw new Error("Export cursor did not progress");
  }
  const ordered = [...seen.values()].sort((a, b) => a.revision - b.revision);
  assertBetAccountingEvidence({ schemaVersion: 1, status: "COMPLETE", movements: ordered });
  expect(ordered).toHaveLength(601);
  expect(ordered.reduce((total, item) => total + item.closedStakeMinor, 0)).toBe(1000);
  expect(ordered.reduce((total, item) => total + item.returnMinor, 0)).toBe(1400);
});

it("history projection failure retains canonical transition/outbox; restart and concurrent retries retain one exact movement", async () => {
  const input = createPlaceBetEvent({ rows: [createPreMatchRow({ eventId: "a", oddsName: "Home" })] });
  const pub = publishers();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  const failure = jest.spyOn(AccountingMovement, "updateOne").mockRejectedValueOnce(new Error("history unavailable"));
  await expect(processFinalScore(createFinalScoreEvent({ eventId: "a", home: "Home", occurredAt: time }), pub))
    .rejects.toThrow("history unavailable");
  failure.mockRestore();
  const canonical = await Bet.findOne({ slipId: input.data.slipId });
  expect(canonical!.status).toBe(ResultingStatus.BET_WIN);
  expect(canonical!.terminalPublicationState).toBe("PENDING");
  expect(canonical!.accountingLastMovement).toMatchObject({ returnMinor: 1500, occurredAt: time });
  expect(SettleSlipPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
  await Promise.all([reconcileSlip(input.data.slipId, pub), reconcileSlip(input.data.slipId, pub)]);
  expect(await AccountingMovement.countDocuments()).toBe(1);
  expect((await BetArchive.findOne({ slipId: input.data.slipId }))!.accountingLastMovement).toEqual(canonical!.accountingLastMovement);
  await expect(retainAccountingHistory(undefined, { ...canonical!.accountingLastMovement, returnMinor: 1501 }))
    .rejects.toThrow("Conflicting immutable");
});

it("concurrent losing source rows contend on the canonical Bet and close principal only once", async () => {
  const rows = ["a", "b"].map(eventId => createPreMatchRow({ eventId, oddsName: "Away" }));
  const input = createPlaceBetEvent({ rows });
  const pub = publishers();
  await upsertPlaceBet(input, pub);
  await applyModerationResult(createModerationEvent(input.data.slipId), pub);
  await Promise.all(rows.map(row => processFinalScore(
    createFinalScoreEvent({ eventId: row.eventId, home: "Home", occurredAt: time }), pub
  )));
  const archived = await BetArchive.findOne({ slipId: input.data.slipId });
  expect(movements(archived!.accounting)).toEqual([expect.objectContaining({
    closedStakeMinor: 1000, returnMinor: 0, revision: 1, remainingStakeMinor: 0,
  })]);
  expect(await AccountingMovement.countDocuments()).toBe(1);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("private export command validates identities and replays durable pages without source-domain mutation", async () => {
  await expect(runAccountingExportCommand(["begin", "../unsafe"])).rejects.toThrow("Usage");
  await expect(runAccountingExportCommand(["ack", "job", "1.5"])).rejects.toThrow("Usage");
  await expect(runAccountingExportCommand(["begin", "job"])).resolves.toEqual({ exportId: "job", started: true });
  const first = await runAccountingExportCommand(["read", "job"]);
  expect(await runAccountingExportCommand(["read", "job"])).toEqual(first);
  await expect(runAccountingExportCommand(["ack", "job", "2"])).rejects.toThrow("conflict");
  await runAccountingExportCommand(["ack", "job", "1"]);
  expect(await Bet.countDocuments()).toBe(0);
  expect(await BetArchive.countDocuments()).toBe(0);
});
