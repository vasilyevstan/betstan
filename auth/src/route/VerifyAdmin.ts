import express, { Request, Response } from "express";
import { currentUser } from "../middleware/CurrentUser";
import { User, UserRole } from "../model/User";
import {
  isSessionTimestampFresh,
  normalizeUserRole,
} from "../service/Session";

const router = express.Router();

router.get(
  "/api/auth/admin/verify",
  currentUser,
  async (req: Request, res: Response) => {
    if (!req.currentUser) {
      return res.status(401).send();
    }

    if (!isSessionTimestampFresh(req.currentUser.timestamp)) {
      req.session = null;
      return res.status(401).send();
    }

    if (normalizeUserRole(req.currentUser.role) !== UserRole.ADMIN) {
      return res.status(403).send();
    }

    const user = await User.findById(req.currentUser.id).select("role");
    if (!user) {
      req.session = null;
      return res.status(401).send();
    }

    if (normalizeUserRole(user.role) !== UserRole.ADMIN) {
      req.session = null;
      return res.status(401).send();
    }

    return res.status(204).send();
  }
);

export { router as verifyAdminRouter };
