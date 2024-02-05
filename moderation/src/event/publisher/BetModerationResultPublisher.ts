import {
  APublisher,
  IModerationResultEvent,
  IPlaceBetEvent,
  QueueNames,
} from "@betstan/common";

class BetModerationResultPublisher extends APublisher<IModerationResultEvent> {
  serviceName: string = "moderation_bet_moderation_result";
  queue: QueueNames = QueueNames.MODERATION_RESULT;
}

export default BetModerationResultPublisher;
