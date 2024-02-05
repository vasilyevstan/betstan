import express, { Request, Response } from "express";
import { Slip } from "../model/Slip";
import { SlipStatus, currentUser, messengerWrapper } from "@betstan/common";
import PlaceBetEventPublisher from "../event/publisher/PlaceBetEventPublisher";

const router = express.Router();

router.post("/api/slip/bet", async (req: Request, res: Response) => {
  const { slipId, wager } = req.body;

  if (!req.currentUser) {
    return res.sendStatus(400).send({ message: "must login first" });
  }

  const slip = await Slip.findById(slipId);

  if (!slip) {
    return res.sendStatus(400).send({ message: "slip does not exist" });
  }

  if (slip.userId != req.currentUser.id) {
    return res.sendStatus(500).send({ message: "Forbidden" });
  }

  if (!wager || wager < 0 || isNaN(wager)) {
    return res.sendStatus(400).send({ message: "Wager must be a number" });
  }

  // check for concurrency

  slip.set({ status: SlipStatus.COMPLETE });
  await slip.save();

  // archive slip
  const publisher = new PlaceBetEventPublisher(messengerWrapper.connection);
  await publisher.init();

  publisher.publish({
    data: {
      userId: req.currentUser.id,
      userName: req.currentUser.email,
      slipId: slip.id,
      wager: wager,
      rows: slip.rows.map((row) => {
        return {
          eventId: row.eventId,
          eventName: row.eventName,
          oddsId: row.oddsId,
          oddsValue: row.oddsValue,
          oddsName: row.oddsName,
          productName: row.productName,
          productId: row.productId,
          timestamp: row.timestamp,
          id: row.id,
        };
      }),
    },
  });

  return res.sendStatus(200);
});

export { router as PlaceBet };
