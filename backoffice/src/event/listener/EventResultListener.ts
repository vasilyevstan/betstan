import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventStatus,
  EventVisibility,
  IEventResultEvent,
  QueueNames,
} from "@betstan/common";

import { Event } from "../../model/Event";

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "backoffice_result_set";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;

  async onMessage(event: IEventResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    if (event.sender === this.serviceName) {
      // ignoring selfinflicted message
      this.ack(msg);
      return;
    }

    const storedEvent = await Event.findOne({ eventId: data.eventId });

    if (!storedEvent) {
      console.log("event not found", event);
      this.ack(msg);
      return;
    }

    storedEvent.set({
      homeResult: data.homeScore,
      awayResult: data.awayScore,
      status: EventStatus.RESULTED,
      visibility: EventVisibility.OFFLINE,
    });

    await storedEvent.save();
    this.ack(msg);
  }
}

export default EventResultListener;
