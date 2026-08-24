import express, { Request, Response } from "express";
import {
  getLegacyPublicBetStats,
  getPublicBetStats,
} from "../service/publicBetStats";

const router = express.Router();

router.get("/api/bet/stats", async (req: Request, res: Response) => {
  const stats = await getLegacyPublicBetStats();

  res.send(stats);
});

router.get("/api/bet/stats/v2", async (req: Request, res: Response) => {
  const stats = await getPublicBetStats();

  res.send(stats);
});

export { router as ShowStats };
