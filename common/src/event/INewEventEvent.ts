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
    /** Creation-time capability. Absent preserves live simulation; false publishes only the final result. */
    liveEnabled?: boolean;
  };
}
