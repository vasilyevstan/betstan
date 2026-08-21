import { ConsumeMessage } from "amqplib";
import { AListener, IEvent } from "@betstan/common";
import SettleSlipPublisher from "../publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../publisher/SettleSlipRowPublisher";
import { RetryDescriptor, parkFailedEvent } from "../../service/retry";
import { SettlementPublishers } from "../../service/resulting";

abstract class RetriableResultingListener<T extends IEvent> extends AListener<T> {
  private settleSlipPublisher!: SettleSlipPublisher;
  private settleSlipRowPublisher!: SettleSlipRowPublisher;

  protected abstract readonly failureLogMessage: string;

  async init() {
    await super.init();
    this.settleSlipRowPublisher = new SettleSlipRowPublisher(this.connection);
    await this.settleSlipRowPublisher.init();
    await this.settleSlipRowPublisher.initConfirmChannel();
    this.settleSlipPublisher = new SettleSlipPublisher(this.connection);
    await this.settleSlipPublisher.init();
    await this.settleSlipPublisher.initConfirmChannel();
  }

  async onMessage(event: T, msg: ConsumeMessage) {
    try {
      await this.handleEvent(event, this.publishers);
      this.ack(msg);
    } catch (error) {
      console.error(this.failureLogMessage, error);

      try {
        await parkFailedEvent(this.buildRetryDescriptor(event), error);
        this.ack(msg);
      } catch (parkingError) {
        console.error(`Error parking retry for ${this.serviceName}:`, parkingError);
      }
    }
  }

  protected abstract buildRetryDescriptor(event: T): RetryDescriptor<T>;

  protected abstract handleEvent(
    event: T,
    publishers: SettlementPublishers
  ): Promise<void>;

  protected get publishers(): SettlementPublishers {
    return {
      settleSlipPublisher: this.settleSlipPublisher,
      settleSlipRowPublisher: this.settleSlipRowPublisher,
    };
  }
}

export default RetriableResultingListener;
