import { EventStatus, messengerWrapper } from "@betstan/common";

import { Event } from "../model/Event";
import ResultSetPublisher from "../event/publisher/ResultSetPublisher";
import { EventArchive } from "../model/EventArchive";

const MAX_SCORE = 10;
const MIN_SCORE = 0;
const POLLING_INTERVAL = 60000;

const getRandomResult = () => {
  return Math.floor(Math.random() * (MAX_SCORE - MIN_SCORE + 1) + MIN_SCORE);
};

export class GamemasterWorker {
  private resultSetPublisher!: ResultSetPublisher;

  async init() {
    this.resultSetPublisher = new ResultSetPublisher(
      messengerWrapper.connection
    );
    await this.resultSetPublisher.init();
  }

  async checkEventsOnce() {
    const eventsToResult = await Event.find({
      status: EventStatus.NO_RESULT,
      time: { $lt: new Date() },
    });

    for (const event of eventsToResult) {
      const homeResult = getRandomResult();
      const awayResult = getRandomResult();

      this.resultSetPublisher.publish({
        data: {
          eventId: event.eventId,
          homeScore: homeResult,
          awayScore: awayResult,
          home: event.home,
          away: event.away,
        },
      });

      event.set({ homeResult, awayResult, status: EventStatus.RESULTED });
      await event.save();

      // archive event
      const archivedEvent = new EventArchive({
        eventId: event.eventId,
        time: event.time,
        home: event.home,
        away: event.away,
        status: event.status,
        homeResult: event.homeResult,
        awayResult: event.awayResult,
      });
      await archivedEvent.save();
      await event.deleteOne();

    }
  }

  work() {
    setInterval(this.checkEventsOnce.bind(this), POLLING_INTERVAL);
  }
}
