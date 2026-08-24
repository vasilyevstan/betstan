import request from "supertest";
import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import { app } from "../../app";
import { Slip, SlipArchive } from "../../model/Slip";
import {
  BetKind,
  LiveMarketStatus,
  ModerationDeclineReason,
  ModerationStatus,
  SlipStatus,
  messengerWrapper,
} from "@betstan/common";
import PlaceBetEventPublisher from "../../event/publisher/PlaceBetEventPublisher";
import ModerationResultListener from "../../event/listener/ModerationResultListener";
import { SlipPublicationState } from "../../model/SlipPublicationState";

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

const buildRow = ({
  betKind = BetKind.PRE_MATCH,
  includeBetKind = true,
  oddsId = new mongoose.Types.ObjectId().toHexString(),
  oddsValue = 1.5,
  oddsName = "Team A",
  marketId = "event-one:NEXT_CORNER",
  marketVersion = 1,
  quoteVersion = 1,
  selectionId = "event-one:NEXT_CORNER:1:HOME",
}: {
  betKind?: BetKind;
  includeBetKind?: boolean;
  oddsId?: string;
  oddsValue?: number;
  oddsName?: string;
  marketId?: string;
  marketVersion?: number;
  quoteVersion?: number;
  selectionId?: string;
} = {}) => {
  const row = {
    _id: new mongoose.Types.ObjectId(),
    eventId: new mongoose.Types.ObjectId().toHexString(),
    eventName: "Team A - Team B",
    oddsId,
    oddsValue,
    oddsName,
    productName: "1X2",
    productId: new mongoose.Types.ObjectId().toHexString(),
    timestamp: new Date().toISOString(),
    ...(betKind === BetKind.LIVE
      ? {
          marketId,
          marketVersion,
          quoteVersion,
          selectionId,
        }
      : {}),
  };

  return includeBetKind ? { ...row, betKind } : row;
};

const createSlip = async ({
  ownerId = userId,
  betKind = BetKind.PRE_MATCH,
  status = SlipStatus.DRAFT,
  rows = [buildRow({ betKind })],
}: {
  ownerId?: string;
  betKind?: BetKind;
  status?: SlipStatus;
  rows?: Array<Record<string, unknown>>;
} = {}) => {
  const slip = new Slip({
    userId: ownerId,
    betKind,
    status,
    timestamp: new Date().toISOString(),
    submittedAt:
      status === SlipStatus.SUBMITTED ? new Date().toISOString() : undefined,
    rows,
  });
  await slip.save();
  return slip;
};

const buildMessage = (): ConsumeMessage => ({
  content: Buffer.alloc(5),
  fields: {
    consumerTag: "",
    deliveryTag: 0,
    redelivered: false,
    exchange: "",
    routingKey: "",
  },
  properties: {
    contentType: undefined,
    contentEncoding: undefined,
    headers: {},
    deliveryMode: undefined,
    priority: undefined,
    correlationId: undefined,
    replyTo: undefined,
    expiration: undefined,
    messageId: undefined,
    timestamp: undefined,
    type: undefined,
    userId: undefined,
    appId: undefined,
    clusterId: undefined,
  },
});

const declineSubmittedSlip = async (slipId: string, betKind: BetKind) => {
  const listener = new ModerationResultListener(messengerWrapper.connection);
  await listener.init();

  const submittedSlip = await Slip.findById(slipId);
  const affectedRow = submittedSlip!.rows[0];

  await listener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: {
        slipId,
        result: ModerationStatus.DECLINED,
        betKind,
        declineReason: ModerationDeclineReason.STALE_QUOTE,
        affectedRows: [
          {
            rowId: affectedRow.id,
            declineReason: ModerationDeclineReason.STALE_QUOTE,
            marketId: affectedRow.marketId ?? undefined,
            marketVersion: affectedRow.marketVersion ?? undefined,
            quoteVersion: (affectedRow.quoteVersion ?? 1) + 1,
            currentOdds: 2.1,
            marketStatus: LiveMarketStatus.OPEN,
            selectionId: affectedRow.selectionId ?? undefined,
          },
        ],
      },
    },
    buildMessage()
  );
};

