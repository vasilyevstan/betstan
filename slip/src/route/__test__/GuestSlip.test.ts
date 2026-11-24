import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import {
  Slip,
  SLIP_DRAFT_UNIQUE_INDEX_KEYS,
  SLIP_DRAFT_UNIQUE_INDEX_NAME,
  SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
} from "../../model/Slip";
import { BetKind, SlipStatus } from "@betstan/common";

const guestId = "0123456789abcdef0123456789abcdef";
const otherGuestId = "fedcba9876543210fedcba9876543210";
const guestPrincipal = `guest:${guestId}`;
const otherGuestPrincipal = `guest:${otherGuestId}`;
const guestCookie = `betstan_guest=${guestId}`;
const userId = new mongoose.Types.ObjectId().toHexString();
const currentUserHeader = JSON.stringify({ id: userId, email: "test@test.com" });
const clearedGuestCookie =
  "betstan_guest=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax";

const preMatchRow = (oddsId = new mongoose.Types.ObjectId().toHexString()) => ({
  _id: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId().toHexString(),
  eventName: "Team A - Team B",
  oddsId,
  oddsValue: 1.5,
  oddsName: "Team A",
  productName: "1X2",
  productId: new mongoose.Types.ObjectId().toHexString(),
  timestamp: new Date().toISOString(),
  betKind: BetKind.PRE_MATCH,
});

const liveRow = (
  market: number,
  side: "HOME" | "AWAY" = "HOME",
  oddsValue = 1.5
) => ({
  _id: new mongoose.Types.ObjectId(),
  eventId: "event-live",
  eventName: "Team A - Team B",
  oddsId: `event-live:MARKET_${market}:${side}`,
  oddsValue,
  oddsName: side,
  productName: "NEXT_CORNER",
  productId: `event-live:MARKET_${market}`,
  timestamp: new Date().toISOString(),
  betKind: BetKind.LIVE,
  marketId: `event-live:MARKET_${market}`,
  marketVersion: 1,
  quoteVersion: 1,
  selectionId: `event-live:MARKET_${market}:1:${side}`,
});

const createSlip = async ({
  ownerId,
  betKind = BetKind.PRE_MATCH,
  status = SlipStatus.DRAFT,
  rows,
}: {
  ownerId: string;
  betKind?: BetKind;
  status?: SlipStatus;
  rows: Array<Record<string, unknown>>;
}) => {
  const slip = new Slip({
    userId: ownerId,
    betKind,
    status,
    timestamp: new Date().toISOString(),
    submittedAt:
      status === SlipStatus.SUBMITTED ? new Date().toISOString() : undefined,
    guestExpiresAt: ownerId.startsWith("guest:")
      ? new Date(Date.now() + 60_000)
      : undefined,
    rows,
  });
  await slip.save();
  return slip;
};

const getBoards = (headers: Record<string, string> = {}) => {
  const pending = request(app).get("/api/slip/boards");
  for (const [name, value] of Object.entries(headers)) {
    pending.set(name, value);
  }
  return pending;
};

const guestCookieHeaders = (response: request.Response) =>
  (
    (response.headers["set-cookie"] as unknown as string[] | undefined) ?? []
  ).filter((cookie) => cookie.startsWith("betstan_guest="));

const oddsIdsOf = (board: { rows: Array<{ oddsId: string }> }) =>
  board.rows.map((row) => row.oddsId);

afterEach(() => {
  jest.restoreAllMocks();
});

