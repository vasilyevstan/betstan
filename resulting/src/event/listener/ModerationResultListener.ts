import { IModerationResultEvent, QueueNames } from "@betstan/common";
import RetriableResultingListener from "./RetriableResultingListener";
import {
  SettlementPublishers,
  applyModerationResult,
} from "../../service/resulting";
import {
  RetryDescriptor,
  retryIdentityForModerationResult,
} from "../../service/retry";

class ModerationResultListener extends RetriableResultingListener<IModerationResultEvent> {
  serviceName: string = "resulting_moderation_result";
  queue: QueueNames.MODERATION_RESULT = QueueNames.MODERATION_RESULT;
  protected readonly failureLogMessage = "Error applying moderation result:";

  protected buildRetryDescriptor(
    event: IModerationResultEvent
  ): RetryDescriptor<IModerationResultEvent> {
    return {
      identity: retryIdentityForModerationResult(event),
      kind: "MODERATION_RESULT",
      listenerServiceName: this.serviceName,
      payload: event,
    };
  }

  protected async handleEvent(
    event: IModerationResultEvent,
    publishers: SettlementPublishers
  ): Promise<void> {
    await applyModerationResult(event, publishers);
  }
}

export default ModerationResultListener;
