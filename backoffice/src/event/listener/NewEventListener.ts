import { ConsumeMessage, Connection } from "amqplib";
import {
  AListener,
  BetStatus,
  EventStatus,
  INewEventEvent,
  QueueNames,
  SlipRowStatus,
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

    const newEvent = new Event({
      eventId: data.id,
      name: data.name,
      time: data.time,
      home: data.home,
      away: data.away,
      status: EventStatus.NO_RESULT,
    });

    await newEvent.save();

    this.channel.ack(msg);
  }
}

export default NewEventListener;
