import express, { Request, Response } from "express";
import { Slip } from "../model/Slip";

const router = express.Router();

router.post("/api/slip/row/clean", async (req: Request, res: Response) => {
  const { slipId } = req.body;

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

  await slip.deleteOne();

  return res.sendStatus(200);
});

export { router as CleanSlip };
