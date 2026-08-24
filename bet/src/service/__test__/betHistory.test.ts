import mongoose from "mongoose";
import {
  BetKind,
  BetStatus,
  IModerationResultEvent,
  IPlaceBetEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  LiveMarketType,
  LiveMarketStatus,
  LiveSettlementReason,
  ModerationDeclineReason,
  ModerationStatus,
  ResultingStatus,
  SlipRowStatus,
  TeamSide,
} from "@betstan/common";
import { Bet } from "../../model/Bet";
import { BetPlacementConflict } from "../../model/BetPlacementConflict";
import {
  PendingBetUpdate,
  PendingBetUpdateKind,
  PendingBetUpdateStatus,
} from "../../model/PendingBetUpdate";
import {
  applyModerationResult,
  applyPendingBetUpdatesToBet,
  applySettleSlip,
  applySettleSlipRow,
  betHistoryInternals,
  buildCanonicalPlacedBetPayload,
  buildCanonicalPlacedBetPayloadFromBet,
  hashCanonicalPlacedBetPayload,
  loadOwnedPendingBetUpdates,
  sanitizePendingBetUpdateError,
  upsertPlaceBet,
} from "../betHistory";

type PlaceBetEventData = IPlaceBetEvent["data"] & {
  submittedAt?: string;
};

const buildPlaceEvent = (
  overrides: Partial<Omit<IPlaceBetEvent, "data">> & {
    data?: Partial<Omit<PlaceBetEventData, "rows">> & {
      rows?: Array<Partial<IPlaceBetEvent["data"]["rows"][number]>>;
    };
  } = {}
): IPlaceBetEvent => {
  const defaultRow = {
    eventId: new mongoose.Types.ObjectId().toHexString(),
    eventName: "Team A - Team B",
    oddsId: new mongoose.Types.ObjectId().toHexString(),
    oddsValue: 1.5,
    oddsName: "Home",
    productName: "1X2",
    productId: new mongoose.Types.ObjectId().toHexString(),
    timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
    id: new mongoose.Types.ObjectId().toHexString(),
  };

  const data: PlaceBetEventData = {
    userId:
      overrides.data?.userId ?? new mongoose.Types.ObjectId().toHexString(),
    userName: overrides.data?.userName ?? "test-user",
    slipId:
      overrides.data?.slipId ?? new mongoose.Types.ObjectId().toHexString(),
    wager: overrides.data?.wager ?? 25,
    betKind: overrides.data?.betKind,
    submittedAt: overrides.data?.submittedAt,
    rows: (overrides.data?.rows?.map((row) => ({
        ...defaultRow,
        ...row,
      })) ?? [defaultRow]) as IPlaceBetEvent["data"]["rows"],
  };

  return {
    timestamp: overrides.timestamp ?? new Date("2025-01-01T12:01:00.000Z").toISOString(),
    data,
  };
};

const buildBet = (overrides: Record<string, unknown> = {}) =>
  new Bet({
    status: BetStatus.PENDING,
    userId: new mongoose.Types.ObjectId().toHexString(),
    userName: "test-user",
    slipId: new mongoose.Types.ObjectId().toHexString(),
    wager: 25,
    timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
    betKind: BetKind.PRE_MATCH,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.NOT_SETTLED,
        timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        winningSelection: "",
        id: new mongoose.Types.ObjectId().toHexString(),
        betKind: BetKind.PRE_MATCH,
      },
    ],
    ...overrides,
  });

const buildModerationEvent = (
  overrides: Partial<IModerationResultEvent["data"]> = {}
): IModerationResultEvent => ({
  timestamp: new Date("2025-01-01T12:02:00.000Z").toISOString(),
  data: {
    slipId: overrides.slipId ?? new mongoose.Types.ObjectId().toHexString(),
    result: overrides.result ?? ModerationStatus.APPROVED,
    ...overrides,
  },
});

const buildSettleSlipEvent = (
  overrides: Partial<ISettleSlipEvent["data"]> = {}
): ISettleSlipEvent => ({
  timestamp: new Date("2025-01-01T12:03:00.000Z").toISOString(),
  data: {
    slipId: overrides.slipId ?? new mongoose.Types.ObjectId().toHexString(),
    result: overrides.result ?? ResultingStatus.BET_WIN,
    ...overrides,
  },
});

