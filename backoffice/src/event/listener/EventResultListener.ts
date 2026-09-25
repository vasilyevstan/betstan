import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventStatus,
  EventVisibility,
  IEventResultEvent,
  QueueNames,
} from "@betstan/common";

import { Event } from "../../model/Event";
import { cashBackAuthorityWritable } from "../../service/CashBackSourceService";

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "backoffice_result_set";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;

  async init() {
    await super.init();
    await this.channel.prefetch(1);
  }

  async onMessage(event: IEventResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    if (event.sender === this.serviceName) {
      // ignoring selfinflicted message
      this.ack(msg);
      return;
    }

    const updated = await Event.updateOne(
      { eventId: data.eventId, $and: [cashBackAuthorityWritable] },
      {
        $set: {
          homeResult: data.homeScore,
          awayResult: data.awayScore,
          status: EventStatus.RESULTED,
          visibility: EventVisibility.OFFLINE,
        },
        $inc: { cashBackAuthorityRevision: 1 },
        $currentDate: { cashBackAuthorityAt: true },
      }
    );
    if (updated.matchedCount === 0 && await Event.exists({ eventId: data.eventId })) {
      console.warn("backoffice_result_waiting_for_cash_back", { eventId: data.eventId });
      await new Promise(resolve => setTimeout(resolve, 100));
      this.channel.nack(msg, false, true);
      return;
    }
    this.ack(msg);
  }
}

export default EventResultListener;
