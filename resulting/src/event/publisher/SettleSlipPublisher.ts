import {
  APublisher,
  ISettleSlipEvent,
  QueueNames,
} from "@betstan/common";

export interface ResultingSettleSlipEvent
  extends Omit<ISettleSlipEvent, "data"> {
  data: ISettleSlipEvent["data"] & {
    occurredAt?: string;
  };
}

class SettleSlipPublisher extends APublisher<ResultingSettleSlipEvent> {
  serviceName: string = "resulting_settle_slip";
  queue: QueueNames.SETTLE_SLIP = QueueNames.SETTLE_SLIP;
}

export default SettleSlipPublisher;
