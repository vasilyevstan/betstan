import {
  BetKind,
  LiveSettlementReason,
  ModerationStatus,
  ResultingStatus,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import EventResultListener from "../EventResultListener";
import ModerationResultListener from "../ModerationResultListener";
import { Bet, BetArchive } from "../../../model/Bet";
import FinalScoreLedger from "../../../model/FinalScoreLedger";
import LiveSettlementLedger from "../../../model/LiveSettlementLedger";
import PendingModerationResult from "../../../model/PendingModerationResult";
import SettleSlipPublisher from "../../publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../publisher/SettleSlipRowPublisher";
import {
  createBet,
  createFinalScoreEvent,
  createLiveRow,
  createMessage,
  createModerationEvent,
  createPreMatchRow,
  setupPublisherSpies,
} from "../../../test/resultingTestUtils";

setupPublisherSpies();

const setup = async () => {
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

const setupEventResultListener = async () => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

it("approves pending live bets and replays stored settlements", async () => {
  const row = createLiveRow({ side: TeamSide.HOME });
  const bet = await createBet({
    betKind: BetKind.LIVE,
    status: ResultingStatus.BET_PENDING,
    rows: [row],
  });
  await LiveSettlementLedger.create({
    eventId: row.eventId,
    occurredAt: "2026-08-20T17:00:00.000Z",
    marketId: row.marketId,
    marketType: row.marketType,
    marketVersion: row.marketVersion,
    settlementReason: LiveSettlementReason.INCIDENT,
    settlementSequence: 9,
    winningSide: TeamSide.HOME,
    winningSelection: row.selectionId,
  });
  const listener = await setup();

  await listener.onMessage(
    createModerationEvent(bet.slipId, ModerationStatus.APPROVED, {
      betKind: BetKind.LIVE,
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });

  expect(await Bet.findOne({ slipId: bet.slipId })).toBeNull();
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(listener.ack).toHaveBeenCalled();
});

it("replays final scores when approval arrives after EVENT_RESULT and a listener restart", async () => {
  const row = createPreMatchRow({
    eventId: "late-approval-event",
    oddsName: "Home Team",
  });
  const bet = await createBet({
    rows: [row],
    status: ResultingStatus.BET_PENDING,
  });
  const eventResultListener = await setupEventResultListener();

  await eventResultListener.onMessage(
    createFinalScoreEvent({
      eventId: row.eventId,
      homeScore: 2,
      awayScore: 0,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  expect(await FinalScoreLedger.countDocuments({ eventId: row.eventId })).toEqual(1);
  expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();

  const moderationListener = await setup();
  await moderationListener.onMessage(
    createModerationEvent(bet.slipId, ModerationStatus.APPROVED),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
});

it("declined moderation results update bets to BET_DECLINED", async () => {
  const bet = await createBet({
    status: ResultingStatus.BET_PENDING,
    rows: [createPreMatchRow()],
  });
  const listener = await setup();

  await listener.onMessage(
    createModerationEvent(bet.slipId, ModerationStatus.DECLINED),
    createMessage()
  );

  const updatedBet = await Bet.findOne({ slipId: bet.slipId });
  expect(updatedBet).not.toBeNull();
  expect(updatedBet!.status).toEqual(ResultingStatus.BET_DECLINED);
  expect(listener.ack).toHaveBeenCalled();
});

it("parks moderation results when the aggregate has not arrived yet", async () => {
  const listener = await setup();
  const slipId = "missing-slip";

  await listener.onMessage(
    createModerationEvent(slipId, ModerationStatus.APPROVED, {
      betKind: BetKind.LIVE,
    }),
    createMessage()
  );

  const pendingModeration = await PendingModerationResult.findOne({ slipId });

  expect(await Bet.findOne({ slipId })).toBeNull();
  expect(pendingModeration).not.toBeNull();
  expect(pendingModeration!.result).toEqual(ModerationStatus.APPROVED);
  expect(pendingModeration!.betKind).toEqual(BetKind.LIVE);
  expect(pendingModeration!.status).toEqual("PENDING");
  expect(pendingModeration!.attemptCount).toEqual(0);
  expect(pendingModeration!.leaseOwner).toEqual("");
  expect(pendingModeration!.nextAttemptAt).toBeInstanceOf(Date);
  expect(pendingModeration!.lastError?.message).toEqual("");
  expect(pendingModeration!.lastError?.name).toEqual("");
  expect(pendingModeration!.exhaustedAt).toBeUndefined();
  expect(listener.ack).toHaveBeenCalled();
});
