import request from "supertest";
import express from "express";
import cookieSession from "cookie-session";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { BetKind, BetStatus, SlipRowStatus } from "@betstan/common";
import { app } from "../../app";
import { Bet } from "../../model/Bet";
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

const createBet = (overrides: Record<string, unknown> = {}) => Bet.create({
  userId: "owner", userName: "private-login@example.com", slipId: new Types.ObjectId().toHexString(),
  status: BetStatus.CONFIRMED, wager: 10, timestamp: "2026-03-29T12:00:00.000Z",
  rows: [{
    id: "row", eventId: "event", eventName: "A - B", productId: "product",
    productName: "1X2", oddsId: "home", oddsName: "A", oddsValue: 3,
    timestamp: "2026-04-01T12:00:00.000Z", status: SlipRowStatus.NOT_SETTLED,
  }],
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
  });
});

it("returns genuine zeros for empty history or a range without activity", async () => {
  const empty = await request(app).get(endpoint).set("currentUser", owner).expect(200);
  expect(empty.body).toMatchObject({ acceptedBets: 0, pendingSubmissions: 0, totalStaked: "0" });
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

it("reports unknown statuses and database failures without exposing private error text", async () => {
  const bet = await createBet();
  await Bet.collection.updateOne({ _id: bet._id }, { $set: { status: "UNKNOWN" } });
  jest.spyOn(console, "error").mockImplementation(() => {});
  await request(app).get(endpoint).set("currentUser", owner).expect(503);
  jest.spyOn(Bet, "aggregate").mockImplementationOnce(() => { throw new Error("private database detail"); });
  const response = await request(app).get(endpoint).set("currentUser", owner).expect(503);
  expect(response.text).not.toContain("private database detail");
});
