import express, { Request, Response } from "express";
import { Slip } from "../model/Slip";

const router = express.Router();

router.post("/api/slip/row", async (req: Request, res: Response) => {
  const { slipId, slipRowId } = req.body;

  if (!req.currentUser) {
    return res.status(400).send({ message: "must login first" });
  }

  const slip = await Slip.findById(slipId);

  if (!slip) {
    return res.status(400).send({ message: "slip does not exist" });
  }

  if (slip.userId != req.currentUser.id) {
    return res.status(500).send({ message: "Forbidden" });
  }

  if (slip.rows.length === 1) {
    await slip.deleteOne();
  } else {
    let updatedSlipRows = slip.rows.filter((row) => row._id != slipRowId);
    slip.set({ rows: updatedSlipRows });
    await slip.save();
  }

  return res.sendStatus(200);
});

export { router as DeleteSlipRow };
