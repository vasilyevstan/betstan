import { Request, Response } from "express";
import { Types } from "mongoose";
import { SlipStatus } from "@betstan/common";
import { Slip } from "../../model/Slip";
import {
  GUEST_COOKIE_MAX_AGE_MS,
  GUEST_COOKIE_NAME,
  GUEST_COOKIE_PATTERN,
  GUEST_DRAFT_ROW_CAP,
  GUEST_PRINCIPAL_PREFIX,
  clearGuestCookie,
  isGuestPrincipal,
  nextGuestExpiry,
  readGuestCookie,
  resolveSlipOwner,
  toOwnerFacingSlip,
} from "../guestIdentity";

const guestId = "0123456789abcdef0123456789abcdef";
const otherGuestId = "fedcba9876543210fedcba9876543210";

const requestWith = (cookie?: string, currentUser?: { id: string }) =>
  ({
    headers: cookie === undefined ? {} : { cookie },
    currentUser,
  }) as unknown as Request;

const responseWith = (forwardedProto?: string | string[]) => {
  const clearCookie = jest.fn();
  const res = {
    req: {
      headers:
        forwardedProto === undefined
          ? {}
          : { "x-forwarded-proto": forwardedProto },
    },
    clearCookie,
  } as unknown as Response;

  return { res, clearCookie };
};

describe("guest identity contract", () => {
  it("pins the cookie name, principal prefix, lifetime and draft cap", () => {
    expect(GUEST_COOKIE_NAME).toEqual("betstan_guest");
    expect(GUEST_PRINCIPAL_PREFIX).toEqual("guest:");
    expect(GUEST_COOKIE_MAX_AGE_MS).toEqual(2_592_000_000);
    expect(GUEST_DRAFT_ROW_CAP).toEqual(50);
  });

  it("accepts exactly 32 lowercase hex characters as a cookie value", () => {
    expect(GUEST_COOKIE_PATTERN.test(guestId)).toBe(true);
    for (const value of [
      "",
      guestId.slice(1),
      `${guestId}0`,
      guestId.toUpperCase(),
      `${guestId.slice(1)}g`,
      `${guestId}\n`,
      `"${guestId}"`,
    ]) {
      expect(GUEST_COOKIE_PATTERN.test(value)).toBe(false);
    }
  });

  it("expires a guest draft 30 days after the write", () => {
    const before = Date.now();
    const expiry = nextGuestExpiry();
    const after = Date.now();

    expect(expiry).toBeInstanceOf(Date);
    expect(expiry.getTime()).toBeGreaterThanOrEqual(
      before + GUEST_COOKIE_MAX_AGE_MS
    );
    expect(expiry.getTime()).toBeLessThanOrEqual(
      after + GUEST_COOKIE_MAX_AGE_MS
    );
  });
});

describe("readGuestCookie", () => {
  it("reads a valid cookie, alone or among other cookies", () => {
    expect(readGuestCookie(requestWith(`betstan_guest=${guestId}`))).toEqual(
      guestId
    );
    expect(
      readGuestCookie(
        requestWith(`session=abc;  betstan_guest=${guestId} ; theme=dark`)
      )
    ).toEqual(guestId);
  });

  it("returns undefined when there is no usable cookie header", () => {
    expect(readGuestCookie(requestWith())).toBeUndefined();
    expect(readGuestCookie(requestWith(""))).toBeUndefined();
    expect(readGuestCookie(requestWith("session=abc"))).toBeUndefined();
    expect(
      readGuestCookie({ headers: { cookie: ["a=b"] } } as unknown as Request)
    ).toBeUndefined();
  });

  it("only matches the exact cookie name", () => {
    expect(
      readGuestCookie(requestWith(`xbetstan_guest=${guestId}`))
    ).toBeUndefined();
    expect(
      readGuestCookie(requestWith(`betstan_guest_x=${guestId}`))
    ).toBeUndefined();
    expect(
      readGuestCookie(requestWith(`BETSTAN_GUEST=${guestId}`))
    ).toBeUndefined();
  });

  it.each([
    ["empty", ""],
    ["uppercase", "0123456789ABCDEF0123456789ABCDEF"],
    ["short", "0123456789abcdef0123456789abcde"],
    ["long", "0123456789abcdef0123456789abcdef0"],
    ["not hex", "0123456789abcdef0123456789abcdeg"],
    ["quoted", `"${guestId}"`],
    ["percent encoded", "%30123456789abcdef0123456789abcdef"],
    ["prefixed with the principal prefix", `guest:${guestId}`],
  ])("rejects a %s value", (_name, value) => {
    expect(readGuestCookie(requestWith(`betstan_guest=${value}`))).toBeUndefined();
  });

  it("uses the first occurrence only and never falls through to a later duplicate", () => {
    expect(
      readGuestCookie(
        requestWith(`betstan_guest=${guestId}; betstan_guest=${otherGuestId}`)
      )
    ).toEqual(guestId);
    expect(
      readGuestCookie(
        requestWith(`betstan_guest=not-valid; betstan_guest=${guestId}`)
      )
    ).toBeUndefined();
  });
});

