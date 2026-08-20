import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventStatus,
  IEventResultEvent,
  QueueNames,
} from "@betstan/common";

import { Event } from "../../model/Event";
import { EventArchive } from "../../model/EventArchive";

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "gamemaster_result_set";
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

    await EventArchive.updateOne(
      { eventId: storedEvent.eventId },
      {
        $setOnInsert: {
          eventId: storedEvent.eventId,
          time: storedEvent.time,
          home: storedEvent.home,
          away: storedEvent.away,
          homeResult: data.homeScore,
          awayResult: data.awayScore,
          status: EventStatus.RESULTED,
        },
      },
      { upsert: true }
    );
    await Event.deleteOne({ _id: storedEvent._id });

    this.ack(msg);
  }
}

export default EventResultListener;
