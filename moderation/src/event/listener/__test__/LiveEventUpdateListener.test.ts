import mongoose from "mongoose";
import { BetKind, ModerationStatus, messengerWrapper } from "@betstan/common";
import { Bet } from "../../../model/Bet";
import { LiveEventMirror } from "../../../model/LiveEventMirror";
import { ParkedPlaceBet } from "../../../model/ParkedPlaceBet";
import LiveEventUpdateListener from "../LiveEventUpdateListener";
import PlaceBetListener from "../PlaceBetListener";
import BetModerationResultPublisher from "../../publisher/BetModerationResultPublisher";
import {
  createDeferred,
  createLiveMarket,
  createLivePlaceBetEvent,
  createLiveUpdateEvent,
  createMessage,
  createReplayWorker,
} from "./helpers";

const setup = async () => {
  const placeBetListener = new PlaceBetListener(messengerWrapper.connection);
  await placeBetListener.init();
  const liveEventListener = new LiveEventUpdateListener(
    messengerWrapper.connection
  );
  await liveEventListener.init();
  const replayWorker = await createReplayWorker();

  return { placeBetListener, liveEventListener, replayWorker };
};

it("stores only the newest live snapshot when duplicates arrive", async () => {
  const { liveEventListener } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const firstSnapshot = createLiveUpdateEvent({
    eventId,
    sequence: 1,
    markets: [createLiveMarket(eventId, { quoteVersion: 1 })],
  });
  const secondSnapshot = createLiveUpdateEvent({
    eventId,
    sequence: 2,
    markets: [createLiveMarket(eventId, { quoteVersion: 2 })],
  });

  await liveEventListener.onMessage(firstSnapshot, createMessage());
  await liveEventListener.onMessage(secondSnapshot, createMessage());
  await liveEventListener.onMessage(secondSnapshot, createMessage());
  await liveEventListener.onMessage(firstSnapshot, createMessage());

  const mirror = await LiveEventMirror.findOne({ eventId });

  expect(mirror).not.toBeNull();
  expect(mirror!.sequence).toEqual(2);
  expect(mirror!.markets).toHaveLength(1);
  expect(mirror!.markets[0].quoteVersion).toEqual(2);
  expect(await LiveEventMirror.countDocuments({ eventId })).toEqual(1);
});

it("replays parked live bets when the mirror arrives later", async () => {
  const { placeBetListener, liveEventListener, replayWorker } = await setup();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = createLiveMarket(eventId, {
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const placeBet = createLivePlaceBetEvent(market);

  await placeBetListener.onMessage(placeBet, createMessage());

  let savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.RECEIVED);
  expect(await ParkedPlaceBet.findOne({ slipId: placeBet.data.slipId })).not.toBeNull();
  expect(
    BetModerationResultPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();

  await liveEventListener.onMessage(
    createLiveUpdateEvent({
      eventId,
      markets: [market],
    }),
    createMessage()
  );
  await replayWorker.runOnce();

  savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(savedBet!.betKind).toEqual(BetKind.LIVE);
  expect(await ParkedPlaceBet.findOne({ slipId: placeBet.data.slipId })).toBeNull();
  expect(publishMock.mock.calls[0][0]).toEqual({
    data: {
      slipId: placeBet.data.slipId,
      result: ModerationStatus.APPROVED,
      betKind: BetKind.LIVE,
    },
  });
});

it("concurrent N+1 then N snapshots cannot roll the mirror back or double replay", async () => {
  const { placeBetListener, liveEventListener, replayWorker } = await setup();
  await LiveEventMirror.init();

  const eventId = new mongoose.Types.ObjectId().toHexString();
  const olderBlocked = createDeferred();
  const releaseOlder = createDeferred();
  const olderMarket = createLiveMarket(eventId, {
    quoteVersion: 1,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const newerMarket = createLiveMarket(eventId, {
    quoteVersion: 2,
    quoteValidUntil: new Date(Date.now() + 60_000).toISOString(),
  });
  const placeBet = createLivePlaceBetEvent(newerMarket);
  const updateOne = LiveEventMirror.collection.updateOne.bind(
    LiveEventMirror.collection
  );
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;

  const updateSpy = jest
    .spyOn(LiveEventMirror.collection, "updateOne")
    .mockImplementation(async (filter, update, options) => {
      const sequence = (update as { $set?: { sequence?: number } }).$set?.sequence;

      if (sequence === 1) {
        olderBlocked.resolve();
        await releaseOlder.promise;
      }

      return updateOne(
        filter as Parameters<typeof updateOne>[0],
        update as Parameters<typeof updateOne>[1],
        options as Parameters<typeof updateOne>[2]
      );
    });

  try {
    await placeBetListener.onMessage(placeBet, createMessage());
    expect(
      await ParkedPlaceBet.findOne({ slipId: placeBet.data.slipId })
    ).not.toBeNull();

    const olderDelivery = liveEventListener.onMessage(
      createLiveUpdateEvent({
        eventId,
        sequence: 1,
        markets: [olderMarket],
      }),
      createMessage()
    );

    await olderBlocked.promise;

    await liveEventListener.onMessage(
      createLiveUpdateEvent({
        eventId,
        sequence: 2,
        markets: [newerMarket],
      }),
      createMessage()
    );
    await replayWorker.runOnce();

    releaseOlder.resolve();
    await olderDelivery;

    const mirror = await LiveEventMirror.findOne({ eventId });
    const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });

    expect(mirror).not.toBeNull();
    expect(mirror!.sequence).toEqual(2);
    expect(mirror!.markets[0].quoteVersion).toEqual(2);
    expect(savedBet).not.toBeNull();
    expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
    expect(savedBet!.publishedAt).not.toEqual("");
    expect(publishMock).toHaveBeenCalledTimes(1);
  } finally {
    updateSpy.mockRestore();
  }
});
