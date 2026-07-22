import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  IPlaceBetEvent,
  ModerationStatus,
  messengerWrapper,
} from "@betstan/common";
import { Bet } from "../../../model/Bet";
import PlaceBetListener from "../PlaceBetListener";
import BetModerationResultPublisher from "../../publisher/BetModerationResultPublisher";

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

const createEventData = (): IPlaceBetEvent => ({
  data: {
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testUser",
    slipId: new mongoose.Types.ObjectId().toHexString(),
    wager: 10,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Test Match",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
        id: new mongoose.Types.ObjectId().toHexString(),
      },
    ],
  },
});

const setup = async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  await listener.init();
  return { listener };
};

it("moderated bet is saved with approved status when event has no result", async () => {
  const { listener } = await setup();
  const message = createMessage();
  const data = createEventData();

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ModerationStatus.APPROVED);
  expect(listener.ack).toHaveBeenCalled();
  expect(BetModerationResultPublisher.prototype.publish).toHaveBeenCalled();
});

it("publisher is initialised once during listener.init(), not on every message", async () => {
  const { listener } = await setup();

  // Publisher should have been initialised exactly once — during listener.init() in setup().
  expect(BetModerationResultPublisher.prototype.init).toHaveBeenCalledTimes(1);

  jest.clearAllMocks();

  // Fire the same message twice — no additional init calls should occur.
  await listener.onMessage(createEventData(), createMessage());
  await listener.onMessage(createEventData(), createMessage());

  expect(BetModerationResultPublisher.prototype.init).not.toHaveBeenCalled();
});
