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

    const event = new Event({
      eventId: new mongoose.Types.ObjectId().toHexString(),
      name: `${home} - ${away}`,
      time: new Date().toISOString(),
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