const buildSettleSlipRowEvent = (
  overrides: Partial<ISettleSlipRowEvent["data"]> = {}
): ISettleSlipRowEvent => ({
  timestamp: new Date("2025-01-01T12:04:00.000Z").toISOString(),
  data: {
    slipId: overrides.slipId ?? new mongoose.Types.ObjectId().toHexString(),
    slipRowId:
      overrides.slipRowId ?? new mongoose.Types.ObjectId().toHexString(),
    result: overrides.result ?? ResultingStatus.ROW_WIN,
    ...overrides,
  },
});

it("resolves placement timestamps, attempt ids, and optional values", () => {
  const directTimestamp = betHistoryInternals.resolvePlaceBetTimestamp(
    buildPlaceEvent({ timestamp: "2025-01-01T12:01:00.000Z" })
  );
  expect(directTimestamp).toBe("2025-01-01T12:01:00.000Z");

  const rowTimestampEvent = buildPlaceEvent({
    data: {
      rows: [{ timestamp: "2025-01-01T12:02:00.000Z" }],
    },
  });
  (rowTimestampEvent as Partial<IPlaceBetEvent>).timestamp = undefined;
  const rowTimestamp =
    betHistoryInternals.resolvePlaceBetTimestamp(rowTimestampEvent);
  expect(rowTimestamp).toBe("2025-01-01T12:02:00.000Z");

  const fallbackTimestampEvent = buildPlaceEvent({
    data: { rows: [{ timestamp: undefined }] },
  }) as IPlaceBetEvent;
  (fallbackTimestampEvent as Partial<IPlaceBetEvent>).timestamp = undefined;
  const fallbackTimestamp =
    betHistoryInternals.resolvePlaceBetTimestamp(fallbackTimestampEvent);
  expect(Number.isNaN(new Date(fallbackTimestamp).getTime())).toBe(false);

  expect(
    betHistoryInternals.resolvePlacementAttemptId({
      userId: "user-id",
      userName: "user-name",
      slipId: "slip-id",
      wager: 10,
      placementAttemptId: "placement-id",
      rows: [],
    } as unknown as IPlaceBetEvent["data"])
  ).toBe("placement-id");
  expect(
    betHistoryInternals.resolvePlacementAttemptId({
      userId: "user-id",
      userName: "user-name",
      slipId: "slip-id",
      wager: 10,
      attemptId: "attempt-id",
      rows: [],
    } as unknown as IPlaceBetEvent["data"])
  ).toBe("attempt-id");
  expect(
    betHistoryInternals.resolvePlacementAttemptId({
      userId: "user-id",
      userName: "user-name",
      slipId: "slip-id",
      wager: 10,
      rows: [],
    } as unknown as IPlaceBetEvent["data"])
  ).toBe("slip-id");

  expect(betHistoryInternals.normalizeOptionalPlacementValue(null)).toBeUndefined();
  expect(
    betHistoryInternals.normalizeOptionalPlacementValue("2025-01-01T12:02:00.000Z")
  ).toBe("2025-01-01T12:02:00.000Z");
});

it("uses immutable submission time for retried placement identity", async () => {
  const submittedAt = "2025-01-01T12:00:30.000Z";
  const firstEvent = buildPlaceEvent({
    timestamp: "2025-01-01T12:01:00.000Z",
    data: {
      betKind: BetKind.LIVE,
      submittedAt,
    },
  });
  const retryEvent = {
    ...firstEvent,
    timestamp: "2025-01-01T12:02:00.000Z",
  };

  await expect(upsertPlaceBet(firstEvent)).resolves.toMatchObject({
    outcome: "inserted",
  });
  await expect(upsertPlaceBet(retryEvent)).resolves.toMatchObject({
    outcome: "exact_duplicate",
  });

  const persistedBet = await Bet.findOne({ slipId: firstEvent.data.slipId });
  expect(persistedBet!.timestamp).toBe(submittedAt);
  expect(
    await BetPlacementConflict.countDocuments({
      slipId: firstEvent.data.slipId,
    })
  ).toBe(0);
});

