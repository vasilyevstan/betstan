import mongoose from "mongoose";
import { ConsumeMessage } from "amqplib";
import {
  BetKind,
  BettingStatus,
  EventPhase,
  IEventResultEvent,
  ILiveEventUpdateEvent,
  IPlaceBetEvent,
  LiveMarketStatus,
  messengerWrapper,
} from "@betstan/common";
import {
  LiveMarketType,
  TeamSide,
} from "../../../compat/LiveContract";
import BetModerationResultPublisher from "../../publisher/BetModerationResultPublisher";
import ModerationService from "../../../service/ModerationService";
import ParkedPlaceBetReplayWorker, {
  ParkedPlaceBetReplayWorkerOptions,
} from "../../../worker/ParkedPlaceBetReplayWorker";

type LiveMarket = ILiveEventUpdateEvent["data"]["markets"][number];
type SlipRow = IPlaceBetEvent["data"]["rows"][number];
type PlaceBetDataOverrides = Partial<
  Omit<IPlaceBetEvent["data"], "rows">
> & {
  submittedAt?: string;
};

const objectId = () => new mongoose.Types.ObjectId().toHexString();

export const createDeferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
};

export const createReplayContext = async (
  options: Partial<ParkedPlaceBetReplayWorkerOptions> = {}
) => {
  const publisher = new BetModerationResultPublisher(messengerWrapper.connection);
  await publisher.init();
  await publisher.initConfirmChannel();

  const service = new ModerationService(publisher);
  const worker = new ParkedPlaceBetReplayWorker(service, {
    pollIntervalMs: 60_000,
    leaseDurationMs: 5_000,
    batchSize: 25,
    maxAttempts: 3,
    maxAgeMs: 60_000,
    baseBackoffMs: 100,
    maxBackoffMs: 1_000,
    ...options,
  });

  return { publisher, service, worker };
};

export const createReplayWorker = async (
  options: Partial<ParkedPlaceBetReplayWorkerOptions> = {}
) => {
  const { worker } = await createReplayContext(options);
  return worker;
};

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

export const createPlaceBetEvent = (
  options: {
    data?: PlaceBetDataOverrides;
    row?: Partial<SlipRow>;
    rows?: SlipRow[];
  } = {}
): IPlaceBetEvent => {
  const eventId =
    options.row?.eventId ?? options.rows?.[0]?.eventId ?? objectId();
  const futureKickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const defaultRow: SlipRow = {
    eventId,
    eventName: "Test Match",
    oddsId: objectId(),
    oddsValue: 1.5,
    oddsName: "Home",
    productName: "1X2",
    productId: objectId(),
    timestamp: futureKickoff,
    eventTime: futureKickoff,
    id: objectId(),
  };

  return {
    data: {
      userId: objectId(),
      userName: "testUser",
      slipId: objectId(),
      wager: 10,
      rows: options.rows ?? [{ ...defaultRow, ...options.row }],
      ...options.data,
    },
  };
};

export const createLiveMarket = (
  eventId: string,
  overrides: Partial<LiveMarket> = {}
): LiveMarket => {
  const marketType = overrides.marketType ?? LiveMarketType.NEXT_CORNER;
  const marketId = overrides.marketId ?? `${eventId}:${marketType}`;
  const marketVersion = overrides.marketVersion ?? 2;
  const selections = overrides.selections ?? [
    {
      selectionId: `${marketId}:${marketVersion}:${TeamSide.HOME}`,
      side: TeamSide.HOME,
      odds: 1.5,
    },
    {
      selectionId: `${marketId}:${marketVersion}:${TeamSide.AWAY}`,
      side: TeamSide.AWAY,
      odds: 2.5,
    },
    {
      selectionId: `${marketId}:${marketVersion}:${TeamSide.NONE}`,
      side: TeamSide.NONE,
      odds: 3.5,
    },
  ];

  return {
    marketId,
    marketType,
    marketVersion,
    quoteVersion: overrides.quoteVersion ?? 4,
    quoteValidUntil:
      overrides.quoteValidUntil
      ?? new Date(Date.now() + 60_000).toISOString(),
    status: overrides.status ?? LiveMarketStatus.OPEN,
    selections,
  };
};

export const createLiveUpdateEvent = (
  options: Partial<ILiveEventUpdateEvent["data"]> = {}
): ILiveEventUpdateEvent => {
  const eventId = options.eventId ?? objectId();

  return {
    data: {
      eventId,
      sequence: options.sequence ?? 1,
      occurredAt: options.occurredAt ?? new Date().toISOString(),
      kickoffAt:
        options.kickoffAt ?? new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      minute: options.minute ?? 12,
      addedTime: options.addedTime,
      phase: options.phase ?? EventPhase.FIRST_HALF,
      homeScore: options.homeScore ?? 0,
      awayScore: options.awayScore ?? 0,
      bettingStatus: options.bettingStatus ?? BettingStatus.OPEN,
      markets: options.markets ?? [createLiveMarket(eventId)],
      settlements: options.settlements ?? [],
      eventName: options.eventName,
      home: options.home,
      away: options.away,
    },
  };
};

export const createLivePlaceBetEvent = (
  market: LiveMarket,
  options: {
    data?: PlaceBetDataOverrides;
    row?: Partial<SlipRow>;
  } = {}
): IPlaceBetEvent => {
  const eventId = options.row?.eventId ?? market.marketId.split(":")[0];
  const kickoffAt =
    options.row?.eventTime ?? new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const selection = market.selections[0];

  return createPlaceBetEvent({
    data: {
      submittedAt: options.data?.submittedAt ?? new Date().toISOString(),
      ...options.data,
      betKind: options.data?.betKind ?? BetKind.LIVE,
    },
    row: {
      eventId,
      eventName: "Live Match",
      timestamp: options.row?.timestamp ?? kickoffAt,
      eventTime: options.row?.eventTime ?? kickoffAt,
      betKind: options.row?.betKind ?? BetKind.LIVE,
      marketId: options.row?.marketId ?? market.marketId,
      marketType: options.row?.marketType ?? market.marketType,
      marketVersion: options.row?.marketVersion ?? market.marketVersion,
      quoteVersion: options.row?.quoteVersion ?? market.quoteVersion,
      selectionId: options.row?.selectionId ?? selection.selectionId,
      side: options.row?.side ?? selection.side,
      oddsValue: options.row?.oddsValue ?? selection.odds,
      quoteValidUntil: options.row?.quoteValidUntil ?? market.quoteValidUntil,
      ...options.row,
    },
  });
};

export const createEventResultEvent = (eventId?: string): IEventResultEvent => ({
  data: {
    eventId: eventId ?? objectId(),
    homeScore: 2,
    awayScore: 1,
    home: "Team A",
    away: "Team B",
  },
});
