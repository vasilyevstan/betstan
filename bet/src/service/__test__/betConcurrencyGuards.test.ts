import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  BetStatus,
  IModerationResultEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  ModerationDeclineReason,
  ModerationStatus,
  ResultingStatus,
  SlipRowStatus,
  messengerWrapper,
} from "@betstan/common";
import { Bet, BetDocument } from "../../model/Bet";
import {
  applyModerationResult,
  applySettleSlip,
  applySettleSlipRow,
  saveBetWithOptimisticRetry,
} from "../betHistory";
import ModerationResultListener from "../../event/listener/ModerationResultListener";
import SettleSlipListener from "../../event/listener/SettleSlipListener";
import SettleSlipRowListener from "../../event/listener/SettleSlipRowListener";

// Regression coverage for code-review finding #2: moderation and settlement
// consumers must not load a bet, then blindly save a stale in-memory
// snapshot in a way that overwrites a terminal status written by a
// concurrent consumer (or by a duplicate/redelivered copy of the very same
// event). `bet/src/model/Bet.ts` now enables mongoose `optimisticConcurrency`
// and every consumer goes through `betHistory.saveBetWithOptimisticRetry`
// (directly, or via `applyBetEventWithRetry`), which reloads the fresh
// document and reapplies the same guarded/idempotent mutator whenever a
// concurrent save wins the race.

const buildMessage = (): ConsumeMessage => ({
  content: Buffer.alloc(5),
  fields: {
    consumerTag: "",
    deliveryTag: 0,
    redelivered: false,
    exchange: "",
    routingKey: "",
  },
  properties: {
    contentType: undefined,
    contentEncoding: undefined,
    headers: {},
    deliveryMode: undefined,
    priority: undefined,
    correlationId: undefined,
    replyTo: undefined,
    expiration: undefined,
    messageId: undefined,
    timestamp: undefined,
    type: undefined,
    userId: undefined,
    appId: undefined,
    clusterId: undefined,
  },
});

const createConfirmedBet = async (
  slipId: string,
  rowId: string = new mongoose.Types.ObjectId().toHexString()
) => {
  const bet = new Bet({
    status: BetStatus.CONFIRMED,
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testuser",
    slipId,
    wager: 10,
    timestamp: new Date().toISOString(),
    betKind: BetKind.LIVE,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
        status: SlipRowStatus.NOT_SETTLED,
        id: rowId,
        betKind: BetKind.LIVE,
      },
    ],
  });
  await bet.save();
  return bet;
};

