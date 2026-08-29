import { ConsumeMessage } from "amqplib";
import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  IEventResultEvent,
  ILiveEventUpdateEvent,
  messengerWrapper,
} from "@betstan/common";
import { applyLiveEventUpdate, listPublicEvents } from "../LiveEventReadModel";
import EventResultListener from "../../messaging/listener/EventResultListener";
import { Event } from "../../model/Event";

// Regression coverage for two independently reported ordering bugs in the
// live-event retention/handoff mechanism:
//   1. The T-10 PRE_MATCH retirement side effect must only run for an
//      *accepted* update (one that actually won the sequence race), and
//      must only ever retire events strictly older (by scheduled kickoff
//      time) than the event whose PRE_MATCH just landed.
//   2. A result event that races ahead of an event's very first live
//      projection (independent queues give no ordering guarantee) must
//      not permanently hide it: the next accepted live update restores
//      visibility, unless the event carries the permanent
//      `liveRetiredAt` tombstone written by an intentional PRE_MATCH
//      handoff retirement.

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

const buildPreMatchLiveUpdate = (
  eventId: string,
  kickoffAt: string,
  sequence = 0
): ILiveEventUpdateEvent =>
  ({
    timestamp: new Date().toISOString(),
    data: {
      eventId,
      sequence,
      occurredAt: kickoffAt,
      kickoffAt,
      minute: 0,
      phase: EventPhase.PRE_MATCH,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidents: [],
      markets: [],
      settlements: [],
      home: "Team C",
      away: "Team D",
    },
  } as unknown as ILiveEventUpdateEvent);

