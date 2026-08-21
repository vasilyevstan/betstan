import mongoose from "mongoose";
import {
  BetKind,
  ModerationDeclineReason,
  ModerationStatus,
  messengerWrapper,
} from "@betstan/common";
import { Bet } from "../../../model/Bet";
import { ParkedPlaceBet } from "../../../model/ParkedPlaceBet";
import { Resulted } from "../../../model/Resulted";
import EventResultListener from "../EventResultListener";
import PlaceBetListener from "../PlaceBetListener";
import BetModerationResultPublisher from "../../publisher/BetModerationResultPublisher";
import {
  createEventResultEvent,
  createLiveMarket,
  createLivePlaceBetEvent,
  createMessage,
  createReplayWorker,
} from "./helpers";

const setup = async () => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  return { listener };
};

it("event result is saved in the Resulted collection", async () => {
  const { listener } = await setup();
  const message = createMessage();
  const data = createEventResultEvent();

  await listener.onMessage(data, message);

  const resulted = await Resulted.findOne({ eventId: data.data.eventId });
  expect(resulted).not.toBeNull();
  expect(resulted!.eventId).toEqual(data.data.eventId);
  expect(listener.ack).toHaveBeenCalled();
});

it("multiple event results are each saved as separate Resulted entries", async () => {
  const { listener } = await setup();
  const message = createMessage();

  await listener.onMessage(createEventResultEvent(), message);
  await listener.onMessage(createEventResultEvent(), message);

  const results = await Resulted.find({});
  expect(results).toHaveLength(2);
});

it("parked live bets are replayed and declined when the result arrives first", async () => {
  const placeBetListener = new PlaceBetListener(messengerWrapper.connection);
  await placeBetListener.init();
  const { listener } = await setup();
  const replayWorker = await createReplayWorker();
  const eventId = new mongoose.Types.ObjectId().toHexString();
  const market = createLiveMarket(eventId);
  const placeBet = createLivePlaceBetEvent(market);

  await placeBetListener.onMessage(placeBet, createMessage());
  expect(await ParkedPlaceBet.findOne({ slipId: placeBet.data.slipId })).not.toBeNull();

  await listener.onMessage(createEventResultEvent(eventId), createMessage());
  await replayWorker.runOnce();

  const savedBet = await Bet.findOne({ slipId: placeBet.data.slipId });
  const publishMock =
    BetModerationResultPublisher.prototype.publishWithConfirm as jest.Mock;

  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.DECLINED);
  expect(savedBet!.betKind).toEqual(BetKind.LIVE);
  expect(savedBet!.declineReason).toEqual(ModerationDeclineReason.EVENT_RESULTED);
  expect(await ParkedPlaceBet.findOne({ slipId: placeBet.data.slipId })).toBeNull();
  expect(publishMock.mock.calls[0][0]).toEqual({
    data: {
      slipId: placeBet.data.slipId,
      result: ModerationStatus.DECLINED,
      betKind: BetKind.LIVE,
      declineReason: ModerationDeclineReason.EVENT_RESULTED,
      affectedRows: [
        {
          rowId: placeBet.data.rows[0].id,
          declineReason: ModerationDeclineReason.EVENT_RESULTED,
        },
      ],
    },
  });
});
