import express, { Request, Response } from "express";
import { Bet } from "../model/Bet";

const router = express.Router();

router.get("/api/bet/stats", async (req: Request, res: Response) => {
  const bets = await Bet.find({});

  res.send(bets);
});

export { router as ShowStats };
