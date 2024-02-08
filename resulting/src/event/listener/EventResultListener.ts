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

    const settleSlipRowPublisher = new SettleSlipRowPublisher(
      messengerWrapper.connection
    );
    await settleSlipRowPublisher.init();

    const settleSlipPublisher = new SettleSlipPublisher(
      messengerWrapper.connection
    );
    await settleSlipPublisher.init();

    for (const bet of bets) {
      let betLost = false;
      let settledRows = 0;

      for (const row of bet.rows) {
        try {
          if (row.eventId !== data.eventId) {
            if (row.result === ResultingStatus.ROW_WIN) settledRows++;
            continue;
          }

          settledRows++;

          if (row.result !== ResultingStatus.ROW_NO_RESULT) continue;

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

          await settleSlipRowPublisher.publish({
            data: {
              slipId: bet.slipId,
              slipRowId: row.id,
              result: row.result,
            },
          });
        } catch (error) {
          console.error("Error processing row:", error);
        }
      }

      if (settledRows === bet.rows.length && !betLost) {
        bet.status = ResultingStatus.BET_WIN;
      } else if (betLost) {
        bet.status = ResultingStatus.BET_LOSS;
      }

      try {
        if (bet.isModified()) {
          await bet.save();

          if (bet.status !== ResultingStatus.BET_APPROVED) {
            await settleSlipPublisher.publish({
              data: {
                slipId: bet.slipId,
                result: bet.status,
              },
            });
          }
        }
      } catch (error) {
        console.error("Error saving bet:", error);
      }
    }

    this.channel.ack(msg);
  }
}

export default EventResultListener;
