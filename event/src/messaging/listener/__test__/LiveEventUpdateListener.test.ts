import { ConsumeMessage } from "amqplib";
import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  ILiveEventUpdateEvent,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import { Event } from "../../../model/Event";
import LiveEventProjectionListener from "../LiveEventProjectionListener";

type LiveUpdateIncident = NonNullable<ILiveEventUpdateEvent["data"]["incident"]>;
type LiveUpdateData = ILiveEventUpdateEvent["data"] & {
  incidents?: LiveUpdateIncident[];
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

const buildIncident = (
  sequence: number,
  overrides: Partial<LiveUpdateIncident> = {}
) => ({
  id: `incident-${sequence}`,
  type: LiveIncidentType.GOAL,
  side: TeamSide.HOME,
  occurredAt: new Date(Date.UTC(2030, 0, 1, 12, sequence, 0)).toISOString(),
  minute: sequence,
  ...overrides,
});

const buildIncidentsThrough = (
  sequence: number
): NonNullable<LiveUpdateData["incidents"]> =>
  Array.from({ length: sequence }, (_, index) => buildIncident(index + 1));

const buildLiveUpdate = (
  sequence: number,
  overrides: Partial<LiveUpdateData> = {}
): ILiveEventUpdateEvent => ({
  timestamp: new Date().toISOString(),
  data: {
    eventId: "live-event",
    sequence,
    occurredAt: new Date(Date.UTC(2030, 0, 1, 12, sequence, 0)).toISOString(),
    kickoffAt: new Date(Date.UTC(2030, 0, 1, 12, 0, 0)).toISOString(),
    minute: sequence,
    phase: EventPhase.FIRST_HALF,
    homeScore: sequence,
    awayScore: 0,
    bettingStatus: BettingStatus.OPEN,
    incident: buildIncident(sequence),
    markets: [
      {
        marketId: `market-${sequence}`,
        marketType: LiveMarketType.NEXT_CORNER,
        marketVersion: sequence,
        quoteVersion: sequence + 10,
        status: LiveMarketStatus.OPEN,
        selections: [
          {
            selectionId: "home",
            side: TeamSide.HOME,
            odds: 1.5 + sequence / 10,
          },
        ],
      },
    ],
    settlements: [],
    eventName: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    ...overrides,
  },
});

it("adds live state to legacy event documents and bounds current markets", async () => {
  await Event.create({
    eventId: "live-event",
    name: "Team A - Team B",
    home: "Team A",
    away: "Team B",
    time: new Date("2030-01-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [
      {
        id: "product-1",
        type: "1X2",
        name: "1X2",
        odds: [{ id: "odds-1", name: "Home", value: 1.5 }],
      },
    ],
  });

  const listener = new LiveEventProjectionListener(messengerWrapper.connection);
  await listener.init();

  const markets = Array.from({ length: 24 }, (_, index) => ({
    marketId: `market-${index}`,
    marketType: LiveMarketType.NEXT_CORNER,
    marketVersion: index + 1,
    quoteVersion: index + 10,
    status: LiveMarketStatus.OPEN,
    selections: [
      {
        selectionId: `selection-${index}`,
        side: TeamSide.HOME,
        odds: 1.5 + index / 10,
      },
    ],
  }));

  await listener.onMessage(
    buildLiveUpdate(1, {
      markets,
    }),
    buildMessage()
  );

  const updatedEvent = await Event.findOne({ eventId: "live-event" });
  expect(updatedEvent!.products[0].id).toEqual("product-1");
  expect(updatedEvent!.live!.sequence).toEqual(1);
  expect(updatedEvent!.live!.currentMarkets).toHaveLength(20);
});

it("keeps legacy single-incident payloads valid for older publishers", async () => {
  const listener = new LiveEventProjectionListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(buildLiveUpdate(1), buildMessage());

  const updatedEvent = await Event.findOne({ eventId: "live-event" }).lean();
  const live = updatedEvent?.live as any;
  expect(updatedEvent?.visibility).toBe(EventVisibility.OFFLINE);
  expect((updatedEvent as any)?.visibilityInitialized).toBe(false);
  expect((updatedEvent as any)?.eventMetadataInitialized).toBe(false);
  expect(live.sequence).toBe(1);
  expect(
    live.incidentHistory.map((incident: { id: string }) => incident.id)
  ).toEqual(["incident-1"]);
});

it("persists only higher sequences and suppresses duplicate or out-of-order writes", async () => {
  const listener = new LiveEventProjectionListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(
    buildLiveUpdate(2, {
      homeScore: 2,
      markets: [
        {
          marketId: "market-a",
          marketType: LiveMarketType.NEXT_CORNER,
          marketVersion: 2,
          quoteVersion: 4,
          status: LiveMarketStatus.OPEN,
          selections: [{ selectionId: "home", side: TeamSide.HOME, odds: 1.8 }],
        },
      ],
    }),
    buildMessage()
  );

  await listener.onMessage(
    buildLiveUpdate(2, {
      homeScore: 9,
      markets: [
        {
          marketId: "market-duplicate",
          marketType: LiveMarketType.NEXT_RED_CARD,
          marketVersion: 9,
          quoteVersion: 9,
          status: LiveMarketStatus.OPEN,
          selections: [{ selectionId: "home", side: TeamSide.HOME, odds: 9.9 }],
        },
      ],
    }),
    buildMessage()
  );

  await listener.onMessage(
    buildLiveUpdate(1, {
      homeScore: 1,
    }),
    buildMessage()
  );

  await listener.onMessage(
    buildLiveUpdate(3, {
      homeScore: 3,
      incident: {
        id: "incident-3",
        type: LiveIncidentType.YELLOW_CARD,
        side: TeamSide.AWAY,
        occurredAt: new Date(Date.UTC(2030, 0, 1, 12, 3, 0)).toISOString(),
        minute: 3,
      },
      markets: [
        {
          marketId: "market-b",
          marketType: LiveMarketType.NEXT_YELLOW_CARD,
          marketVersion: 3,
          quoteVersion: 5,
          status: LiveMarketStatus.OPEN,
          selections: [{ selectionId: "away", side: TeamSide.AWAY, odds: 2.2 }],
        },
      ],
    }),
    buildMessage()
  );

  const updatedEvent = await Event.findOne({ eventId: "live-event" }).lean();
  const live = updatedEvent?.live as any;
  expect(live).toBeTruthy();
  expect(live.sequence).toEqual(3);
  expect(live.homeScore).toEqual(3);
  expect(live.currentMarkets).toHaveLength(1);
  expect(live.currentMarkets[0].marketId).toEqual("market-b");
  expect(
    live.incidentHistory.map((incident: { id: string }) => incident.id)
  ).toEqual(["incident-2", "incident-3"]);
});

it("replaces and deduplicates cumulative incident history when provided", async () => {
  const listener = new LiveEventProjectionListener(messengerWrapper.connection);
  await listener.init();

  await listener.onMessage(
    buildLiveUpdate(4, {
      incidents: [
        ...buildIncidentsThrough(3),
        buildIncident(3),
        buildIncident(4, {
          type: LiveIncidentType.YELLOW_CARD,
          side: TeamSide.AWAY,
        }),
      ],
      incident: buildIncident(4, {
        type: LiveIncidentType.YELLOW_CARD,
        side: TeamSide.AWAY,
      }),
      homeScore: 2,
      awayScore: 1,
    }),
    buildMessage()
  );

  await listener.onMessage(
    buildLiveUpdate(3, {
      incidents: [buildIncident(1)],
      homeScore: 0,
      awayScore: 0,
    }),
    buildMessage()
  );

  const updatedEvent = await Event.findOne({ eventId: "live-event" }).lean();
  const live = updatedEvent?.live as any;
  expect(live.sequence).toEqual(4);
  expect(live.homeScore).toEqual(2);
  expect(live.awayScore).toEqual(1);
  expect(
    live.incidentHistory.map((incident: { id: string }) => incident.id)
  ).toEqual(["incident-1", "incident-2", "incident-3", "incident-4"]);
});

it("keeps only the bounded public incident history", async () => {
  const listener = new LiveEventProjectionListener(messengerWrapper.connection);
  await listener.init();

  for (let sequence = 1; sequence <= 27; sequence++) {
    await listener.onMessage(buildLiveUpdate(sequence), buildMessage());
  }

  const updatedEvent = await Event.findOne({ eventId: "live-event" }).lean();
  const live = updatedEvent?.live as any;
  expect(live).toBeTruthy();
  expect(live.sequence).toEqual(27);
  expect(live.incidentHistory).toHaveLength(25);
  expect(live.incidentHistory[0].id).toEqual("incident-3");
  expect(live.incidentHistory[24].id).toEqual("incident-27");
});
