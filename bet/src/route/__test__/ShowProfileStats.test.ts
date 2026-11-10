import request from "supertest";
import express from "express";
import cookieSession from "cookie-session";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { BetKind, BetStatus, SlipRowStatus } from "@betstan/common";
import { app } from "../../app";
import { TeamSide } from "../../compat/LiveContract";
import { Bet } from "../../model/Bet";
import { createPublicUserKey } from "../../service/publicBetStats";
import { ShowProfileStats } from "../ShowProfileStats";

const owner = JSON.stringify({ id: "owner", timestamp: new Date().toISOString() });
const endpoint = "/api/bet/me/stats";
const from = "2026-03-28T22:00:00.000Z";
const toExclusive = "2026-03-29T21:00:00.000Z";
const actualCommon = jest.requireActual<typeof import("@betstan/common")>("@betstan/common");
const authenticatedApp = express();
authenticatedApp.use(cookieSession({ signed: false, secure: false }));
authenticatedApp.use(actualCommon.currentUser);
authenticatedApp.use(ShowProfileStats);

const row = (productName = "1X2") => ({
  id: "row", eventId: "event", eventName: "A - B", productId: "product",
  productName, oddsId: "home", oddsName: "A", oddsValue: 3,
  timestamp: "2026-04-01T12:00:00.000Z", status: SlipRowStatus.NOT_SETTLED,
});
const createBet = (overrides: Record<string, unknown> = {}) => Bet.create({
  userId: "owner", userName: "private-login@example.com", slipId: new Types.ObjectId().toHexString(),
  status: BetStatus.CONFIRMED, wager: 10, timestamp: "2026-03-29T12:00:00.000Z",
  rows: [row()],
  ...overrides,
});

afterEach(() => jest.restoreAllMocks());

it("returns exact private ticket counts and original non-void stakes across every status", async () => {
  for (const [status, wager] of [
    [BetStatus.PENDING, 99], [BetStatus.DECLINED, 98], [BetStatus.CONFIRMED, 0.1],
    [BetStatus.WIN, 0.2], [BetStatus.LOSS, 5], [BetStatus.VOID, 60], [BetStatus.CASH_BACK, 3.45],
  ] as const) {
    await createBet({ status, wager, betKind: BetKind.LIVE });
  }
  await createBet({ userId: "another-player", wager: 10000 });

  const response = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(response.body).toEqual({
    range: { from: null, toExclusive: null },
    acceptedBets: 5, wins: 1, losses: 1, openBets: 1, voidedBets: 1, cashBackBets: 1,
    pendingSubmissions: 1, declinedSubmissions: 1, totalStaked: "8.75",
    preMatchBets: 0, liveBets: 7, singleBets: 7, accumulatorBets: 0,
    favouriteMarket: { name: "1X2", selections: 7 },
    favouriteTeam: { name: "A", selections: 7 },
    bestWinningPick: null,
    recentResults: [
      { result: "LOSS", placedAt: "2026-03-29T12:00:00.000Z", selections: 1, eventName: "A - B", pick: "A" },
      { result: "WIN", placedAt: "2026-03-29T12:00:00.000Z", selections: 1, eventName: "A - B", pick: "A" },
    ],
    scoreboardRank: { position: 1, players: 2 },
  });
  expect(response.headers["cache-control"]).toBe("no-store");
  for (const privateValue of ["owner", "another-player", "private-login", "slipId", "rows", "_id"]) {
    expect(response.text).not.toContain(privateValue);
  }
});

it("counts an accumulator once and retains the original wager after partial cash back", async () => {
  const first = await createBet({ wager: 100, status: BetStatus.WIN });
  first.rows.push(first.rows[0]);
  first.cashBackFinancial = {
    revision: 3, status: BetStatus.WIN, originalStakeMinor: 10000, remainingStakeMinor: 6000,
    cumulativeClosedStakeMinor: 4000, cumulativeReturnMinor: 4500,
  };
  await first.save();
  const response = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(response.body).toMatchObject({ acceptedBets: 1, wins: 1, losses: 0, totalStaked: "100" });
});

