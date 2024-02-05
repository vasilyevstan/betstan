import {
  APublisher,
  IEventOddsSelectedEvent,
  QueueNames,
} from "@betstan/common";

class EventOddsSelectedPublisher extends APublisher<IEventOddsSelectedEvent> {
  serviceName: string = "event_odds_selected";
  queue: QueueNames.EVENT_ODDS_SELECTED = QueueNames.EVENT_ODDS_SELECTED;
}

export default EventOddsSelectedPublisher;