const insertLegacyDraftSlip = async () => {
  const slipId = new mongoose.Types.ObjectId();
  const boardFingerprint = new mongoose.Types.ObjectId().toHexString();

  await Slip.collection.insertOne({
    _id: slipId,
    userId,
    status: SlipStatus.DRAFT,
    boardRevision: 1,
    boardFingerprint,
    timestamp: new Date().toISOString(),
    rows: [buildRow({ includeBetKind: false })],
  });

  return {
    slipId: slipId.toHexString(),
    expectedBoardRevision: 1,
    expectedBoardFingerprint: boardFingerprint,
  };
};

const insertUnversionedLegacyDraftSlip = async () => {
  const slipId = new mongoose.Types.ObjectId();

  await Slip.collection.insertOne({
    _id: slipId,
    userId,
    status: SlipStatus.DRAFT,
    timestamp: new Date().toISOString(),
    rows: [buildRow({ includeBetKind: false })],
  });

  return slipId.toHexString();
};

const buildPlacementAttemptId = (label: string) =>
  `placement-attempt-${label}`;

const getBoardConfirmation = (slip?: {
  boardRevision?: number | null;
  boardFingerprint?: string | null;
} | null) => ({
  expectedBoardRevision: slip?.boardRevision,
  expectedBoardFingerprint: slip?.boardFingerprint,
});

const placeBet = ({
  currentUser = currentUserHeader,
  slipId,
  wager,
  betKind,
  placementAttemptId,
  useHeaderAttemptId = false,
  expectedBoardRevision,
  expectedBoardFingerprint,
}: {
  currentUser?: string;
  slipId: string;
  wager: number;
  betKind?: BetKind;
  placementAttemptId?: string;
  useHeaderAttemptId?: boolean;
  expectedBoardRevision?: number | null;
  expectedBoardFingerprint?: string | null;
}) => {
  let requestBuilder = request(app).post("/api/slip/bet");

  if (currentUser) {
    requestBuilder = requestBuilder.set("currentUser", currentUser);
  }

  if (placementAttemptId && useHeaderAttemptId) {
    requestBuilder = requestBuilder.set(
      "x-placement-attempt-id",
      placementAttemptId
    );
  }

  return requestBuilder.send({
    slipId,
    wager,
    ...(betKind ? { betKind } : {}),
    ...(
      expectedBoardRevision && expectedBoardFingerprint
        ? {
            expectedBoardRevision,
            expectedBoardFingerprint,
          }
        : {}
    ),
    ...(!useHeaderAttemptId && placementAttemptId
      ? { placementAttemptId }
      : {}),
  });
};

it("returns 400 when user is not authenticated", async () => {
  const slip = await createSlip();
  const response = await request(app)
    .post("/api/slip/bet")
    .send({
      slipId: slip.id,
      wager: 5,
      ...getBoardConfirmation(slip),
    })
    .expect(400);

  expect(response.body.message).toEqual("must login first");
});

it("returns 400 when slip does not exist", async () => {
  const response = await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({ slipId: new mongoose.Types.ObjectId().toHexString(), wager: 5 })
    .expect(400);

  expect(response.body.message).toEqual("slip does not exist");
});

it("returns 400 when wager is invalid", async () => {
  const slip = await createSlip();

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({ slipId: slip.id, wager: -10 })
    .expect(400);
});

