import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import ResultSetPublisher from "../event/publisher/ResultSetPublisher";
import { EventStatus, messengerWrapper } from "@betstan/common";

const router = express.Router();
const MAX_SCORE = 99;

let _publisher: ResultSetPublisher | null = null;
const getPublisher = async (): Promise<ResultSetPublisher> => {
  if (!_publisher) {
    _publisher = new ResultSetPublisher(messengerWrapper.connection);
    await _publisher.init();
  }
  return _publisher;
};

const normalizeScore = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  const score =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (
    typeof score !== "number"
    || !Number.isInteger(score)
    || score < 0
    || score > MAX_SCORE
  ) {
    return null;
  }

  return score;
};

router.post("/api/backoffice/result", async (req: Request, res: Response) => {
  const eventId =
    typeof req.body.eventId === "string" ? req.body.eventId.trim() : "";
  const homeResult = normalizeScore(req.body.homeResult);
  const awayResult = normalizeScore(req.body.awayResult);

  if (!eventId) {
    res.status(400).send({ message: "No event id" });
    return;
  }

  if (homeResult === null || awayResult === null) {
    res.status(400).send({
      message: `Scores must be whole numbers between 0 and ${MAX_SCORE}`,
    });
    return;
  }

  const event = await Event.findOneAndUpdate(
    { eventId, status: { $ne: EventStatus.RESULTED } },
    {
      $set: {
        homeResult,
        awayResult,
        status: EventStatus.RESULTED,
      },
    },
    { new: true }
  );

  if (!event) {
    const existingEvent = await Event.findOne({ eventId });
    if (!existingEvent) {
      res.status(400).send({ message: "No event id" });
      return;
    }

    res.send({ event: existingEvent });
    return;
  }

  const publisher = await getPublisher();

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
