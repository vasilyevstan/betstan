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

const buildRow = ({
  betKind = BetKind.PRE_MATCH,
  includeBetKind = true,
}: {
  betKind?: BetKind;
  includeBetKind?: boolean;
} = {}) => {
  const row = {
    _id: new mongoose.Types.ObjectId(),
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
          marketId: "event-one:NEXT_CORNER",
          marketVersion: 1,
          quoteVersion: 1,
          selectionId: "event-one:NEXT_CORNER:1:HOME",
        }
      : {}),
  };

  return includeBetKind ? { ...row, betKind } : row;
};

const createSlip = async ({
  ownerId = userId,
  betKind = BetKind.PRE_MATCH,
  status = SlipStatus.DRAFT,
  sourceSlipId,
  rows = [buildRow({ betKind })],
}: {
  ownerId?: string;
  betKind?: BetKind;
  status?: SlipStatus;
  sourceSlipId?: string;
  rows?: Array<Record<string, unknown>>;
} = {}) => {
  const slip = new Slip({
    userId: ownerId,
    betKind,
    status,
    sourceSlipId,
    timestamp: new Date().toISOString(),
    submittedAt:
      status === SlipStatus.SUBMITTED ? new Date().toISOString() : undefined,
    rows,
  });
  await slip.save();
  return slip;
};

const insertLegacySlip = async ({
  ownerId = userId,
  status = SlipStatus.DRAFT,
  sourceSlipId,
}: {
  ownerId?: string;
  status?: SlipStatus;
  sourceSlipId?: string;
} = {}) => {
  const slipId = new mongoose.Types.ObjectId();

  await Slip.collection.insertOne({
    _id: slipId,
    userId: ownerId,
    status,
    sourceSlipId,
    timestamp: new Date().toISOString(),
    submittedAt:
      status === SlipStatus.SUBMITTED ? new Date().toISOString() : undefined,
    rows: [buildRow({ includeBetKind: false })],
  });

  return slipId.toHexString();
};

it("returns empty object when user is not authenticated", async () => {
  const response = await request(app).get("/api/slip").send().expect(200);

  expect(response.body).toEqual({});
});

it("returns anonymous board shape for the boards endpoint", async () => {
  const response = await request(app).get("/api/slip/boards").send().expect(200);

  expect(response.body).toEqual({
    PRE_MATCH: null,
    LIVE: null,
  });
});

it("keeps legacy /api/slip compatible by returning the PRE_MATCH draft by default", async () => {
  const preMatchSlip = await createSlip({ betKind: BetKind.PRE_MATCH });
  await createSlip({ betKind: BetKind.LIVE });
  await createSlip({ betKind: BetKind.PRE_MATCH, ownerId: otherUserId });

  const response = await request(app)
    .get("/api/slip")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(response.body).not.toBeNull();
  expect(response.body._id).toEqual(preMatchSlip.id);
  expect(response.body.userId).toEqual(userId);
  expect(response.body.status).toEqual(SlipStatus.DRAFT);
  expect(response.body.betKind).toEqual(BetKind.PRE_MATCH);
});

it("returns the requested LIVE draft board from the legacy route", async () => {
  const liveSlip = await createSlip({ betKind: BetKind.LIVE });

  const response = await request(app)
    .get("/api/slip")
    .query({ betKind: BetKind.LIVE })
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(response.body).not.toBeNull();
  expect(response.body._id).toEqual(liveSlip.id);
  expect(response.body.betKind).toEqual(BetKind.LIVE);
  expect(response.body.status).toEqual(SlipStatus.DRAFT);
});

it("returns a submitted board after refresh while the legacy route stays draft-only", async () => {
  const submittedSlip = await createSlip({ status: SlipStatus.SUBMITTED });

  const boardsResponse = await request(app)
    .get("/api/slip/boards")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(boardsResponse.body.PRE_MATCH._id).toEqual(submittedSlip.id);
  expect(boardsResponse.body.PRE_MATCH.status).toEqual(SlipStatus.SUBMITTED);
  expect(boardsResponse.body.PRE_MATCH.betKind).toEqual(BetKind.PRE_MATCH);
  expect(boardsResponse.body.LIVE).toBeNull();

  const legacyRouteResponse = await request(app)
    .get("/api/slip")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(legacyRouteResponse.body).toEqual({});
});