describe("optimistic concurrency guards for bet moderation/settlement consumers", () => {
  it("does not let a stale moderation decline overwrite a concurrently settled WIN", async () => {
    const slipId = new mongoose.Types.ObjectId().toHexString();
    await createConfirmedBet(slipId);

    // Two consumers load the same (pre-settlement) snapshot before either
    // one saves - this is the load-mutate-save race the finding describes.
    const staleModerationView = (await Bet.findOne({ slipId })) as BetDocument;
    const settlementView = (await Bet.findOne({ slipId })) as BetDocument;

    // The settlement consumer wins the race and persists first.
    const winEvent: ISettleSlipEvent = {
      timestamp: new Date().toISOString(),
      data: { slipId, result: ResultingStatus.BET_WIN, betKind: BetKind.LIVE },
    };
    const { saved: settlementSaved } = await saveBetWithOptimisticRetry(
      settlementView,
      (bet) => applySettleSlip(bet, winEvent)
    );
    expect(settlementSaved).toBe(true);

    // The moderation consumer, still holding its stale pre-settlement
    // snapshot, now tries to apply a late DECLINED result. Its first save
    // attempt must conflict (optimistic concurrency) and recover by
    // reloading + reapplying against the fresh (already-WIN) document,
    // where the guard correctly no-ops instead of overwriting WIN.
    const declineEvent: IModerationResultEvent = {
      timestamp: new Date().toISOString(),
      data: {
        slipId,
        result: ModerationStatus.DECLINED,
        betKind: BetKind.LIVE,
        declineReason: ModerationDeclineReason.STALE_QUOTE,
      },
    };
    const { bet: recoveredBet, saved: moderationSaved } =
      await saveBetWithOptimisticRetry(staleModerationView, (bet) =>
        applyModerationResult(bet, declineEvent)
      );

    expect(moderationSaved).toBe(false);
    expect(recoveredBet.status).toEqual(BetStatus.WIN);
    expect(recoveredBet.declineReason).toBeUndefined();

    const persistedBet = await Bet.findOne({ slipId });
    expect(persistedBet!.status).toEqual(BetStatus.WIN);
    expect(persistedBet!.declineReason).toBeUndefined();
  });

  it("does not let a stale settlement update regress a concurrently written terminal settlement", async () => {
    const slipId = new mongoose.Types.ObjectId().toHexString();
    await createConfirmedBet(slipId);

    // Both settlement consumers load the same pre-terminal snapshot.
    const staleView = (await Bet.findOne({ slipId })) as BetDocument;
    const firstView = (await Bet.findOne({ slipId })) as BetDocument;

    const voidEvent: ISettleSlipEvent = {
      timestamp: new Date().toISOString(),
      data: { slipId, result: ResultingStatus.BET_VOID, betKind: BetKind.LIVE },
    };
    const { saved: firstSaved } = await saveBetWithOptimisticRetry(
      firstView,
      (bet) => applySettleSlip(bet, voidEvent)
    );
    expect(firstSaved).toBe(true);

    // A stale/duplicate LOSS result (e.g. redelivered, or racing on a
    // different consumer instance) must not flip an already-terminal VOID
    // over to LOSS once it reloads the current state.
    const lossEvent: ISettleSlipEvent = {
      timestamp: new Date().toISOString(),
      data: { slipId, result: ResultingStatus.BET_LOSS, betKind: BetKind.LIVE },
    };
    const { bet: recoveredBet, saved: secondSaved } =
      await saveBetWithOptimisticRetry(staleView, (bet) =>
        applySettleSlip(bet, lossEvent)
      );

    expect(secondSaved).toBe(false);
    expect(recoveredBet.status).toEqual(BetStatus.VOID);

    const persistedBet = await Bet.findOne({ slipId });
    expect(persistedBet!.status).toEqual(BetStatus.VOID);
  });

  it("does not let a stale settle-slip-row update regress a concurrently settled terminal row", async () => {
    const slipId = new mongoose.Types.ObjectId().toHexString();
    const rowId = new mongoose.Types.ObjectId().toHexString();
    await createConfirmedBet(slipId, rowId);

    const staleView = (await Bet.findOne({ slipId })) as BetDocument;
    const firstView = (await Bet.findOne({ slipId })) as BetDocument;

    const winRowEvent: ISettleSlipRowEvent = {
      timestamp: new Date().toISOString(),
      data: {
        slipId,
        slipRowId: rowId,
        result: ResultingStatus.ROW_WIN,
        betKind: BetKind.LIVE,
      },
    };
    const { saved: firstSaved } = await saveBetWithOptimisticRetry(
      firstView,
      (bet) => applySettleSlipRow(bet, winRowEvent)
    );
    expect(firstSaved).toBe(true);

    const voidRowEvent: ISettleSlipRowEvent = {
      timestamp: new Date().toISOString(),
      data: {
        slipId,
        slipRowId: rowId,
        result: ResultingStatus.ROW_VOID,
        betKind: BetKind.LIVE,
      },
    };
    const { bet: recoveredBet, saved: secondSaved } =
      await saveBetWithOptimisticRetry(staleView, (bet) =>
        applySettleSlipRow(bet, voidRowEvent)
      );

    expect(secondSaved).toBe(false);
    expect(recoveredBet.rows[0].status).toEqual(SlipRowStatus.WIN);

    const persistedBet = await Bet.findOne({ slipId });
    expect(persistedBet!.rows[0].status).toEqual(SlipRowStatus.WIN);
  });

  it("processes concurrent moderation and settlement listeners without corrupting or losing the terminal status", async () => {
    const slipId = new mongoose.Types.ObjectId().toHexString();
    await createConfirmedBet(slipId);

    const moderationListener = new ModerationResultListener(
      messengerWrapper.connection
    );
    const settleListener = new SettleSlipListener(messengerWrapper.connection);
    await moderationListener.init();
    await settleListener.init();

    const declineEvent: IModerationResultEvent = {
      timestamp: new Date().toISOString(),
      data: {
        slipId,
        result: ModerationStatus.DECLINED,
        betKind: BetKind.LIVE,
        declineReason: ModerationDeclineReason.STALE_QUOTE,
      },
    };
    const winEvent: ISettleSlipEvent = {
      timestamp: new Date().toISOString(),
      data: { slipId, result: ResultingStatus.BET_WIN, betKind: BetKind.LIVE },
    };

    // Genuinely concurrent processing - whichever consumer's save reaches
    // Mongo first should win, and the other must safely reload/reapply
    // rather than throw unhandled or clobber the winner.
    await Promise.all([
      moderationListener.onMessage(declineEvent, buildMessage()),
      settleListener.onMessage(winEvent, buildMessage()),
    ]);

    const finalBet = await Bet.findOne({ slipId });
    expect([BetStatus.WIN, BetStatus.DECLINED]).toContain(finalBet!.status);

    if (finalBet!.status === BetStatus.WIN) {
      expect(finalBet!.declineReason).toBeUndefined();
    } else {
      expect(finalBet!.declineReason).toEqual(
        ModerationDeclineReason.STALE_QUOTE
      );
    }
  });

  it("applying a duplicate/redelivered settlement event a second time is a no-op that does not resave the document", async () => {
    const slipId = new mongoose.Types.ObjectId().toHexString();
    await createConfirmedBet(slipId);

    const listener = new SettleSlipListener(messengerWrapper.connection);
    await listener.init();

    const winEvent: ISettleSlipEvent = {
      timestamp: new Date().toISOString(),
      data: { slipId, result: ResultingStatus.BET_WIN, betKind: BetKind.LIVE },
    };

    await listener.onMessage(winEvent, buildMessage());
    const afterFirst = await Bet.findOne({ slipId });
    expect(afterFirst!.status).toEqual(BetStatus.WIN);
    const versionAfterFirst = (afterFirst as unknown as { __v: number }).__v;

    // Simulate a duplicate delivery of the identical event (e.g. a broker
    // redelivery after an unacked message, or a replayed retry record).
    await listener.onMessage(winEvent, buildMessage());
    const afterSecond = await Bet.findOne({ slipId });
    expect(afterSecond!.status).toEqual(BetStatus.WIN);
    const versionAfterSecond = (afterSecond as unknown as { __v: number }).__v;

    // No-op guard means the document must not have been saved again.
    expect(versionAfterSecond).toEqual(versionAfterFirst);
  });

  it("applying a duplicate/redelivered settle-slip-row event a second time does not regress or resave the row", async () => {
    const slipId = new mongoose.Types.ObjectId().toHexString();
    const rowId = new mongoose.Types.ObjectId().toHexString();
    await createConfirmedBet(slipId, rowId);

    const listener = new SettleSlipRowListener(messengerWrapper.connection);
    await listener.init();

    const voidRowEvent: ISettleSlipRowEvent = {
      timestamp: new Date().toISOString(),
      data: {
        slipId,
        slipRowId: rowId,
        result: ResultingStatus.ROW_VOID,
        betKind: BetKind.LIVE,
      },
    };

    await listener.onMessage(voidRowEvent, buildMessage());
    const afterFirst = await Bet.findOne({ slipId });
    expect(afterFirst!.rows[0].status).toEqual(SlipRowStatus.VOID);
    const versionAfterFirst = (afterFirst as unknown as { __v: number }).__v;

    await listener.onMessage(voidRowEvent, buildMessage());
    const afterSecond = await Bet.findOne({ slipId });
    expect(afterSecond!.rows[0].status).toEqual(SlipRowStatus.VOID);
    const versionAfterSecond = (afterSecond as unknown as { __v: number }).__v;

    expect(versionAfterSecond).toEqual(versionAfterFirst);
  });
});