it("infers and merges bet kinds across legacy and live payloads", () => {
  expect(betHistoryInternals.normalizeBetKind(undefined)).toBe(BetKind.PRE_MATCH);
  expect(betHistoryInternals.normalizeBetKind(BetKind.LIVE)).toBe(BetKind.LIVE);
  expect(betHistoryInternals.mergeBetKind(BetKind.PRE_MATCH, BetKind.LIVE)).toBe(
    BetKind.LIVE
  );
  expect(betHistoryInternals.mergeBetKind(BetKind.LIVE, BetKind.PRE_MATCH)).toBe(
    BetKind.LIVE
  );
  expect(betHistoryInternals.mergeBetKind(undefined, undefined)).toBe(
    BetKind.PRE_MATCH
  );

  expect(
    betHistoryInternals.inferBetKind({
      betKind: BetKind.LIVE,
      rows: [],
    })
  ).toBe(BetKind.LIVE);
  expect(
    betHistoryInternals.inferBetKind({
      rows: [{ betKind: BetKind.LIVE } as IPlaceBetEvent["data"]["rows"][number]],
    } as Pick<IPlaceBetEvent["data"], "betKind" | "rows">)
  ).toBe(BetKind.LIVE);
  expect(
    betHistoryInternals.inferBetKind({
      rows: [{} as IPlaceBetEvent["data"]["rows"][number]],
    } as Pick<IPlaceBetEvent["data"], "betKind" | "rows">)
  ).toBe(BetKind.PRE_MATCH);
});

it("updates defined and missing values only when appropriate", () => {
  const target = {
    defined: "current",
    missing: undefined as string | undefined,
    betKind: undefined as BetKind | undefined,
  };

  expect(betHistoryInternals.setDefinedValue(target, "defined", undefined)).toBe(
    false
  );
  expect(
    betHistoryInternals.setDefinedValue(target, "defined", "current")
  ).toBe(false);
  expect(betHistoryInternals.setDefinedValue(target, "defined", "next")).toBe(
    true
  );
  expect(target.defined).toBe("next");

  expect(
    betHistoryInternals.setMissingValue(target, "missing", undefined)
  ).toBe(false);
  expect(betHistoryInternals.setMissingValue(target, "missing", "new")).toBe(
    true
  );
  expect(betHistoryInternals.setMissingValue(target, "missing", "other")).toBe(
    false
  );
  expect(betHistoryInternals.updateBetKind(target, undefined)).toBe(true);
  expect(target.betKind).toBe(BetKind.PRE_MATCH);
  expect(betHistoryInternals.updateBetKind(target, BetKind.PRE_MATCH)).toBe(false);
  expect(betHistoryInternals.updateBetKind(target, BetKind.LIVE)).toBe(true);
  expect(target.betKind).toBe(BetKind.LIVE);
});

it("builds and merges place rows while preserving existing optional fields", () => {
  const event = buildPlaceEvent({
    data: {
      betKind: BetKind.LIVE,
      rows: [
        {
          id: "row-1",
          betKind: BetKind.LIVE,
          eventTime: "2025-01-01T12:05:00.000Z",
          marketId: "market-1",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 4,
          quoteVersion: 7,
          selectionId: "selection-1",
          side: TeamSide.HOME,
          selectedAt: "2025-01-01T12:00:30.000Z",
          quoteValidUntil: "2025-01-01T12:00:45.000Z",
        },
      ],
    },
  });
  const [incomingRow] = event.data.rows;
  const builtRow = betHistoryInternals.buildBetRow(incomingRow, BetKind.PRE_MATCH);
  expect(builtRow.betKind).toBe(BetKind.LIVE);
  expect(builtRow.marketId).toBe("market-1");

  const existingRow = {
    ...builtRow,
    marketId: undefined,
    marketType: undefined,
    marketVersion: undefined,
    quoteVersion: undefined,
    selectionId: undefined,
    side: undefined,
    selectedAt: undefined,
    quoteValidUntil: undefined,
    betKind: BetKind.PRE_MATCH,
  };

  expect(
    betHistoryInternals.mergePlaceRow(existingRow, incomingRow, BetKind.LIVE)
  ).toBe(true);
  expect(existingRow).toMatchObject({
    marketId: "market-1",
    marketType: LiveMarketType.NEXT_CORNER,
    marketVersion: 4,
    quoteVersion: 7,
    selectionId: "selection-1",
    side: TeamSide.HOME,
    selectedAt: "2025-01-01T12:00:30.000Z",
    quoteValidUntil: "2025-01-01T12:00:45.000Z",
    betKind: BetKind.LIVE,
  });
  expect(
    betHistoryInternals.mergePlaceRow(existingRow, incomingRow, BetKind.LIVE)
  ).toBe(false);

  const legacyBet = buildBet({
    betKind: undefined,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Legacy Event",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.NOT_SETTLED,
        timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        winningSelection: undefined,
        id: "row-legacy",
        betKind: undefined,
      },
    ],
  });
  (legacyBet as any).status = undefined;

  expect(betHistoryInternals.ensureBetDefaults(legacyBet)).toBe(true);
  expect(legacyBet.status).toBe(BetStatus.PENDING);
  expect(legacyBet.betKind).toBe(BetKind.PRE_MATCH);
  expect(legacyBet.rows[0].betKind).toBe(BetKind.PRE_MATCH);
  expect(legacyBet.rows[0].winningSelection).toBe("");
  expect(betHistoryInternals.ensureBetDefaults(legacyBet)).toBe(false);
});