describe("guest owner resolution", () => {
  it("returns the guest's draft boards for a valid guest cookie", async () => {
    const preMatch = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-a")],
    });
    const live = await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [liveRow(1)],
    });
    await createSlip({ ownerId: otherGuestPrincipal, rows: [preMatchRow()] });
    await createSlip({ ownerId: userId, rows: [preMatchRow()] });

    const response = await getBoards({ Cookie: guestCookie }).expect(200);

    expect(response.body.PRE_MATCH._id).toEqual(preMatch.id);
    expect(response.body.PRE_MATCH).not.toHaveProperty("userId");
    expect(response.body.PRE_MATCH.status).toEqual(SlipStatus.DRAFT);
    expect(oddsIdsOf(response.body.PRE_MATCH)).toEqual(["odds-a"]);
    expect(response.body.LIVE._id).toEqual(live.id);
    expect(response.body.LIVE.betKind).toEqual(BetKind.LIVE);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("returns empty boards for a guest without drafts", async () => {
    const response = await getBoards({ Cookie: guestCookie }).expect(200);

    expect(response.body).toEqual({ PRE_MATCH: null, LIVE: null });
  });

  it.each([
    ["no cookie", undefined],
    ["an uppercase value", `betstan_guest=${guestId.toUpperCase()}`],
    ["a short value", `betstan_guest=${guestId.slice(1)}`],
    ["a long value", `betstan_guest=${guestId}0`],
    ["a quoted value", `betstan_guest="${guestId}"`],
    ["an invalid first occurrence", `betstan_guest=nope; ${guestCookie}`],
    ["another cookie name", `other_guest=${guestId}`],
  ])("treats %s as no owner", async (_name, cookie) => {
    await createSlip({ ownerId: guestPrincipal, rows: [preMatchRow()] });

    const response = await getBoards(cookie ? { Cookie: cookie } : {}).expect(200);

    expect(response.body).toEqual({ PRE_MATCH: null, LIVE: null });
  });

  it("finds the guest cookie among other cookies", async () => {
    const preMatch = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow()],
    });

    const response = await getBoards({
      Cookie: `session=abc; ${guestCookie}; theme=dark`,
    }).expect(200);

    expect(response.body.PRE_MATCH._id).toEqual(preMatch.id);
  });

  it("serves the guest's draft from the legacy route and keeps anonymous requests empty", async () => {
    const preMatch = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow()],
    });
    const live = await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [liveRow(1)],
    });

    const defaultKind = await request(app)
      .get("/api/slip")
      .set("Cookie", guestCookie)
      .expect(200);
    const liveKind = await request(app)
      .get("/api/slip")
      .query({ betKind: BetKind.LIVE })
      .set("Cookie", guestCookie)
      .expect(200);
    const invalidKind = await request(app)
      .get("/api/slip")
      .query({ betKind: "NOPE" })
      .set("Cookie", guestCookie)
      .expect(400);
    const malformed = await request(app)
      .get("/api/slip")
      .set("Cookie", `betstan_guest=${guestId.toUpperCase()}`)
      .expect(200);

    expect(defaultKind.body._id).toEqual(preMatch.id);
    expect(liveKind.body._id).toEqual(live.id);
    expect(invalidKind.body.message).toEqual("Invalid bet kind");
    expect(malformed.body).toEqual({});
  });

  it("does not record legacy board confirmations for a guest, even with a stale session token", async () => {
    await createSlip({ ownerId: guestPrincipal, rows: [preMatchRow()] });

    await getBoards({
      Cookie: guestCookie,
      "x-test-session-jwt": "stale-session-token",
    }).expect(200);
    await request(app)
      .get("/api/slip")
      .set("Cookie", guestCookie)
      .set("x-test-session-jwt", "stale-session-token")
      .expect(200);

    const stored = await Slip.collection.findOne({ userId: guestPrincipal });
    expect(stored).not.toBeNull();
    expect(stored).not.toHaveProperty("legacyBoardConfirmations");
  });

  it("lets a signed-in user win over a guest cookie on the legacy route without claiming", async () => {
    const userSlip = await createSlip({ ownerId: userId, rows: [preMatchRow()] });
    await createSlip({ ownerId: guestPrincipal, rows: [preMatchRow()] });

    const response = await request(app)
      .get("/api/slip")
      .set("currentUser", currentUserHeader)
      .set("Cookie", guestCookie)
      .expect(200);

    expect(response.body._id).toEqual(userSlip.id);
    expect(await Slip.countDocuments({ userId: guestPrincipal })).toEqual(1);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  describe("row removal", () => {
    it("lets a guest remove a row from their own draft and refreshes the expiry", async () => {
      const keep = preMatchRow("odds-keep");
      const drop = preMatchRow("odds-drop");
      const slip = await createSlip({
        ownerId: guestPrincipal,
        rows: [keep, drop],
      });
      const before = await Slip.findById(slip.id).lean();

      await request(app)
        .post("/api/slip/row")
        .set("Cookie", guestCookie)
        .send({ slipId: slip.id, slipRowId: drop._id.toString() })
        .expect(200);

      const after = await Slip.findById(slip.id).lean();
      expect(oddsIdsOf(after!)).toEqual(["odds-keep"]);
      expect(after!.boardRevision).toEqual(before!.boardRevision! + 1);
      expect(after!.boardFingerprint).not.toEqual(before!.boardFingerprint);
      expect(after!.guestExpiresAt!.getTime()).toBeGreaterThan(
        Date.now() + 29 * 24 * 60 * 60 * 1000
      );
    });

    it("deletes the guest draft when its last row is removed", async () => {
      const only = preMatchRow();
      const slip = await createSlip({ ownerId: guestPrincipal, rows: [only] });

      await request(app)
        .post("/api/slip/row")
        .set("Cookie", guestCookie)
        .send({ slipId: slip.id, slipRowId: only._id.toString() })
        .expect(200);

      expect(await Slip.findById(slip.id)).toBeNull();
    });

    it("never touches another guest's or a user's draft", async () => {
      const otherGuestRow = preMatchRow();
      const userRow = preMatchRow();
      const otherGuestSlip = await createSlip({
        ownerId: otherGuestPrincipal,
        rows: [otherGuestRow],
      });
      const userSlip = await createSlip({ ownerId: userId, rows: [userRow] });

      for (const [slip, row] of [
        [otherGuestSlip, otherGuestRow],
        [userSlip, userRow],
      ] as const) {
        const response = await request(app)
          .post("/api/slip/row")
          .set("Cookie", guestCookie)
          .send({ slipId: slip.id, slipRowId: row._id.toString() })
          .expect(400);
        expect(response.body.message).toEqual("slip does not exist");
        expect((await Slip.findById(slip.id))!.rows).toHaveLength(1);
      }
    });

    it.each([
      ["no cookie", undefined],
      ["a malformed cookie", `betstan_guest=${guestId.toUpperCase()}`],
    ])("rejects removal with %s as before", async (_name, cookie) => {
      const only = preMatchRow();
      const slip = await createSlip({ ownerId: guestPrincipal, rows: [only] });
      const pending = request(app).post("/api/slip/row");
      if (cookie) {
        pending.set("Cookie", cookie);
      }

      const response = await pending
        .send({ slipId: slip.id, slipRowId: only._id.toString() })
        .expect(400);

      expect(response.body.message).toEqual("must login first");
      expect((await Slip.findById(slip.id))!.rows).toHaveLength(1);
    });
  });

  describe("board cleaning", () => {
    it("lets a guest clean their own draft only", async () => {
      const own = await createSlip({
        ownerId: guestPrincipal,
        rows: [preMatchRow()],
      });
      const otherGuest = await createSlip({
        ownerId: otherGuestPrincipal,
        rows: [preMatchRow()],
      });

      await request(app)
        .post("/api/slip/row/clean")
        .set("Cookie", guestCookie)
        .send({ slipId: otherGuest.id })
        .expect(400);
      expect(await Slip.findById(otherGuest.id)).not.toBeNull();

      await request(app)
        .post("/api/slip/row/clean")
        .set("Cookie", guestCookie)
        .send({ slipId: own.id })
        .expect(200);
      expect(await Slip.findById(own.id)).toBeNull();
    });

    it.each([
      ["no cookie", undefined],
      ["a malformed cookie", `betstan_guest=${guestId.slice(2)}`],
    ])("rejects cleaning with %s as before", async (_name, cookie) => {
      const slip = await createSlip({
        ownerId: guestPrincipal,
        rows: [preMatchRow()],
      });
      const pending = request(app).post("/api/slip/row/clean");
      if (cookie) {
        pending.set("Cookie", cookie);
      }

      const response = await pending.send({ slipId: slip.id }).expect(400);

      expect(response.body.message).toEqual("must login first");
      expect(await Slip.findById(slip.id)).not.toBeNull();
    });
  });

  describe("user-only routes", () => {
    it("rejects a guest-only POST /api/slip/bet exactly like an anonymous request", async () => {
      const slip = await createSlip({
        ownerId: guestPrincipal,
        rows: [preMatchRow()],
      });
      const body = {
        slipId: slip.id,
        wager: 5,
        expectedBoardRevision: slip.boardRevision,
        expectedBoardFingerprint: slip.boardFingerprint,
      };

      const anonymous = await request(app).post("/api/slip/bet").send(body);
      const guest = await request(app)
        .post("/api/slip/bet")
        .set("Cookie", guestCookie)
        .send(body);

      expect(guest.status).toEqual(400);
      expect(guest.body).toEqual({ message: "must login first" });
      expect(guest.status).toEqual(anonymous.status);
      expect(guest.body).toEqual(anonymous.body);
      expect((await Slip.findById(slip.id))!.status).toEqual(SlipStatus.DRAFT);
    });

    it("rejects a guest-only POST /api/slip/market-selection exactly like an anonymous request", async () => {
      const body = {
        quoteId: "quote-a",
        expectedBoardRevision: null,
        expectedBoardFingerprint: null,
      };

      const anonymous = await request(app)
        .post("/api/slip/market-selection")
        .send(body);
      const guest = await request(app)
        .post("/api/slip/market-selection")
        .set("Cookie", guestCookie)
        .send(body);

      expect(guest.status).toEqual(401);
      expect(guest.body).toEqual({ message: "Sign in to add a market selection" });
      expect(guest.status).toEqual(anonymous.status);
      expect(guest.body).toEqual(anonymous.body);
      expect(await Slip.countDocuments({})).toEqual(0);
    });
  });
});

