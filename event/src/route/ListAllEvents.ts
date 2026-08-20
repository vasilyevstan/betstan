import express, { Request, Response } from "express";
import { Event } from "../model/Event";

const router = express.Router();

router.get("/api/event", async (req: Request, res: Response) => {
  res.send(await Event.find().sort({ time: 1 }));
});

export { router as ListllEvents };
