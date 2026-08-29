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
      // Capture provenance from the *actual pre-result* state, before this
      // exact update forces visibility OFFLINE below. `visibilityInitialized`
      // alone is the wrong signal: an ordinary event onboarded through
      // `NewEventListener` already has `visibilityInitialized: true`
      // regardless of its chosen visibility (so gating on it would wrongly
      // exclude a perfectly ordinary ONLINE event from ever being marked as
      // a race), while `EventVisibilityListener` can leave an explicit
      // *pending* decision in place with `visibilityInitialized` still
      // false (so gating on it alone would wrongly let an intentionally
      // OFFLINE fixture be misclassified as a race). What actually
      // distinguishes "no explicit visibility decision at all" is: the
      // event's own current visibility was not already OFFLINE (i.e. this
      // update is a genuine ONLINE-to-OFFLINE transition, not a redundant
      // no-op over an already-decided OFFLINE state), and no pending
      // decision (`pendingVisibility`, set only by `EventVisibilityListener`)
      // is queued, regardless of whether it targets ONLINE or OFFLINE.
      const hasExplicitVisibilityDecision =
        storedEvent.visibility === EventVisibility.OFFLINE
        || storedEvent.pendingVisibility != null;

      storedEvent.visibility = EventVisibility.OFFLINE;

      if (!hasExplicitVisibilityDecision) {
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
