import express, { Request, Response } from "express";
import { getPublicEventConfig } from "../live/config";
import { liveEventHub, LiveEventHub } from "../live/LiveEventHub";
import {
  buildLiveEventId,
  PublicEventSnapshot,
  sanitizePublicEventSnapshot,
} from "../live/LiveEventReadModel";
import { EventVisibility } from "@betstan/common";
import { authorizeAcceptanceEventAccess } from "../middleware/AcceptanceEventAccess";
import { verifyAdminRequest } from "../service/VerifyAdminSession";

const router = express.Router();

export interface EventLiveStreamOptions {
  hub?: LiveEventHub;
  heartbeatMs?: number;
  verifyScopedAccess?: (req: Request) => Promise<boolean>;
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
  const visibleOfflineEventIds = new Set(req.visibleOfflineEventIds ?? []);
  const hasOfflineScope = visibleOfflineEventIds.size > 0;
  const verifyScopedAccess =
    options.verifyScopedAccess
    ?? (async (request: Request) => (
      await verifyAdminRequest(request)
    ) === 204);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let cleanedUp = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = () => {};
  let scopedVerification: Promise<boolean> | undefined;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    unsubscribe();
  };

  const closeScopedStream = () => {
    cleanup();
    if (!res.writableEnded) {
      res.end();
    }
  };

  const revalidateScopedAccess = (): Promise<boolean> => {
    if (!scopedVerification) {
      const verification = verifyScopedAccess(req).catch((_error) => {
        console.error("Scoped event stream authorization failed");
        return false;
      });
      scopedVerification = verification;
      void verification.finally(() => {
        if (scopedVerification === verification) {
          scopedVerification = undefined;
        }
      });
    }

    return scopedVerification;
  };

  unsubscribe = hub.subscribe((snapshot) => {
    if (res.writableEnded || cleanedUp) {
      return;
    }

    if (snapshot.visibility !== EventVisibility.OFFLINE) {
      writeSnapshot(res, snapshot);
      return;
    }

    if (!visibleOfflineEventIds.has(snapshot.eventId)) {
      return;
    }

    void revalidateScopedAccess().then((authorized) => {
      if (!authorized) {
        closeScopedStream();
        return;
      }

      if (!res.writableEnded && !cleanedUp) {
        writeSnapshot(res, snapshot);
      }
    });
  });

  heartbeat = setInterval(() => {
    if (res.writableEnded || cleanedUp) {
      return;
    }

    if (!hasOfflineScope) {
      res.write(": heartbeat\n\n");
      return;
    }

    void revalidateScopedAccess().then((authorized) => {
      if (!authorized) {
        closeScopedStream();
        return;
      }

      if (!res.writableEnded && !cleanedUp) {
        res.write(": heartbeat\n\n");
      }
    });
  }, heartbeatMs);

  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("finish", cleanup);
};

router.get(
  "/api/event/stream",
  authorizeAcceptanceEventAccess,
  (req: Request, res: Response) => {
    openEventLiveStream(req, res);
  }
);

export { router as EventLiveStream };
