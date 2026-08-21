import { APublisher, IModerationResultEvent, QueueNames } from "@betstan/common";

class BetModerationResultPublisher extends APublisher<IModerationResultEvent> {
  serviceName: string = "moderation_bet_moderation_result";
  queue: QueueNames = QueueNames.MODERATION_RESULT;

  async close(): Promise<void> {
    const confirmChannel = Reflect.get(this, "_confirmChannel") as
      | { close?: () => Promise<void> }
      | undefined;
    const channel = Reflect.get(this, "_channel") as
      | { close?: () => Promise<void> }
      | undefined;

    if (confirmChannel?.close) {
      await confirmChannel.close();
    }

    if (channel?.close) {
      await channel.close();
    }
  }
}

export default BetModerationResultPublisher;
