import mongoose from "mongoose";
import EventResultListener from "../EventResultListener";
import { ConsumeMessage } from "amqplib";
import {
  IEventResultEvent,
  ResultingStatus,
  messengerWrapper,
} from "@betstan/common";
import { Bet, BetArchive } from "../../../model/Bet";
import SettleSlipRowPublisher from "../../publisher/SettleSlipRowPublisher";
import SettleSlipPublisher from "../../publisher/SettleSlipPublisher";

const setup = async (
  productName: string,
  slipRowsAmount: number,
  numberOfBets?: number
) => {
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();

  const bets = Array();

  if (!numberOfBets) numberOfBets = 1;

  for (let i = 0; i < numberOfBets; i++) {
    const bet = await createBet();
    bets.push(bet);
  }

  const message: ConsumeMessage = {
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
  };

  return { listener, bets, message };

  async function createBet() {
    const betData = getBetData(productName, slipRowsAmount);

    const bet = new Bet({
      status: ResultingStatus.BET_APPROVED,
      userId: betData.userId,
      slipId: betData.slipId,
      wager: betData.wager,
      timestamp: new Date().toISOString(),
      moderationTimestamp: "",
      resultingTimestamp: "",
      rows: betData.rows.map((row) => {
        return {
          eventId: row.eventId,
          eventName: row.eventName,
          oddsId: row.oddsId,
          oddsValue: row.oddsValue,
          oddsName: row.oddsName,
          productName: row.productName,
          productId: row.productId,
          timestamp: row.timestamp,
          id: row.id,
          resultingTimestamp: "",
          result: ResultingStatus.ROW_NO_RESULT,
        };
      }),
    });

    await bet.save();
    return bet;
  }
};

const getBetData = (productName: string, slipRowsAmount: number) => {
  return {
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "testUser",
    slipId: new mongoose.Types.ObjectId().toHexString(),
    wager: 5,
    rows: getSlipRows(slipRowsAmount, productName),
  };
};

const getSlipRows = (amount: number, productName: string) => {
  let rows = Array();
  for (let i = 0; i < amount; i++) {
    // const eventId = new mongoose.Types.ObjectId().toHexString();

    rows.push({
      eventId: new mongoose.Types.ObjectId().toHexString(),
      eventName: "string",
      oddsId: new mongoose.Types.ObjectId().toHexString(),
      oddsValue: 1.5,
      oddsName: "Team " + i,
      productName: productName,
      productId: new mongoose.Types.ObjectId().toHexString(),
      timestamp: new Date().toISOString(),
      id: new mongoose.Types.ObjectId().toHexString(),
    });
  }

  return rows;
};

const getData = (
  homeScore: number,
  awayScore: number,
  eventId: string,
  home: string,
  away: string
): IEventResultEvent => {
  return {
    data: {
      eventId: eventId,
      homeScore: homeScore,
      awayScore: awayScore,
      home: home,
      away: away,
    },
  };
};

