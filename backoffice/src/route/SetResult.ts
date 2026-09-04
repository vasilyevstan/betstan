import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import { EventStatus, messengerWrapper } from "@betstan/common";
import { getBackofficePublicationService } from "../service/BackofficePublicationService";

const router = express.Router();
const MAX_SCORE = 99;

const normalizeScore = (value: unknown): number | null => {
  if (value === undefined || value === null || value === "") {
    return null;
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
    {
      eventId,
      status: { $ne: EventStatus.RESULTED },
      newEventPublicationPending: { $ne: true },
    },
    {
      $set: {
        homeResult,
        awayResult,
        status: EventStatus.RESULTED,
        resultPublicationPending: true,
      },
    },
    { new: true }
  ).select("+resultPublicationPending +newEventPublicationPending");

  if (!event) {
    const existingEvent = await Event.findOne({ eventId }).select(
      "+resultPublicationPending +newEventPublicationPending"
    );
    if (!existingEvent) {
      res.status(404).send({ message: "Event not found" });
      return;
    }

    if (
      existingEvent.status !== EventStatus.RESULTED
      && existingEvent.newEventPublicationPending
    ) {
      res.status(409).send({
        message: "Event creation is still being published",
      });
      return;
    }

    const resultMatches =
      existingEvent.status === EventStatus.RESULTED
      && existingEvent.homeResult === homeResult
      && existingEvent.awayResult === awayResult;
    if (!resultMatches) {
      res.status(409).send({
        message: "Event already has a different result",
        event: existingEvent,
      });
      return;
    }

    const publication = await getBackofficePublicationService(
      messengerWrapper.connection
    ).publishResultNow(existingEvent.eventId);
    res.status(publication === "PUBLISHED" ? 200 : 202).send({
      event: existingEvent.toObject({ useProjection: true }),
      unchanged: true,
      publication,
      ...(publication === "PENDING"
        ? { message: "Result saved; publication is retrying" }
        : {}),
    });
    return;
  }

  const publication = await getBackofficePublicationService(
    messengerWrapper.connection
  ).publishResultNow(event.eventId);
  res.status(publication === "PUBLISHED" ? 200 : 202).send({
    event: event.toObject({ useProjection: true }),
    publication,
    ...(publication === "PENDING"
      ? { message: "Result saved; publication is retrying" }
      : {}),
  });
});

export { router as SetResult };
