import express, { Request, Response } from "express";
import { Event } from "../model/Event";

const router = express.Router();

router.get("/api/backoffice", async (req: Request, res: Response) => {
  const events = await Event.find().sort({ status: 1, time: 1 });

  res.send(events);
});

export { router as ShowEvents };
