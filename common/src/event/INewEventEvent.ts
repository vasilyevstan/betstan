import { IEvent } from "./IEvent";

export interface INewEventEvent extends IEvent {
  data: {
    id: string;
    name: string;
    time: string;
    home: string;
    away: string;
  };
}