it("merges placement payloads by adding missing rows without mutating stable fields", () => {
  const originalEvent = buildPlaceEvent({
    data: {
      slipId: "slip-merge",
      rows: [{ id: "row-1" }],
    },
  });
  const bet = buildBet({
    slipId: "slip-merge",
    userId: originalEvent.data.userId,
    userName: originalEvent.data.userName,
    wager: originalEvent.data.wager,
    timestamp: originalEvent.timestamp,
    rows: [betHistoryInternals.buildBetRow(originalEvent.data.rows[0], BetKind.PRE_MATCH)],
  });
  const mergedEvent = buildPlaceEvent({
    timestamp: "2025-02-01T12:00:00.000Z",
    data: {
      slipId: "slip-merge",
      userId: originalEvent.data.userId,
      userName: originalEvent.data.userName,
      wager: originalEvent.data.wager,
      rows: [{ id: "row-1" }, { id: "row-2", betKind: BetKind.LIVE }],
    },
  });

  expect(betHistoryInternals.mergePlaceBet(bet, mergedEvent)).toBe(true);
  expect(bet.rows.map((row) => row.id)).toEqual(["row-1", "row-2"]);
  expect(bet.rows[1].betKind).toBe(BetKind.LIVE);
  expect(bet.timestamp).toBe(originalEvent.timestamp);
  expect(betHistoryInternals.mergePlaceBet(bet, mergedEvent)).toBe(false);
});

it("maps status transitions and advance rules", () => {
  expect(
    betHistoryInternals.mapBetResultToStatus(ResultingStatus.BET_WIN)
  ).toBe(BetStatus.WIN);
  expect(
    betHistoryInternals.mapBetResultToStatus(ResultingStatus.BET_LOSS)
  ).toBe(BetStatus.LOSS);
  expect(
    betHistoryInternals.mapBetResultToStatus(ResultingStatus.BET_VOID)
  ).toBe(BetStatus.VOID);
  expect(
    betHistoryInternals.mapBetResultToStatus(ResultingStatus.BET_APPROVED)
  ).toBe(BetStatus.CONFIRMED);
  expect(
    betHistoryInternals.mapBetResultToStatus(ResultingStatus.BET_DECLINED)
  ).toBe(BetStatus.DECLINED);
  expect(
    betHistoryInternals.mapBetResultToStatus(ResultingStatus.BET_PENDING)
  ).toBe(BetStatus.PENDING);
  expect(betHistoryInternals.mapBetResultToStatus("UNKNOWN")).toBeUndefined();

  expect(
    betHistoryInternals.mapRowResultToStatus(ResultingStatus.ROW_WIN)
  ).toBe(SlipRowStatus.WIN);
  expect(
    betHistoryInternals.mapRowResultToStatus(ResultingStatus.ROW_LOSS)
  ).toBe(SlipRowStatus.LOSS);
  expect(
    betHistoryInternals.mapRowResultToStatus(ResultingStatus.ROW_VOID)
  ).toBe(SlipRowStatus.VOID);
  expect(
    betHistoryInternals.mapRowResultToStatus(ResultingStatus.ROW_NO_RESULT)
  ).toBe(SlipRowStatus.NOT_SETTLED);
  expect(betHistoryInternals.mapRowResultToStatus("UNKNOWN")).toBeUndefined();

  expect(
    betHistoryInternals.canAdvanceBetStatus(BetStatus.PENDING, BetStatus.CONFIRMED)
  ).toBe(true);
  expect(
    betHistoryInternals.canAdvanceBetStatus(BetStatus.CONFIRMED, BetStatus.PENDING)
  ).toBe(false);
  expect(
    betHistoryInternals.canAdvanceBetStatus(BetStatus.WIN, BetStatus.VOID)
  ).toBe(false);
  expect(
    betHistoryInternals.canAdvanceBetStatus(BetStatus.PENDING, BetStatus.PENDING)
  ).toBe(false);

  expect(
    betHistoryInternals.canAdvanceRowStatus(
      SlipRowStatus.NOT_SETTLED,
      SlipRowStatus.WIN
    )
  ).toBe(true);
  expect(
    betHistoryInternals.canAdvanceRowStatus(SlipRowStatus.VOID, SlipRowStatus.LOSS)
  ).toBe(false);
  expect(
    betHistoryInternals.canAdvanceRowStatus(
      SlipRowStatus.NOT_SETTLED,
      SlipRowStatus.NOT_SETTLED
    )
  ).toBe(false);
});

