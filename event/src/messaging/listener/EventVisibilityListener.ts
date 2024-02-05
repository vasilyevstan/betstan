import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventVisibility,
  IEventVibibilityEvent,
  QueueNames,
} from "@betstan/common";
import { Event } from "./../../model/Event";

class EventVisibilityListener extends AListener<IEventVibibilityEvent> {
  serviceName: string = "event_event_visibility";
  queue: QueueNames.EVENT_VISIBILITY = QueueNames.EVENT_VISIBILITY;

  async onMessage(event: IEventVibibilityEvent, msg: ConsumeMessage) {
    const { data } = event;

    const storedEvent = await Event.findOne({ eventId: data.eventId });

    if (!storedEvent) {
      console.log("event not found", event);
      this.channel.ack(msg);
      return;
    }

    if (data.visibility === EventVisibility.ONLINE) {
      storedEvent.visibility = EventVisibility.ONLINE;
    } else {
      storedEvent.visibility = EventVisibility.OFFLINE;
    }

    await storedEvent.save();

    this.channel.ack(msg);
  }
}

export default EventVisibilityListener;
