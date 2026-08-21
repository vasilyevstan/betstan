import express, { Request, Response } from "express";
import { Bet } from "../model/Bet";

const router = express.Router();

router.get("/api/bet", async (req: Request, res: Response) => {
  if (!req.currentUser) {
    return res.send({});
  }

  const bets = await Bet.find({
    userId: req.currentUser.id,
  }).sort({ timestamp: -1 });

  return res.send(bets.map((bet) => bet.toJSON()));
});

export { router as ShowBets };
