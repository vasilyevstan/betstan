import { ConsumeMessage } from "amqplib";
import {
  AListener,
  IPlaceBetEvent,
  QueueNames,
} from "@betstan/common";
import { requestPendingBetUpdateReplay } from "../../service/PendingBetUpdateWorker";
import { upsertPlaceBet } from "../../service/betHistory";

class PlaceBetListener extends AListener<IPlaceBetEvent> {
  serviceName: string = "bet_place_bet";
  queue: QueueNames.SLIP_BET = QueueNames.SLIP_BET;

  async onMessage(event: IPlaceBetEvent, msg: ConsumeMessage) {
    await upsertPlaceBet(event);
    await requestPendingBetUpdateReplay(event.data.slipId);

    this.channel.ack(msg);
  }
}

export default PlaceBetListener;