it("applies moderation affected rows, moderation results, and settlement transitions", () => {
  const bet = buildBet({
    status: BetStatus.PENDING,
    betKind: undefined,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Live Event",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.NOT_SETTLED,
        timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        winningSelection: "",
        id: "row-1",
        betKind: undefined,
      },
    ],
  });
  const row = bet.rows[0];

  expect(
    betHistoryInternals.applyModerationAffectedRow(
      row,
      {
        rowId: row.id,
        marketId: "market-1",
        marketVersion: 2,
        quoteVersion: 3,
        currentOdds: 2.4,
        marketStatus: LiveMarketStatus.SUSPENDED,
        selectionId: "selection-1",
      } as NonNullable<IModerationResultEvent["data"]["affectedRows"]>[number],
      BetKind.LIVE,
      ModerationDeclineReason.STALE_QUOTE
    )
  ).toBe(true);
  expect(row).toMatchObject({
    betKind: BetKind.LIVE,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    marketId: "market-1",
    marketVersion: 2,
    quoteVersion: 3,
    currentOdds: 2.4,
    marketStatus: LiveMarketStatus.SUSPENDED,
    selectionId: "selection-1",
  });

  expect(applyModerationResult(bet, buildModerationEvent())).toBe(true);
  expect(bet.status).toBe(BetStatus.CONFIRMED);

  const declinedBet = buildBet({
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Row A",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.NOT_SETTLED,
        timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        winningSelection: "",
        id: "row-a",
      },
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Row B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Away",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.NOT_SETTLED,
        timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        winningSelection: "",
        id: "row-b",
      },
    ],
  });
  expect(
    applyModerationResult(
      declinedBet,
      buildModerationEvent({
        slipId: declinedBet.slipId,
        result: ModerationStatus.DECLINED,
        declineReason: ModerationDeclineReason.STALE_QUOTE,
      })
    )
  ).toBe(true);
  expect(declinedBet.status).toBe(BetStatus.DECLINED);
  expect(declinedBet.rows.map((candidate) => candidate.declineReason)).toEqual([
    ModerationDeclineReason.STALE_QUOTE,
    ModerationDeclineReason.STALE_QUOTE,
  ]);

  const settledBet = buildBet({ status: BetStatus.CONFIRMED });
  expect(
    applySettleSlip(
      settledBet,
      buildSettleSlipEvent({
        slipId: settledBet.slipId,
        result: ResultingStatus.BET_VOID,
      })
    )
  ).toBe(true);
  expect(settledBet.status).toBe(BetStatus.VOID);
  expect(
    applySettleSlip(
      settledBet,
      buildSettleSlipEvent({
        slipId: settledBet.slipId,
        result: ResultingStatus.BET_PENDING,
      })
    )
  ).toBe(false);
  expect(
    applySettleSlip(
      buildBet(),
      buildSettleSlipEvent({
        result: "UNKNOWN" as ResultingStatus,
      })
    )
  ).toBe(false);

  const rowBet = buildBet({
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Row Event",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.NOT_SETTLED,
        timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        winningSelection: "",
        id: "row-live",
      },
    ],
  });
  expect(
    applySettleSlipRow(
      rowBet,
      buildSettleSlipRowEvent({
        slipId: rowBet.slipId,
        slipRowId: "missing-row",
      })
    )
  ).toBe(false);
  expect(
    applySettleSlipRow(
      rowBet,
      buildSettleSlipRowEvent({
        slipId: rowBet.slipId,
        slipRowId: "row-live",
        result: ResultingStatus.ROW_VOID,
        betKind: BetKind.LIVE,
        marketId: "market-live",
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: 6,
        winningSelection: "Draw",
        winningSide: TeamSide.HOME,
        settlementReason: LiveSettlementReason.MANUAL_VOID,
        settlementSequence: 12,
      })
    )
  ).toBe(true);
  expect(rowBet.rows[0].betKind).toBe(BetKind.LIVE);
  expect(rowBet.rows[0].marketId).toBe("market-live");
  expect(rowBet.rows[0].marketType).toBe(LiveMarketType.NEXT_CORNER);
  expect(rowBet.rows[0].marketVersion).toBe(6);
  expect(rowBet.rows[0].winningSelection).toBe("Draw");
  expect(rowBet.rows[0].winningSide).toBe(TeamSide.HOME);
  expect(rowBet.rows[0].settlementReason).toBe(
    LiveSettlementReason.MANUAL_VOID
  );
  expect(rowBet.rows[0].settlementSequence).toBe(12);
  expect(rowBet.rows[0].status).toBe(SlipRowStatus.VOID);
  expect(
    applySettleSlipRow(
      rowBet,
      buildSettleSlipRowEvent({
        slipId: rowBet.slipId,
        slipRowId: "row-live",
        result: ResultingStatus.ROW_LOSS,
      })
    )
  ).toBe(false);
});

