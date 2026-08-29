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
      // exact update forces visibility OFFLINE below. Neither
      // `visibilityInitialized` nor "any pending decision" is the right
      // signal:
      //  - `NewEventListener` sets `visibilityInitialized: true` for every
      //    event it onboards regardless of chosen visibility, so gating on
      //    it alone would wrongly exclude an ordinary ONLINE event.
      //  - A pending decision of ONLINE (`pendingVisibility:
      //    EventVisibility.ONLINE`) is the normal "fail-dark" onboarding
      //    path -- `EventVisibilityListener` may have recorded the admin's
      //    real (visible) intent before `NewEventListener`'s metadata ever
      //    arrives, defaulting the event OFFLINE only as a transient,
      //    unfinalized safety placeholder. Treating a pending ONLINE
      //    decision the same as a deliberate OFFLINE one would permanently
      //    block the race-before-live recovery this event still needs once
      //    it does go live -- `NewEventListener` alone would only fix
      //    `visibility`, never `status`.
      // What actually indicates a *deliberate intent to keep this OFFLINE*
      // is: a pending decision that is itself OFFLINE, or -- with no
      // pending decision in flight -- an already-finalized
      // (`visibilityInitialized: true`) current visibility of OFFLINE.
      const pendingVisibility = storedEvent.pendingVisibility;
      const hasExplicitOfflineIntent =
        pendingVisibility === EventVisibility.OFFLINE
        || (
          pendingVisibility == null
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
