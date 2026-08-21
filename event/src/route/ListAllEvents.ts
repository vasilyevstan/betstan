import express, { Request, Response } from "express";
import { listPublicEvents } from "../live/LiveEventReadModel";

const router = express.Router();

router.get("/api/event", async (_req: Request, res: Response) => {
  res.send(await listPublicEvents());
});

export { router as ListllEvents };
