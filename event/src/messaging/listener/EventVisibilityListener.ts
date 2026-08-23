import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventStatus,
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

    try {
      await Event.updateOne(
        { eventId: data.eventId },
        {
          $set: { pendingVisibility: data.visibility },
          $setOnInsert: {
            eventId: data.eventId,
            name: data.eventId,
            time: new Date(),
            status: EventStatus.NO_RESULT,
            visibility: EventVisibility.OFFLINE,
            visibilityInitialized: false,
            eventMetadataInitialized: false,
            products: [],
            source: "EXTERNAL",
          },
        },
        { upsert: true }
      );
    } catch (err: any) {
      if (err?.code !== 11000) {
        throw err;
      }

      await Event.updateOne(
        { eventId: data.eventId },
        { $set: { pendingVisibility: data.visibility } }
      );
    }

    await Event.updateOne(
      {
        eventId: data.eventId,
        $or: [
          { eventMetadataInitialized: false },
          {
            eventMetadataInitialized: { $exists: false },
            source: "EXTERNAL",
            "live.sequence": { $exists: true },
            "products.0": { $exists: false },
          },
        ],
      },
      {
        $set: {
          visibility: EventVisibility.OFFLINE,
          eventMetadataInitialized: false,
        },
      }
    );

    await Event.updateOne(
      {
        eventId: data.eventId,
        pendingVisibility: data.visibility,
        $or: [
          { eventMetadataInitialized: true },
          { "products.0": { $exists: true } },
        ],
      },
      {
        $set: {
          visibility: data.visibility,
          visibilityInitialized: true,
          eventMetadataInitialized: true,
        },
        $unset: { pendingVisibility: 1 },
      }
    );

    this.channel.ack(msg);
  }
}

export default EventVisibilityListener;
