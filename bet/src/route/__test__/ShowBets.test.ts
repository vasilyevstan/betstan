import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Bet } from "../../model/Bet";
import { BetStatus, SlipRowStatus } from "@betstan/common";

const createBet = async (userId: string) => {
  const bet = new Bet({
    status: BetStatus.CONFIRMED,
    userId,
    userName: "testuser",
    slipId: new mongoose.Types.ObjectId().toHexString(),
    wager: 5,
    timestamp: new Date().toISOString(),
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Team A",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        timestamp: new Date().toISOString(),
        status: SlipRowStatus.NOT_SETTLED,
        id: new mongoose.Types.ObjectId().toHexString(),
      },
    ],
  });
  await bet.save();
  return bet;
};

it("returns empty object when user is not authenticated", async () => {
  const response = await request(app).get("/api/bet").send().expect(200);

  expect(response.body).toEqual({});
});

it("returns bets for the current user when authenticated", async () => {
  const userId = new mongoose.Types.ObjectId().toHexString();
  await createBet(userId);
  await createBet(new mongoose.Types.ObjectId().toHexString());

  const response = await request(app)
    .get("/api/bet")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send()
    .expect(200);

  expect(Array.isArray(response.body)).toBe(true);
  expect(response.body.length).toEqual(1);
  expect(response.body[0].userId).toEqual(userId);
});
