import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import { EventVisibility, messengerWrapper } from "@betstan/common";
import EventVisibilityPublisher from "../event/publisher/EventVisibilityPublisher";

const router = express.Router();

let _publisher: EventVisibilityPublisher | null = null;
const getPublisher = async (): Promise<EventVisibilityPublisher> => {
  if (!_publisher) {
    _publisher = new EventVisibilityPublisher(messengerWrapper.connection);
    await _publisher.init();
  }
  return _publisher;
};

router.post(
  "/api/backoffice/event_visibility",
  async (req: Request, res: Response) => {
    const eventId =
      typeof req.body.eventId === "string" ? req.body.eventId.trim() : "";
    const requestedVisibility = req.body.visibility;
    if (!eventId) {
      res.status(400).send({ message: "No event id" });
      return;
    }

    if (
      requestedVisibility !== undefined
      && !Object.values(EventVisibility).includes(requestedVisibility)
    ) {
      res.status(400).send({ message: "Event visibility is invalid" });
      return;
    }

    const event = requestedVisibility
      ? await Event.findOneAndUpdate(
        { eventId, visibility: { $ne: requestedVisibility } },
        { $set: { visibility: requestedVisibility } },
        { new: true }
      )
      : await Event.findOneAndUpdate(
        { eventId },
        [
          {
            $set: {
              visibility: {
                $cond: [
                  { $eq: ["$visibility", EventVisibility.ONLINE] },
                  EventVisibility.OFFLINE,
                  {
                    $cond: [
                      { $eq: ["$visibility", EventVisibility.OFFLINE] },
                      EventVisibility.ONLINE,
                      EventVisibility.OFFLINE,
                    ],
                  },
                ],
              },
            },
          },
        ],
        { new: true }
      );

    if (!event) {
      const existingEvent = await Event.findOne({ eventId });
      if (!existingEvent) {
        res.send({ message: "Event not found" });
        return;
      }

      res.send(existingEvent);
      return;
    }

    const publisher = await getPublisher();

    publisher.publish({
      data: {
        eventId,
        visibility: event.visibility,
      },
    });

    res.send(event);
  }
);

export { router as EventVisibility };
