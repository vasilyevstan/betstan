import { Request, Response } from "express";
import {
  GUEST_COOKIE_NAME,
  GUEST_ID_PATTERN,
  GUEST_PRINCIPAL_PREFIX,
  readGuestId,
  refreshGuestCookie,
  resolveOddsPrincipal,
} from "../GuestIdentity";

const GUEST_ID = "0123456789abcdef0123456789abcdef";
const OTHER_GUEST_ID = "fedcba9876543210fedcba9876543210";

const requestWith = (
  headers: Record<string, string> = {},
  currentUser?: { id: string; email: string }
) => ({ headers, currentUser }) as unknown as Request;

describe("guest cookie contract", () => {
  it("keeps the shared cookie name, prefix and strict id pattern", () => {
    expect(GUEST_COOKIE_NAME).toBe("betstan_guest");
    expect(GUEST_PRINCIPAL_PREFIX).toBe("guest:");
    expect(GUEST_ID_PATTERN.source).toBe("^[a-f0-9]{32}$");
    expect(GUEST_ID_PATTERN.test(GUEST_ID)).toBe(true);
  });
});

describe("readGuestId", () => {
  it.each([
    ["no header", undefined],
    ["an empty header", ""],
    ["unrelated cookies", "session=abc; theme=dark"],
    ["a cookie whose name only ends with the guest name", `x_${GUEST_COOKIE_NAME}=${GUEST_ID}`],
    ["a cookie whose name only starts with the guest name", `${GUEST_COOKIE_NAME}2=${GUEST_ID}`],
    ["the guest cookie nested in another cookie value", `other=${GUEST_COOKIE_NAME}=${GUEST_ID}`],
    ["a bare guest cookie name without a value", GUEST_COOKIE_NAME],
  ])("finds no guest id in %s", (_label, header) => {
    expect(readGuestId(header)).toBeNull();
  });

  it.each([
    ["alone", GUEST_ID, `${GUEST_COOKIE_NAME}=${GUEST_ID}`],
    ["between other cookies", GUEST_ID, `theme=dark; ${GUEST_COOKIE_NAME}=${GUEST_ID}; session=abc`],
    ["with irregular whitespace", GUEST_ID, `theme=dark;   ${GUEST_COOKIE_NAME}=${GUEST_ID}  `],
    ["with no space after the separator", GUEST_ID, `theme=dark;${GUEST_COOKIE_NAME}=${GUEST_ID}`],
  ])("reads a valid id %s", (_label, expected, header) => {
    expect(readGuestId(header)).toBe(expected);
  });

  it.each([
    ["uppercase hex", GUEST_ID.toUpperCase()],
    ["a 31 character id", GUEST_ID.slice(1)],
    ["a 33 character id", `${GUEST_ID}0`],
    ["non-hex text", "g".repeat(32)],
    ["a principal-prefixed id", `${GUEST_PRINCIPAL_PREFIX}${GUEST_ID}`],
    ["a quoted id", `"${GUEST_ID}"`],
    ["an id with inner whitespace", `${GUEST_ID.slice(0, 16)} ${GUEST_ID.slice(17)}`],
    ["an empty value", ""],
  ])("treats %s as absent", (_label, value) => {
    expect(readGuestId(`${GUEST_COOKIE_NAME}=${value}`)).toBeNull();
  });

  it("takes the first guest cookie and never falls through to a later one", () => {
    expect(
      readGuestId(`${GUEST_COOKIE_NAME}=${GUEST_ID}; ${GUEST_COOKIE_NAME}=${OTHER_GUEST_ID}`)
    ).toBe(GUEST_ID);
    expect(
      readGuestId(`${GUEST_COOKIE_NAME}=nope; ${GUEST_COOKIE_NAME}=${OTHER_GUEST_ID}`)
    ).toBeNull();
  });
});

describe("resolveOddsPrincipal", () => {
  it("uses the signed-in user and ignores any guest cookie", () => {
    const req = requestWith(
      { cookie: `${GUEST_COOKIE_NAME}=${GUEST_ID}` },
      { id: "user-1", email: "user-1" }
    );

    expect(resolveOddsPrincipal(req)).toEqual({ userId: "user-1", guestId: null });
  });

  it("reuses a valid guest cookie", () => {
    expect(
      resolveOddsPrincipal(requestWith({ cookie: `${GUEST_COOKIE_NAME}=${GUEST_ID}` }))
    ).toEqual({ userId: `guest:${GUEST_ID}`, guestId: GUEST_ID });
  });

  it("mints a fresh strict id for a guest without a usable cookie", () => {
    const missing = resolveOddsPrincipal(requestWith());
    const malformed = resolveOddsPrincipal(
      requestWith({ cookie: `${GUEST_COOKIE_NAME}=${GUEST_ID.toUpperCase()}` })
    );

    for (const principal of [missing, malformed]) {
      expect(principal.guestId).toMatch(GUEST_ID_PATTERN);
      expect(principal.userId).toBe(`guest:${principal.guestId}`);
    }
    expect(missing.guestId).not.toBe(malformed.guestId);
  });
});

describe("refreshGuestCookie", () => {
  const refresh = (headers: Record<string, string>, guestId: string | null) => {
    const cookie = jest.fn();
    refreshGuestCookie(
      requestWith(headers),
      { cookie } as unknown as Response,
      { userId: guestId ? `guest:${guestId}` : "user-1", guestId }
    );
    return cookie;
  };

  it("never writes a cookie for a signed-in principal", () => {
    expect(refresh({}, null)).not.toHaveBeenCalled();
  });

  it("writes an HttpOnly, SameSite=Lax, 30-day cookie for the whole site", () => {
    expect(refresh({}, GUEST_ID)).toHaveBeenCalledWith(GUEST_COOKIE_NAME, GUEST_ID, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      secure: false,
    });
  });

  it.each([
    ["https", true],
    ["HTTPS", true],
    [" https ", true],
    ["https,http", true],
    ["http", false],
    ["http,https", false],
    ["wss", false],
    ["", false],
  ])("marks the cookie Secure for x-forwarded-proto %j: %s", (proto, secure) => {
    const cookie = refresh({ "x-forwarded-proto": proto }, GUEST_ID);

    expect(cookie).toHaveBeenCalledWith(
      GUEST_COOKIE_NAME,
      GUEST_ID,
      expect.objectContaining({ secure })
    );
  });
});
