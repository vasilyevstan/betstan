import { ConsumeMessage } from "amqplib";
import { AListener, IEventResultEvent, QueueNames } from "@betstan/common";
import BetModerationResultPublisher from "../publisher/BetModerationResultPublisher";
import ModerationService from "../../service/ModerationService";

class EventResultListener extends AListener<IEventResultEvent> {
  serviceName: string = "moderation_event_result";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;

  private publisher!: BetModerationResultPublisher;
  private moderationService!: ModerationService;

  async init() {
    await super.init();
    this.publisher = new BetModerationResultPublisher(this.connection);
    await this.publisher.init();
    await this.publisher.initConfirmChannel();
    this.moderationService = new ModerationService(this.publisher);
  }

  async onMessage(event: IEventResultEvent, msg: ConsumeMessage) {
    await this.moderationService.upsertResulted(
      event.data.eventId,
      event.timestamp ?? new Date().toISOString()
    );
    await this.moderationService.replayParkedForEvent(event.data.eventId);

    this.ack(msg);
  }

  async close(): Promise<void> {
    const channel = Reflect.get(this, "_channel") as
      | { close?: () => Promise<void> }
      | undefined;

    if (this.publisher) {
      await this.publisher.close();
    }

    if (channel?.close) {
      await channel.close();
    }
  }
}

export default EventResultListener;