it("checks that win result for the bet was set", async () => {
  const { listener, bets, message } = await setup("1X2", 1);

  const eventId = bets[0].rows[0].eventId;

  const data = getData(3, 0, eventId, bets[0].rows[0].oddsName, "Other team");

  await listener.onMessage(data, message);

  const updatedBet = await BetArchive.findOne();

  expect(listener.ack).toHaveBeenCalled();
  expect(updatedBet!.rows[0].eventId).toEqual(data.data.eventId);
  expect(updatedBet!.status).toEqual(ResultingStatus.BET_WIN);
  expect(updatedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
  expect(SettleSlipRowPublisher.prototype.publish).toHaveBeenCalled();
  expect(SettleSlipPublisher.prototype.publish).toHaveBeenCalled();
});

it("checks that loss result for the bet was set", async () => {
  const { listener, bets, message } = await setup("1X2", 1);

  const eventId = bets[0].rows[0].eventId;

  const data = getData(1, 3, eventId, bets[0].rows[0].oddsName, "Other team");

  await listener.onMessage(data, message);

  const updatedBet = await BetArchive.findOne();

  expect(listener.ack).toHaveBeenCalled();
  expect(updatedBet!.rows[0].eventId).toEqual(data.data.eventId);
  expect(updatedBet!.status).toEqual(ResultingStatus.BET_LOSS);
  expect(updatedBet!.rows[0].result).toEqual(ResultingStatus.ROW_LOSS);
  expect(SettleSlipRowPublisher.prototype.publish).toHaveBeenCalled();
  expect(SettleSlipPublisher.prototype.publish).toHaveBeenCalled();
});

it("checks that bet is not resolved if the bet product does not exist", async () => {
  const { listener, bets, message } = await setup("uga-uga", 1);

  const eventId = bets[0].rows[0].eventId;
  const data = getData(1, 3, eventId, bets[0].rows[0].oddsName, "Other team");

  // const originalBet = await Bet.findById(bet.id);

  await listener.onMessage(data, message);

  const updatedBet = await Bet.findOne();

  expect(listener.ack).toHaveBeenCalled();
  expect(updatedBet!.rows[0].eventId).toEqual(data.data.eventId);
  expect(updatedBet!.status).toEqual(ResultingStatus.BET_APPROVED);
  expect(updatedBet!.rows[0].result).toEqual(ResultingStatus.ROW_NO_RESULT);
  expect(SettleSlipRowPublisher.prototype.publish).not.toHaveBeenCalled();
  expect(SettleSlipPublisher.prototype.publish).not.toHaveBeenCalled();
});

it("bet with multiple slip rows eventually won", async () => {
  const numberOfSlipRows = 5;
  const { listener, bets, message } = await setup("1X2", numberOfSlipRows);

  for (let i = 0; i < numberOfSlipRows; i++) {
    const eventId = bets[0].rows[i].eventId;
    const data = getData(3, 1, eventId, bets[0].rows[i].oddsName, "Other team");
    await listener.onMessage(data, message);
    const updatedBet = await Bet.findOne();

    if (i < bets[0].rows.length - 1) {
      expect(updatedBet!.rows[i].eventId).toEqual(data.data.eventId);
      expect(updatedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
      expect(updatedBet!.status).toEqual(ResultingStatus.BET_APPROVED);
    } else {
      const updatedBet = await BetArchive.findOne();
      expect(updatedBet!.rows[i].eventId).toEqual(data.data.eventId);
      expect(updatedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
      expect(updatedBet!.status).toEqual(ResultingStatus.BET_WIN);
    }
    expect(SettleSlipRowPublisher.prototype.publish).toHaveBeenCalled();
    // expect(SettleSlipPublisher.prototype.publish).not.toHaveBeenCalled();

    expect(listener.ack).toHaveBeenCalled();
  }

  expect(SettleSlipPublisher.prototype.publish).toHaveBeenCalled();
});

it("there are 20 bets in the system but only one is resolved", async () => {
  const winningBetIndex = 9;
  const numberOfSlipRows = 5;
  const numberOfBetsInTheSystem = 20;
  const { listener, bets, message } = await setup(
    "1X2",
    numberOfSlipRows,
    numberOfBetsInTheSystem
  );

  for (let i = 0; i < numberOfSlipRows; i++) {
    const eventId = bets[winningBetIndex].rows[i].eventId;
    const data = getData(
      3,
      1,
      eventId,
      bets[winningBetIndex].rows[i].oddsName,
      "Other team"
    );
    await listener.onMessage(data, message);
    const updatedBet = await Bet.findById(bets[winningBetIndex].id);

    if (i < bets[winningBetIndex].rows.length - 1) {
      expect(updatedBet!.rows[i].eventId).toEqual(data.data.eventId);
      expect(updatedBet!.rows[i].result).toEqual(ResultingStatus.ROW_WIN);
      expect(updatedBet!.status).toEqual(ResultingStatus.BET_APPROVED);
    } else {
      const updatedBet = await BetArchive.findOne();
      expect(updatedBet!.rows[i].eventId).toEqual(data.data.eventId);
      expect(updatedBet!.rows[i].result).toEqual(ResultingStatus.ROW_WIN);
      expect(updatedBet!.status).toEqual(ResultingStatus.BET_WIN);
    }
    expect(SettleSlipRowPublisher.prototype.publish).toHaveBeenCalled();
    // expect(SettleSlipPublisher.prototype.publish).not.toHaveBeenCalled();

    expect(listener.ack).toHaveBeenCalled();
  }

  expect(SettleSlipPublisher.prototype.publish).toHaveBeenCalled();
});

// it("there are 10000 bets in the system, single event processing time", async () => {
//   const winningBetIndex = 5000;
//   const numberOfSlipRows = 10;
//   const numberOfBetsInTheSystem = 10000;
//   const { listener, bets, message } = await setup(
//     "1X2",
//     numberOfSlipRows,
//     numberOfBetsInTheSystem
//   );

//   console.log("setup complate");

//   const i = 5;
//   const eventId = bets[winningBetIndex].rows[i].eventId;
//   const data = getData(
//     3,
//     1,
//     eventId,
//     bets[winningBetIndex].rows[i].oddsName,
//     "Other team"
//   );
//   await listener.onMessage(data, message);
//   const updatedBet = await Bet.findById(bets[winningBetIndex].id);

//   expect(updatedBet!.rows[i].eventId).toEqual(data.data.eventId);
//   expect(updatedBet!.rows[i].result).toEqual(ResultingStatus.ROW_WIN);
//   if (i < bets[winningBetIndex].rows.length - 1) {
//     expect(updatedBet!.status).toEqual(ResultingStatus.BET_APPROVED);
//   } else {
//     expect(updatedBet!.status).toEqual(ResultingStatus.BET_WIN);
//   }
//   expect(SettleSlipRowPublisher.prototype.publish).toHaveBeenCalled();
//   // expect(SettleSlipPublisher.prototype.publish).not.toHaveBeenCalled();

//   expect(listener.ack).toHaveBeenCalled();

//   expect(SettleSlipPublisher.prototype.publish).toHaveBeenCalled();
// }, 1000000);

// it("there are 10000 of bets in the system but only one is resolved", async () => {
//   const winningBetIndex = 5000;
//   const numberOfSlipRows = 10;
//   const numberOfBetsInTheSystem = 10000;
//   const { listener, bets, message } = await setup(
//     "1X2",
//     numberOfSlipRows,
//     numberOfBetsInTheSystem
//   );

//   for (let i = 0; i < numberOfSlipRows; i++) {
//     const eventId = bets[winningBetIndex].rows[i].eventId;
//     const data = getData(
//       3,
//       1,
//       eventId,
//       bets[winningBetIndex].rows[i].oddsName,
//       "Other team"
//     );
//     await listener.onMessage(data, message);
//     const updatedBet = await Bet.findById(bets[winningBetIndex].id);

//     expect(updatedBet!.rows[i].eventId).toEqual(data.data.eventId);
//     expect(updatedBet!.rows[0].result).toEqual(ResultingStatus.ROW_WIN);
//     if (i < bets[winningBetIndex].rows.length - 1) {
//       expect(updatedBet!.status).toEqual(ResultingStatus.BET_APPROVED);
//     } else {
//       expect(updatedBet!.status).toEqual(ResultingStatus.BET_WIN);
//     }
//     expect(SettleSlipRowPublisher.prototype.publish).toHaveBeenCalled();
//     // expect(SettleSlipPublisher.prototype.publish).not.toHaveBeenCalled();

//     expect(listener.ack).toHaveBeenCalled();
//   }

//   expect(SettleSlipPublisher.prototype.publish).toHaveBeenCalled();
// }, 1000000);
