import { APublisher, IEventVibibilityEvent, QueueNames } from "@betstan/common";

class EventVisibilityPublisher extends APublisher<IEventVibibilityEvent> {
  serviceName: string = "backoffice_event_visibility";
  queue: QueueNames.EVENT_VISIBILITY = QueueNames.EVENT_VISIBILITY;
}

export default EventVisibilityPublisher;