it("submits legacy PRE_MATCH slips without archiving them immediately", async () => {
  const legacyDraftSlip = await insertLegacyDraftSlip();

  const response = await placeBet({ ...legacyDraftSlip, wager: 5 }).expect(200);
  const { slipId } = legacyDraftSlip;

  expect(response.body._id).toEqual(slipId);
  expect(response.body.status).toEqual(SlipStatus.SUBMITTED);
  expect(response.body.publication.state).toEqual(SlipPublicationState.PUBLISHED);
  expect(response.body.submittedEvent.wager).toEqual(5);
  expect(response.body.submittedEvent.placementAttemptId).toEqual(
    response.body.placement.authoritativePlacementAttemptId
  );
  expect(response.body.placement).toEqual({
    requestedPlacementAttemptId: response.body.submittedEvent.placementAttemptId,
    authoritativePlacementAttemptId:
      response.body.submittedEvent.placementAttemptId,
    outcome: "accepted",
    isLegacyRequest: true,
  });
  expect(response.headers["x-placement-attempt-id"]).toEqual(
    response.body.submittedEvent.placementAttemptId
  );
  const submittedSlip = await Slip.findById(slipId);
  expect(submittedSlip).not.toBeNull();
  expect(submittedSlip!.status).toEqual(SlipStatus.SUBMITTED);
  expect(submittedSlip!.betKind).toEqual(BetKind.PRE_MATCH);
  expect(submittedSlip!.rows[0].betKind).toEqual(BetKind.PRE_MATCH);
  expect(submittedSlip!.submittedEvent?.placementAttemptId).toEqual(
    response.body.submittedEvent.placementAttemptId
  );
  expect(await SlipArchive.findById(slipId)).toBeNull();

  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        slipId,
        betKind: BetKind.PRE_MATCH,
        placementAttemptId: response.body.submittedEvent.placementAttemptId,
        rows: [expect.objectContaining({ betKind: BetKind.PRE_MATCH })],
      }),
    })
  );
});

it("lets a loaded legacy PRE_MATCH client submit only the board it fetched", async () => {
  const slipId = await insertUnversionedLegacyDraftSlip();

  const boardResponse = await request(app)
    .get("/api/slip")
    .set("currentUser", currentUserHeader)
    .expect(200);

  expect(boardResponse.body._id).toEqual(slipId);
  expect(boardResponse.body.boardRevision).toEqual(1);
  expect(boardResponse.body.boardFingerprint).toEqual(expect.any(String));

  const preparedSlip = await Slip.findById(slipId).lean();
  expect(preparedSlip!.boardRevision).toEqual(
    boardResponse.body.boardRevision
  );
  expect(preparedSlip!.boardFingerprint).toEqual(
    boardResponse.body.boardFingerprint
  );
  expect(preparedSlip!.legacyBoardRevision).toEqual(
    boardResponse.body.boardRevision
  );
  expect(preparedSlip!.legacyBoardFingerprint).toEqual(
    boardResponse.body.boardFingerprint
  );

  const placementResponse = await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({ slipId, wager: 5 })
    .expect(200);

  expect(placementResponse.body.status).toEqual(SlipStatus.SUBMITTED);
  expect(placementResponse.body.placement).toEqual(
    expect.objectContaining({
      outcome: "accepted",
      isLegacyRequest: true,
    })
  );
});

it.each([BetKind.PRE_MATCH, BetKind.LIVE])(
  "keeps the previously deployed boards client compatible for %s",
  async (betKind) => {
    const slip = await createSlip({ betKind });
    const boardResponse = await request(app)
      .get("/api/slip/boards")
      .set("currentUser", currentUserHeader)
      .expect(200);

    expect(boardResponse.body[betKind]._id).toEqual(slip.id);

    const placementResponse = await placeBet({
      slipId: slip.id,
      wager: 5,
      betKind,
      placementAttemptId: buildPlacementAttemptId(`rolling-${betKind}`),
    }).expect(200);

    expect(placementResponse.body.status).toEqual(SlipStatus.SUBMITTED);
    expect(placementResponse.body.placement).toEqual(
      expect.objectContaining({
        outcome: "accepted",
        isLegacyRequest: false,
      })
    );
  }
);

it("keeps a board loaded before the API rollout placeable after backfill", async () => {
  const slip = await createSlip({ betKind: BetKind.LIVE });
  await Slip.updateOne(
    { _id: slip.id },
    {
      $set: {
        legacyBoardRevision: slip.boardRevision,
        legacyBoardFingerprint: slip.boardFingerprint,
        legacyBoardConfirmedAt: new Date().toISOString(),
      },
    }
  );

  const placementResponse = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId: buildPlacementAttemptId("pre-rollout-live"),
  }).expect(200);

  expect(placementResponse.body.status).toEqual(SlipStatus.SUBMITTED);
  expect(placementResponse.body.placement.outcome).toEqual("accepted");
});