it("returns PRE_MATCH and LIVE boards independently", async () => {
  const submittedPreMatchSlip = await createSlip({
    betKind: BetKind.PRE_MATCH,
    status: SlipStatus.SUBMITTED,
  });
  const liveDraftSlip = await createSlip({ betKind: BetKind.LIVE });

  const response = await request(app)
    .get("/api/slip/boards")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(response.body.PRE_MATCH._id).toEqual(submittedPreMatchSlip.id);
  expect(response.body.PRE_MATCH.status).toEqual(SlipStatus.SUBMITTED);
  expect(response.body.LIVE._id).toEqual(liveDraftSlip.id);
  expect(response.body.LIVE.status).toEqual(SlipStatus.DRAFT);
});

it("prefers the linked replacement draft over its matching submitted attempt", async () => {
  const submittedSlip = await createSlip({
    betKind: BetKind.LIVE,
    status: SlipStatus.SUBMITTED,
  });
  const replacementDraft = await createSlip({
    betKind: BetKind.LIVE,
    sourceSlipId: submittedSlip.id,
  });

  const response = await request(app)
    .get("/api/slip/boards")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(response.body.LIVE._id).toEqual(replacementDraft.id);
  expect(response.body.LIVE.status).toEqual(SlipStatus.DRAFT);
  expect(response.body.LIVE.sourceSlipId).toEqual(submittedSlip.id);
});

it("normalizes legacy active PRE_MATCH boards without betKind", async () => {
  const legacySlipId = await insertLegacySlip({
    status: SlipStatus.SUBMITTED,
  });

  const response = await request(app)
    .get("/api/slip/boards")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(response.body.PRE_MATCH._id).toEqual(legacySlipId);
  expect(response.body.PRE_MATCH.status).toEqual(SlipStatus.SUBMITTED);
  expect(response.body.PRE_MATCH.betKind).toEqual(BetKind.PRE_MATCH);
  expect(response.body.PRE_MATCH.rows[0].betKind).toEqual(BetKind.PRE_MATCH);
  expect(response.body.LIVE).toBeNull();
});

it("prefers SUBMITTED when dual-state data is ambiguous", async () => {
  const submittedSlip = await createSlip({
    betKind: BetKind.PRE_MATCH,
    status: SlipStatus.SUBMITTED,
  });
  const ambiguousDraft = await createSlip({
    betKind: BetKind.PRE_MATCH,
    sourceSlipId: new mongoose.Types.ObjectId().toHexString(),
  });

  const boardsResponse = await request(app)
    .get("/api/slip/boards")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(boardsResponse.body.PRE_MATCH._id).toEqual(submittedSlip.id);
  expect(boardsResponse.body.PRE_MATCH.status).toEqual(SlipStatus.SUBMITTED);

  const legacyRouteResponse = await request(app)
    .get("/api/slip")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(legacyRouteResponse.body._id).toEqual(ambiguousDraft.id);
  expect(legacyRouteResponse.body.status).toEqual(SlipStatus.DRAFT);
});

it("does not expose another user's boards", async () => {
  await createSlip({
    ownerId: otherUserId,
    betKind: BetKind.LIVE,
    status: SlipStatus.SUBMITTED,
  });
  const ownDraft = await createSlip({
    ownerId: userId,
    betKind: BetKind.PRE_MATCH,
  });

  const response = await request(app)
    .get("/api/slip/boards")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(response.body.PRE_MATCH._id).toEqual(ownDraft.id);
  expect(response.body.PRE_MATCH.userId).toEqual(userId);
  expect(response.body.LIVE).toBeNull();
});

it("normalizes legacy draft documents without betKind for the legacy route", async () => {
  const legacySlipId = await insertLegacySlip();

  const legacyResponse = await request(app)
    .get("/api/slip")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(legacyResponse.body._id).toEqual(legacySlipId);
  expect(legacyResponse.body.betKind).toEqual(BetKind.PRE_MATCH);
  expect(legacyResponse.body.rows[0].betKind).toEqual(BetKind.PRE_MATCH);

  const boardsResponse = await request(app)
    .get("/api/slip/boards")
    .set("currentUser", currentUserHeader)
    .send()
    .expect(200);

  expect(boardsResponse.body.PRE_MATCH._id).toEqual(legacySlipId);
  expect(boardsResponse.body.PRE_MATCH.status).toEqual(SlipStatus.DRAFT);
  expect(boardsResponse.body.PRE_MATCH.betKind).toEqual(BetKind.PRE_MATCH);
  expect(boardsResponse.body.LIVE).toBeNull();
});
