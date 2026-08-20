import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventStatus,
  INewEventEvent,
  QueueNames,
} from "@betstan/common";
import { Event } from "../../model/Event";

class NewEventListener extends AListener<INewEventEvent> {
  serviceName: string = "backoffice_new_event";
  queue: QueueNames.NEW_EVENT = QueueNames.NEW_EVENT;

  async onMessage(event: INewEventEvent, msg: ConsumeMessage) {
    const { data } = event;

    if (event.sender === this.serviceName) {
      // ignoring selfinflicted message
      this.channel.ack(msg);
      return;
    }

    try {
      await Event.updateOne(
        { eventId: data.id },
        {
          $setOnInsert: {
            eventId: data.id,
            name: data.name,
            time: data.time,
            home: data.home,
            away: data.away,
            status: EventStatus.NO_RESULT,
          },
        },
        { upsert: true }
      );
    } catch (err: any) {
      if (err?.code !== 11000) {
        throw err;
      }
    }

    this.channel.ack(msg);
  }
}

export default NewEventListener;
