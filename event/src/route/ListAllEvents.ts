import express, { Request, Response } from "express";
import EventTemplate from "../data/EventTemplate";
import { Event } from "../model/Event";
import NewEventPublisher from "../messaging/publisher/NewEventPublisher";
import { messengerWrapper } from "@betstan/common";

const router = express.Router();

const EVENT_COUNT = 24;

const initEvents = (): EventTemplate[] => {
  const events: EventTemplate[] = [];

  for (let i = 0; i < EVENT_COUNT; i++) {
    events.push(new EventTemplate());
  }

  return events;
};

router.get("/api/event", async (req: Request, res: Response) => {
  // check if db has events
  let dbEvents = await Event.find().sort({ time: 1 });

  if (dbEvents.length === 0) {
    console.log("Generating events");
    const events = initEvents();

    // temporary, events must come from the backoffice
    const publisher = new NewEventPublisher(messengerWrapper.connection);
    await publisher.init();

    events.forEach(async (event) => {
      const newEvent = await Event.create(event);
      newEvent.save();

      // propagate events to backoffice service -- temporary
      publisher.publish({
        data: {
          id: newEvent.eventId,
          name: newEvent.name,
          time: newEvent.time.toISOString(),
          home: event.products[0].odds[0].name,
          away: event.products[0].odds[2].name,
        },
      });
    });

    dbEvents = await Event.find();
  }
  res.send(dbEvents);
});

export { router as ListllEvents };
