import { APublisher, IEventResultEvent, QueueNames } from "@betstan/common";

class ResultSetPublisher extends APublisher<IEventResultEvent> {
  serviceName: string = "gamemaster_result_set";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;

  async init(): Promise<void> {
    await super.init();
  }

  async initConfirmChannel(): Promise<void> {
    await super.initConfirmChannel();
  }

  async publishWithConfirm(data: IEventResultEvent): Promise<void> {
    await super.publishWithConfirm(data);
  }
}

export default ResultSetPublisher;
