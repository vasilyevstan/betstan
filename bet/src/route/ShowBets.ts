import express, { Request, Response } from "express";
import { Bet } from "../model/Bet";

const router = express.Router();

router.get("/api/bet", async (req: Request, res: Response) => {
  if (!req.currentUser) {
    res.send({});
  } else {
    const bets = await Bet.find({
      userId: req.currentUser.id,
    });

    res.send(bets);
  }
});

export { router as ShowBets };