describe("claiming the guest slip on login", () => {
  const signedIn = { currentUser: currentUserHeader, Cookie: guestCookie };

  it("merges both bet kinds into the user's drafts and lets the guest win on the same market", async () => {
    const sharedOdds = preMatchRow("odds-shared");
    const guestShared = { ...sharedOdds, _id: new mongoose.Types.ObjectId() };
    const guestLiveReplacement = liveRow(1, "AWAY", 2.5);
    await createSlip({
      ownerId: userId,
      rows: [preMatchRow("odds-user"), sharedOdds],
    });
    await createSlip({
      ownerId: userId,
      betKind: BetKind.LIVE,
      rows: [liveRow(1, "HOME", 1.5), liveRow(2)],
    });
    await createSlip({
      ownerId: guestPrincipal,
      rows: [guestShared, preMatchRow("odds-guest")],
    });
    await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [guestLiveReplacement, liveRow(3)],
    });

    const response = await getBoards(signedIn).expect(200);

    expect(oddsIdsOf(response.body.PRE_MATCH).sort()).toEqual([
      "odds-guest",
      "odds-shared",
      "odds-user",
    ]);
    expect(
      response.body.PRE_MATCH.rows.find(
        (row: { oddsId: string }) => row.oddsId === "odds-shared"
      )._id
    ).toEqual(sharedOdds._id.toString());
    const liveRows = response.body.LIVE.rows as Array<{
      _id: string;
      marketId: string;
      oddsValue: number;
      selectionId: string;
    }>;
    expect(liveRows.map((row) => row.marketId).sort()).toEqual([
      "event-live:MARKET_1",
      "event-live:MARKET_2",
      "event-live:MARKET_3",
    ]);
    expect(
      liveRows.find((row) => row.marketId === "event-live:MARKET_1")
    ).toMatchObject({
      _id: guestLiveReplacement._id.toString(),
      oddsValue: 2.5,
      selectionId: "event-live:MARKET_1:1:AWAY",
    });
    expect(response.body.PRE_MATCH.userId).toEqual(userId);
    expect(response.body.LIVE.userId).toEqual(userId);
    expect(await Slip.countDocuments({ userId: guestPrincipal })).toEqual(0);
    expect(await Slip.countDocuments({ userId })).toEqual(2);
    expect(guestCookieHeaders(response)).toEqual([clearedGuestCookie]);
  });

  it("moves a guest draft to a user without drafts and never gives the user's draft an expiry", async () => {
    const guestRows = [preMatchRow("odds-1"), preMatchRow("odds-2")];
    await createSlip({ ownerId: guestPrincipal, rows: guestRows });

    const response = await getBoards(signedIn).expect(200);

    expect(response.body.LIVE).toBeNull();
    expect(oddsIdsOf(response.body.PRE_MATCH)).toEqual(["odds-1", "odds-2"]);
    expect(
      response.body.PRE_MATCH.rows.map((row: { _id: string }) => row._id)
    ).toEqual(guestRows.map((row) => row._id.toString()));
    expect(response.body.PRE_MATCH.status).toEqual(SlipStatus.DRAFT);
    const stored = await Slip.collection
      .find({ userId })
      .toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toHaveProperty("guestExpiresAt");
    expect(await Slip.countDocuments({ userId: guestPrincipal })).toEqual(0);
    expect(guestCookieHeaders(response)).toEqual([clearedGuestCookie]);
  });

  it("adds the Secure attribute to the clearing cookie only behind https", async () => {
    await createSlip({ ownerId: guestPrincipal, rows: [preMatchRow()] });

    const secure = await getBoards({
      ...signedIn,
      "x-forwarded-proto": "https",
    }).expect(200);
    await createSlip({ ownerId: guestPrincipal, rows: [preMatchRow()] });
    const plain = await getBoards({
      ...signedIn,
      "x-forwarded-proto": "http",
    }).expect(200);

    expect(guestCookieHeaders(secure)).toEqual([
      "betstan_guest=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax",
    ]);
    expect(guestCookieHeaders(plain)).toEqual([clearedGuestCookie]);
  });

  it("skips a bet kind with a submitted board, leaves its guest draft and keeps the cookie", async () => {
    const submitted = await createSlip({
      ownerId: userId,
      status: SlipStatus.SUBMITTED,
      rows: [preMatchRow("odds-in-flight")],
    });
    const guestPreMatch = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-guest")],
    });
    await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [liveRow(1)],
    });
    const before = await Slip.findById(guestPreMatch.id).lean();

    const response = await getBoards(signedIn).expect(200);

    expect(response.body.PRE_MATCH._id).toEqual(submitted.id);
    expect(response.body.PRE_MATCH.status).toEqual(SlipStatus.SUBMITTED);
    expect(oddsIdsOf(response.body.PRE_MATCH)).toEqual(["odds-in-flight"]);
    expect(response.body.LIVE.rows).toHaveLength(1);
    expect(
      await Slip.countDocuments({
        userId,
        status: SlipStatus.DRAFT,
        betKind: BetKind.PRE_MATCH,
      })
    ).toEqual(0);
    const untouched = await Slip.findById(guestPreMatch.id).lean();
    expect(untouched).toEqual(before);
    expect(
      await Slip.countDocuments({ userId: guestPrincipal, betKind: BetKind.LIVE })
    ).toEqual(0);
    expect(guestCookieHeaders(response)).toEqual([]);

    await Slip.deleteOne({ _id: submitted.id });
    const retried = await getBoards(signedIn).expect(200);

    expect(oddsIdsOf(retried.body.PRE_MATCH)).toEqual(["odds-guest"]);
    expect(retried.body.PRE_MATCH.status).toEqual(SlipStatus.DRAFT);
    expect(await Slip.countDocuments({ userId: guestPrincipal })).toEqual(0);
    expect(guestCookieHeaders(retried)).toEqual([clearedGuestCookie]);
  });

  it("also skips the bet kind when the user holds a draft next to the submitted board", async () => {
    const userDraft = await createSlip({
      ownerId: userId,
      rows: [preMatchRow("odds-user")],
    });
    await createSlip({
      ownerId: userId,
      status: SlipStatus.SUBMITTED,
      rows: [preMatchRow("odds-in-flight")],
    });
    const guestPreMatch = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-guest")],
    });
    const draftBefore = await Slip.findById(userDraft.id).lean();
    const guestBefore = await Slip.findById(guestPreMatch.id).lean();

    const response = await getBoards(signedIn).expect(200);

    expect(response.body.PRE_MATCH.status).toEqual(SlipStatus.SUBMITTED);
    expect(await Slip.findById(userDraft.id).lean()).toEqual(draftBefore);
    expect(await Slip.findById(guestPreMatch.id).lean()).toEqual(guestBefore);
    expect(guestCookieHeaders(response)).toEqual([]);
  });

  it("is idempotent: a repeated load changes nothing and still clears the cookie", async () => {
    await createSlip({
      ownerId: userId,
      rows: [preMatchRow("odds-user")],
    });
    await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-guest")],
    });
    await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [liveRow(1)],
    });

    const first = await getBoards(signedIn).expect(200);
    const second = await getBoards(signedIn).expect(200);

    expect(second.body).toEqual(first.body);
    expect(await Slip.countDocuments({ userId })).toEqual(2);
    expect(await Slip.countDocuments({ userId: guestPrincipal })).toEqual(0);
    expect(guestCookieHeaders(first)).toEqual([clearedGuestCookie]);
    expect(guestCookieHeaders(second)).toEqual([clearedGuestCookie]);
  });

  it("re-running a claim that stopped before deleting the guest draft yields the same boards", async () => {
    const mergedPreMatch = preMatchRow("odds-guest");
    const mergedLive = liveRow(1, "AWAY", 2.5);
    await createSlip({
      ownerId: userId,
      rows: [preMatchRow("odds-user"), mergedPreMatch],
    });
    await createSlip({
      ownerId: userId,
      betKind: BetKind.LIVE,
      rows: [mergedLive],
    });
    await createSlip({ ownerId: guestPrincipal, rows: [mergedPreMatch] });
    await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [mergedLive],
    });

    const response = await getBoards(signedIn).expect(200);

    expect(oddsIdsOf(response.body.PRE_MATCH).sort()).toEqual([
      "odds-guest",
      "odds-user",
    ]);
    expect(response.body.LIVE.rows).toHaveLength(1);
    expect(response.body.LIVE.rows[0]._id).toEqual(mergedLive._id.toString());
    expect(await Slip.countDocuments({ userId: guestPrincipal })).toEqual(0);
    expect(guestCookieHeaders(response)).toEqual([clearedGuestCookie]);
  });

  it("copes with simultaneous loads of the same signed-in guest session", async () => {
    await Slip.collection.createIndex(SLIP_DRAFT_UNIQUE_INDEX_KEYS, {
      name: SLIP_DRAFT_UNIQUE_INDEX_NAME,
      unique: true,
      partialFilterExpression: SLIP_DRAFT_UNIQUE_INDEX_PARTIAL_FILTER,
    });
    await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-1"), preMatchRow("odds-2"), preMatchRow("odds-3")],
    });
    await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [liveRow(1), liveRow(2)],
    });

    const responses = await Promise.all([
      getBoards(signedIn),
      getBoards(signedIn),
      getBoards(signedIn),
    ]);

    for (const response of responses) {
      expect(response.status).toEqual(200);
    }
    const preMatchDrafts = await Slip.find({
      userId,
      status: SlipStatus.DRAFT,
      betKind: BetKind.PRE_MATCH,
    }).lean();
    const liveDrafts = await Slip.find({
      userId,
      status: SlipStatus.DRAFT,
      betKind: BetKind.LIVE,
    }).lean();
    expect(preMatchDrafts).toHaveLength(1);
    expect(oddsIdsOf(preMatchDrafts[0]).sort()).toEqual([
      "odds-1",
      "odds-2",
      "odds-3",
    ]);
    expect(liveDrafts).toHaveLength(1);
    expect(liveDrafts[0].rows).toHaveLength(2);
    expect(await Slip.countDocuments({ userId: guestPrincipal })).toEqual(0);
  });

  it("keeps a guest draft that changed while it was merged and claims it on the next load", async () => {
    const guestSlip = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-1")],
    });
    const lateRow = preMatchRow("odds-late");
    const realDeleteOne = Slip.deleteOne.bind(Slip);
    jest.spyOn(Slip, "deleteOne").mockImplementationOnce(((
      filter: Record<string, unknown>
    ) =>
      Slip.collection
        .updateOne(
          { _id: guestSlip._id },
          {
            $push: { rows: lateRow },
            $set: { boardRevision: 7, boardFingerprint: "late-click" },
          } as never
        )
        .then(() => realDeleteOne(filter))) as never);

    const first = await getBoards(signedIn).expect(200);

    expect(oddsIdsOf(first.body.PRE_MATCH)).toEqual(["odds-1"]);
    const kept = await Slip.findById(guestSlip.id).lean();
    expect(oddsIdsOf(kept!).sort()).toEqual(["odds-1", "odds-late"]);
    expect(guestCookieHeaders(first)).toEqual([]);

    const second = await getBoards(signedIn).expect(200);

    expect(oddsIdsOf(second.body.PRE_MATCH).sort()).toEqual([
      "odds-1",
      "odds-late",
    ]);
    expect(await Slip.countDocuments({ userId: guestPrincipal })).toEqual(0);
    expect(guestCookieHeaders(second)).toEqual([clearedGuestCookie]);
  });

  it("clears a stale guest cookie when nothing is left to claim", async () => {
    await createSlip({ ownerId: userId, rows: [preMatchRow("odds-user")] });

    const response = await getBoards(signedIn).expect(200);

    expect(oddsIdsOf(response.body.PRE_MATCH)).toEqual(["odds-user"]);
    expect(guestCookieHeaders(response)).toEqual([clearedGuestCookie]);
  });

  it("does nothing without a guest cookie", async () => {
    const userSlip = await createSlip({
      ownerId: userId,
      rows: [preMatchRow("odds-user")],
    });
    const guestSlip = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-guest")],
    });

    const response = await getBoards({ currentUser: currentUserHeader }).expect(
      200
    );

    expect(response.body.PRE_MATCH._id).toEqual(userSlip.id);
    expect(oddsIdsOf(response.body.PRE_MATCH)).toEqual(["odds-user"]);
    expect(await Slip.findById(guestSlip.id)).not.toBeNull();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("does nothing for a malformed guest cookie", async () => {
    const guestSlip = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-guest")],
    });

    const response = await getBoards({
      currentUser: currentUserHeader,
      Cookie: `betstan_guest=${guestId.toUpperCase()}`,
    }).expect(200);

    expect(response.body).toEqual({ PRE_MATCH: null, LIVE: null });
    expect(await Slip.findById(guestSlip.id)).not.toBeNull();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("serves the guest boards without claiming anything when only the guest cookie is present", async () => {
    const guestSlip = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-guest")],
    });

    const response = await getBoards({ Cookie: guestCookie }).expect(200);

    expect(response.body.PRE_MATCH._id).toEqual(guestSlip.id);
    expect(await Slip.countDocuments({ userId })).toEqual(0);
    expect(await Slip.findById(guestSlip.id)).not.toBeNull();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("never claims another guest's draft", async () => {
    const otherSlip = await createSlip({
      ownerId: otherGuestPrincipal,
      rows: [preMatchRow("odds-other")],
    });

    const response = await getBoards(signedIn).expect(200);

    expect(response.body).toEqual({ PRE_MATCH: null, LIVE: null });
    expect(await Slip.findById(otherSlip.id)).not.toBeNull();
    expect(await Slip.countDocuments({ userId })).toEqual(0);
  });

  it("still loads the signed-in boards when the claim fails and keeps the cookie", async () => {
    await createSlip({ ownerId: userId, rows: [preMatchRow("odds-user")] });
    const guestSlip = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-guest")],
    });
    jest
      .spyOn(Slip, "exists")
      .mockRejectedValueOnce(new Error("database unavailable"));
    const error = jest.spyOn(console, "error").mockImplementation(() => {});

    const response = await getBoards(signedIn).expect(200);

    expect(oddsIdsOf(response.body.PRE_MATCH)).toEqual(["odds-user"]);
    expect(await Slip.findById(guestSlip.id)).not.toBeNull();
    expect(guestCookieHeaders(response)).toEqual([]);
    expect(error).toHaveBeenCalledWith("slip_guest_claim_failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain(guestId);
    expect(JSON.stringify(error.mock.calls)).not.toContain(
      "database unavailable"
    );
  });
});

