import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Slip } from "../../model/Slip";
import { SlipStatus } from "@betstan/common";

const userId = new mongoose.Types.ObjectId().toHexString();

const createSlip = async () => {
  const slip = new Slip({
    userId,
    status: SlipStatus.DRAFT,
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
      },
    ],
  });
  await slip.save();
  return slip;
};

it("returns 400 when user is not authenticated", async () => {
  const slip = await createSlip();

  const response = await request(app)
    .post("/api/slip/row/clean")
    .send({ slipId: slip.id })
    .expect(400);

  expect(response.body.message).toEqual("must login first");
});

it("returns 400 when slip does not exist", async () => {
  const response = await request(app)
    .post("/api/slip/row/clean")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send({ slipId: new mongoose.Types.ObjectId().toHexString() })
    .expect(400);

  expect(response.body.message).toEqual("slip does not exist");
});

it("returns 500 when slip belongs to another user", async () => {
  const slip = await createSlip();
  const otherUserId = new mongoose.Types.ObjectId().toHexString();

  await request(app)
    .post("/api/slip/row/clean")
    .set("currentUser", JSON.stringify({ id: otherUserId, email: "other@test.com" }))
    .send({ slipId: slip.id })
    .expect(500);
});

it("deletes the slip on clean", async () => {
  const slip = await createSlip();

  await request(app)
    .post("/api/slip/row/clean")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send({ slipId: slip.id })
    .expect(200);

  const deletedSlip = await Slip.findById(slip.id);
  expect(deletedSlip).toBeNull();
});
