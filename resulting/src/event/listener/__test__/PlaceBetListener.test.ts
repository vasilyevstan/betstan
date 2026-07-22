import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  IPlaceBetEvent,
  ResultingStatus,
  messengerWrapper,
} from "@betstan/common";
import { Bet } from "../../../model/Bet";
import PlaceBetListener from "../PlaceBetListener";

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
    wager: 20,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Test Match",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 2.0,
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

it("places bet event creates a new bet with BET_PENDING status", async () => {
  const { listener } = await setup();
  const message = createMessage();
  const data = createEventData();

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.status).toEqual(ResultingStatus.BET_PENDING);
  expect(savedBet!.userId).toEqual(data.data.userId);
  expect(savedBet!.wager).toEqual(data.data.wager);
  expect(listener.ack).toHaveBeenCalled();
});

it("all slip rows are saved with ROW_NO_RESULT status", async () => {
  const { listener } = await setup();
  const message = createMessage();
  const data = createEventData();

  await listener.onMessage(data, message);

  const savedBet = await Bet.findOne({ slipId: data.data.slipId });
  expect(savedBet).not.toBeNull();
  expect(savedBet!.rows).toHaveLength(1);
  expect(savedBet!.rows[0].result).toEqual(ResultingStatus.ROW_NO_RESULT);
  expect(savedBet!.rows[0].eventId).toEqual(data.data.rows[0].eventId);
});

it("multiple place bet events each create a separate bet", async () => {
  const { listener } = await setup();
  const message = createMessage();

  await listener.onMessage(createEventData(), message);
  await listener.onMessage(createEventData(), message);

  const bets = await Bet.find({});
  expect(bets).toHaveLength(2);
});
