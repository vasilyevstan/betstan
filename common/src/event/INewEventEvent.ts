import { IEvent } from "./IEvent";
import { EventVisibility } from "./status/EventVisibility";

export interface INewEventEvent extends IEvent {
  data: {
    id: string;
    name: string;
    time: string;
    home: string;
    away: string;
    visibility?: EventVisibility;
  };
}
