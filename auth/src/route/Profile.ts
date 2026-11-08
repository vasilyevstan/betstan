import express from "express";
import { BadRequestError } from "@betstan/common";
import { currentUser } from "../middleware/CurrentUser";
import { User } from "../model/User";
import { getSessionUser } from "../service/Session";

const router = express.Router();
const controlCharacters = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

router.patch("/api/auth/profile", currentUser, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = await getSessionUser(req.currentUser);
  if (!user) {
    req.session = null;
    return res.status(401).send({ errors: [{ msg: "Authentication required" }] });
  }

  const body: unknown = req.body;
  if (
    !body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1 || !("displayName" in body)
    || Object.keys(req.query).length !== 0
  ) {
    throw new BadRequestError("Only displayName can be updated");
  }

  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  if (
    !displayName || Array.from(displayName).length > 254
    || controlCharacters.test(String(body.displayName))
  ) {
    throw new BadRequestError("Display name must be 1 to 254 characters of single-line text");
  }

  const updatedUser = await User.findOneAndUpdate(
    { _id: user._id, role: user.role ?? { $exists: false } },
    { $set: { displayName } },
    { new: true, runValidators: true }
  );
  if (!updatedUser) {
    req.session = null;
    return res.status(401).send({ errors: [{ msg: "Authentication required" }] });
  }

  return res.send({ displayName: updatedUser.displayName });
});

export { router as profileRouter };
