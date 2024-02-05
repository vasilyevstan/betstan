import {
  APublisher,
  IPlaceBetEvent,
  ISettleSlipRowEvent,
  QueueNames,
} from "@betstan/common";

class SettleSlipRowPublisher extends APublisher<ISettleSlipRowEvent> {
  serviceName: string = "resulting_settle_slip_row";
  queue: QueueNames.SETTLE_SLIP_ROW = QueueNames.SETTLE_SLIP_ROW;
}

export default SettleSlipRowPublisher;
