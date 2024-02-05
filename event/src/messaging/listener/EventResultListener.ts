import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventStatus,
  IEventResultEvent,
  QueueNames,
} from "@betstan/common";

import { Event } from "../../model/Event";

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "event_result";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;

  async onMessage(event: IEventResultEvent, msg: ConsumeMessage) {
    const { data } = event;

    const storedEvent = await Event.findOne({ eventId: data.eventId });

    if (!storedEvent) {
      console.log("event not found", event);
      this.channel.ack(msg);
      return;
    }

    storedEvent.status = EventStatus.RESULTED;
    await storedEvent.save();
    this.channel.ack(msg);
  }
}

export default EventResultListener;
