import express from "express";
import { EventStatus } from "@betstan/common";
import { Event } from "../model/Event";
import { cashBackAuthorityWritable } from "../service/CashBackSourceService";
import { serializeBackofficeEvent } from "../service/serializeBackofficeEvent";

const router = express.Router();

router.post("/api/backoffice/event_cash_back", async (req, res) => {
  const { eventId, enabled, expectedEnabled } = req.body;
  if (typeof eventId !== "string" || !eventId.trim() || eventId.length > 128
    || typeof enabled !== "boolean" || typeof expectedEnabled !== "boolean") {
    res.status(400).send({ message: "Provide an event and its current and requested cash-back settings" });
    return;
  }
  const updated = await Event.findOneAndUpdate({
    eventId, status: EventStatus.NO_RESULT,
    cashBackEnabled: expectedEnabled ? { $ne: false } : false,
    $and: [cashBackAuthorityWritable, { cashBackEnabled: enabled ? false : { $ne: false } }],
  }, {
    $set: { cashBackEnabled: enabled },
    $inc: { cashBackAuthorityRevision: 1 },
    $currentDate: { cashBackAuthorityAt: true },
  }, { new: true });
  if (updated) {
    res.send(serializeBackofficeEvent(updated));
    return;
  }
  const current = await Event.findOne({ eventId }).select("+cashBackHold");
  if (!current) {
    res.status(404).send({ message: "Event not found" });
  } else if ((current.cashBackEnabled !== false) === enabled) {
    res.send({ ...serializeBackofficeEvent(current), unchanged: true });
  } else {
    res.status(409).send({ message: current.cashBackHold
      ? "A cash-back is being confirmed. Try again after it completes."
      : "The event or its cash-back setting changed. Refresh before trying again." });
  }
});

export { router as EventCashBack };
