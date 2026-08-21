import express, { Request, Response } from "express";
import { getPublicEventConfig } from "../live/config";
import { liveEventHub, LiveEventHub } from "../live/LiveEventHub";
import {
  buildLiveEventId,
  PublicEventSnapshot,
  sanitizePublicEventSnapshot,
} from "../live/LiveEventReadModel";

const router = express.Router();

export interface EventLiveStreamOptions {
  hub?: LiveEventHub;
  heartbeatMs?: number;
}

const writeSnapshot = (res: Response, snapshot: PublicEventSnapshot): void => {
  const sanitizedSnapshot = sanitizePublicEventSnapshot(snapshot);

  if (!sanitizedSnapshot.live) {
    return;
  }

  res.write(
    `id: ${buildLiveEventId(
      sanitizedSnapshot.eventId,
      sanitizedSnapshot.live.sequence
    )}\n`
  );
  res.write("event: snapshot\n");
  res.write(`data: ${JSON.stringify(sanitizedSnapshot)}\n\n`);
};

export const openEventLiveStream = (
  req: Request,
  res: Response,
  options: EventLiveStreamOptions = {}
): void => {
  const heartbeatMs =
    options.heartbeatMs ?? getPublicEventConfig().sseHeartbeatMs;
  const hub = options.hub ?? liveEventHub;

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const unsubscribe = hub.subscribe((snapshot) => {
    if (!res.writableEnded) {
      writeSnapshot(res, snapshot);
    }
  });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": heartbeat\n\n");
    }
  }, heartbeatMs);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("finish", cleanup);
};

router.get("/api/event/stream", (req: Request, res: Response) => {
  openEventLiveStream(req, res);
});

export { router as EventLiveStream };
