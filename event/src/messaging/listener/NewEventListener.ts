import { ConsumeMessage, Connection } from "amqplib";
import { AListener, INewEventEvent, QueueNames } from "@betstan/common";
import EventTemplate from "../../data/EventTemplate";
import { Event } from "../../model/Event";

class NewEventListener extends AListener<INewEventEvent> {
  serviceName: string = "event_new_event";
  queue: QueueNames.NEW_EVENT = QueueNames.NEW_EVENT;

  async onMessage(event: INewEventEvent, msg: ConsumeMessage) {
    const { data } = event;

    if (event.sender === this.serviceName) {
      // ignoring selfinflicted message
      this.channel.ack(msg);
      return;
    }

    // in the future all events and products must come from backoffice
    const newEvent = new EventTemplate(
      data.id,
      data.home,
      data.away,
      data.time
    );
    const persistedEvent = await Event.create(newEvent);
    await persistedEvent.save();

    //await newEvent.save();

    this.channel.ack(msg);
  }
}

export default NewEventListener;
