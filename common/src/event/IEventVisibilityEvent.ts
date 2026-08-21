import { IEvent } from "./IEvent";

export interface IEventVibibilityEvent extends IEvent {
  data: {
    eventId: string;
    visibility: string;
  };
}
