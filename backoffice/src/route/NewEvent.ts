import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import NewEventPublisher from "../event/publisher/NewEventPublisher";
import {
  EventStatus,
  EventVisibility,
  messengerWrapper,
} from "@betstan/common";
import mongoose from "mongoose";

const router = express.Router();
const MAX_TEAM_NAME_LENGTH = 80;

let _publisher: NewEventPublisher | null = null;
const getPublisher = async (): Promise<NewEventPublisher> => {
  if (!_publisher) {
    _publisher = new NewEventPublisher(messengerWrapper.connection);
    await _publisher.init();
  }
  return _publisher;
};

router.post("/api/backoffice/new_event", async (req: Request, res: Response) => {
  const home = typeof req.body.home === "string" ? req.body.home.trim() : "";
  const away = typeof req.body.away === "string" ? req.body.away.trim() : "";
  const { kickoffDelaySeconds } = req.body;
  const visibility = req.body.visibility ?? EventVisibility.ONLINE;

  if (
    !home
    || !away
    || home.length > MAX_TEAM_NAME_LENGTH
    || away.length > MAX_TEAM_NAME_LENGTH
  ) {
    res.status(400).send({
      message: `Team names must be between 1 and ${MAX_TEAM_NAME_LENGTH} characters`,
    });
    return;
  }

  const delaySeconds = kickoffDelaySeconds ?? 30 * 60;
  if (
    !Number.isInteger(delaySeconds)
    || delaySeconds < 15
    || delaySeconds > 24 * 60 * 60
  ) {
    res.status(400).send({
      message: "Kickoff delay must be between 15 seconds and 24 hours",
    });
    return;
  }
  if (!Object.values(EventVisibility).includes(visibility)) {
    res.status(400).send({ message: "Event visibility is invalid" });
    return;
  }

  const eventTime = new Date(Date.now() + delaySeconds * 1000);

  const event = new Event({
    eventId: new mongoose.Types.ObjectId().toHexString(),
    name: `${home} - ${away}`,
    time: eventTime.toISOString(),
    home,
    away,
    status: EventStatus.NO_RESULT,
    visibility,
  });

  await event.save();

  const publisher = await getPublisher();

  const newEventMessage = {
    data: {
      id: event.eventId,
      name: event.name,
      time: event.time,
      home: event.home,
      away: event.away,
      visibility,
    },
  };
  publisher.publish(newEventMessage);

  res.send({ event });
});

export { router as NewEvent };
