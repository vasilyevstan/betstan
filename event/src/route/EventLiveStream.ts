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
  maxConnections?: number;
  verifyScopedAccess?: (req: Request) => Promise<boolean>;
}

const MAX_BUFFERED_BYTES = 256 * 1024;
const DRAIN_TIMEOUT_MS = 5000;

const buildSnapshotFrame = (snapshot: PublicEventSnapshot): string | undefined => {
  const sanitizedSnapshot = sanitizePublicEventSnapshot(snapshot);

  if (!sanitizedSnapshot.live) {
    return undefined;
  }

  return `id: ${buildLiveEventId(
    sanitizedSnapshot.eventId,
    sanitizedSnapshot.live.sequence
  )}\n`
    + "event: snapshot\n"
    + `data: ${JSON.stringify(sanitizedSnapshot)}\n\n`;
};

export const openEventLiveStream = (
  req: Request,
  res: Response,
  options: EventLiveStreamOptions = {}
): void => {
  const heartbeatMs =
    options.heartbeatMs ?? getPublicEventConfig().sseHeartbeatMs;
  const hub = options.hub ?? liveEventHub;
  const maxConnections =
    options.maxConnections ?? getPublicEventConfig().sseMaxConnections;
  const visibleOfflineEventIds = new Set(req.visibleOfflineEventIds ?? []);
  const hasOfflineScope = visibleOfflineEventIds.size > 0;
  const verifyScopedAccess =
    options.verifyScopedAccess
    ?? (async (request: Request) => (
      await verifyAdminRequest(request)
    ) === 204);

  if (hub.subscriberCount() >= maxConnections) {
    res.status(503);
    res.setHeader("Retry-After", "5");
    res.end();
    return;
  }

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
  let drainDeadline: ReturnType<typeof setTimeout> | undefined;
  let pendingAuthBytes = 0;
  let unsubscribe = () => {};
  let scopedVerification: Promise<boolean> | undefined;

  const isClosed = () => cleanedUp || res.writableEnded || res.destroyed;

  const onDrain = () => {
    if (drainDeadline !== undefined) {
      clearTimeout(drainDeadline);
      drainDeadline = undefined;
    }
  };

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    onDrain();
    res.removeListener("drain", onDrain);
    unsubscribe();
    // Pending auth callbacks still own their reservations, even after close.
    // Do not reset the counter: each callback releases its bytes exactly once.
  };

  const destroyStream = (diagnostic: string) => {
    if (cleanedUp) {
      return;
    }
    console.error(diagnostic);
    cleanup();
    res.destroy();
  };

  const closeScopedStream = () => {
    if (isClosed()) {
      return;
    }
    const buffered = res.writableLength > 0;
    cleanup();
    if (buffered) {
      res.destroy();
    } else {
      res.end();
    }
  };

  const fitsBudget = (additionalBytes: number): boolean => {
    if (res.writableLength + pendingAuthBytes + additionalBytes > MAX_BUFFERED_BYTES) {
      destroyStream("Event stream buffer limit exceeded");
      return false;
    }
    return true;
  };

  const writeFrame = (frame: string, bytes: number) => {
    if (isClosed() || !fitsBudget(bytes)) {
      return;
    }
    try {
      // false means Node accepted this frame into its writable buffer. Do not
      // resend it or maintain another outbound queue; bounded later writes
      // retain Node's write-call order.
      const belowHighWaterMark = res.write(frame);
      // A write can synchronously emit error/close before returning false.
      if (isClosed() || !fitsBudget(0)) {
        return;
      }
      // writableLength now includes HTTP framing overhead.
      if (!belowHighWaterMark && drainDeadline === undefined) {
        drainDeadline = setTimeout(() => {
          destroyStream("Event stream drain deadline exceeded");
        }, DRAIN_TIMEOUT_MS);
      }
    } catch {
      destroyStream("Event stream write failed");
    }
  };

  const revalidateScopedAccess = (): Promise<boolean> => {
    if (!scopedVerification) {
      const verification = Promise.resolve().then(() => verifyScopedAccess(req)).catch(() => {
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

  const sendFrame = (frame: string, requiresAuthorization: boolean) => {
    if (isClosed()) {
      return;
    }
    const bytes = Buffer.byteLength(frame, "utf8");
    if (!requiresAuthorization) {
      writeFrame(frame, bytes);
      return;
    }
    if (!fitsBudget(bytes)) {
      return;
    }
    pendingAuthBytes += bytes;
    void revalidateScopedAccess().then((authorized) => {
      pendingAuthBytes -= bytes;
      if (isClosed()) {
        return;
      }
      if (!authorized) {
        closeScopedStream();
        return;
      }
      writeFrame(frame, bytes);
    });
  };

  req.on("close", cleanup);
  res.on("close", cleanup);
  res.on("finish", cleanup);
  res.on("drain", onDrain);
  // Keep this listener through teardown so late response errors are handled.
  res.on("error", () => destroyStream("Event stream response failed"));

  unsubscribe = hub.subscribe((snapshot) => {
    if (isClosed()) {
      return;
    }
    const offline = snapshot.visibility === EventVisibility.OFFLINE;
    // Excluded offline snapshots never retain a sanitized frame or auth work.
    if (offline && !visibleOfflineEventIds.has(snapshot.eventId)) {
      return;
    }
    const frame = buildSnapshotFrame(snapshot);
    if (frame !== undefined) {
      sendFrame(frame, offline);
    }
  });

  heartbeat = setInterval(() => {
    sendFrame(": heartbeat\n\n", hasOfflineScope);
  }, heartbeatMs);
};

router.get(
  "/api/event/stream",
  authorizeAcceptanceEventAccess,
  (req: Request, res: Response) => {
    openEventLiveStream(req, res);
  }
);

export { router as EventLiveStream };