it("rejects a previously deployed boards client after its fetched board changes", async () => {
  const slip = await createSlip({ betKind: BetKind.LIVE });
  await request(app)
    .get("/api/slip/boards")
    .set("currentUser", currentUserHeader)
    .expect(200);

  await Slip.updateOne(
    { _id: slip.id },
    {
      $set: {
        rows: [
          ...slip.rows.map((row) => row.toObject()),
          buildRow({ betKind: BetKind.LIVE }),
        ],
        boardRevision: (slip.boardRevision ?? 1) + 1,
        boardFingerprint: new mongoose.Types.ObjectId().toHexString(),
      },
    }
  );

  const response = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId: buildPlacementAttemptId("rolling-stale-live"),
  }).expect(409);

  expect(response.body.reload).toEqual({
    required: true,
    reason: "board-mismatch",
  });
  expect((await Slip.findById(slip.id))!.status).toEqual(SlipStatus.DRAFT);
});

it("rejects a legacy PRE_MATCH placement when its fetched board changed", async () => {
  const slip = await createSlip();

  const boardResponse = await request(app)
    .get("/api/slip")
    .set("currentUser", currentUserHeader)
    .expect(200);
  const nextFingerprint = new mongoose.Types.ObjectId().toHexString();

  await Slip.updateOne(
    { _id: slip.id },
    {
      $set: {
        rows: [...slip.rows.map((row) => row.toObject()), buildRow()],
        boardRevision: boardResponse.body.boardRevision + 1,
        boardFingerprint: nextFingerprint,
      },
    }
  );

  const response = await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({ slipId: slip.id, wager: 5 })
    .expect(409);

  expect(response.body.reload).toEqual({
    required: true,
    reason: "board-mismatch",
  });
  expect(response.body.slip.boardFingerprint).toEqual(nextFingerprint);
  expect((await Slip.findById(slip.id))!.status).toEqual(SlipStatus.DRAFT);
  expect(
    PlaceBetEventPublisher.prototype.publishWithConfirm
  ).not.toHaveBeenCalled();
});

it("submitting the same attempt twice with the same payload is idempotent", async () => {
  const slip = await createSlip({ betKind: BetKind.LIVE });
  const placementAttemptId = buildPlacementAttemptId("same-attempt");

  await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId,
    ...getBoardConfirmation(slip),
  }).expect(200);

  const duplicateResponse = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId,
    ...getBoardConfirmation(slip),
  }).expect(200);

  expect(duplicateResponse.body._id).toEqual(slip.id);
  expect(duplicateResponse.body.status).toEqual(SlipStatus.SUBMITTED);
  expect(duplicateResponse.body.submittedEvent.wager).toEqual(5);
  expect(duplicateResponse.body.submittedEvent.placementAttemptId).toEqual(
    placementAttemptId
  );
  expect(duplicateResponse.body.placement).toEqual({
    requestedPlacementAttemptId: placementAttemptId,
    authoritativePlacementAttemptId: placementAttemptId,
    outcome: "idempotent",
    isLegacyRequest: false,
  });
  const submittedSlip = await Slip.findById(slip.id);
  expect(submittedSlip!.status).toEqual(SlipStatus.SUBMITTED);
  expect(submittedSlip!.submittedEvent?.placementAttemptId).toEqual(
    placementAttemptId
  );
  expect(await SlipArchive.findById(slip.id)).toBeNull();
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("rejects a conflicting payload for the same placement attempt", async () => {
  const slip = await createSlip({ betKind: BetKind.LIVE });
  const placementAttemptId = buildPlacementAttemptId("same-attempt-conflict");

  await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId,
    ...getBoardConfirmation(slip),
  }).expect(200);

  const response = await placeBet({
    slipId: slip.id,
    wager: 10,
    betKind: BetKind.LIVE,
    placementAttemptId,
    ...getBoardConfirmation(slip),
  }).expect(409);

  expect(response.body.message).toEqual(
    "placement attempt conflicts with submitted slip"
  );
  expect(response.body.slip._id).toEqual(slip.id);
  expect(response.body.slip.submittedEvent.wager).toEqual(5);
  expect(response.body.slip.submittedEvent.placementAttemptId).toEqual(
    placementAttemptId
  );
  expect(response.body.placement).toEqual({
    requestedPlacementAttemptId: placementAttemptId,
    authoritativePlacementAttemptId: placementAttemptId,
    outcome: "conflict",
    isLegacyRequest: false,
  });
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("rejects a different placement attempt even when the wager matches", async () => {
  const slip = await createSlip({ betKind: BetKind.LIVE });
  const winningAttemptId = buildPlacementAttemptId("winner");

  await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId: winningAttemptId,
    ...getBoardConfirmation(slip),
  }).expect(200);

  const response = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId: buildPlacementAttemptId("loser"),
    ...getBoardConfirmation(slip),
  }).expect(409);

  expect(response.body.message).toEqual(
    "slip already submitted by another placement attempt"
  );
  expect(response.body.slip._id).toEqual(slip.id);
  expect(response.body.slip.submittedEvent.wager).toEqual(5);
  expect(response.body.slip.submittedEvent.placementAttemptId).toEqual(
    winningAttemptId
  );
  expect(response.body.placement).toEqual({
    requestedPlacementAttemptId: buildPlacementAttemptId("loser"),
    authoritativePlacementAttemptId: winningAttemptId,
    outcome: "conflict",
    isLegacyRequest: false,
  });
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
});

