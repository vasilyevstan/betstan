import mongoose from "mongoose";
import {
  BetKind,
  LiveMarketStatus,
  LiveMarketType,
  ModerationDeclineReason,
  SlipStatus,
  TeamSide,
} from "@betstan/common";
import { Slip, SlipArchive } from "../Slip";
import { SlipPublicationState } from "../SlipPublicationState";
import {
  applyAffectedRows,
  buildBetKindScope,
  buildLegacyPlacementAttemptId,
  buildSlipScope,
  clearSlipDeclineReason,
  clearSlipDeclineState,
  clearSubmittedAttemptState,
  createPlacementAttemptId,
  findActiveSlipForUser,
  findAnyArchivedOrActiveSlipById,
  isDuplicateKeyError,
  isValidSlipId,
  normalizeBetKind,
  normalizePlainSlip,
  normalizeSlip,
  parsePlacementAttemptId,
  parseRequestedBetKind,
  rowIdOf,
  selectActiveSlip,
  slipHasMixedBetKinds,
  slipIdOf,
  submissionMatchesPlacementAttempt,
  submissionMatchesPlacementPayload,
  submissionMatchesWager,
  submittedPlacementAttemptIdOf,
  submittedWagerOf,
  toPlaceBetRows,
  toPlainSlip,
  toPublishedSubmittedEventData,
  upsertDraftSlipRow,
} from "../slipSupport";

const buildRow = ({
  id = new mongoose.Types.ObjectId().toHexString(),
  betKind = BetKind.PRE_MATCH,
  marketId,
  marketVersion,
  quoteVersion,
  selectionId,
  eventTime,
  marketType,
  side,
  selectedAt,
  quoteValidUntil,
}: {
  id?: string;
  betKind?: BetKind;
  marketId?: string;
  marketVersion?: number;
  quoteVersion?: number;
  selectionId?: string;
  eventTime?: string;
  marketType?: LiveMarketType;
  side?: TeamSide;
  selectedAt?: string;
  quoteValidUntil?: string;
} = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  eventId: new mongoose.Types.ObjectId().toHexString(),
  eventName: "Derby",
  oddsId: `${id}-odds`,
  oddsValue: 2.25,
  oddsName: "Home",
  productName: "1X2",
  productId: new mongoose.Types.ObjectId().toHexString(),
  timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
  betKind,
  marketId,
  marketVersion,
  quoteVersion,
  selectionId,
  eventTime,
  marketType,
  side,
  selectedAt,
  quoteValidUntil,
});