it("summarises bet kinds, accumulators and the most-picked market across every submitted ticket", async () => {
  const legacy = await createBet({ status: BetStatus.PENDING, rows: [row("Correct Score")] });
  await Bet.collection.updateOne({ _id: legacy._id }, { $unset: { betKind: "" } });
  await createBet({ status: BetStatus.DECLINED, betKind: BetKind.LIVE, rows: [row("Next goal"), row("Correct Score")] });
  await createBet({ status: BetStatus.WIN, betKind: BetKind.PRE_MATCH, rows: [row("1X2"), row("Correct Score"), row("  ")] });
  await createBet({ userId: "another-player", rows: [row("1X2"), row("1X2"), row("1X2"), row("1X2")] });
  const response = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(response.body).toMatchObject({
    acceptedBets: 1, pendingSubmissions: 1, declinedSubmissions: 1,
    preMatchBets: 2, liveBets: 1, singleBets: 1, accumulatorBets: 2,
    favouriteMarket: { name: "Correct Score", selections: 3 },
  });
});

it("summarises recent results, the best winning pick and the favourite team within the period", async () => {
  const pick = (eventName: string, oddsName: string, oddsValue: number, status: SlipRowStatus, extra = {}) => ({
    ...row(), eventName, oddsName, oddsValue, status, ...extra,
  });
  const won = SlipRowStatus.WIN;
  const lost = SlipRowStatus.LOSS;
  await createBet({ status: BetStatus.WIN, timestamp: "2026-03-29T01:00:00.000Z",
    rows: [pick("Riverside - Lake Town", "Riverside", 2.5, won)] });
  // Chronologically oldest, but lexicographically after the 01:00Z ticket.
  await createBet({ status: BetStatus.LOSS, timestamp: "2026-03-29T05:00:00+05:00", rows: [
    pick("Riverside - Port Ada", "Next goal: home", 6.5, won, { side: TeamSide.HOME, productName: "NEXT_GOAL" }),
    pick("Lake Town - Hill", "draw", 3.2, lost),
  ] });
  await createBet({ timestamp: "2026-03-29T02:00:00.000Z", rows: [pick("Lake Town - Riverside", "Riverside", 2, won)] });
  await createBet({ status: BetStatus.DECLINED, rows: [pick("Lake Town - Hill", "Lake Town", 50, won)] });
  await createBet({ status: BetStatus.PENDING, rows: [pick("Hill - Bay", "Bay", 45, won)] });
  await createBet({ status: BetStatus.LOSS, timestamp: "2026-03-29T03:00:00.000Z",
    rows: [pick("Riverside - Lake Town", "1 - 0", 9, lost, { productName: "Correct Score" })] });
  await createBet({ status: BetStatus.WIN, timestamp: toExclusive, rows: [pick("Hill - Port Ada", "Hill", 20, won)] });
  await createBet({ userId: "another-player", status: BetStatus.WIN, rows: [
    pick("Hill - Port Ada", "Hill", 99, won), pick("Hill - Bay", "Hill", 2, won), pick("Hill - Cove", "Hill", 2, won),
  ] });

  const response = await request(app).get(endpoint).query({ from, toExclusive })
    .set("currentUser", owner).expect(200);
  expect(response.body).toMatchObject({
    favouriteTeam: { name: "Riverside", selections: 3 },
    bestWinningPick: { odds: 6.5, eventName: "Riverside - Port Ada", pick: "Next goal: home", market: "NEXT_GOAL" },
    recentResults: [
      { result: "LOSS", placedAt: "2026-03-29T03:00:00.000Z", selections: 1, eventName: "Riverside - Lake Town", pick: "1 - 0" },
      { result: "WIN", placedAt: "2026-03-29T01:00:00.000Z", selections: 1, eventName: "Riverside - Lake Town", pick: "Riverside" },
      { result: "LOSS", placedAt: "2026-03-29T00:00:00.000Z", selections: 2, eventName: null, pick: null },
    ],
  });
  const allTime = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(allTime.body.bestWinningPick).toMatchObject({ odds: 20, pick: "Hill" });
});

