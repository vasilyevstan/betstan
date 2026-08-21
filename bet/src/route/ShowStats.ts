import express, { Request, Response } from "express";
import { getPublicBetStats } from "../service/publicBetStats";

const router = express.Router();

router.get("/api/bet/stats", async (req: Request, res: Response) => {
  const stats = await getPublicBetStats();

  res.send(stats);
});

export { router as ShowStats };
