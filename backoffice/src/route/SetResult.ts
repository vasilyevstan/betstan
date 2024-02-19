import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import ResultSetPublisher from "../event/publisher/ResultSetPublisher";
import { EventStatus, messengerWrapper } from "@betstan/common";

const router = express.Router();

router.post("/api/backoffice/result", async (req: Request, res: Response) => {
  let { eventId, homeResult, awayResult } = req.body;

  const event = await Event.findOne({ eventId: eventId });

  if (!event) {
    res.status(400).send({ message: "No event id" });
    return;
  }

  if (!homeResult || homeResult < 0 || isNaN(homeResult)) {
    homeResult = 0;
  }

  if (!awayResult || awayResult < 0 || isNaN(awayResult)) {
    awayResult = 0;
  }

  if (event.status === EventStatus.RESULTED) {
    res.send({ event });
    return;
  }

  event.set({ homeResult: homeResult });
  event.set({ awayResult: awayResult });
  event.set({ status: EventStatus.RESULTED });

  await event.save();

  const publisher = new ResultSetPublisher(messengerWrapper.connection);
  await publisher.init();

  publisher.publish({
    data: {
      eventId: event.eventId,
      homeScore: homeResult,
      awayScore: awayResult,
      home: event.home,
      away: event.away,
    },
  });

  res.send({ event });
});

export { router as SetResult };