it("shows a favourite team only after a repeat pick and caps recent results", async () => {
  await createBet({ status: BetStatus.WIN, timestamp: "2026-03-28T09:00:00.000Z",
    rows: [{ ...row(), oddsName: "B", side: TeamSide.AWAY }] });
  const single = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(single.body.favouriteTeam).toBeNull();
  for (let hour = 10; hour < 15; hour++) {
    await createBet({ status: BetStatus.LOSS, timestamp: `2026-03-29T${hour}:00:00.000Z`,
      rows: [{ ...row(), oddsName: "draw", side: TeamSide.DRAW }] });
  }
  const response = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(response.body.favouriteTeam).toBeNull();
  for (const productName of ["NEXT_RED_CARD", "NEXT_YELLOW_CARD"]) {
    await createBet({ timestamp: "2026-03-28T08:00:00.000Z", rows: [{ ...row(productName), side: TeamSide.HOME }] });
  }
  await createBet({ timestamp: "2026-03-28T07:00:00.000Z",
    rows: [{ ...row("NEXT_CORNER"), oddsName: "Next corner: away", side: TeamSide.AWAY }] });
  const repeat = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(repeat.body.favouriteTeam).toEqual({ name: "B", selections: 2 });
  expect(response.body.recentResults.map(({ placedAt }: { placedAt: string }) => placedAt.slice(11, 13)))
    .toEqual(["14", "13", "12", "11", "10"]);
});

it("ranks the player in the public scoreboard order regardless of the selected period", async () => {
  const bets = async (userId: string, wagers: number[]) => {
    for (const wager of wagers) await createBet({ userId, wager, timestamp: "2026-01-01T00:00:00.000Z" });
  };
  await bets("owner", [10, 10]);
  await bets("alpha", [15, 5]);
  await bets("busy", [1, 1, 1]);
  await bets("quiet", [500]);
  await bets("zed", [30, 1]);
  await bets("aaa", [1, 1]);

  const response = await request(app).get(endpoint).query({ from, toExclusive })
    .set("currentUser", owner).expect(200);
  expect(response.body).toMatchObject({ acceptedBets: 0, scoreboardRank: { position: 4, players: 6 } });
  const board = await request(app).get("/api/bet/stats/v2").expect(200);
  expect(board.body.findIndex(({ userKey }: { userKey: string }) => userKey === createPublicUserKey("owner"))).toBe(3);

  const newcomer = JSON.stringify({ id: "newcomer", timestamp: new Date().toISOString() });
  const empty = await request(app).get(endpoint).set("currentUser", newcomer).expect(200);
  expect(empty.body.scoreboardRank).toBeNull();
});

it("includes legacy kinds and sub-cent wagers without floating-point addition", async () => {
  await createBet({ wager: 0.1 });
  await createBet({ wager: 0.2 });
  const legacy = await createBet({ wager: 0.001 });
  await Bet.collection.updateOne({ _id: legacy._id }, { $unset: { betKind: "" } });
  const response = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(response.body).toMatchObject({ acceptedBets: 3, totalStaked: "0.301" });
});

it("filters placement instants with inclusive start and exclusive end, including offset timestamps", async () => {
  await createBet({ timestamp: from, status: BetStatus.WIN, wager: 1 });
  await createBet({ timestamp: "2026-03-29T04:30:00+03:00", status: BetStatus.LOSS, wager: 2 });
  await createBet({ timestamp: toExclusive, wager: 50 });
  await createBet({ timestamp: "2026-03-28T21:59:59.999Z", wager: 50 });
  const response = await request(app).get(endpoint).query({ from, toExclusive })
    .set("currentUser", owner).expect(200);
  expect(response.body).toMatchObject({
    range: { from, toExclusive }, acceptedBets: 2, wins: 1, losses: 1, totalStaked: "3",
    favouriteMarket: { name: "1X2", selections: 2 },
  });
});

