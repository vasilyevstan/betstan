import express, { Request, Response } from "express";
import { Event } from "../model/Event";
import { EventVisibility, messengerWrapper } from "@betstan/common";
import { getBackofficePublicationService } from "../service/BackofficePublicationService";

const router = express.Router();

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
        {
          eventId,
          visibility: { $ne: requestedVisibility },
          visibilityPublicationPending: { $ne: true },
        },
        {
          $set: {
            visibility: requestedVisibility,
            visibilityPublicationPending: true,
            visibilityPublicationTarget: requestedVisibility,
          },
        },
        { new: true }
      ).select(
        "+visibilityPublicationPending +visibilityPublicationTarget"
      )
      : await Event.findOneAndUpdate(
        { eventId, visibilityPublicationPending: { $ne: true } },
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
              visibilityPublicationPending: true,
              visibilityPublicationTarget: {
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
      ).select(
        "+visibilityPublicationPending +visibilityPublicationTarget"
      );

    if (!event) {
      const existingEvent = await Event.findOne({ eventId }).select(
        "+visibilityPublicationPending +visibilityPublicationTarget"
      );
      if (!existingEvent) {
        res.status(404).send({ message: "Event not found" });
        return;
      }

      if (existingEvent.visibilityPublicationPending) {
        if (
          requestedVisibility
          && existingEvent.visibilityPublicationTarget === requestedVisibility
        ) {
          const publication = await getBackofficePublicationService(
            messengerWrapper.connection
          ).publishVisibilityNow(existingEvent.eventId);
          res.status(publication === "PUBLISHED" ? 200 : 202).send({
            ...existingEvent.toObject({ useProjection: true }),
            publication,
            ...(publication === "PENDING"
              ? { message: "Visibility saved; publication is retrying" }
              : {}),
          });
          return;
        }

        res.status(409).send({
          message: "Another visibility change is still being published",
        });
        return;
      }

      res.send({
        ...existingEvent.toObject({ useProjection: true }),
        unchanged: true,
        publication: "PUBLISHED",
      });
      return;
    }

    const publication = await getBackofficePublicationService(
      messengerWrapper.connection
    ).publishVisibilityNow(event.eventId);
    res.status(publication === "PUBLISHED" ? 200 : 202).send({
      ...event.toObject({ useProjection: true }),
      publication,
      ...(publication === "PENDING"
        ? { message: "Visibility saved; publication is retrying" }
        : {}),
    });
  }
);

export { router as EventVisibility };
