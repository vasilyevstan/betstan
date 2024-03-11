import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import NewEventPublisher from "../event/publisher/NewEventPublisher";
import { EventStatus, messengerWrapper } from "@betstan/common";
import mongoose from "mongoose";

const router = express.Router();

router.post(
  "/api/backoffice/new_event",
  async (req: Request, res: Response) => {
    const { home, away } = req.body;

    if (!home || !away) {
      res.send({});
      return;
    }

    // all custom events will "run" in 30 minutes
    const eventTime = new Date(new Date().getTime() + 30 * 60 * 1000);

    const event = new Event({
      eventId: new mongoose.Types.ObjectId().toHexString(),
      name: `${home} - ${away}`,
      time: eventTime.toISOString(),
      home: home,
      away: away,
      status: EventStatus.NO_RESULT,
    });

    await event.save();

    const publisher = new NewEventPublisher(messengerWrapper.connection);
    await publisher.init();

    publisher.publish({
      data: {
        id: event.eventId,
        name: event.name,
        time: event.time,
        home: event.home,
        away: event.away,
      },
    });

    res.send({ event });
  }
);

export { router as NewEvent };
