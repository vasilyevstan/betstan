import { ConsumeMessage } from "amqplib";
import {
  AListener,
  EventPhase,
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
    // A completed live event stays visible only once its matching FULL_TIME
    // projection is present. If EVENT_RESULT wins the queue race while the
    // projection is absent or still non-terminal, hide it and retain
    // provenance so delayed snapshots cannot present a resulted match as
    // active. `applyLiveEventUpdate` restores the retained card when
    // FULL_TIME eventually arrives.
    if (storedEvent.live?.phase !== EventPhase.FULL_TIME) {
      // Capture explicit intent before forcing the runtime projection dark.
      // A pending ONLINE decision is the normal fail-dark onboarding path,
      // while an explicit/pending OFFLINE decision must remain authoritative.
      // The final predicate preserves legacy initialized OFFLINE documents
      // created before visibility-decision provenance existed.
      const pendingVisibility = storedEvent.pendingVisibility;
      const visibilityDecision = storedEvent.visibilityDecision;
      const hasExplicitOfflineIntent =
        visibilityDecision === EventVisibility.OFFLINE
        || pendingVisibility === EventVisibility.OFFLINE
        || (
          visibilityDecision == null
          && pendingVisibility == null
          && storedEvent.visibilityInitialized === true
          && storedEvent.visibility === EventVisibility.OFFLINE
        );

      storedEvent.visibility = EventVisibility.OFFLINE;

      if (!hasExplicitOfflineIntent) {
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
