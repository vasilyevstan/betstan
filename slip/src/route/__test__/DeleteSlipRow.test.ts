import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Slip } from "../../model/Slip";
import { BetKind, SlipStatus } from "@betstan/common";

const userId = new mongoose.Types.ObjectId().toHexString();
const otherUserId = new mongoose.Types.ObjectId().toHexString();
const currentUserHeader = JSON.stringify({
  id: userId,
  email: "test@test.com",
});
const otherUserHeader = JSON.stringify({
  id: otherUserId,
  email: "other@test.com",
});

const buildRow = (betKind: BetKind = BetKind.PRE_MATCH) => ({
  eventId: new mongoose.Types.ObjectId().toHexString(),
  eventName: "Team A - Team B",
  oddsId: new mongoose.Types.ObjectId().toHexString(),
  oddsValue: 1.5,
  oddsName: "Team A",
  productName: "1X2",
  productId: new mongoose.Types.ObjectId().toHexString(),
  timestamp: new Date().toISOString(),
  ...(betKind === BetKind.LIVE
    ? {
        betKind,
        marketId: "event-one:NEXT_CORNER",
        marketVersion: 1,
        quoteVersion: 1,
        selectionId: "event-one:NEXT_CORNER:1:HOME",
      }
    : { betKind }),
});

const createSlipWithRows = async (
  rowCount: number,
  betKind: BetKind = BetKind.PRE_MATCH,
  ownerId: string = userId
) => {
  const rows = Array.from({ length: rowCount }, () => buildRow(betKind));

  const slip = new Slip({
    userId: ownerId,
    betKind,
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
    .send({ slipId: slip.id, slipRowId: slip.rows[0].id })
    .expect(400);

  expect(response.body.message).toEqual("must login first");
});

it("returns 400 when slip does not exist", async () => {
  const response = await request(app)
    .post("/api/slip/row")
    .set("currentUser", currentUserHeader)
    .send({ slipId: new mongoose.Types.ObjectId().toHexString(), slipRowId: "row-1" })
    .expect(400);

  expect(response.body.message).toEqual("slip does not exist");
});

it("does not remove another user's board", async () => {
  const slip = await createSlipWithRows(1);

  await request(app)
    .post("/api/slip/row")
    .set("currentUser", otherUserHeader)
    .send({ slipId: slip.id, slipRowId: slip.rows[0].id })
    .expect(400);

  const untouchedSlip = await Slip.findById(slip.id);
  expect(untouchedSlip).not.toBeNull();
  expect(untouchedSlip!.rows.length).toEqual(1);
});

it("does not remove a LIVE board row when kind defaults to PRE_MATCH", async () => {
  const liveSlip = await createSlipWithRows(1, BetKind.LIVE);

  await request(app)
    .post("/api/slip/row")
    .set("currentUser", currentUserHeader)
    .send({ slipId: liveSlip.id, slipRowId: liveSlip.rows[0].id })
    .expect(400);

  const untouchedSlip = await Slip.findById(liveSlip.id);
  expect(untouchedSlip).not.toBeNull();
  expect(untouchedSlip!.rows.length).toEqual(1);
});

it("deletes the slip when only one row remains", async () => {
  const slip = await createSlipWithRows(1);

  await request(app)
    .post("/api/slip/row")
    .set("currentUser", currentUserHeader)
    .send({ slipId: slip.id, slipRowId: slip.rows[0].id })
    .expect(200);

  expect(await Slip.findById(slip.id)).toBeNull();
});

it("removes only the specified row from a LIVE board when multiple rows exist", async () => {
  const liveSlip = await createSlipWithRows(3, BetKind.LIVE);
  const rowToRemove = liveSlip.rows[0].id;
  const previousBoardRevision = liveSlip.boardRevision;
  const previousBoardFingerprint = liveSlip.boardFingerprint;

  await request(app)
    .post("/api/slip/row")
    .set("currentUser", currentUserHeader)
    .send({
      slipId: liveSlip.id,
      slipRowId: rowToRemove,
      betKind: BetKind.LIVE,
    })
    .expect(200);

  const updatedSlip = await Slip.findById(liveSlip.id);
  expect(updatedSlip!.rows.length).toEqual(2);
  expect(updatedSlip!.rows.find((row) => row.id === rowToRemove)).toBeUndefined();
  expect(updatedSlip!.boardRevision).toEqual(previousBoardRevision + 1);
  expect(updatedSlip!.boardFingerprint).not.toEqual(previousBoardFingerprint);
});
