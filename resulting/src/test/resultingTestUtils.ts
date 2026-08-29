import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  BettingStatus,
  EventPhase,
  IEventResultEvent,
  ILiveEventUpdateEvent,
  IModerationResultEvent,
  IPlaceBetEvent,
  LiveMarketStatus,
  ModerationStatus,
  ResultingStatus,
} from "@betstan/common";
import {
  LiveMarketType,
  LiveSettlementReason,
  TeamSide,
} from "../compat/LiveContract";
import SettleSlipPublisher from "../event/publisher/SettleSlipPublisher";
import SettleSlipRowPublisher from "../event/publisher/SettleSlipRowPublisher";
import { Bet, BetArchive } from "../model/Bet";

export const objectId = (): string =>
  new mongoose.Types.ObjectId().toHexString();

const inferMarketType = (marketId: string): LiveMarketType | undefined =>
  Object.values(LiveMarketType).find((type) => marketId.endsWith(`:${type}`));

export const createMessage = (): ConsumeMessage => ({
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

export const createPreMatchRow = (
  overrides: Partial<IPlaceBetEvent["data"]["rows"][number]> = {}
): IPlaceBetEvent["data"]["rows"][number] => ({
  eventId: overrides.eventId ?? objectId(),
  eventName: overrides.eventName ?? "Pre-match fixture",
  oddsId: overrides.oddsId ?? objectId(),
  oddsValue: overrides.oddsValue ?? 1.5,
  oddsName: overrides.oddsName ?? "Home",
  productName: overrides.productName ?? "1X2",
  productId: overrides.productId ?? objectId(),
  timestamp: overrides.timestamp ?? new Date().toISOString(),
  id: overrides.id ?? objectId(),
  eventTime: overrides.eventTime,
  betKind: overrides.betKind,
  marketId: overrides.marketId,
  marketType: overrides.marketType,
  marketVersion: overrides.marketVersion,
  quoteVersion: overrides.quoteVersion,
  selectionId: overrides.selectionId,
  side: overrides.side,
  selectedAt: overrides.selectedAt,
  quoteValidUntil: overrides.quoteValidUntil,
});

export const createLiveRow = (
  overrides: Partial<IPlaceBetEvent["data"]["rows"][number]> & {
    eventId?: string;
    marketId?: string;
    marketType?: LiveMarketType;
    marketVersion?: number;
    side?: TeamSide;
  } = {}
): IPlaceBetEvent["data"]["rows"][number] => {
  const eventId = overrides.eventId ?? objectId();
  const marketType = overrides.marketType ?? LiveMarketType.NEXT_CORNER;
  const marketVersion = overrides.marketVersion ?? 1;
  const side = overrides.side ?? TeamSide.HOME;
  const marketId = overrides.marketId ?? `${eventId}:${marketType}`;
  const timestamp = overrides.timestamp ?? new Date().toISOString();
  const selectionId =
    overrides.selectionId ?? `${marketId}:${marketVersion}:${side}`;

  return {
    eventId,
    eventName: overrides.eventName ?? `Live ${marketType}`,
    oddsId: overrides.oddsId ?? objectId(),
    oddsValue: overrides.oddsValue ?? 2.2,
    oddsName: overrides.oddsName ?? side,
    productName: overrides.productName ?? marketType,
    productId: overrides.productId ?? marketId,
    timestamp,
    id: overrides.id ?? objectId(),
    eventTime: overrides.eventTime,
    betKind: overrides.betKind ?? BetKind.LIVE,
    marketId,
    marketType,
    marketVersion,
    quoteVersion: overrides.quoteVersion ?? 1,
    selectionId,
    side,
    selectedAt: overrides.selectedAt ?? timestamp,
    quoteValidUntil: overrides.quoteValidUntil,
  };
};

export const createPlaceBetEvent = (
  overrides: Partial<IPlaceBetEvent["data"]> = {}
): IPlaceBetEvent => {
  const rows = overrides.rows ?? [createPreMatchRow()];
  const inferredBetKind =
    overrides.betKind
    ?? (rows.some((row) => row.betKind === BetKind.LIVE)
      ? BetKind.LIVE
      : undefined);

  return {
    data: {
      userId: overrides.userId ?? objectId(),
      userName: overrides.userName ?? "test-user@betstan.dev",
      slipId: overrides.slipId ?? objectId(),
      wager: overrides.wager ?? 10,
      rows,
      ...(inferredBetKind ? { betKind: inferredBetKind } : {}),
    },
  };
};

export const createModerationEvent = (
  slipId: string,
  result: ModerationStatus = ModerationStatus.APPROVED,
  overrides: Partial<IModerationResultEvent["data"]> = {}
): IModerationResultEvent => ({
  data: {
    slipId,
    result,
    ...overrides,
  },
});

export const createFinalScoreEvent = (
  overrides: Partial<IEventResultEvent["data"]> = {}
): IEventResultEvent => ({
  data: {
    eventId: overrides.eventId ?? objectId(),
    homeScore: overrides.homeScore ?? 1,
    awayScore: overrides.awayScore ?? 0,
    home: overrides.home ?? "Home Team",
    away: overrides.away ?? "Away Team",
  },
});

export const createLiveMarketSnapshot = (
  overrides: Partial<ILiveEventUpdateEvent["data"]["markets"][number]> & {
    eventId?: string;
    marketId?: string;
    marketType?: LiveMarketType;
    marketVersion?: number;
  } = {}
): ILiveEventUpdateEvent["data"]["markets"][number] => {
  const eventId = overrides.eventId ?? objectId();
  const marketType = overrides.marketType ?? LiveMarketType.NEXT_CORNER;
  const marketId = overrides.marketId ?? `${eventId}:${marketType}`;
  const marketVersion = overrides.marketVersion ?? 1;
  const sides =
    marketType === LiveMarketType.HALF_TIME_RESULT
      ? [TeamSide.HOME, TeamSide.DRAW, TeamSide.AWAY]
      : [TeamSide.HOME, TeamSide.AWAY, TeamSide.NONE];

  return {
    marketId,
    marketType,
    marketVersion,
    quoteVersion: overrides.quoteVersion ?? 1,
    status: overrides.status ?? LiveMarketStatus.OPEN,
    selections:
      overrides.selections
      ?? sides.map((side, index) => ({
        selectionId: `${marketId}:${marketVersion}:${side}`,
        side,
        odds: index + 1.5,
      })),
  };
};

export const createLiveSettlement = (
  overrides: Partial<ILiveEventUpdateEvent["data"]["settlements"][number]> & {
    eventId?: string;
    marketId?: string;
    marketType?: LiveMarketType;
    marketVersion?: number;
    settlementReason?: LiveSettlementReason;
    winningSide?: TeamSide;
  } = {}
): ILiveEventUpdateEvent["data"]["settlements"][number] => {
  const eventId = overrides.eventId ?? objectId();
  const marketType = overrides.marketType ?? LiveMarketType.NEXT_CORNER;
  const marketId = overrides.marketId ?? `${eventId}:${marketType}`;
  const marketVersion = overrides.marketVersion ?? 1;
  const winningSide = overrides.winningSide ?? TeamSide.HOME;

  return {
    marketId,
    marketVersion,
    settlementReason:
      overrides.settlementReason ?? LiveSettlementReason.INCIDENT,
    settlementSequence: overrides.settlementSequence ?? 1,
    winningSide,
    winningSelection:
      overrides.winningSelection
      ?? `${marketId}:${marketVersion}:${winningSide}`,
  };
};

export const createLiveUpdateEvent = (
  overrides: Partial<ILiveEventUpdateEvent["data"]> & {
    settlements?: ILiveEventUpdateEvent["data"]["settlements"];
    markets?: ILiveEventUpdateEvent["data"]["markets"];
    eventId?: string;
  } = {}
): ILiveEventUpdateEvent => {
  const settlements = overrides.settlements ?? [];
  const fallbackEventId = settlements[0]?.marketId.split(":")[0] ?? objectId();
  const eventId = overrides.eventId ?? fallbackEventId;
  const markets =
    overrides.markets
    ?? [...new Map(
      settlements.map((settlement) => [
        `${settlement.marketId}:${settlement.marketVersion}`,
        createLiveMarketSnapshot({
          eventId,
          marketId: settlement.marketId,
          marketType: inferMarketType(settlement.marketId),
          marketVersion: settlement.marketVersion,
          status: LiveMarketStatus.SETTLED,
        }),
      ])
    ).values()];

  return {
    data: {
      eventId,
      sequence: overrides.sequence ?? settlements[0]?.settlementSequence ?? 1,
      occurredAt: overrides.occurredAt ?? new Date().toISOString(),
      kickoffAt: overrides.kickoffAt ?? new Date().toISOString(),
      minute: overrides.minute ?? 60,
      addedTime: overrides.addedTime,
      phase: overrides.phase ?? EventPhase.SECOND_HALF,
      homeScore: overrides.homeScore ?? 1,
      awayScore: overrides.awayScore ?? 0,
      bettingStatus: overrides.bettingStatus ?? BettingStatus.OPEN,
      incident: overrides.incident,
      markets,
      settlements,
      eventName: overrides.eventName,
      home: overrides.home,
      away: overrides.away,
    },
  };
};

interface CreateBetOptions {
  archive?: boolean;
  betKind?: BetKind;
  rows?: any[];
  slipId?: string;
  status?: ResultingStatus;
  userId?: string;
  wager?: number;
}

export const createBet = async ({
  archive = false,
  betKind,
  rows = [createPreMatchRow()],
  slipId = objectId(),
  status = ResultingStatus.BET_APPROVED,
  userId = objectId(),
  wager = 10,
}: CreateBetOptions = {}): Promise<any> => {
  const resolvedBetKind =
    betKind
    ?? (rows.some((row) => row.betKind === BetKind.LIVE)
      ? BetKind.LIVE
      : BetKind.PRE_MATCH);
  const Model = archive ? BetArchive : Bet;

  const bet = new Model({
    userId,
    slipId,
    betKind: resolvedBetKind,
    status,
    wager,
    timestamp: new Date().toISOString(),
    moderationTimestamp: "",
    resultingTimestamp: "",
    rows: rows.map((row) => ({
      ...row,
      betKind: row.betKind ?? resolvedBetKind,
      winningSelection: row.winningSelection ?? "",
      winningSide: row.winningSide,
      settlementReason: row.settlementReason,
      settlementSequence: row.settlementSequence,
      resultingTimestamp: row.resultingTimestamp ?? "",
      settlementPublicationState: row.settlementPublicationState ?? "",
      pendingRemoval: row.pendingRemoval ?? false,
      result: row.result ?? ResultingStatus.ROW_NO_RESULT,
    })),
  });

  await bet.save();
  return bet;
};

export const setupPublisherSpies = (): void => {
  beforeAll(() => {
    SettleSlipRowPublisher.prototype.init = jest
      .fn()
      .mockResolvedValue(undefined);
    SettleSlipRowPublisher.prototype.initConfirmChannel = jest
      .fn()
      .mockResolvedValue(undefined);
    SettleSlipPublisher.prototype.init = jest.fn().mockResolvedValue(undefined);
    SettleSlipPublisher.prototype.initConfirmChannel = jest
      .fn()
      .mockResolvedValue(undefined);
    SettleSlipRowPublisher.prototype.publish = jest.fn();
    SettleSlipRowPublisher.prototype.publishWithConfirm = jest
      .fn()
      .mockResolvedValue(undefined);
    SettleSlipPublisher.prototype.publish = jest.fn();
    SettleSlipPublisher.prototype.publishWithConfirm = jest
      .fn()
      .mockResolvedValue(undefined);
  });
};
