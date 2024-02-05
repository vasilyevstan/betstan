import { ConsumeMessage } from "amqplib";
import {
  AListener,
  IEventResultEvent,
  QueueNames,
  ResultingStatus,
  messengerWrapper,
} from "@betstan/common";
import { Bet } from "../../model/Bet";
import SettleSlipRowPublisher from "../publisher/SettleSlipRowPublisher";
import SettleSlipPublisher from "../publisher/SettleSlipPublisher";

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "resulting_result";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;

  async onMessage(event: IEventResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    const bets = await Bet.find({ status: ResultingStatus.BET_APPROVED });

    const correctScoreResult = data.homeScore + " - " + data.awayScore;
    const oneCrossTwoResult =
      data.homeScore > data.awayScore
        ? data.home
        : data.homeScore < data.awayScore
        ? data.away
        : "draw";

    // console.log("bets to validate", bets);
    // console.log(
    //   "event result by product",
    //   oneCrossTwoResult,
    //   correctScoreResult
    // );

    const settleSlipRowPublisher = new SettleSlipRowPublisher(
      messengerWrapper.connection
    );
    await settleSlipRowPublisher.init();

    const settleSlipPublisher = new SettleSlipPublisher(
      messengerWrapper.connection
    );
    await settleSlipPublisher.init();

    bets.map(async (bet) => {
      let betLost = false;
      let settledRows = 0;

      bet.rows.map(async (row) => {
        if (row.eventId !== data.eventId) {
          if (row.result === ResultingStatus.ROW_WIN) settledRows++;

          return;
        }

        settledRows++;

        if (row.result !== ResultingStatus.ROW_NO_RESULT) return;

        switch (row.productName) {
          case "1X2":
            if (row.oddsName == oneCrossTwoResult) {
              row.result = ResultingStatus.ROW_WIN;
            } else {
              row.result = ResultingStatus.ROW_LOSS;
              betLost = true;
            }
            break;
          case "Correct Score":
            if (row.oddsName === correctScoreResult) {
              row.result = ResultingStatus.ROW_WIN;
            } else {
              row.result = ResultingStatus.ROW_LOSS;
              betLost = true;
            }
            break;
        }

        settleSlipRowPublisher.publish({
          data: {
            slipId: bet.slipId,
            slipRowId: row.id,
            result: row.result,
          },
        });
      });

      console.log("settled rows", settledRows, bet.rows.length, betLost);

      if (settledRows === bet.rows.length && !betLost) {
        bet.status = ResultingStatus.BET_WIN;
      } else if (betLost) {
        bet.status = ResultingStatus.BET_LOSS;
      }

      if (bet.isModified()) {
        // console.log("bet was modified", bet.id);
        await bet.save();

        if (bet.status !== ResultingStatus.BET_APPROVED) {
          settleSlipPublisher.publish({
            data: {
              slipId: bet.slipId,
              result: bet.status,
            },
          });
        }
      }
    });

    this.channel.ack(msg);
  }
}

export default EventResultListener;

// [gaming-resulting] Recieved: {"data":{"userId":"659f143572631e10e435467b","userName":"ytrewq","slipId":"65bcc94431583acf96bf75f3","wager":"2","rows":[{"eventId":"65bcc939a4e51980b196297e","eventName":"stan - not stan","oddsId":"58432aeb-2a36-4d9b-b562-e89c7f540c7f","oddsValue":4.54,"oddsName":"draw","productName":"1X2","productId":"951c83d7-6eb0-4956-8e96-c1c3e59cc5c0","timestamp":"2024-02-02T10:51:48.402Z","id":"65bcc94431583acf96bf75f4"},{"eventId":"65bcc939a4e51980b196297e","eventName":"stan - not stan","oddsId":"31583356-04f1-48f0-82ba-1c576e8b85ab","oddsValue":1.85,"oddsName":"6 - 4","productName":"Correct Score","productId":"47369489-456b-45c8-9f54-6d84c5739234","timestamp":"2024-02-02T10:51:48.961Z","id":"65bcc94431583acf96bf75fa"}]},"timestamp":"2024-02-02T10:51:53.016Z","sender":"slip_place_bet"} from queue slip:bet
