import express, { Request, Response } from "express";
import { Slip } from "../model/Slip";
import { SlipStatus } from "@betstan/common";

const router = express.Router();

router.get("/api/slip", async (req: Request, res: Response) => {
  // console.log("fetching slip");

  if (!req.currentUser) {
    // console.log("returning empty slip");
    res.send({});
  } else {
    const slip = await Slip.findOne({
      userId: req.currentUser.id,
      status: SlipStatus.DRAFT,
    });
    // console.log("returning slip", slip);
    res.send(slip);
  }
});

export { router as ShowSlip };
