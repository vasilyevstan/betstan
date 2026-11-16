import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import {
  EventStatus,
  EventVisibility,
  messengerWrapper,
} from "@betstan/common";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import { getBackofficePublicationService } from "../service/BackofficePublicationService";
import { serializeBackofficeEvent } from "../service/serializeBackofficeEvent";

const router = express.Router();
const MAX_TEAM_NAME_LENGTH = 80;
const MAX_REQUEST_ID_LENGTH = 128;
const DEFAULT_KICKOFF_DELAY_SECONDS = 15 * 60;

router.post("/api/backoffice/new_event", async (req: Request, res: Response) => {
  const home = typeof req.body.home === "string" ? req.body.home.trim() : "";
  const away = typeof req.body.away === "string" ? req.body.away.trim() : "";
  const { kickoffDelaySeconds } = req.body;
  const visibility = req.body.visibility ?? EventVisibility.ONLINE;
  const liveEnabled = req.body.liveEnabled ?? true;
  const cashBackEnabled = req.body.cashBackEnabled ?? true;
  if ((req.body.liveEnabled !== undefined && typeof req.body.liveEnabled !== "boolean")
    || (req.body.cashBackEnabled !== undefined && typeof req.body.cashBackEnabled !== "boolean")) {
    res.status(400).send({ message: "Live game and cash-back settings must be on or off" });
    return;
  }
  const suppliedRequestId =
    typeof req.body.requestId === "string" ? req.body.requestId.trim() : "";

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

  const delaySeconds = kickoffDelaySeconds ?? DEFAULT_KICKOFF_DELAY_SECONDS;
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
  if (
    req.body.requestId !== undefined
    && (!suppliedRequestId || suppliedRequestId.length > MAX_REQUEST_ID_LENGTH)
  ) {
    res.status(400).send({ message: "Creation request id is invalid" });
    return;
  }

  const creationRequestId = suppliedRequestId || randomUUID();
  const creationRequestFingerprint = JSON.stringify({
    home,
    away,
    delaySeconds,
    visibility,
    ...(liveEnabled ? {} : { liveEnabled: false }),
    ...(cashBackEnabled ? {} : { cashBackEnabled: false }),
  });
  const existingEvent = await Event.findOne({ creationRequestId }).select(
    "+creationRequestId +creationRequestFingerprint "
    + "+newEventPublicationPending"
  );
  if (existingEvent) {
    if (existingEvent.creationRequestFingerprint !== creationRequestFingerprint) {
      res.status(409).send({
        message: "Creation request id was already used for another event",
      });
      return;
    }

    const publication = await getBackofficePublicationService(
      messengerWrapper.connection
    ).publishNewEventNow(existingEvent.eventId);
    res.status(publication === "PUBLISHED" ? 200 : 202).send({
      event: serializeBackofficeEvent(existingEvent),
      publication,
      ...(publication === "PENDING"
        ? { message: "Event saved; publication is retrying" }
        : {}),
    });
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
    liveEnabled,
    cashBackEnabled,
    creationRequestId,
    creationRequestFingerprint,
    newEventPublicationPending: true,
  });

  try {
    await event.save();
  } catch (error: any) {
    if (error?.code !== 11000) {
      throw error;
    }

    const concurrentEvent = await Event.findOne({ creationRequestId }).select(
      "+creationRequestId +creationRequestFingerprint "
      + "+newEventPublicationPending"
    );
    if (
      !concurrentEvent
      || concurrentEvent.creationRequestFingerprint !== creationRequestFingerprint
    ) {
      res.status(409).send({
        message: "Creation request id was already used for another event",
      });
      return;
    }

    const publication = await getBackofficePublicationService(
      messengerWrapper.connection
    ).publishNewEventNow(concurrentEvent.eventId);
    res.status(publication === "PUBLISHED" ? 200 : 202).send({
      event: serializeBackofficeEvent(concurrentEvent),
      publication,
      ...(publication === "PENDING"
        ? { message: "Event saved; publication is retrying" }
        : {}),
    });
    return;
  }

  const publication = await getBackofficePublicationService(
    messengerWrapper.connection
  ).publishNewEventNow(event.eventId);
  res.status(publication === "PUBLISHED" ? 200 : 202).send({
    event: serializeBackofficeEvent(event),
    publication,
    ...(publication === "PENDING"
      ? { message: "Event saved; publication is retrying" }
      : {}),
  });
});

export { router as NewEvent };
