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
    // A completed live-simulated event (one that ever entered the live
    // pipeline -- `live` is populated, whether still mid-match or already
    // FULL_TIME) must stay visible with its retained live snapshot across
    // refresh/reconnect. It is only ever hidden later, when the next
    // event's own T-10 pre-kickoff window becomes authoritative (see
    // `applyLiveEventUpdate`'s PRE_MATCH handoff, which retires it back to
    // OFFLINE). Ordinary pre-match results -- events that never went
    // live -- are unaffected and go OFFLINE exactly as before.
    if (!storedEvent.live) {
      storedEvent.visibility = EventVisibility.OFFLINE;

      // Only stamp the race-provenance marker when no explicit admin/
      // backoffice visibility decision already governs this event
      // (`visibilityInitialized` unset/false). An intentionally OFFLINE
      // admin/acceptance-gated fixture must never be auto-restored later
      // by `applyLiveEventUpdate`'s resurrection branch, so it must never
      // receive this marker even though it is forced OFFLINE here exactly
      // like the genuine race case.
      if (storedEvent.visibilityInitialized !== true) {
        storedEvent.liveRaceResultedAt = new Date(
          event.timestamp ?? Date.now()
        );
      }
    }
    await storedEvent.save();
    this.channel.ack(msg);
  }
}

export default EventResultListener;
