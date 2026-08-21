import {
  BettingStatus,
  BetKind,
  EventPhase,
  IEvent,
  IEventOddsSelectedEvent,
  IEventResultEvent,
  IEventVibibilityEvent,
  ILiveEventUpdateEvent,
  LiveIncidentType,
  IModerationResultEvent,
  INewEventEvent,
  IPlaceBetEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  LiveMarketStatus,
  LiveMarketType,
  LiveSettlementReason,
  ModerationDeclineReason,
  TeamSide,
} from "../../src";

const event: IEvent = { data: {} };

const oddsSelected: IEventOddsSelectedEvent = {
  data: {
    userId: "user-id",
    eventId: "event-id",
    eventName: "Event",
    oddsId: "odds-id",
    oddsValue: 1.5,
    oddsName: "Odds",
    productName: "Product",
    productId: "product-id",
  },
};

const eventResult: IEventResultEvent = {
  data: {
    eventId: "event-id",
    homeScore: 1,
    awayScore: 0,
    home: "Home",
    away: "Away",
  },
};

const eventVisibility: IEventVibibilityEvent = {
  data: {
    eventId: "event-id",
    visibility: "ONLINE",
  },
};

const moderationResult: IModerationResultEvent = {
  data: {
    slipId: "slip-id",
    result: "APPROVED",
  },
};

const liveModerationResult: IModerationResultEvent = {
  data: {
    slipId: "live-slip-id",
    result: "DECLINED",
    betKind: BetKind.LIVE,
    declineReason: ModerationDeclineReason.STALE_QUOTE,
    affectedRows: [
      {
        rowId: "row-one",
        declineReason: ModerationDeclineReason.STALE_QUOTE,
        marketId: "event-one:NEXT_CORNER",
        marketVersion: 2,
        quoteVersion: 4,
        currentOdds: 2.1,
        marketStatus: LiveMarketStatus.OPEN,
        selectionId: "event-one:NEXT_CORNER:2:HOME",
      },
      {
        rowId: "row-two",
        declineReason: ModerationDeclineReason.MARKET_SUSPENDED,
        marketId: "event-two:NEXT_RED_CARD",
        marketVersion: 1,
        quoteVersion: 3,
        marketStatus: LiveMarketStatus.SUSPENDED,
        selectionId: "event-two:NEXT_RED_CARD:1:AWAY",
      },
    ],
  },
};

const ambiguousModerationVersion: IModerationResultEvent = {
  data: {
    slipId: "invalid-slip-id",
    result: "DECLINED",
    // @ts-expect-error Current versions must be scoped to an affected row.
    currentMarketVersion: 2,
  },
};

const ambiguousModerationRows: IModerationResultEvent = {
  data: {
    slipId: "invalid-slip-id",
    result: "DECLINED",
    // @ts-expect-error Affected row metadata must be carried by affectedRows.
    affectedRowIds: ["row-one"],
  },
};

const newEvent: INewEventEvent = {
  data: {
    id: "event-id",
    name: "Event",
    time: "2026-08-20T17:00:00.000Z",
    home: "Home",
    away: "Away",
  },
};

const placeBet: IPlaceBetEvent = {
  data: {
    userId: "user-id",
    userName: "User",
    slipId: "slip-id",
    wager: 10,
    rows: [
      {
        eventId: "event-id",
        eventName: "Event",
        oddsId: "odds-id",
        oddsValue: 1.5,
        oddsName: "Odds",
        productName: "Product",
        productId: "product-id",
        timestamp: "2026-08-20T17:00:00.000Z",
        id: "row-id",
      },
    ],
  },
};

const settleSlip: ISettleSlipEvent = {
  data: {
    slipId: "slip-id",
    result: "WIN",
  },
};

const settleSlipRow: ISettleSlipRowEvent = {
  data: {
    slipId: "slip-id",
    slipRowId: "row-id",
    result: "WIN",
  },
};

const liveUpdate: ILiveEventUpdateEvent = {
  data: {
    eventId: "event-id",
    sequence: 1,
    occurredAt: "2026-08-20T17:00:00.000Z",
    kickoffAt: "2026-08-20T16:00:00.000Z",
    minute: 60,
    phase: EventPhase.SECOND_HALF,
    homeScore: 1,
    awayScore: 0,
    bettingStatus: BettingStatus.OPEN,
    incident: {
      id: "incident-id",
      type: LiveIncidentType.GOAL,
      side: TeamSide.HOME,
      occurredAt: "2026-08-20T17:00:00.000Z",
      minute: 60,
    },
    markets: [
      {
        marketId: "market-id",
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: 2,
        quoteVersion: 3,
        status: LiveMarketStatus.OPEN,
        selections: [
          {
            selectionId: "home",
            side: TeamSide.HOME,
            odds: 1.5,
          },
        ],
      },
    ],
    settlements: [
      {
        marketId: "market-id",
        marketVersion: 1,
        settlementReason: LiveSettlementReason.INCIDENT,
        settlementSequence: 1,
        winningSide: TeamSide.HOME,
        winningSelection: "home",
      },
    ],
  },
};

const cumulativeLiveUpdate: ILiveEventUpdateEvent = {
  data: {
    ...liveUpdate.data,
    sequence: 2,
    occurredAt: "2026-08-20T17:01:00.000Z",
    minute: 61,
    incidents: [
      {
        id: "incident-id",
        type: LiveIncidentType.GOAL,
        side: TeamSide.HOME,
        occurredAt: "2026-08-20T17:00:00.000Z",
        minute: 60,
      },
      {
        id: "incident-id-2",
        type: LiveIncidentType.YELLOW_CARD,
        side: TeamSide.AWAY,
        occurredAt: "2026-08-20T17:01:00.000Z",
        minute: 61,
      },
    ],
  },
};

oddsSelected.data.betKind = BetKind.LIVE;
oddsSelected.data.side = TeamSide.HOME;
placeBet.data.rows[0].betKind = BetKind.LIVE;
placeBet.data.rows[0].side = TeamSide.HOME;

void [
  event,
  oddsSelected,
  eventResult,
  eventVisibility,
  moderationResult,
  liveModerationResult,
  ambiguousModerationVersion,
  ambiguousModerationRows,
  newEvent,
  placeBet,
  settleSlip,
  settleSlipRow,
  liveUpdate,
  cumulativeLiveUpdate,
];
