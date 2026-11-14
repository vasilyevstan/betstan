import { IEvent } from "./IEvent";

export interface IEventResultEvent extends IEvent {
  data: {
    eventId: string;
    /** Immutable source economic time; absence requires an explicit legacy fallback. */
    occurredAt?: string;
    homeScore: number;
    awayScore: number;
    home: string;
    away: string;
  };
}
