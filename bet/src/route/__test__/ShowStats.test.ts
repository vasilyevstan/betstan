import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Bet } from "../../model/Bet";
import { BetStatus, SlipRowStatus } from "@betstan/common";

const createBet = async () => {
  const bet = new Bet({
    status: BetStatus.CONFIRMED,
    userId: new mongoose.Types.ObjectId().toHexString(),
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

it("returns all bets", async () => {
  await createBet();
  await createBet();

  const response = await request(app).get("/api/bet/stats").send().expect(200);

  expect(Array.isArray(response.body)).toBe(true);
  expect(response.body.length).toEqual(2);
});

it("returns empty array when no bets exist", async () => {
  const response = await request(app).get("/api/bet/stats").send().expect(200);

  expect(Array.isArray(response.body)).toBe(true);
  expect(response.body.length).toEqual(0);
});
