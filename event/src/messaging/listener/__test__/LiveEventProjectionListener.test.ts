import { ConsumeMessage } from "amqplib";
import {
  BettingStatus,
  EventPhase,
  ILiveEventUpdateEvent,
  LiveIncidentType,
  LiveMarketStatus,
  LiveMarketType,
  QueueNames,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import { LiveEventHub } from "../../../live/LiveEventHub";
import { Event } from "../../../model/Event";
import LiveEventProjectionListener from "../LiveEventProjectionListener";
import LiveEventUpdateListener from "../LiveEventUpdateListener";
import { createLiveEventListeners } from "../liveEventListeners";

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

it("registers durable projection and pod-local fanout listeners with the expected queue identities", () => {
  const registry = createLiveEventListeners(messengerWrapper.connection, {
    hub: new LiveEventHub(),
    podId: "pod/name with spaces",
  });

  expect(registry.all).toEqual([
    registry.projectionListener,
    registry.fanoutListener,
  ]);
  expect(registry.projectionListener.queue).toEqual(
    QueueNames.LIVE_EVENT_UPDATE
  );
  expect((registry.projectionListener as any).queueName).toEqual(
    "event_live_projection"
  );
  expect((registry.projectionListener as any).queueOptions).toEqual({});
  expect(registry.fanoutListener.queue).toEqual(QueueNames.LIVE_EVENT_UPDATE);
  expect((registry.fanoutListener as any).queueName).toEqual(
    "event_live_update.pod-name-with-spaces"
  );
  expect((registry.fanoutListener as any).queueOptions).toEqual({
    durable: false,
    exclusive: true,
    autoDelete: true,
  });
});

it("replays durable projection state for a restarted pod-local fanout listener", async () => {
  const projectionListener = new LiveEventProjectionListener(
    messengerWrapper.connection
  );
  await projectionListener.init();

  await projectionListener.onMessage(buildLiveUpdate(1), buildMessage());
  await projectionListener.onMessage(buildLiveUpdate(2), buildMessage());

  const restartedHub = new LiveEventHub();
  const restartedListener = new LiveEventUpdateListener(
    messengerWrapper.connection,
    {
      hub: restartedHub,
      podId: "pod-restarted",
    }
  );
  await restartedListener.init();

  const subscriber = jest.fn();
  restartedHub.subscribe(subscriber);

  await restartedListener.onMessage(buildLiveUpdate(3), buildMessage());

  expect(subscriber).toHaveBeenCalledTimes(1);
  expect(
    subscriber.mock.calls[0][0].live.incidentHistory.map(
      (incident: { id: string }) => incident.id
    )
  ).toEqual(["incident-1", "incident-2", "incident-3"]);
  expect(subscriber.mock.calls[0][0].live.sequence).toEqual(3);

  const storedEvent = await Event.findOne({ eventId: "live-event" }).lean();
  expect((storedEvent?.live as any).sequence).toEqual(2);
});

it("rebuilds pod-local snapshots from cumulative incidents without duplicating the current incident", async () => {
  const projectionListener = new LiveEventProjectionListener(
    messengerWrapper.connection
  );
  await projectionListener.init();

  await projectionListener.onMessage(buildLiveUpdate(1), buildMessage());
  await projectionListener.onMessage(buildLiveUpdate(2), buildMessage());

  const restartedHub = new LiveEventHub();
  const restartedListener = new LiveEventUpdateListener(
    messengerWrapper.connection,
    {
      hub: restartedHub,
      podId: "pod-restarted-cumulative",
    }
  );
  await restartedListener.init();

  const subscriber = jest.fn();
  restartedHub.subscribe(subscriber);

  await restartedListener.onMessage(
    buildLiveUpdate(3, {
      incident: buildIncident(3, {
        type: LiveIncidentType.YELLOW_CARD,
        side: TeamSide.AWAY,
      }),
      incidents: [
        ...buildIncidentsThrough(2),
        buildIncident(2),
        buildIncident(3, {
          type: LiveIncidentType.YELLOW_CARD,
          side: TeamSide.AWAY,
        }),
      ],
    }),
    buildMessage()
  );

  expect(subscriber).toHaveBeenCalledTimes(1);
  expect(
    subscriber.mock.calls[0][0].live.incidentHistory.map(
      (incident: { id: string }) => incident.id
    )
  ).toEqual(["incident-1", "incident-2", "incident-3"]);
  expect(subscriber.mock.calls[0][0].live.sequence).toEqual(3);
});

it("delivers snapshots to both pod-local fanout listeners", async () => {
  const projectionListener = new LiveEventProjectionListener(
    messengerWrapper.connection
  );
  await projectionListener.init();
  await projectionListener.onMessage(buildLiveUpdate(1), buildMessage());

  const firstHub = new LiveEventHub();
  const secondHub = new LiveEventHub();
  const firstListener = new LiveEventUpdateListener(messengerWrapper.connection, {
    hub: firstHub,
    podId: "pod-a",
  });
  const secondListener = new LiveEventUpdateListener(
    messengerWrapper.connection,
    {
      hub: secondHub,
      podId: "pod-b",
    }
  );
  await firstListener.init();
  await secondListener.init();

  const firstSubscriber = jest.fn();
  const secondSubscriber = jest.fn();
  firstHub.subscribe(firstSubscriber);
  secondHub.subscribe(secondSubscriber);

  const snapshot = buildLiveUpdate(2);
  await firstListener.onMessage(snapshot, buildMessage());
  await secondListener.onMessage(snapshot, buildMessage());

  expect(firstSubscriber).toHaveBeenCalledTimes(1);
  expect(secondSubscriber).toHaveBeenCalledTimes(1);
  expect(firstSubscriber.mock.calls[0][0].live.sequence).toEqual(2);
  expect(secondSubscriber.mock.calls[0][0].live.sequence).toEqual(2);
});

it("does not duplicate local SSE emission for durable, duplicate, or out-of-order deliveries", async () => {
  const projectionListener = new LiveEventProjectionListener(
    messengerWrapper.connection
  );
  await projectionListener.init();

  const hub = new LiveEventHub();
  const localListener = new LiveEventUpdateListener(messengerWrapper.connection, {
    hub,
    podId: "pod-a",
  });
  await localListener.init();

  const subscriber = jest.fn();
  hub.subscribe(subscriber);

  const sequenceFour = buildLiveUpdate(4);
  await projectionListener.onMessage(sequenceFour, buildMessage());
  await localListener.onMessage(sequenceFour, buildMessage());
  await localListener.onMessage(sequenceFour, buildMessage());
  await localListener.onMessage(buildLiveUpdate(3), buildMessage());

  expect(subscriber).toHaveBeenCalledTimes(1);
  expect(subscriber.mock.calls[0][0].live.sequence).toEqual(4);
});
