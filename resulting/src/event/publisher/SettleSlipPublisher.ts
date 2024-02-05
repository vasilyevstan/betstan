import {
  APublisher,
  IPlaceBetEvent,
  ISettleSlipEvent,
  QueueNames,
} from "@betstan/common";

class SettleSlipPublisher extends APublisher<ISettleSlipEvent> {
  serviceName: string = "resulting_settle_slip";
  queue: QueueNames.SETTLE_SLIP = QueueNames.SETTLE_SLIP;
}

export default SettleSlipPublisher;
