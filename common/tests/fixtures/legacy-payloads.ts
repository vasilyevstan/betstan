import {
  BettingStatus,
  BetKind,
  EventPhase,
  IEvent,
  IEventOddsSelectedEvent,
  IEventResultEvent,
  IEventVibibilityEvent,
  ILiveEventUpdateEvent,
  IModerationResultEvent,
  INewEventEvent,
  IPlaceBetEvent,
  ISettleSlipEvent,
  ISettleSlipRowEvent,
  LiveMarketStatus,
  LiveMarketType,
  LiveSettlementReason,
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
  newEvent,
  placeBet,
  settleSlip,
  settleSlipRow,
  liveUpdate,
];