it("builds stable fingerprints and sanitizes pending update errors", async () => {
  const placeEvent = buildPlaceEvent({
    data: {
      betKind: BetKind.LIVE,
      rows: [{ id: "row-1", betKind: undefined, marketId: null as never }],
    },
  });
  const inserted = await upsertPlaceBet(placeEvent);
  const fromEvent = buildCanonicalPlacedBetPayload(placeEvent);
  const fromBet = buildCanonicalPlacedBetPayloadFromBet(inserted.bet.toObject());

  expect(hashCanonicalPlacedBetPayload(fromEvent)).toBe(
    hashCanonicalPlacedBetPayload(fromBet)
  );
  expect(
    sanitizePendingBetUpdateError(new Error("  replay   failed\nfor slip "))
  ).toBe("replay failed for slip");
  expect(sanitizePendingBetUpdateError({ reason: "bad payload" })).toContain(
    "reason"
  );

  const longMessage = sanitizePendingBetUpdateError("x".repeat(600));
  expect(longMessage).toHaveLength(500);
});

it("sorts pending updates and loads only owned processing records", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const moderation = new PendingBetUpdate({
    slipId,
    kind: PendingBetUpdateKind.MODERATION_RESULT,
    dedupeKey: "dedupe-mod",
    timestamp: "2025-01-01T12:00:00.000Z",
    payload: buildModerationEvent({ slipId }),
    status: PendingBetUpdateStatus.PROCESSING,
    leaseOwner: "owner-a",
    nextAttemptAt: new Date("2025-01-01T12:10:00.000Z"),
  });
  const settleRowLater = new PendingBetUpdate({
    slipId,
    kind: PendingBetUpdateKind.SETTLE_SLIP_ROW,
    dedupeKey: "dedupe-row-later",
    timestamp: "2025-01-01T12:01:00.000Z",
    payload: buildSettleSlipRowEvent({
      slipId,
      slipRowId: "row-1",
      settlementSequence: 2,
    }),
    status: PendingBetUpdateStatus.PROCESSING,
    leaseOwner: "owner-a",
    nextAttemptAt: new Date("2025-01-01T12:10:00.000Z"),
  });
  const settleRowEarlier = new PendingBetUpdate({
    slipId,
    kind: PendingBetUpdateKind.SETTLE_SLIP_ROW,
    dedupeKey: "dedupe-row-earlier",
    timestamp: "not-a-date",
    payload: buildSettleSlipRowEvent({
      slipId,
      slipRowId: "row-1",
      settlementSequence: 1,
    }),
    status: PendingBetUpdateStatus.PROCESSING,
    leaseOwner: "owner-a",
    nextAttemptAt: new Date("2025-01-01T12:10:00.000Z"),
  });
  const settleSlip = new PendingBetUpdate({
    slipId,
    kind: PendingBetUpdateKind.SETTLE_SLIP,
    dedupeKey: "dedupe-slip",
    timestamp: "2025-01-01T12:02:00.000Z",
    payload: buildSettleSlipEvent({ slipId }),
    status: PendingBetUpdateStatus.PROCESSING,
    leaseOwner: "owner-a",
    nextAttemptAt: new Date("2025-01-01T12:10:00.000Z"),
  });
  moderation.createdAt = new Date("2025-01-01T12:00:00.000Z");
  settleRowLater.createdAt = new Date("2025-01-01T12:00:02.000Z");
  settleRowEarlier.createdAt = new Date("2025-01-01T12:00:01.000Z");
  settleSlip.createdAt = new Date("2025-01-01T12:00:03.000Z");

  const ordered = [settleSlip, settleRowLater, moderation, settleRowEarlier].sort(
    betHistoryInternals.comparePendingUpdates
  );
  expect(ordered.map((update) => update.kind)).toEqual([
    PendingBetUpdateKind.MODERATION_RESULT,
    PendingBetUpdateKind.SETTLE_SLIP_ROW,
    PendingBetUpdateKind.SETTLE_SLIP_ROW,
    PendingBetUpdateKind.SETTLE_SLIP,
  ]);
  expect(betHistoryInternals.resolvePendingTimestamp("bad-date")).toBe(0);
  expect(betHistoryInternals.resolvePendingSequence(settleSlip)).toBe(0);
  expect(betHistoryInternals.resolvePendingSequence(settleRowLater)).toBe(2);
  expect(
    betHistoryInternals.stableStringify({
      b: [2, 1],
      a: { z: null, y: undefined },
    })
  ).toBe("{\"a\":{\"y\":undefined,\"z\":null},\"b\":[2,1]}");

  const savedOwned = await PendingBetUpdate.create({
    ...moderation.toObject(),
    _id: new mongoose.Types.ObjectId(),
  });
  await PendingBetUpdate.create({
    ...settleSlip.toObject(),
    _id: new mongoose.Types.ObjectId(),
    leaseOwner: "owner-b",
  });
  await PendingBetUpdate.create({
    ...settleRowLater.toObject(),
    _id: new mongoose.Types.ObjectId(),
    status: PendingBetUpdateStatus.PENDING,
  });

  const loaded = await loadOwnedPendingBetUpdates(
    [savedOwned._id, new mongoose.Types.ObjectId()],
    "owner-a"
  );
  expect(loaded.map((update) => String(update._id))).toEqual([
    String(savedOwned._id),
  ]);
});

