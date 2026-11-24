import { createHash, randomBytes } from "crypto";
import { Request, Response } from "express";

// The slip service keeps its own copy of the cookie name, id pattern and
// principal derivation until @betstan/common can carry them through a
// coordinated publish.
export const GUEST_COOKIE_NAME = "betstan_guest";
export const GUEST_ID_PATTERN = /^[a-f0-9]{32}$/;
export const GUEST_PRINCIPAL_PREFIX = "guest:";

const GUEST_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type OddsPrincipal = {
  /** Published as IEventOddsSelectedEvent.userId, and publishers log the payload: a guest appears only as a one-way hash. */
  userId: string;
  /** A guest's raw cookie value, handed back once a click is accepted. It is a bearer credential: never publish or log it. */
  guestId: string | null;
};

/** `guest:` plus the SHA-256 hex of the 32-character cookie text (not of its decoded bytes). */
const toGuestPrincipal = (guestId: string): string =>
  `${GUEST_PRINCIPAL_PREFIX}${createHash("sha256").update(guestId, "utf8").digest("hex")}`;

/** The first `betstan_guest` cookie decides; anything but a strict id is treated as absent. */
export const readGuestId = (cookieHeader: string | undefined): string | null => {
  for (const pair of (cookieHeader ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1 || pair.slice(0, separator).trim() !== GUEST_COOKIE_NAME) {
      continue;
    }

    const value = pair.slice(separator + 1).trim();
    return GUEST_ID_PATTERN.test(value) ? value : null;
  }

  return null;
};

export const resolveOddsPrincipal = (req: Request): OddsPrincipal => {
  if (req.currentUser) {
    return { userId: req.currentUser.id, guestId: null };
  }

  const guestId = readGuestId(req.headers.cookie) ?? randomBytes(16).toString("hex");
  return { userId: toGuestPrincipal(guestId), guestId };
};

/** Call only once the click is accepted: a rejected click must not set the cookie. */
export const refreshGuestCookie = (
  req: Request,
  res: Response,
  { guestId }: OddsPrincipal
): void => {
  if (guestId === null) {
    return;
  }

  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();

  res.cookie(GUEST_COOKIE_NAME, guestId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: GUEST_COOKIE_MAX_AGE_MS,
    secure: forwardedProto === "https",
  });
};
