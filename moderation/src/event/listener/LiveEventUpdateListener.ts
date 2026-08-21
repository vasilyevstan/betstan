import { ConsumeMessage } from "amqplib";
import { AListener, ILiveEventUpdateEvent, QueueNames } from "@betstan/common";
import BetModerationResultPublisher from "../publisher/BetModerationResultPublisher";
import ModerationService from "../../service/ModerationService";

class LiveEventUpdateListener extends AListener<ILiveEventUpdateEvent> {
  serviceName: string = "moderation_live_event_update";
  queue: QueueNames.LIVE_EVENT_UPDATE = QueueNames.LIVE_EVENT_UPDATE;

  private publisher!: BetModerationResultPublisher;
  private moderationService!: ModerationService;

  async init() {
    await super.init();
    this.publisher = new BetModerationResultPublisher(this.connection);
    await this.publisher.init();
    await this.publisher.initConfirmChannel();
    this.moderationService = new ModerationService(this.publisher);
  }

  async onMessage(event: ILiveEventUpdateEvent, msg: ConsumeMessage) {
    const updated = await this.moderationService.upsertLiveEventMirror(event);

    if (updated) {
      await this.moderationService.replayParkedForEvent(event.data.eventId);
    }

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

export default LiveEventUpdateListener;