describe("slipSupport", () => {
  it("parses placement attempts, bet kinds, ids, and duplicate-key errors defensively", () => {
    expect(parsePlacementAttemptId("  attempt-1  ")).toBe("attempt-1");
    expect(parsePlacementAttemptId("")).toBeNull();
    expect(parsePlacementAttemptId(" ".repeat(201))).toBeNull();
    expect(parsePlacementAttemptId(5)).toBeNull();

    expect(parseRequestedBetKind(undefined)).toBe(BetKind.PRE_MATCH);
    expect(parseRequestedBetKind(null)).toBe(BetKind.PRE_MATCH);
    expect(parseRequestedBetKind("")).toBe(BetKind.PRE_MATCH);
    expect(parseRequestedBetKind(BetKind.LIVE)).toBe(BetKind.LIVE);
    expect(parseRequestedBetKind("INVALID")).toBeNull();

    const slipId = new mongoose.Types.ObjectId().toHexString();
    expect(isValidSlipId(slipId)).toBe(true);
    expect(isValidSlipId("not-an-id")).toBe(false);

    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError({ code: 1 })).toBe(false);
    expect(isDuplicateKeyError({})).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);

    expect(normalizeBetKind(BetKind.LIVE)).toBe(BetKind.LIVE);
    expect(normalizeBetKind(undefined)).toBe(BetKind.PRE_MATCH);
    expect(createPlacementAttemptId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("builds query scopes and resolves active or archived slips by id", async () => {
    const activeSlip = await Slip.create({
      userId: "active-user",
      status: SlipStatus.DRAFT,
      betKind: BetKind.LIVE,
      draftKey: BetKind.LIVE,
      timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
      rows: [buildRow({ betKind: BetKind.LIVE, marketId: "market-a" })],
    });
    const archivedId = new mongoose.Types.ObjectId();
    await SlipArchive.create({
      _id: archivedId,
      userId: "archived-user",
      status: SlipStatus.COMPLETE,
      timestamp: new Date("2025-01-01T12:05:00.000Z").toISOString(),
      rows: [buildRow()],
    });

    expect(buildBetKindScope(BetKind.LIVE)).toEqual({ betKind: BetKind.LIVE });
    expect(buildBetKindScope(BetKind.PRE_MATCH)).toEqual({
      $or: [
        { betKind: BetKind.PRE_MATCH },
        { betKind: { $exists: false } },
        { betKind: null },
      ],
    });
    expect(buildSlipScope(SlipStatus.DRAFT, BetKind.LIVE)).toEqual({
      status: SlipStatus.DRAFT,
      betKind: BetKind.LIVE,
    });
    expect(
      buildSlipScope(
        SlipStatus.SUBMITTED,
        BetKind.PRE_MATCH,
        "user-1",
        activeSlip.id
      )
    ).toEqual({
      status: SlipStatus.SUBMITTED,
      $or: [
        { betKind: BetKind.PRE_MATCH },
        { betKind: { $exists: false } },
        { betKind: null },
      ],
      userId: "user-1",
      _id: activeSlip.id,
    });

    expect(await findAnyArchivedOrActiveSlipById(activeSlip.id)).toMatchObject({
      id: activeSlip.id,
    });
    expect(
      (await findAnyArchivedOrActiveSlipById(archivedId.toHexString()))?.id
    ).toBe(archivedId.toHexString());
    expect(
      await findAnyArchivedOrActiveSlipById(
        new mongoose.Types.ObjectId().toHexString()
      )
    ).toBeNull();
  });

  it("normalizes slips, row ids, precedence, decline state, and affected rows", async () => {
    const rowWithoutKind: Record<string, unknown> = {
      ...buildRow({ betKind: BetKind.PRE_MATCH }),
      betKind: undefined,
    };
    const rowWithKind = buildRow({ betKind: BetKind.LIVE, marketId: "market-a" });
    const mutableSlip: any = {
      betKind: undefined,
      rows: [rowWithoutKind, rowWithKind],
      set: jest.fn(function (key: string, value: unknown) {
        this[key] = value;
      }),
      declineReason: ModerationDeclineReason.STALE_QUOTE,
    };

    expect(normalizeSlip(mutableSlip, BetKind.PRE_MATCH)).toBe(
      BetKind.PRE_MATCH
    );
    expect(mutableSlip.set).toHaveBeenCalledWith("betKind", BetKind.PRE_MATCH);
    expect(mutableSlip.set).toHaveBeenCalledWith("draftKey", BetKind.PRE_MATCH);
    expect(rowWithoutKind.betKind).toBe(BetKind.PRE_MATCH);
    expect(rowWithKind.betKind).toBe(BetKind.LIVE);

    const plainSlip = normalizePlainSlip(
      {
        _id: new mongoose.Types.ObjectId(),
        userId: "plain-user",
        status: SlipStatus.DRAFT,
        timestamp: new Date().toISOString(),
        rows: [
          { ...buildRow({ betKind: BetKind.PRE_MATCH }), betKind: undefined },
          buildRow({ betKind: BetKind.LIVE, marketId: "market-live" }),
        ],
      },
      BetKind.PRE_MATCH
    );
    expect(plainSlip.betKind).toBe(BetKind.PRE_MATCH);
    expect(plainSlip.draftKey).toBe(BetKind.PRE_MATCH);
    expect(plainSlip.rows[0].betKind).toBe(BetKind.PRE_MATCH);
    expect(plainSlip.rows[1].betKind).toBe(BetKind.LIVE);

    const submittedId = new mongoose.Types.ObjectId().toHexString();
    const matchingDraft = {
      id: "draft-1",
      sourceSlipId: submittedId,
      rows: [],
    } as any;
    const submittedSlip = { _id: submittedId, rows: [] } as any;
    const mismatchedDraft = {
      id: "draft-2",
      sourceSlipId: "different-source",
      rows: [],
    } as any;
    expect(selectActiveSlip(matchingDraft, submittedSlip)).toBe(matchingDraft);
    expect(selectActiveSlip(mismatchedDraft, submittedSlip)).toBe(submittedSlip);
    expect(selectActiveSlip(null, submittedSlip)).toBe(submittedSlip);
    expect(selectActiveSlip(matchingDraft, null)).toBe(matchingDraft);
    expect(selectActiveSlip(null, null)).toBeNull();

    const rowWithId = { ...buildRow(), id: "row-id-1" } as any;
    const rowWithObjectId = { ...buildRow() } as any;
    const rowWithoutId = { ...buildRow(), _id: undefined, id: undefined } as any;
    expect(slipIdOf(null)).toBeNull();
    expect(slipIdOf({ id: "slip-id-1" })).toBe("slip-id-1");
    expect(
      slipIdOf({ _id: new mongoose.Types.ObjectId("507f191e810c19729de860ea") })
    ).toBe("507f191e810c19729de860ea");
    expect(rowIdOf(rowWithId)).toBe("row-id-1");
    expect(rowIdOf(rowWithObjectId)).toBe(rowWithObjectId._id.toString());
    expect(rowIdOf(rowWithoutId)).toBeNull();

    expect(
      slipHasMixedBetKinds(
        {
          betKind: BetKind.PRE_MATCH,
          rows: [
            buildRow({ betKind: BetKind.PRE_MATCH }),
            buildRow({ betKind: BetKind.LIVE, marketId: "market-b" }),
          ],
        } as any
      )
    ).toBe(true);
    expect(
      slipHasMixedBetKinds(
        {
          betKind: BetKind.PRE_MATCH,
          rows: [
            { ...buildRow({ betKind: BetKind.PRE_MATCH }), betKind: undefined },
            buildRow({ betKind: BetKind.PRE_MATCH }),
          ],
        } as any,
        BetKind.PRE_MATCH
      )
    ).toBe(false);

    const slipForModeration: any = {
      declineReason: ModerationDeclineReason.STALE_QUOTE,
      rows: [rowWithId, rowWithoutId],
    };
    applyAffectedRows(slipForModeration, [
      {
        rowId: "row-id-1",
        declineReason: ModerationDeclineReason.STALE_QUOTE,
        currentOdds: 2.6,
        marketStatus: LiveMarketStatus.OPEN,
      },
    ]);
    expect(slipForModeration.rows[0].moderation).toEqual(
      expect.objectContaining({
        rowId: "row-id-1",
        currentOdds: 2.6,
      })
    );
    expect(slipForModeration.rows[1].moderation).toBeUndefined();
    applyAffectedRows(slipForModeration);
    expect(slipForModeration.rows[0].moderation).toBeUndefined();

    clearSlipDeclineReason(slipForModeration);
    expect(slipForModeration.declineReason).toBeUndefined();
    slipForModeration.rows[0].moderation = {
      rowId: "row-id-1",
      declineReason: ModerationDeclineReason.STALE_QUOTE,
    };
    clearSlipDeclineState(slipForModeration);
    expect(slipForModeration.declineReason).toBeUndefined();
    expect(slipForModeration.rows[0].moderation).toBeUndefined();

    const activeUserId = new mongoose.Types.ObjectId().toHexString();
    const submitted = await Slip.create({
      _id: submittedId,
      userId: activeUserId,
      status: SlipStatus.SUBMITTED,
      betKind: BetKind.PRE_MATCH,
      draftKey: BetKind.PRE_MATCH,
      timestamp: new Date("2025-01-01T10:00:00.000Z").toISOString(),
      submittedAt: new Date("2025-01-01T10:05:00.000Z").toISOString(),
      rows: [buildRow({ betKind: BetKind.PRE_MATCH })],
    });
    await Slip.create({
      userId: activeUserId,
      status: SlipStatus.DRAFT,
      betKind: BetKind.PRE_MATCH,
      draftKey: BetKind.PRE_MATCH,
      timestamp: new Date("2025-01-01T10:06:00.000Z").toISOString(),
      sourceSlipId: submitted.id,
      rows: [{ ...buildRow({ betKind: BetKind.PRE_MATCH }), betKind: undefined }],
    });
    const activeSlip = await findActiveSlipForUser(activeUserId, BetKind.PRE_MATCH);
    expect(activeSlip?.status).toBe(SlipStatus.DRAFT);
    expect(activeSlip?.betKind).toBe(BetKind.PRE_MATCH);
    expect(activeSlip?.rows[0].betKind).toBe(BetKind.PRE_MATCH);

    const plainCopy = toPlainSlip(activeSlip as any);
    plainCopy.rows[0].oddsName = "Changed";
    expect(activeSlip?.rows[0].oddsName).toBe("Home");
  });

  it("upserts draft rows with logical market replacement and duplicate-key retries", async () => {
    await upsertDraftSlipRow(
      "user-a",
      BetKind.PRE_MATCH,
      {
        ...buildRow(),
        oddsId: "shared-odds",
      }
    );
    await upsertDraftSlipRow(
      "user-a",
      BetKind.PRE_MATCH,
      {
        ...buildRow({ id: "row-dup", betKind: BetKind.PRE_MATCH }),
        oddsId: "unique-odds",
      }
    );
    await upsertDraftSlipRow(
      "user-a",
      BetKind.PRE_MATCH,
      {
        ...buildRow({ id: "row-dup", betKind: BetKind.PRE_MATCH }),
        oddsId: "shared-odds",
      }
    );
    await upsertDraftSlipRow(
      "user-live",
      BetKind.LIVE,
      buildRow({
        id: "live-row-1",
        betKind: BetKind.LIVE,
        marketId: "market-x",
        marketVersion: 1,
        quoteVersion: 1,
        selectionId: "home",
      })
    );
    await upsertDraftSlipRow(
      "user-live",
      BetKind.LIVE,
      buildRow({
        id: "live-row-2",
        betKind: BetKind.LIVE,
        marketId: "market-x",
        marketVersion: 2,
        quoteVersion: 2,
        selectionId: "away",
      })
    );
    await upsertDraftSlipRow(
      "user-live",
      BetKind.LIVE,
      buildRow({
        id: "live-row-3",
        betKind: BetKind.LIVE,
        marketId: "market-y",
        marketVersion: 1,
        quoteVersion: 1,
        selectionId: "home",
      })
    );

    const preMatchDraft = await Slip.findOne({
      userId: "user-a",
      status: SlipStatus.DRAFT,
    }).lean();
    expect(preMatchDraft?.rows).toHaveLength(2);

    const liveDraft = await Slip.findOne({
      userId: "user-live",
      status: SlipStatus.DRAFT,
    }).lean();
    expect(liveDraft?.rows).toHaveLength(2);
    expect(
      (liveDraft?.rows as Array<{ marketId?: string; marketVersion?: number }>)
        .find((row) => row.marketId === "market-x")?.marketVersion
    ).toBe(2);

    const duplicateSpy = jest
      .spyOn(Slip.collection, "findOneAndUpdate")
      .mockRejectedValueOnce({ code: 11000 } as any)
      .mockResolvedValueOnce({ ok: 1 } as any);
    await upsertDraftSlipRow("retry-user", BetKind.PRE_MATCH, buildRow());
    expect(duplicateSpy).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expect.any(Array),
      expect.objectContaining({
        upsert: false,
      })
    );
    duplicateSpy.mockRestore();

    const errorSpy = jest
      .spyOn(Slip.collection, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("update failed"));
    await expect(
      upsertDraftSlipRow("error-user", BetKind.PRE_MATCH, buildRow())
    ).rejects.toThrow("update failed");
    errorSpy.mockRestore();
  });

  it("serializes place-bet rows, wagers, placement attempts, and published events", () => {
    const optionalRow = {
      ...buildRow({
        id: "serialised-row",
        betKind: BetKind.LIVE,
        marketId: "market-z",
        marketVersion: 3,
        quoteVersion: 4,
        selectionId: "selection-home",
        eventTime: "2025-01-01T12:05:00.000Z",
        marketType: LiveMarketType.NEXT_CORNER,
        side: TeamSide.HOME,
        selectedAt: "2025-01-01T12:01:00.000Z",
        quoteValidUntil: "2025-01-01T12:02:00.000Z",
      }),
      id: "serialised-row",
    };
    const placeBetRows = toPlaceBetRows({
      betKind: BetKind.LIVE,
      rows: [optionalRow],
    } as any);
    expect(placeBetRows).toEqual([
      expect.objectContaining({
        id: "serialised-row",
        eventTime: "2025-01-01T12:05:00.000Z",
        betKind: BetKind.LIVE,
        marketId: "market-z",
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: 3,
        quoteVersion: 4,
        selectionId: "selection-home",
        side: TeamSide.HOME,
        selectedAt: "2025-01-01T12:01:00.000Z",
        quoteValidUntil: "2025-01-01T12:02:00.000Z",
      }),
    ]);
    expect(() =>
      toPlaceBetRows({
        betKind: BetKind.PRE_MATCH,
        rows: [{ ...buildRow(), _id: undefined, id: undefined }],
      } as any)
    ).toThrow("Slip row id is missing");

    expect(submittedWagerOf(null)).toBeNull();
    expect(submittedWagerOf({ submittedEvent: { wager: 15 } as any })).toBe(15);
    expect(
      submittedWagerOf({ submittedEvent: { wager: Number.NaN } as any })
    ).toBeNull();
    expect(
      submissionMatchesWager(
        { submittedEvent: { wager: 15 } as any },
        15
      )
    ).toBe(true);

    const legacySlipId = new mongoose.Types.ObjectId().toHexString();
    expect(
      submittedPlacementAttemptIdOf({
        id: legacySlipId,
      } as any)
    ).toBe(buildLegacyPlacementAttemptId(legacySlipId));
    expect(submittedPlacementAttemptIdOf(null)).toBeNull();

    const submittedSlip = {
      id: legacySlipId,
      betKind: BetKind.PRE_MATCH,
      submittedEvent: {
        slipId: legacySlipId,
        placementAttemptId: " attempt-1 ",
        wager: 25,
        betKind: BetKind.PRE_MATCH,
        rows: [],
      },
    } as any;
    expect(submittedPlacementAttemptIdOf(submittedSlip)).toBe("attempt-1");
    expect(
      submissionMatchesPlacementAttempt(submittedSlip, "attempt-1")
    ).toBe(true);
    expect(
      submissionMatchesPlacementAttempt(submittedSlip, "attempt-2")
    ).toBe(false);
    expect(submissionMatchesPlacementAttempt(submittedSlip, null)).toBe(false);
    expect(
      submissionMatchesPlacementPayload(submittedSlip, {
        placementAttemptId: "attempt-1",
        wager: 25,
        betKind: BetKind.PRE_MATCH,
      })
    ).toBe(true);
    expect(
      submissionMatchesPlacementPayload(submittedSlip, {
        placementAttemptId: "attempt-1",
        wager: 30,
        betKind: BetKind.PRE_MATCH,
      })
    ).toBe(false);
    expect(
      submissionMatchesPlacementPayload(
        {
          ...submittedSlip,
          submittedEvent: {
            ...submittedSlip.submittedEvent,
            betKind: BetKind.LIVE,
          },
        },
        {
          placementAttemptId: "attempt-1",
          wager: 25,
          betKind: BetKind.PRE_MATCH,
        }
      )
    ).toBe(false);

    const slipToClear = {
      _id: new mongoose.Types.ObjectId(),
      userId: "clear-user",
      status: SlipStatus.SUBMITTED,
      timestamp: new Date().toISOString(),
      submittedAt: new Date().toISOString(),
      submittedEvent: {
        slipId: legacySlipId,
        placementAttemptId: "attempt-clear",
        wager: 10,
        rows: [],
      },
      publication: {
        state: SlipPublicationState.PENDING,
      },
      rows: [],
    } as any;
    clearSubmittedAttemptState(slipToClear);
    expect(slipToClear.submittedAt).toBeUndefined();
    expect(slipToClear.submittedEvent).toBeUndefined();
    expect(slipToClear.publication).toBeUndefined();

    const publishedEvent = toPublishedSubmittedEventData({
      userId: "publisher",
      userName: "publisher@example.com",
      slipId: legacySlipId,
      wager: 25,
      betKind: BetKind.LIVE,
      rows: [optionalRow],
    });
    expect(publishedEvent.placementAttemptId).toBe(
      buildLegacyPlacementAttemptId(legacySlipId)
    );
    expect(publishedEvent.rows[0]).toEqual(
      expect.objectContaining({
        eventTime: "2025-01-01T12:05:00.000Z",
        betKind: BetKind.LIVE,
        marketId: "market-z",
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: 3,
        quoteVersion: 4,
        selectionId: "selection-home",
        side: TeamSide.HOME,
        selectedAt: "2025-01-01T12:01:00.000Z",
        quoteValidUntil: "2025-01-01T12:02:00.000Z",
      })
    );
  });
});
