import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  BetStatus,
  ISettleSlipRowEvent,
  LiveMarketType,
  LiveSettlementReason,
  ResultingStatus,
  SlipRowStatus,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import SettleSlipRowListener from "../SettleSlipRowListener";
import { Bet } from "../../../model/Bet";
import {
  PendingBetUpdate,
  PendingBetUpdateKind,
} from "../../../model/PendingBetUpdate";

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

it("propagates live void metadata when row result is ROW_VOID", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId, rowId);

  const listener = new SettleSlipRowListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipRowEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      slipRowId: rowId,
      result: ResultingStatus.ROW_VOID,
      betKind: BetKind.LIVE,
      marketId: "event-one:NEXT_CORNER",
      marketType: LiveMarketType.NEXT_CORNER,
      marketVersion: 2,
      settlementReason: LiveSettlementReason.MANUAL_VOID,
      settlementSequence: 4,
      winningSide: TeamSide.NONE,
    },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.betKind).toEqual(BetKind.LIVE);
  expect(updatedBet!.rows[0].betKind).toEqual(BetKind.LIVE);
  expect(updatedBet!.rows[0].status).toEqual(SlipRowStatus.VOID);
  expect(updatedBet!.rows[0].marketId).toEqual("event-one:NEXT_CORNER");
  expect(updatedBet!.rows[0].marketType).toEqual(LiveMarketType.NEXT_CORNER);
  expect(updatedBet!.rows[0].marketVersion).toEqual(2);
  expect(updatedBet!.rows[0].settlementReason).toEqual(
    LiveSettlementReason.MANUAL_VOID
  );
  expect(updatedBet!.rows[0].settlementSequence).toEqual(4);
  expect(updatedBet!.rows[0].winningSide).toEqual(TeamSide.NONE);
});

it("parks row settlements when the bet is not found", async () => {
  const listener = new SettleSlipRowListener(messengerWrapper.connection);
  await listener.init();

  const slipId = new mongoose.Types.ObjectId().toHexString();
  const event: ISettleSlipRowEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      slipRowId: new mongoose.Types.ObjectId().toHexString(),
      result: ResultingStatus.ROW_WIN,
    },
  };

  await listener.onMessage(event, buildMessage());

  expect(listener.ack).toHaveBeenCalled();
  expect((listener as unknown as { channel: { nack: jest.Mock } }).channel.nack).not.toHaveBeenCalled();
  expect(await PendingBetUpdate.countDocuments({ slipId })).toEqual(1);

  const pendingUpdate = await PendingBetUpdate.findOne({ slipId });
  expect(pendingUpdate!.kind).toEqual(PendingBetUpdateKind.SETTLE_SLIP_ROW);
});

it("does not regress terminal row outcomes on duplicate or conflicting updates", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const rowId = new mongoose.Types.ObjectId().toHexString();
  await createBet(slipId, rowId);
  await Bet.updateOne(
    { slipId, "rows.id": rowId },
    {
      $set: {
        "rows.$.status": SlipRowStatus.VOID,
        "rows.$.settlementReason": LiveSettlementReason.MANUAL_VOID,
      },
    }
  );

  const listener = new SettleSlipRowListener(messengerWrapper.connection);
  await listener.init();

  const event: ISettleSlipRowEvent = {
    timestamp: new Date().toISOString(),
    data: {
      slipId,
      slipRowId: rowId,
      result: ResultingStatus.ROW_LOSS,
      winningSelection: "Away",
    },
  };

  await listener.onMessage(event, buildMessage());

  const updatedBet = await Bet.findOne({ slipId });
  expect(updatedBet!.rows[0].status).toEqual(SlipRowStatus.VOID);
  expect(updatedBet!.rows[0].winningSelection).toEqual("");
});
