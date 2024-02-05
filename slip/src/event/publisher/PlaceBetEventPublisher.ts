import { APublisher, IPlaceBetEvent, QueueNames } from "@betstan/common";

class PlaceBetEventPublisher extends APublisher<IPlaceBetEvent> {
  serviceName: string = "slip_place_bet";
  queue: QueueNames.SLIP_BET = QueueNames.SLIP_BET;
}

export default PlaceBetEventPublisher;
