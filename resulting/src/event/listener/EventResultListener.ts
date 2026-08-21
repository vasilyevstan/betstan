import { IEventResultEvent, QueueNames } from "@betstan/common";
import RetriableResultingListener from "./RetriableResultingListener";
import { SettlementPublishers, processFinalScore } from "../../service/resulting";
import {
  RetryDescriptor,
  retryIdentityForEventResult,
} from "../../service/retry";

class EventResultListener extends RetriableResultingListener<IEventResultEvent> {
  serviceName: string = "resulting_result";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;
  protected readonly failureLogMessage = "Error processing final score result:";

  protected buildRetryDescriptor(
    event: IEventResultEvent
  ): RetryDescriptor<IEventResultEvent> {
    return {
      identity: retryIdentityForEventResult(event),
      kind: "EVENT_RESULT",
      listenerServiceName: this.serviceName,
      payload: event,
    };
  }

  protected async handleEvent(
    event: IEventResultEvent,
    publishers: SettlementPublishers
  ): Promise<void> {
    await processFinalScore(event, publishers);
  }
}

export default EventResultListener;
