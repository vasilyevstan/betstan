import { IPlaceBetEvent, QueueNames } from "@betstan/common";
import RetriableResultingListener from "./RetriableResultingListener";
import { SettlementPublishers, upsertPlaceBet } from "../../service/resulting";
import { RetryDescriptor, retryIdentityForPlaceBet } from "../../service/retry";

class PlaceBetListener extends RetriableResultingListener<IPlaceBetEvent> {
  serviceName: string = "resulting_place_bet";
  queue: QueueNames.SLIP_BET = QueueNames.SLIP_BET;
  protected readonly failureLogMessage = "Error upserting place bet:";

  protected buildRetryDescriptor(
    event: IPlaceBetEvent
  ): RetryDescriptor<IPlaceBetEvent> {
    return {
      identity: retryIdentityForPlaceBet(event),
      kind: "PLACE_BET",
      listenerServiceName: this.serviceName,
      payload: event,
    };
  }

  protected async handleEvent(
    event: IPlaceBetEvent,
    publishers: SettlementPublishers
  ): Promise<void> {
    await upsertPlaceBet(event, publishers);
  }
}

export default PlaceBetListener;