it("treats retries without an explicit legacy placement attempt id as conflicts after a winner", async () => {
  const slip = await createSlip({ betKind: BetKind.LIVE });

  const firstResponse = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    ...getBoardConfirmation(slip),
  }).expect(200);

  const response = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    ...getBoardConfirmation(slip),
  }).expect(409);

  expect(response.body.message).toEqual(
    "slip already submitted by another placement attempt"
  );
  expect(response.body.slip.submittedEvent.placementAttemptId).toEqual(
    firstResponse.body.submittedEvent.placementAttemptId
  );
  expect(response.body.placement).toEqual({
    requestedPlacementAttemptId: null,
    authoritativePlacementAttemptId:
      firstResponse.body.submittedEvent.placementAttemptId,
    outcome: "conflict",
    isLegacyRequest: true,
  });
});

it("allows only one concurrent identical attempt to publish", async () => {
  const slip = await createSlip({ betKind: BetKind.LIVE });
  const placementAttemptId = buildPlacementAttemptId("concurrent-identical");

  const [firstResponse, secondResponse] = await Promise.all([
    placeBet({
      slipId: slip.id,
      wager: 5,
      betKind: BetKind.LIVE,
      placementAttemptId,
      ...getBoardConfirmation(slip),
    }),
    placeBet({
      slipId: slip.id,
      wager: 5,
      betKind: BetKind.LIVE,
      placementAttemptId,
      ...getBoardConfirmation(slip),
    }),
  ]);

  expect([firstResponse.status, secondResponse.status].sort()).toEqual([200, 200]);
  expect(firstResponse.body.submittedEvent.placementAttemptId).toEqual(
    placementAttemptId
  );
  expect(secondResponse.body.submittedEvent.placementAttemptId).toEqual(
    placementAttemptId
  );
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(1);
  expect((await Slip.findById(slip.id))!.status).toEqual(SlipStatus.SUBMITTED);
  expect((await Slip.findById(slip.id))!.submittedEvent?.placementAttemptId).toEqual(
    placementAttemptId
  );
});