it("does not retire a retained finished event when a delayed, already-superseded sequence-0 message is rejected by the sequence gate", async () => {
  await Event.create({
    eventId: "retained-newer",
    name: "Retained Newer",
    // Deliberately scheduled *after* the stale event's kickoff below, so
    // that -- absent the "accepted" gate -- the older-events time scoping
    // alone would still wrongly match it and let the stale message retire
    // it.
    time: new Date("2030-01-01T20:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T21:45:00.000Z",
      kickoffAt: "2030-01-01T20:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 2,
      awayScore: 1,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  // "stale-older" already progressed past its opening snapshot (its
  // stored sequence is 5), so a delayed re-delivery of its original
  // sequence-0 PRE_MATCH message is stale and must be rejected by the
  // sequence gate.
  await Event.create({
    eventId: "stale-older",
    name: "Stale Older",
    time: new Date("2030-01-01T09:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 5,
      occurredAt: "2030-01-01T09:12:00.000Z",
      kickoffAt: "2030-01-01T09:00:00.000Z",
      minute: 12,
      phase: EventPhase.FIRST_HALF,
      homeScore: 0,
      awayScore: 0,
      bettingStatus: BettingStatus.OPEN,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  const result = await applyLiveEventUpdate(
    buildPreMatchLiveUpdate("stale-older", "2030-01-01T09:00:00.000Z", 0)
  );

  expect(result).toBeNull();

  const retainedNewer = await Event.findOne({ eventId: "retained-newer" }).lean();
  expect(retainedNewer?.visibility).toEqual(EventVisibility.ONLINE);
  expect(retainedNewer?.liveRetiredAt ?? null).toBeNull();

  const staleOlder = await Event.findOne({ eventId: "stale-older" }).lean();
  expect(staleOlder?.live?.sequence).toEqual(5);
  expect(staleOlder?.live?.phase).toEqual(EventPhase.FIRST_HALF);
});

it("only retires events strictly older (by scheduled kickoff time) than the event whose accepted PRE_MATCH snapshot just landed", async () => {
  // A currently-retained finished event scheduled *after* the incoming
  // event's own kickoff -- it must never be retired by an
  // earlier-scheduled event's countdown, even though that countdown
  // update is genuinely accepted (brand new event, sequence 0).
  await Event.create({
    eventId: "retained-later-kickoff",
    name: "Retained Later Kickoff",
    time: new Date("2030-01-01T15:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T16:45:00.000Z",
      kickoffAt: "2030-01-01T15:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 1,
      awayScore: 0,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  // Ordinary onboarding created this earlier-kickoff event as ONLINE
  // before its own T-10 countdown starts populating `live`.
  await Event.create({
    eventId: "earlier-countdown",
    name: "Earlier Countdown",
    time: new Date("2030-01-01T08:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  const result = await applyLiveEventUpdate(
    buildPreMatchLiveUpdate("earlier-countdown", "2030-01-01T08:00:00.000Z", 0)
  );

  expect(result?.live?.phase).toEqual(EventPhase.PRE_MATCH);

  const retainedLater = await Event.findOne({
    eventId: "retained-later-kickoff",
  }).lean();
  expect(retainedLater?.visibility).toEqual(EventVisibility.ONLINE);
  expect(retainedLater?.liveRetiredAt ?? null).toBeNull();
});

it("restores visibility to ONLINE when an accepted live update arrives after a result-before-live race set it OFFLINE", async () => {
  const eventId = "result-before-live";
  await Event.create({
    eventId,
    name: "Result Before Live",
    time: new Date("2030-01-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  // Independent queues/listeners give no cross-service ordering
  // guarantee: the EVENT_RESULT message can be processed before this
  // service has ever seen a live projection for the event.
  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  const resultEvent: IEventResultEvent = {
    timestamp: new Date().toISOString(),
    data: { eventId, homeScore: 1, awayScore: 0, home: "Team C", away: "Team D" },
  };
  await listener.onMessage(resultEvent, buildMessage());

  const afterResult = await Event.findOne({ eventId }).lean();
  expect(afterResult?.status).toEqual(EventStatus.RESULTED);
  expect(afterResult?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterResult?.live).toBeFalsy();

  // The live pipeline's own opening snapshot then lands (independently
  // published, arriving after the result in this ordering).
  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate(eventId, "2030-01-01T12:00:00.000Z", 0)
  );

  const afterLive = await Event.findOne({ eventId }).lean();
  expect(afterLive?.visibility).toEqual(EventVisibility.ONLINE);
  expect(afterLive?.live?.phase).toEqual(EventPhase.PRE_MATCH);

  const listed = await listPublicEvents(new Date("2030-01-01T12:05:00.000Z"));
  expect(listed.map((entry) => entry.eventId)).toContain(eventId);
});

it("keeps an intentionally retired (tombstoned) event hidden even when a late duplicate update for it is accepted", async () => {
  await Event.create({
    eventId: "retired-event",
    name: "Retired Event",
    time: new Date("2030-01-01T09:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T10:45:00.000Z",
      kickoffAt: "2030-01-01T09:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 2,
      awayScore: 2,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });
  await Event.create({
    eventId: "handoff-event",
    name: "Handoff Event",
    time: new Date("2030-01-01T14:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  // The next event's countdown becomes authoritative and retires the
  // older finished event, stamping the permanent tombstone.
  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate("handoff-event", "2030-01-01T14:00:00.000Z", 0)
  );

  const retiredAfterHandoff = await Event.findOne({
    eventId: "retired-event",
  }).lean();
  expect(retiredAfterHandoff?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(retiredAfterHandoff?.liveRetiredAt).toBeTruthy();

  // A late duplicate re-delivery of the retired event's own final
  // sequence is idempotent/accepted (its stored sequence already equals
  // the incoming one), but must not resurrect it.
  const lateDuplicate = await applyLiveEventUpdate({
    timestamp: new Date().toISOString(),
    data: {
      eventId: "retired-event",
      sequence: 40,
      occurredAt: "2030-01-01T10:45:00.000Z",
      kickoffAt: "2030-01-01T09:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 2,
      awayScore: 2,
      bettingStatus: BettingStatus.CLOSED,
      incidents: [],
      markets: [],
      settlements: [],
      home: "Team A",
      away: "Team B",
    },
  } as unknown as ILiveEventUpdateEvent);

  expect(lateDuplicate?.visibility).toEqual(EventVisibility.OFFLINE);

  const stillRetired = await Event.findOne({ eventId: "retired-event" }).lean();
  expect(stillRetired?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(stillRetired?.liveRetiredAt).toBeTruthy();

  const listed = await listPublicEvents(new Date("2030-01-01T14:05:00.000Z"));
  expect(listed.map((entry) => entry.eventId)).not.toContain("retired-event");
});
