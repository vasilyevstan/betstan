import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Slip } from "../../model/Slip";
import { SlipStatus } from "@betstan/common";

const userId = new mongoose.Types.ObjectId().toHexString();

const createSlipWithRows = async (rowCount: number) => {
  const rows = Array.from({ length: rowCount }, () => ({
    eventId: new mongoose.Types.ObjectId().toHexString(),
    eventName: "Team A - Team B",
    oddsId: new mongoose.Types.ObjectId().toHexString(),
    oddsValue: 1.5,
    oddsName: "Team A",
    productName: "1X2",
    productId: new mongoose.Types.ObjectId().toHexString(),
    timestamp: new Date().toISOString(),
  }));

  const slip = new Slip({
    userId,
    status: SlipStatus.DRAFT,
    timestamp: new Date().toISOString(),
    rows,
  });
  await slip.save();
  return slip;
};

it("returns 400 when user is not authenticated", async () => {
  const slip = await createSlipWithRows(1);

  const response = await request(app)
    .post("/api/slip/row")
    .send({ slipId: slip.id, slipRowId: slip.rows[0]._id })
    .expect(400);

  expect(response.body.message).toEqual("must login first");
});

it("returns 400 when slip does not exist", async () => {
  const response = await request(app)
    .post("/api/slip/row")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send({ slipId: new mongoose.Types.ObjectId().toHexString(), slipRowId: "row-1" })
    .expect(400);

  expect(response.body.message).toEqual("slip does not exist");
});

it("deletes the slip when only one row remains", async () => {
  const slip = await createSlipWithRows(1);
  const rowId = (slip.rows[0] as any)._id.toString();

  await request(app)
    .post("/api/slip/row")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send({ slipId: slip.id, slipRowId: rowId })
    .expect(200);

  const deletedSlip = await Slip.findById(slip.id);
  expect(deletedSlip).toBeNull();
});

it("removes only the specified row when multiple rows exist", async () => {
  const slip = await createSlipWithRows(3);
  const rowToRemove = (slip.rows[0] as any)._id.toString();

  await request(app)
    .post("/api/slip/row")
    .set("currentUser", JSON.stringify({ id: userId, email: "test@test.com" }))
    .send({ slipId: slip.id, slipRowId: rowToRemove })
    .expect(200);

  const updatedSlip = await Slip.findById(slip.id);
  expect(updatedSlip!.rows.length).toEqual(2);
});