it("builds pending update inserts, checks duplicate-key errors, and respects ownership stop", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const pendingInsert = betHistoryInternals.buildPendingUpdateInsert(
    PendingBetUpdateKind.SETTLE_SLIP,
    buildSettleSlipEvent({ slipId })
  );
  expect(pendingInsert).toMatchObject({
    attemptCount: 0,
    kind: PendingBetUpdateKind.SETTLE_SLIP,
    slipId,
    status: PendingBetUpdateStatus.PENDING,
  });
  expect(pendingInsert.nextAttemptAt).toBeInstanceOf(Date);
  expect(pendingInsert.dedupeKey).toHaveLength(64);
  expect(betHistoryInternals.isDuplicateKeyError({ code: 11000 })).toBe(true);
  expect(betHistoryInternals.isDuplicateKeyError({ code: 42 })).toBe(false);
  expect(betHistoryInternals.isDuplicateKeyError("boom")).toBe(false);

  const bet = buildBet({
    slipId,
    status: BetStatus.PENDING,
    rows: [
      {
        eventId: new mongoose.Types.ObjectId().toHexString(),
        eventName: "Team A - Team B",
        oddsId: new mongoose.Types.ObjectId().toHexString(),
        oddsValue: 1.5,
        oddsName: "Home",
        productName: "1X2",
        productId: new mongoose.Types.ObjectId().toHexString(),
        status: SlipRowStatus.NOT_SETTLED,
        timestamp: new Date("2025-01-01T12:00:00.000Z").toISOString(),
        winningSelection: "",
        id: "row-owned",
      },
    ],
  });
  await bet.save();

  const moderation = new PendingBetUpdate({
    ...betHistoryInternals.buildPendingUpdateInsert(
      PendingBetUpdateKind.MODERATION_RESULT,
      buildModerationEvent({ slipId, result: ModerationStatus.APPROVED })
    ),
    status: PendingBetUpdateStatus.PROCESSING,
  });
  const rowSettlement = new PendingBetUpdate({
    ...betHistoryInternals.buildPendingUpdateInsert(
      PendingBetUpdateKind.SETTLE_SLIP_ROW,
      buildSettleSlipRowEvent({
        slipId,
        slipRowId: "row-owned",
        result: ResultingStatus.ROW_WIN,
      })
    ),
    status: PendingBetUpdateStatus.PROCESSING,
  });

  const stopped = await applyPendingBetUpdatesToBet(
    bet,
    [rowSettlement, moderation],
    {
      beforeApply: async (pendingUpdate) =>
        pendingUpdate.kind === PendingBetUpdateKind.MODERATION_RESULT,
    }
  );
  expect(stopped.changed).toBe(true);
  expect(stopped.ownershipLost).toBe(true);
  expect(stopped.processedPendingUpdates).toHaveLength(1);
  expect(bet.status).toBe(BetStatus.CONFIRMED);
  expect(bet.rows[0].status).toBe(SlipRowStatus.NOT_SETTLED);

  const applied = await applyPendingBetUpdatesToBet(bet, [rowSettlement]);
  expect(applied.changed).toBe(true);
  expect(applied.ownershipLost).toBe(false);
  expect(applied.processedPendingUpdates).toHaveLength(1);
  expect(bet.rows[0].status).toBe(SlipRowStatus.WIN);
});

