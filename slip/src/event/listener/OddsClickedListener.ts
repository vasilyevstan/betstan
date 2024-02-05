import { ConsumeMessage } from "amqplib";
import {
  AListener,
  IEventOddsSelectedEvent,
  QueueNames,
  SlipStatus,
} from "@betstan/common";
import { Slip } from "../../model/Slip";

class OddsClickedListener extends AListener<IEventOddsSelectedEvent> {
  serviceName: string = "slip_odds_clicked";
  queue: QueueNames.EVENT_ODDS_SELECTED = QueueNames.EVENT_ODDS_SELECTED;

  async onMessage(event: IEventOddsSelectedEvent, msg: ConsumeMessage) {
    const userId = event.data.userId;

    if (!userId) {
      this.channel.ack(msg);
      return;
    }

    let slip = await Slip.findOne({
      userId: userId,
      status: SlipStatus.DRAFT,
    });

    if (!slip) {
      slip = new Slip({
        userId,
        status: SlipStatus.DRAFT,
        timestamp: new Date().toISOString(),
        rows: [
          {
            timestamp: event.timestamp,
            ...event.data,
          },
        ],
      });
    } else {
      const newRow = { timestamp: event.timestamp, ...event.data };

      // check if that odds already in the list
      let hasDuplicate = false;
      slip.rows.map((row) => {
        if (row.oddsId === event.data.oddsId) {
          hasDuplicate = true;
        }
      });

      if (!hasDuplicate) {
        slip.rows.push(newRow);
      }
    }

    await slip.save();
    this.channel.ack(msg);
  }
}

export default OddsClickedListener;
