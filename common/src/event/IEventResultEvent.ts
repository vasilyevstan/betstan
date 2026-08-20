import { IEvent } from "./IEvent";

export interface IEventResultEvent extends IEvent {
  data: {
    eventId: string;
    homeScore: number;
    awayScore: number;
    home: string;
    away: string;
  };
}
