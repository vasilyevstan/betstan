import { BetKind, ResultingStatus, messengerWrapper } from "@betstan/common";
import EventResultListener from "../EventResultListener";
import { Bet, BetArchive } from "../../../model/Bet";
import FinalScoreLedger from "../../../model/FinalScoreLedger";
import RetryRecord from "../../../model/RetryRecord";
import { RetryWorker, buildRetryKey } from "../../../service/retry";
import SettleSlipPublisher from "../../publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../../publisher/SettleSlipRowPublisher";
import {
  createBet,
  createFinalScoreEvent,
  createMessage,
  createLiveRow,
  createPreMatchRow,
  setupPublisherSpies,
} from "../../../test/resultingTestUtils";

setupPublisherSpies();

const setup = async () => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  return listener;
};

const createWorker = async () => {
  const worker = new RetryWorker(messengerWrapper.connection);
  await worker.init();
  return worker;
};

const makeRetryDue = async (key: string) => {
  await RetryRecord.updateOne(
    { key },
    {
      $set: {
        nextAttemptAt: new Date(0),
      },
    }
  );
};

it("settles legacy pre-match rows when kind metadata is missing", async () => {
  const row = createPreMatchRow({
    oddsName: "Home Team",
    eventName: "Home Team vs Away Team",
  });
  const bet = await createBet({
    rows: [row],
    status: ResultingStatus.BET_APPROVED,
  });
  await Bet.updateOne(
    { slipId: bet.slipId },
    {
      $unset: {
        betKind: "",
        "rows.0.betKind": "",
      },
    }
  );
  const listener = await setup();

  await listener.onMessage(
    createFinalScoreEvent({
      eventId: row.eventId,
      homeScore: 2,
      awayScore: 0,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });

  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
  expect(listener.ack).toHaveBeenCalled();
});

it("ignores live rows even when their product name looks like a final-score market", async () => {
  const row = createLiveRow({
    productName: "1X2",
    oddsName: "Home Team",
  });
  const bet = await createBet({
    betKind: BetKind.LIVE,
    rows: [row],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await setup();

  await listener.onMessage(
    createFinalScoreEvent({
      eventId: row.eventId,
      homeScore: 1,
      awayScore: 0,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  const activeBet = await Bet.findOne({ slipId: bet.slipId });

  expect(activeBet).not.toBeNull();
  expect(activeBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(activeBet!.rows[0].result).toEqual(ResultingStatus.ROW_NO_RESULT);
  expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("first pre-match loss immediately finalises the accumulator and voids unsettled rows", async () => {
  const losingRow = createPreMatchRow({
    eventId: "event-loss",
    oddsName: "Away Team",
    eventName: "Home Team vs Away Team",
  });
  const pendingRow = createPreMatchRow({
    eventId: "event-pending",
    productName: "Correct Score",
    oddsName: "2 - 1",
  });
  const bet = await createBet({
    rows: [losingRow, pendingRow],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await setup();

  await listener.onMessage(
    createFinalScoreEvent({
      eventId: losingRow.eventId,
      homeScore: 3,
      awayScore: 1,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });

  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_LOSS);
  expect(archivedBet!.rows[0].result).toEqual(ResultingStatus.ROW_LOSS);
  expect(archivedBet!.rows[1].result).toEqual(ResultingStatus.ROW_VOID);
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(2);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("settles winning 1X2 and Correct Score accumulators once all rows have landed", async () => {
  const rowOne = createPreMatchRow({
    eventId: "event-home-win",
    oddsName: "Home Team",
  });
  const rowTwo = createPreMatchRow({
    eventId: "event-correct-score",
    productName: "Correct Score",
    oddsName: "2 - 1",
  });
  const bet = await createBet({
    rows: [rowOne, rowTwo],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await setup();

  await listener.onMessage(
    createFinalScoreEvent({
      eventId: rowOne.eventId,
      homeScore: 1,
      awayScore: 0,
      home: "Home Team",
      away: "Away Team",
    }),
    createMessage()
  );

  const activeBet = await Bet.findOne({ slipId: bet.slipId });
  expect(activeBet).not.toBeNull();
  expect(activeBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(activeBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
  expect(activeBet!.rows[1].result).toEqual(ResultingStatus.ROW_NO_RESULT);

  await listener.onMessage(
    createFinalScoreEvent({
      eventId: rowTwo.eventId,
      homeScore: 2,
      awayScore: 1,
      home: "Second Home",
      away: "Second Away",
    }),
    createMessage()
  );

  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(
    archivedBet!.rows.every((row: any) => row.result === ResultingStatus.ROW_WIN)
  ).toBe(true);
});

it("persists final-score facts idempotently across duplicate deliveries", async () => {
  const row = createPreMatchRow({
    eventId: "duplicate-event-result",
    oddsName: "Home Team",
  });
  const bet = await createBet({
    rows: [row],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await setup();
  const event = createFinalScoreEvent({
    eventId: row.eventId,
    homeScore: 4,
    awayScore: 0,
    home: "Home Team",
    away: "Away Team",
  });

  await listener.onMessage(event, createMessage());
  await listener.onMessage(event, createMessage());

  expect(await FinalScoreLedger.countDocuments({ eventId: row.eventId })).toEqual(1);
  expect(await BetArchive.countDocuments({ slipId: bet.slipId })).toEqual(1);
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("parks row publication confirm failures, acknowledges the message, and recovers via the retry worker", async () => {
  const rowPublish = SettleSlipRowPublisher.prototype
    .publishWithConfirm as jest.Mock;
  rowPublish.mockRejectedValueOnce(new Error("row confirm failed"));

  const row = createPreMatchRow({
    eventId: "row-confirm-retry",
    oddsName: "Home Team",
  });
  const bet = await createBet({
    rows: [row],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await setup();
  const event = createFinalScoreEvent({
    eventId: row.eventId,
    homeScore: 2,
    awayScore: 0,
    home: "Home Team",
    away: "Away Team",
  });

  await listener.onMessage(event, createMessage());

  let activeBet = await Bet.findOne({ slipId: bet.slipId });
  const retryKey = buildRetryKey("EVENT_RESULT", row.eventId);
  let retryRecord = await RetryRecord.findOne({ key: retryKey });

  expect(listener.ack).toHaveBeenCalledTimes(1);
  expect(activeBet).not.toBeNull();
  expect(activeBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(activeBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
  expect(activeBet!.rows[0].settlementPublicationState).toEqual("PENDING");
  expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();
  expect(retryRecord).not.toBeNull();
  expect(retryRecord!.status).toEqual("PENDING");

  await makeRetryDue(retryKey);
  const worker = await createWorker();
  await worker.runOnce();

  activeBet = await Bet.findOne({ slipId: bet.slipId });
  retryRecord = await RetryRecord.findOne({ key: retryKey });
  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });

  expect(activeBet).toBeNull();
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(retryRecord).not.toBeNull();
  expect(retryRecord!.status).toEqual("COMPLETED");
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(2);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("parks terminal publication confirm failures and resumes them after worker restart", async () => {
  const slipPublish = SettleSlipPublisher.prototype
    .publishWithConfirm as jest.Mock;
  slipPublish.mockRejectedValueOnce(new Error("terminal confirm failed"));

  const row = createPreMatchRow({
    eventId: "terminal-confirm-retry",
    oddsName: "Home Team",
  });
  const bet = await createBet({
    rows: [row],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await setup();
  const event = createFinalScoreEvent({
    eventId: row.eventId,
    homeScore: 3,
    awayScore: 0,
    home: "Home Team",
    away: "Away Team",
  });

  await listener.onMessage(event, createMessage());

  let activeBet = await Bet.findOne({ slipId: bet.slipId });
  const retryKey = buildRetryKey("EVENT_RESULT", row.eventId);
  let retryRecord = await RetryRecord.findOne({ key: retryKey });

  expect(listener.ack).toHaveBeenCalledTimes(1);
  expect(activeBet).not.toBeNull();
  expect(activeBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(activeBet!.rows[0].settlementPublicationState).toEqual("PUBLISHED");
  expect(activeBet!.terminalPublicationState).toEqual("PENDING");
  expect(await BetArchive.findOne({ slipId: bet.slipId })).toBeNull();
  expect(retryRecord).not.toBeNull();
  expect(retryRecord!.status).toEqual("PENDING");

  await makeRetryDue(retryKey);
  const worker = await createWorker();
  await worker.runOnce();

  activeBet = await Bet.findOne({ slipId: bet.slipId });
  retryRecord = await RetryRecord.findOne({ key: retryKey });
  const archivedBet = await BetArchive.findOne({ slipId: bet.slipId });

  expect(activeBet).toBeNull();
  expect(archivedBet).not.toBeNull();
  expect(archivedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(retryRecord).not.toBeNull();
  expect(retryRecord!.status).toEqual("COMPLETED");
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(2);
});

it("deduplicates duplicate final-score deliveries under concurrency", async () => {
  const row = createPreMatchRow({
    eventId: "event-concurrent",
    oddsName: "Home Team",
  });
  const bet = await createBet({
    rows: [row],
    status: ResultingStatus.BET_APPROVED,
  });
  const listener = await setup();
  const event = createFinalScoreEvent({
    eventId: row.eventId,
    homeScore: 2,
    awayScore: 0,
    home: "Home Team",
    away: "Away Team",
  });

  await Promise.all([
    listener.onMessage(event, createMessage()),
    listener.onMessage(event, createMessage()),
  ]);

  expect(await FinalScoreLedger.countDocuments({ eventId: row.eventId })).toEqual(1);
  expect(await BetArchive.countDocuments({ slipId: bet.slipId })).toEqual(1);
  expect(SettleSlipRowPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(SettleSlipPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(await RetryRecord.countDocuments({ key: buildRetryKey("EVENT_RESULT", row.eventId) })).toEqual(0);
});
