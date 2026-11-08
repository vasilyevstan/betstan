import express from "express";
import { currentUser } from "../middleware/CurrentUser";
import { getSessionUser, normalizeUserRole } from "../service/Session";

const router = express.Router();

router.get("/api/auth/currentuser", currentUser, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const payload = req.currentUser;
  const user = await getSessionUser(payload);

  if (payload && !user) {
    req.session = null;
  }

  res.send({
    currentUser: user && payload ? {
      id: String(user._id),
      email: user.email,
      displayName: user.displayName ?? user.email,
      role: normalizeUserRole(user.role),
      timestamp: payload.timestamp,
    } : null,
  });
});

export { router as currentUserRouter };
