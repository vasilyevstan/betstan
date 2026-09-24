import { ConsumeMessage } from "amqplib";
import {
  AListener,
  IEventResultEvent,
  QueueNames,
} from "@betstan/common";

import { Event } from "../../model/Event";
import { EventArchive } from "../../model/EventArchive";
import { cashBackAuthorityWritable, LiveResultSource } from "../../model/liveStateFields";

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "gamemaster_result_set";
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

    const requestedAt = new Date(event.timestamp ?? new Date().toISOString());
    const updatedEvent = await Event.findOneAndUpdate(
      {
        eventId: data.eventId,
        resultPublishedAt: null,
        "pendingResult.source": { $ne: LiveResultSource.MANUAL },
        $and: [cashBackAuthorityWritable],
      },
      {
        $inc: { cashBackAuthorityRevision: 1 },
        $currentDate: { cashBackAuthorityAt: true },
        $set: {
          homeResult: data.homeScore,
          awayResult: data.awayScore,
          resultPublishedAt: requestedAt,
          pendingResult: {
            source: LiveResultSource.MANUAL,
            homeScore: data.homeScore,
            awayScore: data.awayScore,
            requestedAt,
            sender: event.sender ?? null,
          },
        },
      },
      { new: true }
    );

    if (!updatedEvent) {
      const fenced = await Event.exists({
        eventId: data.eventId,
        $or: [
          { cashBackHold: { $exists: true } },
          { cashBackAuthorityIntent: { $exists: true } },
        ],
      });
      if (fenced) {
        console.warn("gamemaster_result_waiting_for_authority", { eventId: data.eventId });
        await new Promise(resolve => setTimeout(resolve, 100));
        this.channel.nack(msg, false, true);
        return;
      }
      const [eventExists, archivedExists] = await Promise.all([
        Event.exists({ eventId: data.eventId }),
        EventArchive.exists({ eventId: data.eventId }),
      ]);
      if (!eventExists && !archivedExists) {
        console.log("event not found", event);
      }
      this.ack(msg);
      return;
    }

    this.ack(msg);
  }
}

export default EventResultListener;
