import { Request, Response } from "express";

export const GUEST_COOKIE_NAME = "betstan_guest";
export const GUEST_COOKIE_PATTERN = /^[a-f0-9]{32}$/;
export const GUEST_PRINCIPAL_PREFIX = "guest:";
const GUEST_PRINCIPAL_PATTERN = /^guest:[a-f0-9]{32}$/;
export const GUEST_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const GUEST_DRAFT_ROW_CAP = 50;

export interface SlipOwner {
  id: string;
  isGuest: boolean;
}

export const nextGuestExpiry = () =>
  new Date(Date.now() + GUEST_COOKIE_MAX_AGE_MS);

// Only the first occurrence counts: a later duplicate must never override it.
export const readGuestCookie = (req: Request): string | undefined => {
  const header = req.headers.cookie;
  if (typeof header !== "string") {
    return undefined;
  }

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== GUEST_COOKIE_NAME) {
      continue;
    }

    const value = pair.slice(separator + 1).trim();
    return GUEST_COOKIE_PATTERN.test(value) ? value : undefined;
  }

  return undefined;
};

export const isGuestPrincipal = (userId: unknown): userId is string =>
  typeof userId === "string" && GUEST_PRINCIPAL_PATTERN.test(userId);

export const resolveSlipOwner = (req: Request): SlipOwner | undefined => {
  if (req.currentUser) {
    return { id: req.currentUser.id, isGuest: false };
  }

  const guestId = readGuestCookie(req);

  return guestId
    ? { id: `${GUEST_PRINCIPAL_PREFIX}${guestId}`, isGuest: true }
    : undefined;
};

// The guest id is a bearer credential kept in an HttpOnly cookie, so a slip
// echoed to the page must carry neither the principal nor the retention clock.
// Copying from the serialized form also covers a slip that is still a Mongoose
// document; a signed-in owner's slip is returned untouched.
export const toOwnerFacingSlip = (owner: SlipOwner, slip: object): object => {
  if (!owner.isGuest) {
    return slip;
  }

  const facing = JSON.parse(JSON.stringify(slip)) as Record<string, unknown>;
  delete facing.userId;
  delete facing.guestExpiresAt;

  return facing;
};

export const clearGuestCookie = (res: Response) => {
  const forwardedProto = res.req.headers["x-forwarded-proto"];
  const proto = Array.isArray(forwardedProto)
    ? forwardedProto[0]
    : forwardedProto;

  res.clearCookie(GUEST_COOKIE_NAME, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: proto?.split(",")[0].trim().toLowerCase() === "https",
  });
};
