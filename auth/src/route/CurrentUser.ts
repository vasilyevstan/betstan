import express from "express";
import { currentUser, UserPayload } from "../middleware/CurrentUser";
import { User } from "../model/User";
import {
  isSessionTimestampFresh,
  normalizeUserRole,
} from "../service/Session";

const router = express.Router();

router.get("/api/auth/currentuser", currentUser, async (req, res) => {
  let currentUser = req.currentUser;

  if (currentUser) {
    const user = await User.findById(currentUser.id);
    const signedRole = normalizeUserRole(currentUser.role);
    const persistedRole = normalizeUserRole(user?.role);

    if (
      !user
      || !isSessionTimestampFresh(currentUser.timestamp)
      || signedRole !== persistedRole
    ) {
      req.session = null;
      currentUser = undefined;
    } else {
      currentUser = {
        id: currentUser.id,
        email: currentUser.email,
        role: signedRole,
        timestamp: currentUser.timestamp,
      } satisfies UserPayload;
    }
  }

  res.send({ currentUser: currentUser || null });
});

export { router as currentUserRouter };
