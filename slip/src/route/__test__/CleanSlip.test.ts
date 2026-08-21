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

const createSlip = async (
  betKind: BetKind = BetKind.PRE_MATCH,
  ownerId: string = userId
) => {
  const slip = new Slip({
    userId: ownerId,
    betKind,
    status: SlipStatus.DRAFT,
    timestamp: new Date().toISOString(),
    rows: [buildRow(betKind)],
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
    .set("currentUser", currentUserHeader)
    .send({ slipId: new mongoose.Types.ObjectId().toHexString() })
    .expect(400);

  expect(response.body.message).toEqual("slip does not exist");
});

it("does not delete another user's board", async () => {
  const slip = await createSlip();

  await request(app)
    .post("/api/slip/row/clean")
    .set("currentUser", otherUserHeader)
    .send({ slipId: slip.id })
    .expect(400);

  expect(await Slip.findById(slip.id)).not.toBeNull();
});

it("does not delete a LIVE board when kind defaults to PRE_MATCH", async () => {
  const liveSlip = await createSlip(BetKind.LIVE);

  await request(app)
    .post("/api/slip/row/clean")
    .set("currentUser", currentUserHeader)
    .send({ slipId: liveSlip.id })
    .expect(400);

  expect(await Slip.findById(liveSlip.id)).not.toBeNull();
});

it("deletes the targeted LIVE board on clean", async () => {
  const liveSlip = await createSlip(BetKind.LIVE);

  await request(app)
    .post("/api/slip/row/clean")
    .set("currentUser", currentUserHeader)
    .send({ slipId: liveSlip.id, betKind: BetKind.LIVE })
    .expect(200);

  expect(await Slip.findById(liveSlip.id)).toBeNull();
});
