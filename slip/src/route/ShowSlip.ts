import express, { Request, Response } from "express";
import { Slip } from "../model/Slip";
import { SlipStatus } from "@betstan/common";

const router = express.Router();

router.get("/api/slip", async (req: Request, res: Response) => {
  if (!req.currentUser) {
    res.send({});
  } else {
    const slip = await Slip.findOne({
      userId: req.currentUser.id,
      status: SlipStatus.DRAFT,
    });
    res.send(slip);
  }
});

export { router as ShowSlip };
