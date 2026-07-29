import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetStatus,
  ISettleSlipRowEvent,
  ResultingStatus,
  SlipRowStatus,
  messengerWrapper,
} from "@betstan/common";
import SettleSlipRowListener from "../SettleSlipRowListener";
import { Bet } from "../../../model/Bet";

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

const createBet = async (slipId: string, rowId: string) => {
  const bet = new Bet({
    status: BetStatus.CONFIRMED,
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testuser",
    slipId,
    wager: 10,
    timestamp: new Date().toISOString(),
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
      },
    ],
  });
  await bet.save();
  return bet;
};

it("sets row status to WIN when row result is ROW_WIN", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId, rowId);

  const listener = new SettleSlipRowListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipRowEvent = {
    timestamp: new Date().toISOString(),
    data: { slipId, slipRowId: rowId, result: ResultingStatus.ROW_WIN },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.rows[0].status).toEqual(SlipRowStatus.WIN);
});

it("sets row status to LOSS when row result is ROW_LOSS", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId, rowId);

  const listener = new SettleSlipRowListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipRowEvent = {
    timestamp: new Date().toISOString(),
    data: { slipId, slipRowId: rowId, result: ResultingStatus.ROW_LOSS },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.rows[0].status).toEqual(SlipRowStatus.LOSS);
});

it("nacks if bet is not found", async () => {
  const listener = new SettleSlipRowListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipRowEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId: new mongoose.Types.ObjectId().toHexString(),
      slipRowId: new mongoose.Types.ObjectId().toHexString(),
      result: ResultingStatus.ROW_WIN,
    },
  };

  await listener.onMessage(event, buildMessage());

  // ack is not called when bet not found — channel.nack requeues the message
  expect(listener.ack).not.toHaveBeenCalled();
});