describe("isGuestPrincipal", () => {
  it("accepts exactly guest: followed by 32 lowercase hex characters", () => {
    expect(isGuestPrincipal(`guest:${guestId}`)).toBe(true);
  });

  it.each([
    ["the bare prefix", "guest:"],
    ["a missing prefix", guestId],
    ["a differently cased prefix", `Guest:${guestId}`],
    ["uppercase hex", `guest:${guestId.toUpperCase()}`],
    ["a short id", `guest:${guestId.slice(1)}`],
    ["a long id", `guest:${guestId}0`],
    ["a non-hex id", `guest:${guestId.slice(1)}z`],
    ["a trailing newline", `guest:${guestId}\n`],
    ["a leading space", ` guest:${guestId}`],
    ["an object id", "507f1f77bcf86cd799439011"],
    ["an empty string", ""],
  ])("rejects %s", (_name, value) => {
    expect(isGuestPrincipal(value)).toBe(false);
  });

  it("rejects values that are not strings", () => {
    for (const value of [undefined, null, 5, {}, [`guest:${guestId}`]]) {
      expect(isGuestPrincipal(value)).toBe(false);
    }
  });
});

describe("resolveSlipOwner", () => {
  it("prefers the signed-in user over a guest cookie", () => {
    expect(
      resolveSlipOwner(
        requestWith(`betstan_guest=${guestId}`, { id: "user-1" })
      )
    ).toEqual({ id: "user-1", isGuest: false });
    expect(resolveSlipOwner(requestWith(undefined, { id: "user-1" }))).toEqual({
      id: "user-1",
      isGuest: false,
    });
  });

  it("resolves the guest principal from a valid cookie", () => {
    expect(resolveSlipOwner(requestWith(`betstan_guest=${guestId}`))).toEqual({
      id: `guest:${guestId}`,
      isGuest: true,
    });
  });

  it("resolves no owner without a user and without a valid cookie", () => {
    expect(resolveSlipOwner(requestWith())).toBeUndefined();
    expect(
      resolveSlipOwner(requestWith(`betstan_guest=${guestId.toUpperCase()}`))
    ).toBeUndefined();
    expect(
      resolveSlipOwner(requestWith(`betstan_guest=bad; betstan_guest=${guestId}`))
    ).toBeUndefined();
  });
});

describe("clearGuestCookie", () => {
  const expectedOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
  };

  it("expires the cookie with the attributes it was issued with", () => {
    const { res, clearCookie } = responseWith();

    clearGuestCookie(res);

    expect(clearCookie).toHaveBeenCalledTimes(1);
    expect(clearCookie).toHaveBeenCalledWith("betstan_guest", {
      ...expectedOptions,
      secure: false,
    });
  });

  it.each([
    ["https", "https"],
    ["a list starting with https", "https,http"],
    ["an uppercase value", "HTTPS"],
    ["an array header", ["https"]],
  ])("marks the clearing cookie Secure for %s", (_name, proto) => {
    const { res, clearCookie } = responseWith(proto);

    clearGuestCookie(res);

    expect(clearCookie).toHaveBeenCalledWith("betstan_guest", {
      ...expectedOptions,
      secure: true,
    });
  });

  it.each([
    ["http", "http"],
    ["a list starting with http", "http,https"],
    ["an unknown scheme", "ws"],
  ])("does not mark the clearing cookie Secure for %s", (_name, proto) => {
    const { res, clearCookie } = responseWith(proto);

    clearGuestCookie(res);

    expect(clearCookie).toHaveBeenCalledWith("betstan_guest", {
      ...expectedOptions,
      secure: false,
    });
  });
});

describe("toOwnerFacingSlip", () => {
  const guestOwner = { id: `guest:${guestId}`, isGuest: true };
  const userOwner = { id: "user-1", isGuest: false };
  const storedSlip = (userId: string) => ({
    _id: new Types.ObjectId(),
    userId,
    guestExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
    status: "DRAFT",
    boardRevision: 3,
    boardFingerprint: "fingerprint",
    rows: [{ _id: new Types.ObjectId(), oddsId: "odds-a", oddsValue: 1.5 }],
  });

  it("returns a signed-in owner's slip itself, untouched", () => {
    const slip = storedSlip("user-1");

    expect(toOwnerFacingSlip(userOwner, slip)).toBe(slip);
    expect(slip.userId).toEqual("user-1");
    expect(slip.guestExpiresAt).toBeInstanceOf(Date);
  });

  it("drops the principal and the expiry from a guest's slip and keeps every other value", () => {
    const slip = storedSlip(`guest:${guestId}`);

    const facing = toOwnerFacingSlip(guestOwner, slip);

    expect(facing).not.toBe(slip);
    expect(facing).not.toHaveProperty("userId");
    expect(facing).not.toHaveProperty("guestExpiresAt");
    expect(facing).toEqual(
      JSON.parse(
        JSON.stringify({ ...slip, userId: undefined, guestExpiresAt: undefined })
      )
    );
    expect(JSON.stringify(facing)).not.toContain(guestId);
    expect(slip.userId).toEqual(`guest:${guestId}`);
    expect(slip.guestExpiresAt).toBeInstanceOf(Date);
  });

  it("copes with a guest slip that is still a document", () => {
    const document = new Slip({
      userId: `guest:${guestId}`,
      status: SlipStatus.DRAFT,
      timestamp: "2030-01-01T00:00:00.000Z",
      guestExpiresAt: new Date("2030-01-01T00:00:00.000Z"),
      rows: [],
    });

    const facing = toOwnerFacingSlip(guestOwner, document);

    expect(facing).not.toHaveProperty("userId");
    expect(facing).not.toHaveProperty("guestExpiresAt");
    expect(facing).toMatchObject({
      _id: document.id,
      status: SlipStatus.DRAFT,
      boardRevision: 1,
      rows: [],
    });
    expect(JSON.stringify(facing)).not.toContain(guestId);
    expect(document.get("userId")).toEqual(`guest:${guestId}`);
  });
});
