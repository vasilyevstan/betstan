import {
  BetKind,
  LiveMarketType,
  ModerationStatus,
  ResultingStatus,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import EventResultListener from "../EventResultListener";
import ModerationResultListener from "../ModerationResultListener";
import PlaceBetListener from "../PlaceBetListener";
import { Bet, BetArchive } from "../../../model/Bet";
import FinalScoreLedger from "../../../model/FinalScoreLedger";
import PendingModerationResult from "../../../model/PendingModerationResult";
import RetryRecord from "../../../model/RetryRecord";
import SettleSlipPublisher from "../../publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../publisher/SettleSlipRowPublisher";
import {
  createBet,
  createFinalScoreEvent,
  createLiveRow,
  createMessage,
  createModerationEvent,
  createPlaceBetEvent,
  createPreMatchRow,
  setupPublisherSpies,
} from "../../../test/resultingTestUtils";
import { PendingModerationReplayWorker } from "../../../service/pendingModeration";
import { replayPendingModerationResult } from "../../../service/resulting";

setupPublisherSpies();

const setupPlaceListener = async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

const setupModerationListener = async () => {
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

const setupEventResultListener = async () => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

it("creates a pending pre-match bet with PRE_MATCH defaults", async () => {
  const listener = await setupPlaceListener();
  const event = createPlaceBetEvent({
    rows: [createPreMatchRow()],
  });

  await listener.onMessage(event, createMessage());

  const savedBet = await Bet.findOne({ slipId: event.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ResultingStatus.BET_PENDING);
  expect(savedBet!.betKind).toEqual(BetKind.PRE_MATCH);
  expect(savedBet!.rows[0].betKind).toEqual(BetKind.PRE_MATCH);
  expect(savedBet!.rows[0].result).toEqual(ResultingStatus.ROW_NO_RESULT);
  expect(listener.ack).toHaveBeenCalled();
});

it("stores live identifiers on live rows", async () => {
  const listener = await setupPlaceListener();
  const row = createLiveRow({
    marketType: LiveMarketType.NEXT_RED_CARD,
    side: TeamSide.AWAY,
  });
  const event = createPlaceBetEvent({
    betKind: BetKind.LIVE,
    rows: [row],
  });

  await listener.onMessage(event, createMessage());

  const savedBet = await Bet.findOne({ slipId: event.data.slipId });

  expect(savedBet).not.toBeNull();
  expect(savedBet!.betKind).toEqual(BetKind.LIVE);
  expect(savedBet!.rows[0].betKind).toEqual(BetKind.LIVE);
  expect(savedBet!.rows[0].marketId).toEqual(row.marketId);
  expect(savedBet!.rows[0].marketType).toEqual(LiveMarketType.NEXT_RED_CARD);
  expect(savedBet!.rows[0].marketVersion).toEqual(row.marketVersion);
  expect(savedBet!.rows[0].selectionId).toEqual(row.selectionId);
  expect(savedBet!.rows[0].side).toEqual(TeamSide.AWAY);
});

it("deduplicates row identities and upserts by unique slip id", async () => {
  const listener = await setupPlaceListener();
  const slipId = "slip-dedupe";
  const row = createLiveRow({
    id: "row-dedupe",
    marketType: LiveMarketType.NEXT_CORNER,
  });
  const event = createPlaceBetEvent({
    slipId,
    betKind: BetKind.LIVE,
    rows: [row, { ...row, oddsValue: 99 }],
  });

  await listener.onMessage(event, createMessage());
  await listener.onMessage(event, createMessage());

  const bets = await Bet.find({ slipId });

  expect(bets).toHaveLength(1);
  expect(bets[0].rows).toHaveLength(1);
  expect(bets[0].rows[0].id).toEqual("row-dedupe");
});

it("ignores duplicate place bets for already archived slips", async () => {
  const slipId = "archived-slip";
  await createBet({
    archive: true,
    slipId,
    status: ResultingStatus.BET_WIN,
    rows: [createPreMatchRow()],
  });
  const listener = await setupPlaceListener();

  await listener.onMessage(
    createPlaceBetEvent({
      slipId,
      rows: [createPreMatchRow()],
    }),
    createMessage()
  );

  expect(await Bet.findOne({ slipId })).toBeNull();
  expect(await BetArchive.countDocuments({ slipId })).toEqual(1);
});

it("replays stored final scores when EVENT_RESULT and approval both arrive before placement", async () => {
  const slipId = "event-before-place-slip";
  const row = createPreMatchRow({
    eventId: "event-before-place",
    oddsName: "Home Team",
  });
  const eventListener = await setupEventResultListener();

  await eventListener.onMessage(
    createFinalScoreEvent({
      eventId: row.eventId,
      homeScore: 2,
      awayScore: 0,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  const moderationListener = await setupModerationListener();
  await moderationListener.onMessage(
    createModerationEvent(slipId, ModerationStatus.APPROVED),
    createMessage()
  );

  const placeListener = await setupPlaceListener();
  await placeListener.onMessage(
    createPlaceBetEvent({
      slipId,
      rows: [row],
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId });
  expect(await FinalScoreLedger.countDocuments({ eventId: row.eventId })).toEqual(1);
  expect(await Bet.findOne({ slipId })).toBeNull();
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
});

it("treats a corrected resubmission under a new slip id as an independent aggregate", async () => {
  const sharedRow = createPreMatchRow({
    eventId: "resubmission-event",
    oddsName: "Home Team",
  });
  const declinedSlipId = "declined-slip";
  await createBet({
    slipId: declinedSlipId,
    status: ResultingStatus.BET_DECLINED,
    rows: [sharedRow],
  });
  const eventListener = await setupEventResultListener();

  await eventListener.onMessage(
    createFinalScoreEvent({
      eventId: sharedRow.eventId,
      homeScore: 1,
      awayScore: 0,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  const newSlipId = "resubmitted-slip";
  const newPlaceListener = await setupPlaceListener();
  await newPlaceListener.onMessage(
    createPlaceBetEvent({
      slipId: newSlipId,
      rows: [{ ...sharedRow, id: "resubmitted-row" }],
    }),
    createMessage()
  );

  const moderationListener = await setupModerationListener();
  await moderationListener.onMessage(
    createModerationEvent(newSlipId, ModerationStatus.APPROVED),
    createMessage()
  );

  const declinedBet = await Bet.findOne({ slipId: declinedSlipId });
  const archivedResubmission = await BetArchive.findOne({ slipId: newSlipId });

  expect(declinedBet).not.toBeNull();
  expect(declinedBet!.status).toEqual(ResultingStatus.BET_DECLINED);
  expect(await BetArchive.findOne({ slipId: declinedSlipId })).toBeNull();
  expect(archivedResubmission).not.toBeNull();
  expect(archivedResubmission!.status).toEqual(ResultingStatus.BET_WIN);
  expect(archivedResubmission!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
});

it("coalesces duplicate parked moderation and settles once when the place bet arrives later", async () => {
  const slipId = "duplicate-moderation-before-place";
  const row = createPreMatchRow({
    eventId: "duplicate-moderation-event",
    oddsName: "Home Team",
  });
  const eventListener = await setupEventResultListener();
  const moderationListener = await setupModerationListener();
  const placeListener = await setupPlaceListener();

  await eventListener.onMessage(
    createFinalScoreEvent({
      eventId: row.eventId,
      homeScore: 2,
      awayScore: 0,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  await moderationListener.onMessage(
    createModerationEvent(slipId, ModerationStatus.APPROVED),
    createMessage()
  );
  await moderationListener.onMessage(
    createModerationEvent(slipId, ModerationStatus.APPROVED),
    createMessage()
  );

  expect(await PendingModerationResult.countDocuments({ slipId })).toEqual(1);

  await placeListener.onMessage(
    createPlaceBetEvent({
      slipId,
      rows: [row],
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId });

  expect(await PendingModerationResult.findOne({ slipId })).toBeNull();
  expect(await Bet.findOne({ slipId })).toBeNull();
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("requeues parked moderation recovery failures without parking a competing place retry", async () => {
  const rowPublish = SettleSlipRowPublisher.prototype
    .publishWithConfirm as jest.Mock;
  rowPublish.mockRejectedValueOnce(new Error("row confirm failed"));

  const slipId = "pending-moderation-confirm-failure";
  const row = createPreMatchRow({
    eventId: "pending-moderation-confirm-event",
    oddsName: "Home Team",
  });
  const eventListener = await setupEventResultListener();
  const moderationListener = await setupModerationListener();
  const placeListener = await setupPlaceListener();

  await eventListener.onMessage(
    createFinalScoreEvent({
      eventId: row.eventId,
      homeScore: 1,
      awayScore: 0,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  await moderationListener.onMessage(
    createModerationEvent(slipId, ModerationStatus.APPROVED),
    createMessage()
  );

  await placeListener.onMessage(
    createPlaceBetEvent({
      slipId,
      rows: [row],
    }),
    createMessage()
  );

  let activeBet = await Bet.findOne({ slipId });
  let pendingModeration = await PendingModerationResult.findOne({ slipId });

  expect(placeListener.ack).toHaveBeenCalledTimes(1);
  expect(activeBet).not.toBeNull();
  expect(activeBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(activeBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
  expect(activeBet!.rows[0].settlementPublicationState).toEqual("PENDING");
  expect(pendingModeration).not.toBeNull();
  expect(pendingModeration!.status).toEqual("PENDING");
  expect(pendingModeration!.attemptCount).toEqual(1);
  expect(pendingModeration!.lastError?.message).toEqual("row confirm failed");
  expect(pendingModeration!.lastError?.name).toEqual("Error");
  expect(await RetryRecord.countDocuments({})).toEqual(0);

  await PendingModerationResult.updateOne(
    { slipId },
    {
      $set: {
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    }
  );

  const worker = new PendingModerationReplayWorker(
    messengerWrapper.connection,
    replayPendingModerationResult
  );
  await worker.init();
  await worker.runOnce();

  activeBet = await Bet.findOne({ slipId });
  pendingModeration = await PendingModerationResult.findOne({ slipId });
  const archivedBet = await BetArchive.findOne({ slipId });

  expect(activeBet).toBeNull();
  expect(pendingModeration).toBeNull();
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(2);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});
