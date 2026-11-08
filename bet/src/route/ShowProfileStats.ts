import express from "express";
import { getProfileBetStats, ProfileStatsRange } from "../service/profileBetStats";
import { isSessionTimestampFresh } from "../service/Session";

const router = express.Router();
const isInstant = (value: unknown): value is string =>
  typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

router.get("/api/bet/me/stats", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user: unknown = req.currentUser;
  if (
    !user || typeof user !== "object"
    || !("id" in user) || typeof user.id !== "string" || !user.id.trim()
    || !("timestamp" in user) || !isSessionTimestampFresh(user.timestamp)
  ) {
    return res.status(401).send({
      errors: [{ code: "AUTHENTICATION_REQUIRED", message: "Authentication required" }],
    });
  }

  const { from, toExclusive } = req.query;
  let range: ProfileStatsRange = { from: null, toExclusive: null };
  if (
    Object.keys(req.query).some(key => key !== "from" && key !== "toExclusive")
    || ((from !== undefined || toExclusive !== undefined)
      && (!isInstant(from) || !isInstant(toExclusive) || from >= toExclusive))
  ) {
    return res.status(400).send({
      errors: [{ code: "INVALID_RANGE", message: "Provide both from and toExclusive as an increasing UTC ISO range" }],
    });
  }
  if (isInstant(from) && isInstant(toExclusive)) range = { from, toExclusive };

  void getProfileBetStats(user.id, range).then(stats => res.send(stats)).catch(error => {
    console.error("bet_profile_stats_failed", { error: error instanceof Error ? error.name : "unknown" });
    res.status(503).send({
      errors: [{ code: "PROFILE_STATS_UNAVAILABLE", message: "Personal betting statistics are unavailable. Try again." }],
    });
  });
});

export { router as ShowProfileStats };
