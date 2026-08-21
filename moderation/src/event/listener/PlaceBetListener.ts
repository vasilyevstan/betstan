import { ConsumeMessage } from "amqplib";
import { AListener, IPlaceBetEvent, QueueNames } from "@betstan/common";
import BetModerationResultPublisher from "../publisher/BetModerationResultPublisher";
import ModerationService from "../../service/ModerationService";

class PlaceBetListener extends AListener<IPlaceBetEvent> {
  serviceName: string = "moderation_place_bet";
  queue: QueueNames.SLIP_BET = QueueNames.SLIP_BET;

  private publisher!: BetModerationResultPublisher;
  private moderationService!: ModerationService;

  async init() {
    await super.init();
    this.publisher = new BetModerationResultPublisher(this.connection);
    await this.publisher.init();
    await this.publisher.initConfirmChannel();
    this.moderationService = new ModerationService(this.publisher);
  }

  async onMessage(event: IPlaceBetEvent, msg: ConsumeMessage) {
    await this.moderationService.handlePlaceBet(event);
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

export default PlaceBetListener;
