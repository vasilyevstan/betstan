import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventVisibility,
  INewEventEvent,
  QueueNames,
} from "@betstan/common";
import EventTemplate from "../../data/EventTemplate";
import { Event } from "../../model/Event";

class NewEventListener extends AListener<INewEventEvent> {
  serviceName: string = "event_new_event";
  queue: QueueNames.NEW_EVENT = QueueNames.NEW_EVENT;

  async onMessage(event: INewEventEvent, msg: ConsumeMessage) {
    const { data } = event;
    const requestedVisibility = (
      data as typeof data & { visibility?: EventVisibility }
    ).visibility;
    const hasExplicitVisibility =
      requestedVisibility === EventVisibility.OFFLINE
      || requestedVisibility === EventVisibility.ONLINE;
    const visibility =
      requestedVisibility === EventVisibility.OFFLINE
        ? EventVisibility.OFFLINE
        : EventVisibility.ONLINE;

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
    const eventMetadata = {
      name: newEvent.name,
      time: newEvent.time,
      home: newEvent.home,
      away: newEvent.away,
      products: newEvent.products,
    };

    try {
      await Event.updateOne(
        { eventId: data.id },
        {
          $setOnInsert: {
            eventId: newEvent.eventId,
            source: "EXTERNAL",
            ...eventMetadata,
            visibility,
            visibilityInitialized: true,
            eventMetadataInitialized: true,
            ...(hasExplicitVisibility ? { visibilityDecision: visibility } : {}),
          },
        },
        { upsert: true }
      );
    } catch (err: any) {
      if (err?.code !== 11000) {
        throw err;
      }
    }

    await Event.updateOne(
      {
        eventId: data.id,
        $or: [
          { eventMetadataInitialized: false },
          { visibilityInitialized: false },
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
          ...eventMetadata,
          eventMetadataInitialized: true,
        },
      }
    );

    for (const pendingVisibility of [
      EventVisibility.OFFLINE,
      EventVisibility.ONLINE,
    ]) {
      await Event.updateOne(
        {
          eventId: data.id,
          eventMetadataInitialized: true,
          pendingVisibility,
        },
        {
          $set: {
            visibility: pendingVisibility,
            visibilityInitialized: true,
          },
          $unset: { pendingVisibility: 1 },
        }
      );
    }

    await Event.updateOne(
      {
        eventId: data.id,
        eventMetadataInitialized: true,
        visibilityInitialized: { $exists: false },
        pendingVisibility: { $exists: false },
        visibility: EventVisibility.OFFLINE,
      },
      {
        $set: { visibilityInitialized: true },
      }
    );

    await Event.updateOne(
      {
        eventId: data.id,
        eventMetadataInitialized: true,
        visibilityInitialized: { $ne: true },
        pendingVisibility: { $exists: false },
      },
      {
        $set: {
          visibility,
          visibilityInitialized: true,
          ...(hasExplicitVisibility ? { visibilityDecision: visibility } : {}),
        },
      }
    );

    this.channel.ack(msg);
  }
}

export default NewEventListener;
