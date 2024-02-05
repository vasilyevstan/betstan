import {
  APublisher,
  IEventOddsSelectedEvent,
  INewEventEvent,
  QueueNames,
} from "@betstan/common";

class NewEventPublisher extends APublisher<INewEventEvent> {
  serviceName: string = "event_new_event";
  queue: QueueNames.NEW_EVENT = QueueNames.NEW_EVENT;
}

export default NewEventPublisher;
