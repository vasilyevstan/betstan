import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  IModerationResultEvent,
  ModerationStatus,
  ResultingStatus,
  messengerWrapper,
} from "@betstan/common";
import { Bet } from "../../../model/Bet";
import ModerationResultListener from "../ModerationResultListener";

const createMessage = (): ConsumeMessage => ({
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

const createBet = async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const bet = new Bet({
    status: ResultingStatus.BET_PENDING,
    userId: new mongoose.Types.ObjectId().toHexString(),
    slipId,
    wager: 10,
    timestamp: new Date().toISOString(),
    moderationTimestamp: "",
    resultingTimestamp: "",
    rows: [
      {
        id: new mongoose.Types.ObjectId().toHexString(),
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Test Match",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
        resultingTimestamp: "",
        result: ResultingStatus.ROW_NO_RESULT,
      },
    ],
  });
  await bet.save();
  return bet;
};

const setup = async () => {
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();
  return { listener };
};

const createEventData = (
  slipId: string,
  result: string
): IModerationResultEvent => ({
  data: { slipId, result },
});

it("approved moderation result updates bet status to BET_APPROVED", async () => {
  const { listener } = await setup();
  const bet = await createBet();
  const message = createMessage();
  const data = createEventData(bet.slipId, ModerationStatus.APPROVED);

  await listener.onMessage(data, message);

  const updatedBet = await Bet.findOne({ slipId: bet.slipId });
  expect(updatedBet).not.toBeNull();
  expect(updatedBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(listener.ack).toHaveBeenCalled();
});

it("declined moderation result updates bet status to BET_DECLINED", async () => {
  const { listener } = await setup();
  const bet = await createBet();
  const message = createMessage();
  const data = createEventData(bet.slipId, ModerationStatus.DECLINED);

  await listener.onMessage(data, message);

  const updatedBet = await Bet.findOne({ slipId: bet.slipId });
  expect(updatedBet).not.toBeNull();
  expect(updatedBet!.status).toEqual(ResultingStatus.BET_DECLINED);
  expect(listener.ack).toHaveBeenCalled();
});

it("nacks message when bet is not found for the given slipId", async () => {
  const { listener } = await setup();
  const mockChannel = { nack: jest.fn(), ack: jest.fn() };
  Object.defineProperty(listener, "channel", {
    get: jest.fn().mockReturnValue(mockChannel),
    configurable: true,
  });
  const message = createMessage();
  const unknownSlipId = new mongoose.Types.ObjectId().toHexString();
  const data = createEventData(unknownSlipId, ModerationStatus.APPROVED);

  await listener.onMessage(data, message);

  expect(mockChannel.nack).toHaveBeenCalled();
  expect(listener.ack).not.toHaveBeenCalled();
});