describe("guest identity in responses", () => {
  type CreatedSlip = Awaited<ReturnType<typeof createSlip>>;

  // Everything a page script or a proxy could read back from a response.
  const expectNoGuestIdentity = (response: request.Response) => {
    const wire = `${response.text}\n${JSON.stringify(response.headers)}`;

    expect(wire).not.toContain("guest:");
    expect(wire).not.toContain(guestId);
    expect(wire).not.toContain(guestId.toUpperCase());
    expect(wire).not.toContain(otherGuestId);
    expect(wire).not.toContain("guestExpiresAt");
    expect(response.text).not.toMatch(/[a-f0-9]{32}/);
  };

  const stored = async (slip: CreatedSlip) =>
    JSON.parse(
      JSON.stringify(await Slip.collection.findOne({ _id: slip._id }))
    );

  const withoutGuestFields = (storedSlip: Record<string, unknown>) => {
    const { userId: _principal, guestExpiresAt: _expiry, ...rest } = storedSlip;
    return rest;
  };

  it("omits the principal and the expiry from both boards and keeps every other field", async () => {
    const preMatch = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-a"), preMatchRow("odds-b")],
    });
    const live = await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [liveRow(1)],
    });
    await createSlip({ ownerId: otherGuestPrincipal, rows: [preMatchRow()] });
    await createSlip({ ownerId: userId, rows: [preMatchRow()] });

    const response = await getBoards({ Cookie: guestCookie }).expect(200);

    expect(oddsIdsOf(response.body.PRE_MATCH)).toEqual(["odds-a", "odds-b"]);
    expect(response.body.LIVE.rows).toHaveLength(1);
    for (const board of [response.body.PRE_MATCH, response.body.LIVE]) {
      expect(board).not.toHaveProperty("userId");
      expect(board).not.toHaveProperty("guestExpiresAt");
    }
    expectNoGuestIdentity(response);
    expect(response.body.PRE_MATCH).toEqual(
      withoutGuestFields(await stored(preMatch))
    );
    expect(response.body.LIVE).toEqual(withoutGuestFields(await stored(live)));
    // Only the copy sent to the page is redacted; the stored drafts keep both fields.
    expect(
      await Slip.collection.countDocuments({
        userId: guestPrincipal,
        guestExpiresAt: { $type: "date" },
      })
    ).toEqual(2);
  });

  it("omits them from the legacy slip route as well", async () => {
    const preMatch = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-a")],
    });

    const defaultKind = await request(app)
      .get("/api/slip")
      .set("Cookie", guestCookie)
      .expect(200);
    const emptyKind = await request(app)
      .get("/api/slip")
      .query({ betKind: BetKind.LIVE })
      .set("Cookie", guestCookie)
      .expect(200);
    const invalidKind = await request(app)
      .get("/api/slip")
      .query({ betKind: "NOPE" })
      .set("Cookie", guestCookie)
      .expect(400);

    expect(oddsIdsOf(defaultKind.body)).toEqual(["odds-a"]);
    expect(defaultKind.body).not.toHaveProperty("userId");
    expect(defaultKind.body).not.toHaveProperty("guestExpiresAt");
    expect(defaultKind.body).toEqual(withoutGuestFields(await stored(preMatch)));
    for (const response of [defaultKind, emptyKind, invalidKind]) {
      expectNoGuestIdentity(response);
    }
  });

  it("also hides them when the board is served from the document that was just read", async () => {
    const slip = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-a")],
    });
    // The authoritative refresh finds nothing, for instance after a concurrent
    // removal, so the route answers from the document it has already read.
    const refresh = jest
      .spyOn(Slip.collection, "findOneAndUpdate")
      .mockResolvedValue(null as never);

    const response = await getBoards({ Cookie: guestCookie }).expect(200);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(response.body.PRE_MATCH._id).toEqual(slip.id);
    expect(oddsIdsOf(response.body.PRE_MATCH)).toEqual(["odds-a"]);
    expect(response.body.PRE_MATCH.status).toEqual(SlipStatus.DRAFT);
    expect(response.body.PRE_MATCH).not.toHaveProperty("userId");
    expect(response.body.PRE_MATCH).not.toHaveProperty("guestExpiresAt");
    expectNoGuestIdentity(response);
  });

  it("never echoes the guest id from the row, clean and user-only routes", async () => {
    const dropped = preMatchRow("odds-dropped");
    const slip = await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-kept"), dropped],
    });
    const otherGuestSlip = await createSlip({
      ownerId: otherGuestPrincipal,
      rows: [preMatchRow()],
    });
    const post = (
      path: string,
      body: Record<string, unknown>,
      cookie = guestCookie
    ) => request(app).post(path).set("Cookie", cookie).send(body);
    const droppedRow = { slipId: slip.id, slipRowId: dropped._id.toString() };

    // Awaited in order: the later calls rely on what the earlier ones changed.
    const outcomes: Array<[request.Response, number]> = [
      [await post("/api/slip/row", droppedRow), 200],
      [await post("/api/slip/row", droppedRow), 200],
      [await post("/api/slip/row", { slipId: otherGuestSlip.id, slipRowId: "x" }), 400],
      [await post("/api/slip/row", { slipId: "nope", slipRowId: "x" }), 400],
      [await post("/api/slip/row", { ...droppedRow, betKind: "NOPE" }), 400],
      [
        await post("/api/slip/row", droppedRow, `betstan_guest=${guestId.toUpperCase()}`),
        400,
      ],
      [await post("/api/slip/row/clean", { slipId: otherGuestSlip.id }), 400],
      [await post("/api/slip/row/clean", { slipId: slip.id }), 200],
      [await post("/api/slip/row/clean", { slipId: slip.id }), 400],
      [
        await post("/api/slip/bet", {
          slipId: slip.id,
          wager: 5,
          expectedBoardRevision: slip.boardRevision,
          expectedBoardFingerprint: slip.boardFingerprint,
        }),
        400,
      ],
      [
        await post("/api/slip/market-selection", {
          quoteId: "quote-a",
          expectedBoardRevision: null,
          expectedBoardFingerprint: null,
        }),
        401,
      ],
    ];

    for (const [response, status] of outcomes) {
      expect(response.status).toEqual(status);
      expectNoGuestIdentity(response);
    }
  });

  it("leaves a signed-in user's boards exactly as stored, including their own id", async () => {
    const preMatch = await createSlip({
      ownerId: userId,
      rows: [preMatchRow("odds-a")],
    });
    const live = await createSlip({
      ownerId: userId,
      betKind: BetKind.LIVE,
      rows: [liveRow(1)],
    });

    const boards = await getBoards({ currentUser: currentUserHeader }).expect(200);
    const legacy = await request(app)
      .get("/api/slip")
      .set("currentUser", currentUserHeader)
      .expect(200);

    expect(boards.body.PRE_MATCH).toEqual(await stored(preMatch));
    expect(boards.body.LIVE).toEqual(await stored(live));
    expect(legacy.body).toEqual(await stored(preMatch));
    expect(boards.body.PRE_MATCH.userId).toEqual(userId);
    expect(boards.body.LIVE.userId).toEqual(userId);
    expect(legacy.body.userId).toEqual(userId);
  });

  it("does not echo the claimed guest id to the signed-in user either", async () => {
    await createSlip({ ownerId: userId, rows: [preMatchRow("odds-user")] });
    await createSlip({
      ownerId: guestPrincipal,
      rows: [preMatchRow("odds-guest")],
    });
    await createSlip({
      ownerId: guestPrincipal,
      betKind: BetKind.LIVE,
      rows: [liveRow(1)],
    });

    const response = await getBoards({
      currentUser: currentUserHeader,
      Cookie: guestCookie,
    }).expect(200);

    expect(oddsIdsOf(response.body.PRE_MATCH).sort()).toEqual([
      "odds-guest",
      "odds-user",
    ]);
    expect(response.body.LIVE.rows).toHaveLength(1);
    expect(response.body.PRE_MATCH.userId).toEqual(userId);
    expect(response.body.LIVE.userId).toEqual(userId);
    expect(guestCookieHeaders(response)).toEqual([clearedGuestCookie]);
    expectNoGuestIdentity(response);
  });
});
