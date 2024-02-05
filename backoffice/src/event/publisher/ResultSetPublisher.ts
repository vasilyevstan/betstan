import { APublisher, IEventResultEvent, QueueNames } from "@betstan/common";

class ResultSetPublisher extends APublisher<IEventResultEvent> {
  serviceName: string = "backoffice_result_set";
  queue: QueueNames.EVENT_RESULT = QueueNames.EVENT_RESULT;
}

export default ResultSetPublisher;
