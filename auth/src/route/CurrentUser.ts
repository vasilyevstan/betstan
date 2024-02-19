import express from "express";
import { currentUser } from "../middleware/CurrentUser";
import { User } from "../model/User";

const router = express.Router();

router.get("/api/auth/currentuser", currentUser, async (req, res) => {
  let currentUser = req.currentUser;

  if (currentUser) {
    const user = await User.findById(currentUser.id);

    // session token expires evert 12 hours
    const dateToExpire = currentUser.timestamp
      ? new Date(
          new Date(currentUser.timestamp).getTime() + 12 * 60 * 60 * 1000
        )
      : new Date().getTime() - 1 * 60 * 60 * 1000;

    if (!user || new Date() > dateToExpire) {
      console.log("user not found or expired", user, currentUser.email);

      req.session = null;
      currentUser = undefined;
    }
  }

  res.send({ currentUser: currentUser || null });
});

export { router as currentUserRouter };