it("maps simultaneous conflicting attempts to the persisted winning attempt across many runs", async () => {
  const publishWithConfirmMock =
    PlaceBetEventPublisher.prototype.publishWithConfirm as jest.Mock;

  for (let run = 0; run < 12; run += 1) {
    const slip = await createSlip({ betKind: BetKind.LIVE });
    const attempts = [
      {
        placementAttemptId: buildPlacementAttemptId(`run-${run}-one`),
        wager: 5,
      },
      {
        placementAttemptId: buildPlacementAttemptId(`run-${run}-two`),
        wager: 9,
      },
      {
        placementAttemptId: buildPlacementAttemptId(`run-${run}-three`),
        wager: 13,
      },
    ];

    const responses = await Promise.all(
      attempts.map(({ placementAttemptId, wager }) =>
        placeBet({
          slipId: slip.id,
          wager,
          betKind: BetKind.LIVE,
          placementAttemptId,
          ...getBoardConfirmation(slip),
        })
      )
    );

    const successResponses = responses.filter((response) => response.status === 200);
    const conflictResponses = responses.filter((response) => response.status === 409);

    expect(successResponses).toHaveLength(1);
    expect(conflictResponses).toHaveLength(attempts.length - 1);

    const winningResponse = successResponses[0];
    const winningAttemptId =
      winningResponse.body.submittedEvent.placementAttemptId;
    const winningAttempt = attempts.find(
      (attempt) => attempt.placementAttemptId === winningAttemptId
    );

    expect(winningAttempt).toBeDefined();
    expect(winningResponse.body.placement).toEqual({
      requestedPlacementAttemptId: winningAttemptId,
      authoritativePlacementAttemptId: winningAttemptId,
      outcome: "accepted",
      isLegacyRequest: false,
    });

    const storedSlip = await Slip.findById(slip.id);
    expect(storedSlip!.submittedEvent?.placementAttemptId).toEqual(winningAttemptId);
    expect(storedSlip!.submittedEvent?.wager).toEqual(winningAttempt!.wager);
    expect(storedSlip!.rows).toHaveLength(1);

    for (const conflictResponse of conflictResponses) {
      expect(conflictResponse.body.message).toEqual(
        "slip already submitted by another placement attempt"
      );
      expect(conflictResponse.body.slip._id).toEqual(slip.id);
      expect(conflictResponse.body.slip.submittedEvent.placementAttemptId).toEqual(
        winningAttemptId
      );
      expect(conflictResponse.body.slip.submittedEvent.wager).toEqual(
        winningAttempt!.wager
      );
      expect(conflictResponse.body.placement.authoritativePlacementAttemptId).toEqual(
        winningAttemptId
      );
      expect(conflictResponse.body.placement.outcome).toEqual("conflict");
      expect(conflictResponse.body.placement.isLegacyRequest).toEqual(false);
      expect(conflictResponse.body.placement.requestedPlacementAttemptId).not.toEqual(
        winningAttemptId
      );
    }
  }

  expect(publishWithConfirmMock).toHaveBeenCalledTimes(12);
});

