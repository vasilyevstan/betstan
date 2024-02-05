import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import { EventVisibility, messengerWrapper } from "@betstan/common";
import EventVisibilityPublisher from "../event/publisher/EventVisibilityPublisher";

const router = express.Router();

router.post(
  "/api/backoffice/event_visibility",
  async (req: Request, res: Response) => {
    const { eventId } = req.body;
    const event = await Event.findOne({ eventId: eventId });

    if (!event) {
      res.send({ message: "Event not found" });
      return;
    }

    // flipping the event status
    // TODO: concurrency magic
    let newEventVisibility: EventVisibility;
    if (event.visibility === EventVisibility.ONLINE) {
      newEventVisibility = EventVisibility.OFFLINE;
    } else if (event.visibility === EventVisibility.OFFLINE) {
      newEventVisibility = EventVisibility.ONLINE;
    } else {
      // seems that data was corrupted
      newEventVisibility = EventVisibility.OFFLINE;
    }

    event.visibility = newEventVisibility;
    await event.save();

    const publisher = new EventVisibilityPublisher(messengerWrapper.connection);
    await publisher.init();

    publisher.publish({
      data: {
        eventId: eventId,
        visibility: newEventVisibility,
      },
    });

    res.send(event);
  }
);

export { router as EventVisibility };
