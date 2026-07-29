import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Slip, SlipArchive } from "../../model/Slip";
import { SlipStatus, messengerWrapper } from "@betstan/common";
import PlaceBetEventPublisher from "../../event/publisher/PlaceBetEventPublisher";

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
    .post("/api/slip/bet")
    .send({ slipId: slip.id, wager: 5 })
    .expect(400);

  expect(response.body.message).toEqual("must login first");
});

it("returns 400 when slip does not exist", async () => {
  const response = await request(app)
    .post("/api/slip/bet")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send({ slipId: new mongoose.Types.ObjectId().toHexString(), wager: 5 })
    .expect(400);

  expect(response.body.message).toEqual("slip does not exist");
});

it("returns 400 when wager is invalid", async () => {
  const slip = await createSlip();

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send({ slipId: slip.id, wager: -10 })
    .expect(400);
});

it("places bet successfully and archives the slip", async () => {
  const slip = await createSlip();

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send({ slipId: slip.id, wager: 5 })
    .expect(200);

  const activeSlip = await Slip.findById(slip.id);
  expect(activeSlip).toBeNull();

  const archivedSlip = await SlipArchive.findOne({ userId });
  expect(archivedSlip).not.toBeNull();

  expect(PlaceBetEventPublisher.prototype.publish).toHaveBeenCalledTimes(1);
});