it("returns a reload conflict when the confirmed board revision is stale", async () => {
  const slip = await createSlip({ betKind: BetKind.LIVE });
  const staleBoardConfirmation = getBoardConfirmation(slip);
  const nextBoardFingerprint = new mongoose.Types.ObjectId().toHexString();

  await Slip.updateOne(
    { _id: slip.id },
    {
      $set: {
        rows: [buildRow({ betKind: BetKind.LIVE }), buildRow({ betKind: BetKind.LIVE, marketId: 'event-two:NEXT_CORNER', selectionId: 'event-two:NEXT_CORNER:1:HOME' })],
        boardRevision: (slip.boardRevision ?? 1) + 1,
        boardFingerprint: nextBoardFingerprint,
      },
    }
  );

  const response = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    ...staleBoardConfirmation,
  }).expect(409);

  expect(response.body.message).toEqual(
    'This board changed before placement. Review the latest selections and try again.'
  );
  expect(response.body.reload).toEqual({
    required: true,
    reason: 'board-mismatch',
  });
  expect(response.body.slip._id).toEqual(slip.id);
  expect(response.body.slip.status).toEqual(SlipStatus.DRAFT);
  expect(response.body.slip.boardRevision).toEqual((slip.boardRevision ?? 1) + 1);
  expect(response.body.slip.boardFingerprint).toEqual(nextBoardFingerprint);
  expect(response.body.slip.rows).toHaveLength(2);
  expect((await Slip.findById(slip.id))!.status).toEqual(SlipStatus.DRAFT);
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("rejects slips that contain mixed bet kinds", async () => {
  const slip = await createSlip({
    betKind: BetKind.PRE_MATCH,
    rows: [buildRow({ betKind: BetKind.PRE_MATCH }), buildRow({ betKind: BetKind.LIVE })],
  });

  const response = await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({
      slipId: slip.id,
      wager: 5,
      ...getBoardConfirmation(slip),
    })
    .expect(400);

  expect(response.body.message).toEqual("slip contains mixed bet kinds");

  const untouchedSlip = await Slip.findById(slip.id);
  expect(untouchedSlip!.status).toEqual(SlipStatus.DRAFT);
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("does not submit a LIVE board when kind defaults to PRE_MATCH", async () => {
  const liveSlip = await createSlip({ betKind: BetKind.LIVE });

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({ slipId: liveSlip.id, wager: 5 })
    .expect(400);

  const untouchedSlip = await Slip.findById(liveSlip.id);
  expect(untouchedSlip!.status).toEqual(SlipStatus.DRAFT);
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).not.toHaveBeenCalled();
});

it("does not sweep unrelated COMPLETE slips into the archive", async () => {
  const completeSlip = await createSlip({
    ownerId: otherUserId,
    betKind: BetKind.PRE_MATCH,
    status: SlipStatus.COMPLETE,
  });
  const slip = await createSlip();

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({
      slipId: slip.id,
      wager: 5,
      ...getBoardConfirmation(slip),
    })
    .expect(200);

  expect(await Slip.findById(completeSlip.id)).not.toBeNull();
  expect(await SlipArchive.findById(completeSlip.id)).toBeNull();
});

it("restores a declined board under a new id and resubmits only the new attempt", async () => {
  const originalSlip = await createSlip({ betKind: BetKind.LIVE });

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({
      slipId: originalSlip.id,
      wager: 5,
      betKind: BetKind.LIVE,
      ...getBoardConfirmation(originalSlip),
    })
    .expect(200);

  await declineSubmittedSlip(originalSlip.id, BetKind.LIVE);

  const archivedDeclinedSlip = await SlipArchive.findById(originalSlip.id);
  const restoredDraft = await Slip.findOne({
    userId,
    betKind: BetKind.LIVE,
    status: SlipStatus.DRAFT,
    sourceSlipId: originalSlip.id,
  });

  expect(archivedDeclinedSlip).not.toBeNull();
  expect(restoredDraft).not.toBeNull();
  expect(restoredDraft!.id).not.toEqual(originalSlip.id);
  expect(archivedDeclinedSlip!.replacementSlipId).toEqual(restoredDraft!.id);

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({
      slipId: restoredDraft!.id,
      wager: 10,
      betKind: BetKind.LIVE,
      ...getBoardConfirmation(restoredDraft),
    })
    .expect(200);

  const resubmittedSlip = await Slip.findById(restoredDraft!.id);
  expect(resubmittedSlip!.status).toEqual(SlipStatus.SUBMITTED);
  expect(await Slip.findById(originalSlip.id)).toBeNull();
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledTimes(2);
  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenLastCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        slipId: restoredDraft!.id,
        betKind: BetKind.LIVE,
      }),
    })
  );
});

it("publishes the latest LIVE market version in the immutable submitted payload", async () => {
  const slip = await createSlip({
    betKind: BetKind.LIVE,
    rows: [
      buildRow({
        betKind: BetKind.LIVE,
        marketId: "event-one:NEXT_CORNER",
        marketVersion: 2,
        quoteVersion: 1,
        selectionId: "event-one:NEXT_CORNER:2:AWAY",
        oddsId: "version-two-odds",
        oddsValue: 2.2,
        oddsName: "Away",
      }),
    ],
  });

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", currentUserHeader)
    .send({
      slipId: slip.id,
      wager: 5,
      betKind: BetKind.LIVE,
      ...getBoardConfirmation(slip),
    })
    .expect(200);

  expect(PlaceBetEventPublisher.prototype.publishWithConfirm).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        slipId: slip.id,
        rows: [
          expect.objectContaining({
            marketId: "event-one:NEXT_CORNER",
            marketVersion: 2,
            quoteVersion: 1,
            selectionId: "event-one:NEXT_CORNER:2:AWAY",
            oddsId: "version-two-odds",
          }),
        ],
      }),
    })
  );

  const submittedSlip = await Slip.findById(slip.id);
  expect(submittedSlip!.submittedEvent?.rows[0].marketVersion).toEqual(2);
  expect(submittedSlip!.submittedEvent?.rows[0].selectionId).toEqual(
    "event-one:NEXT_CORNER:2:AWAY"
  );
});

