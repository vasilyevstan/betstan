import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Slip } from "../../model/Slip";
import { SlipStatus } from "@betstan/common";

const userId = new mongoose.Types.ObjectId().toHexString();

const createDraftSlip = async () => {
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

it("returns empty object when user is not authenticated", async () => {
  const response = await request(app).get("/api/slip").send().expect(200);

  expect(response.body).toEqual({});
});

it("returns draft slip for current user", async () => {
  await createDraftSlip();

  const response = await request(app)
    .get("/api/slip")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send()
    .expect(200);

  expect(response.body).not.toBeNull();
  expect(response.body.userId).toEqual(userId);
  expect(response.body.status).toEqual(SlipStatus.DRAFT);
});
