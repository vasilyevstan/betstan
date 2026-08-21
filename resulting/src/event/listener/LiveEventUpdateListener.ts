import { ILiveEventUpdateEvent, QueueNames } from "@betstan/common";
import RetriableResultingListener from "./RetriableResultingListener";
import { SettlementPublishers, processLiveUpdate } from "../../service/resulting";
import {
  RetryDescriptor,
  retryIdentityForLiveEventUpdate,
} from "../../service/retry";

class LiveEventUpdateListener extends RetriableResultingListener<ILiveEventUpdateEvent> {
  serviceName: string = "resulting_live_event_update";
  queue: QueueNames.LIVE_EVENT_UPDATE = QueueNames.LIVE_EVENT_UPDATE;
  protected readonly failureLogMessage = "Error processing live update:";

  protected buildRetryDescriptor(
    event: ILiveEventUpdateEvent
  ): RetryDescriptor<ILiveEventUpdateEvent> {
    return {
      identity: retryIdentityForLiveEventUpdate(event),
      kind: "LIVE_EVENT_UPDATE",
      listenerServiceName: this.serviceName,
      payload: event,
    };
  }

  protected async handleEvent(
    event: ILiveEventUpdateEvent,
    publishers: SettlementPublishers
  ): Promise<void> {
    await processLiveUpdate(event, publishers);
  }
}

export default LiveEventUpdateListener;
