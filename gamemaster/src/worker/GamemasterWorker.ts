import { EventStatus, messengerWrapper } from "@betstan/common";

import { Event } from "../model/Event";
import NewEventPublisher from "../event/publisher/NewEventPublisher";
import ResultSetPublisher from "../event/publisher/ResultSetPublisher";
import { faker } from "@faker-js/faker";
import { EventArchive } from "../model/EventArchive";

const MAX_SCORE = 10;
const MIN_SCORE = 0;
const POLLING_INTERVAL = 60000;

const getRandomResult = () => {
  return Math.floor(Math.random() * (MAX_SCORE - MIN_SCORE + 1) + MIN_SCORE);
};

export class GamemasterWorker {
  async checkEventsOnce() {
    // console.log("checking if there are events to result", new Date());
    const eventsToResult = await Event.find({
      status: EventStatus.NO_RESULT,
      time: { $lt: new Date() },
    });

    eventsToResult.map(async (event) => {
      const resultSetPublisher = new ResultSetPublisher(
        messengerWrapper.connection
      );
      await resultSetPublisher.init();

      const homeResult = getRandomResult();
      const awayResult = getRandomResult();

      resultSetPublisher.publish({
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
      // await Event.deleteOne({ _id: event._id });

      // publish event that will create a new event
      const newEventPublisher = new NewEventPublisher(
        messengerWrapper.connection
      );
      await newEventPublisher.init();

      const home = faker.location.city();
      const away = faker.location.city();

      newEventPublisher.publish({
        data: {
          id: faker.string.uuid(),
          name: `${home} - ${away}`,
          time: faker.date.soon().toISOString(),
          home,
          away,
        },
      });
    });
  }

  work() {
    setInterval(this.checkEventsOnce, POLLING_INTERVAL);
  }
}