it("keeps first placement immutable and records conflicting duplicates without raw payload leakage", async () => {
  const slipId = new mongoose.Types.ObjectId().toHexString();
  const firstEvent = buildPlaceEvent({
    data: {
      slipId,
      betKind: undefined,
      userName: "first-user",
      rows: [{ id: "row-1" }],
    },
  });
  const conflictingEvent = buildPlaceEvent({
    data: {
      slipId,
      userName: "second-user",
      wager: 99,
      betKind: BetKind.LIVE,
      rows: [{ id: "row-1", marketId: "market-2" }],
    },
  });

  const inserted = await upsertPlaceBet(firstEvent);
  expect(inserted.outcome).toBe("inserted");
  expect(inserted.bet.betKind).toBe(BetKind.PRE_MATCH);
  expect(
    (await Bet.collection.findOne({ slipId }, { projection: { __v: 1 } }))
      ?.__v
  ).toBe(0);

  const exactDuplicate = await upsertPlaceBet(firstEvent);
  expect(exactDuplicate.outcome).toBe("exact_duplicate");

  const conflictingDuplicate = await upsertPlaceBet(conflictingEvent);
  expect(conflictingDuplicate.outcome).toBe("conflicting_duplicate");

  const persistedBet = await Bet.findOne({ slipId }).lean();
  expect(persistedBet).toMatchObject({
    betKind: BetKind.PRE_MATCH,
    userName: "first-user",
    wager: 25,
  });
  expect(persistedBet?.rows[0]).toMatchObject({
    id: "row-1",
    marketId: null,
    betKind: BetKind.PRE_MATCH,
  });

  const conflicts = await BetPlacementConflict.find({ slipId }).lean();
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]).toMatchObject({
    slipId,
    placementAttemptId: slipId,
    observedStatus: BetStatus.PENDING,
    occurrenceCount: 1,
  });
  expect(JSON.stringify(conflicts[0])).not.toContain("second-user");
});