it("returns genuine zeros for empty history or a range without activity", async () => {
  const empty = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(empty.body).toMatchObject({
    acceptedBets: 0, pendingSubmissions: 0, totalStaked: "0",
    preMatchBets: 0, liveBets: 0, singleBets: 0, accumulatorBets: 0, favouriteMarket: null,
  });
  await createBet({ timestamp: toExclusive });
  const range = await request(app).get(endpoint).query({ from, toExclusive })
    .set("currentUser", owner).expect(200);
  expect(range.body).toMatchObject({ acceptedBets: 0, totalStaked: "0" });
});

it.each([
  { from }, { toExclusive }, { from: "invalid", toExclusive },
  { from: toExclusive, toExclusive: from }, { from, toExclusive: from },
  { from: "2026-02-30T00:00:00.000Z", toExclusive },
  { from: "2026-03-28T22:00:00Z", toExclusive },
  { from: [from, from], toExclusive }, { from: { $gte: from }, toExclusive },
  { userId: "another-player" },
])("rejects malformed or owner-selecting queries %p", async (query) => {
  await request(app).get(endpoint).query(query).set("currentUser", owner).expect(400);
});

it.each([
  undefined, { id: "owner" }, { id: "", timestamp: new Date() },
  { id: "owner", timestamp: new Date(Date.now() - 13 * 3600000) },
  { id: "owner", timestamp: new Date(Date.now() + 6 * 60000) },
])("rejects missing or stale identity %p", async (identity) => {
  const call = request(app).get(endpoint);
  if (identity) call.set("currentUser", JSON.stringify(identity));
  const response = await call.expect(401);
  expect(response.headers["cache-control"]).toBe("no-store");
});

it("verifies real session signatures and ignores a forged currentUser header", async () => {
  await createBet();
  await request(authenticatedApp).get(endpoint).set("currentUser", owner).expect(401);
  const payload = { id: "owner", email: "private-login", timestamp: new Date() };
  for (const validSignature of [false, true]) {
    const token = jwt.sign(payload, validSignature ? process.env.JWT_KEY! : "invalid-test-key");
    const cookie = `session=${Buffer.from(JSON.stringify({ jwt: token })).toString("base64")}`;
    await request(authenticatedApp).get(endpoint).set("Cookie", cookie)
      .expect(validSignature ? 200 : 401);
  }
});

it.each([0, -1, "invalid", null, NaN, Infinity])("reports an invalid contributing stake %p instead of zero", async (wager) => {
  const bet = await createBet();
  await Bet.collection.updateOne({ _id: bet._id }, { $set: { wager } });
  const log = jest.spyOn(console, "error").mockImplementation(() => {});
  const response = await request(app).get(endpoint).set("currentUser", owner).expect(503);
  expect(response.body.errors[0].code).toBe("PROFILE_STATS_UNAVAILABLE");
  expect(log).toHaveBeenCalledWith("bet_profile_stats_failed", { error: expect.any(String) });
});

it("does not silently exclude unassignable legacy placement dates", async () => {
  const bet = await createBet();
  await Bet.collection.updateOne({ _id: bet._id }, { $unset: { timestamp: "" } });
  await request(app).get(endpoint).set("currentUser", owner).expect(200);
  jest.spyOn(console, "error").mockImplementation(() => {});
  await request(app).get(endpoint).query({ from, toExclusive }).set("currentUser", owner).expect(503);
});

it("reports unknown statuses, unknown bet kinds and database failures without exposing private error text", async () => {
  const bet = await createBet();
  await Bet.collection.updateOne({ _id: bet._id }, { $set: { status: "UNKNOWN" } });
  jest.spyOn(console, "error").mockImplementation(() => {});
  await request(app).get(endpoint).set("currentUser", owner).expect(503);
  await Bet.collection.updateOne({ _id: bet._id }, { $set: { status: BetStatus.WIN, betKind: "UNKNOWN" } });
  await request(app).get(endpoint).set("currentUser", owner).expect(503);
  jest.spyOn(Bet, "aggregate").mockImplementationOnce(() => { throw new Error("private database detail"); });
  const response = await request(app).get(endpoint).set("currentUser", owner).expect(503);
  expect(response.text).not.toContain("private database detail");
});
