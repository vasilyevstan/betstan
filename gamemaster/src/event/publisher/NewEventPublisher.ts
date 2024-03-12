import { APublisher, INewEventEvent, QueueNames } from "@betstan/common";

class NewEventPublisher extends APublisher<INewEventEvent> {
  serviceName: string = "gamemaster_new_event";
  queue: QueueNames.NEW_EVENT = QueueNames.NEW_EVENT;
}

export default NewEventPublisher;