it("keeps the board submitted and pending when publish confirm fails", async () => {
  const publishWithConfirmMock =
    PlaceBetEventPublisher.prototype.publishWithConfirm as jest.Mock;
  publishWithConfirmMock.mockRejectedValueOnce(new Error("confirm failed"));

  const slip = await createSlip({ betKind: BetKind.LIVE });
  const placementAttemptId = buildPlacementAttemptId("confirm-failure");

  const failedResponse = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId,
    ...getBoardConfirmation(slip),
  }).expect(200);

  expect(failedResponse.body._id).toEqual(slip.id);
  expect(failedResponse.body.status).toEqual(SlipStatus.SUBMITTED);
  expect(failedResponse.body.publication.state).toEqual(SlipPublicationState.PENDING);
  expect(failedResponse.body.publication.attemptCount).toEqual(1);
  expect(failedResponse.body.publication.lastError).toEqual("confirm failed");
  expect(failedResponse.body.submittedEvent.placementAttemptId).toEqual(
    placementAttemptId
  );
  expect(failedResponse.body.submittedEvent.submittedAt).toEqual(
    failedResponse.body.submittedAt
  );

  const pendingSlip = await Slip.findById(slip.id);
  expect(pendingSlip!.status).toEqual(SlipStatus.SUBMITTED);
  expect(pendingSlip!.publication?.state).toEqual(SlipPublicationState.PENDING);
  expect(pendingSlip!.publication?.attemptCount).toEqual(1);
  expect(pendingSlip!.submittedEvent?.placementAttemptId).toEqual(
    placementAttemptId
  );
  expect(pendingSlip!.submittedEvent?.submittedAt).toEqual(
    pendingSlip!.submittedAt
  );
  expect(publishWithConfirmMock).toHaveBeenCalledTimes(1);
  expect(publishWithConfirmMock).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        slipId: slip.id,
        placementAttemptId,
        submittedAt: pendingSlip!.submittedAt,
      }),
    })
  );

  const duplicateResponse = await placeBet({
    slipId: slip.id,
    wager: 5,
    betKind: BetKind.LIVE,
    placementAttemptId,
    ...getBoardConfirmation(slip),
  }).expect(200);

  expect(duplicateResponse.body.placement).toEqual({
    requestedPlacementAttemptId: placementAttemptId,
    authoritativePlacementAttemptId: placementAttemptId,
    outcome: "idempotent",
    isLegacyRequest: false,
  });
  expect(publishWithConfirmMock).toHaveBeenCalledTimes(1);
});

it("does not submit another user's board or mutate the caller's sibling board", async () => {
  const foreignSlip = await createSlip({ ownerId: otherUserId, betKind: BetKind.PRE_MATCH });
  const siblingLiveSlip = await createSlip({ ownerId: userId, betKind: BetKind.LIVE });

  await request(app)
    .post("/api/slip/bet")
    .set("currentUser", otherUserHeader)
    .send({
      slipId: foreignSlip.id,
      wager: 5,
      ...getBoardConfirmation(foreignSlip),
    })
    .expect(200);

  const unauthorizedResponse = await placeBet({
    slipId: foreignSlip.id,
    wager: 5,
  }).expect(400);

  expect((await Slip.findById(foreignSlip.id))!.status).toEqual(SlipStatus.SUBMITTED);
  expect((await Slip.findById(siblingLiveSlip.id))!.status).toEqual(SlipStatus.DRAFT);
  expect(unauthorizedResponse.body.message).toEqual("slip does not exist");
  expect(unauthorizedResponse.body.slip).toBeUndefined();
  expect(unauthorizedResponse.headers["x-placement-attempt-id"]).toBeUndefined();
});
