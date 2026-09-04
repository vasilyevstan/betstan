import { ConsumeMessage } from "amqplib";
import {
  BettingStatus,
  EventPhase,
  EventStatus,
  EventVisibility,
  IEventResultEvent,
  ILiveEventUpdateEvent,
  INewEventEvent,
  messengerWrapper,
} from "@betstan/common";
import { applyLiveEventUpdate, listPublicEvents } from "../LiveEventReadModel";
import EventResultListener from "../../messaging/listener/EventResultListener";
import NewEventListener from "../../messaging/listener/NewEventListener";
import EventVisibilityListener from "../../messaging/listener/EventVisibilityListener";
import { Event } from "../../model/Event";

afterEach(() => {
  jest.restoreAllMocks();
});

// Regression coverage for independently reported ordering/reconciliation
// bugs in the live-event retention/handoff mechanism:
//   1. The T-10 PRE_MATCH retirement side effect must only run for an
//      *accepted* update (one that actually won the sequence race), and
//      must only ever retire events strictly older (by scheduled kickoff
//      time) than the event whose PRE_MATCH just landed.
//   2. A result event that races ahead of live projections remains terminal:
//      delayed non-FULL_TIME updates may fill history but stay hidden, and
//      only the matching FULL_TIME projection restores the retained card.
//   3. Explicit OFFLINE intent is persisted independently from transient
//      runtime visibility, so neither pending nor completed admin decisions
//      can be overridden by delayed live updates.
//   4. The single currently-retained finished (FULL_TIME) event must keep
//      showing in `listPublicEvents` regardless of how long ago its
//      scheduled kickoff was, until it is actually retired (tombstoned).
//   5. An accepted PRE_MATCH handoff also removes terminal or already-offline
//      Event projections whose kickoff is more than seven days old.

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

const buildFullTimeLiveUpdate = (
  eventId: string,
  kickoffAt: string,
  sequence = 180
): ILiveEventUpdateEvent =>
  ({
    timestamp: new Date().toISOString(),
    data: {
      eventId,
      sequence,
      occurredAt: new Date(Date.parse(kickoffAt) + 105 * 60_000).toISOString(),
      kickoffAt,
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 1,
      awayScore: 0,
      bettingStatus: BettingStatus.CLOSED,
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

it("does not repeat retention cleanup for an equal-sequence PRE_MATCH redelivery", async () => {
  const kickoffAt = "2030-01-10T12:00:00.000Z";
  await Event.create([
    {
      eventId: "duplicate-countdown",
      name: "Duplicate Countdown",
      time: new Date(kickoffAt),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        sequence: 0,
        occurredAt: kickoffAt,
        kickoffAt,
        minute: 0,
        phase: EventPhase.PRE_MATCH,
        homeScore: 0,
        awayScore: 0,
        bettingStatus: BettingStatus.OPEN,
        incidentHistory: [],
        currentMarkets: [],
      },
    },
    {
      eventId: "expired-after-first-delivery",
      name: "Expired After First Delivery",
      time: new Date("2030-01-01T12:00:00.000Z"),
      status: EventStatus.RESULTED,
      visibility: EventVisibility.OFFLINE,
      products: [],
    },
  ]);

  const result = await applyLiveEventUpdate(
    buildPreMatchLiveUpdate("duplicate-countdown", kickoffAt, 0)
  );

  expect(result).toBeNull();
  expect(
    await Event.exists({ eventId: "expired-after-first-delivery" })
  ).not.toBeNull();
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

it("removes only terminal or offline event projections older than seven days during an accepted PRE_MATCH handoff", async () => {
  const referenceKickoff = "2030-01-10T12:00:00.000Z";
  await Event.create([
    {
      eventId: "expired-offline",
      name: "Expired Offline",
      time: new Date("2030-01-02T11:59:59.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.OFFLINE,
      products: [],
    },
    {
      eventId: "expired-resulted",
      name: "Expired Resulted",
      time: new Date("2030-01-03T11:59:59.000Z"),
      status: EventStatus.RESULTED,
      visibility: EventVisibility.ONLINE,
      products: [],
    },
    {
      eventId: "expired-active-anomaly",
      name: "Expired Active Anomaly",
      time: new Date("2030-01-01T12:00:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        sequence: 5,
        occurredAt: "2030-01-01T12:12:00.000Z",
        kickoffAt: "2030-01-01T12:00:00.000Z",
        minute: 12,
        phase: EventPhase.FIRST_HALF,
        homeScore: 0,
        awayScore: 0,
        bettingStatus: BettingStatus.OPEN,
        incidentHistory: [],
        currentMarkets: [],
      },
    },
    {
      eventId: "fresh-offline",
      name: "Fresh Offline",
      time: new Date("2030-01-04T12:00:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.OFFLINE,
      products: [],
    },
    {
      eventId: "retention-trigger",
      name: "Retention Trigger",
      time: new Date(referenceKickoff),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
    },
  ]);

  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate("retention-trigger", referenceKickoff, 0)
  );

  expect(await Event.findOne({ eventId: "expired-offline" })).toBeNull();
  expect(await Event.findOne({ eventId: "expired-resulted" })).toBeNull();
  expect(await Event.findOne({ eventId: "expired-active-anomaly" })).not.toBeNull();
  expect(await Event.findOne({ eventId: "fresh-offline" })).not.toBeNull();
  expect(await Event.findOne({ eventId: "retention-trigger" })).not.toBeNull();
});

it("does not run the seven-day cleanup for a stale rejected PRE_MATCH update", async () => {
  await Event.create([
    {
      eventId: "expired-but-not-cleaned",
      name: "Expired But Not Cleaned",
      time: new Date("2030-01-01T00:00:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.OFFLINE,
      products: [],
    },
    {
      eventId: "stale-retention-trigger",
      name: "Stale Retention Trigger",
      time: new Date("2030-01-10T12:00:00.000Z"),
      status: EventStatus.NO_RESULT,
      visibility: EventVisibility.ONLINE,
      products: [],
      live: {
        sequence: 1,
        occurredAt: "2030-01-10T11:51:00.000Z",
        kickoffAt: "2030-01-10T12:00:00.000Z",
        minute: 0,
        phase: EventPhase.PRE_MATCH,
        homeScore: 0,
        awayScore: 0,
        bettingStatus: BettingStatus.OPEN,
        incidentHistory: [],
        currentMarkets: [],
      },
    },
  ]);

  const result = await applyLiveEventUpdate(
    buildPreMatchLiveUpdate(
      "stale-retention-trigger",
      "2030-01-10T12:00:00.000Z",
      0
    )
  );

  expect(result).toBeNull();
  expect(await Event.findOne({ eventId: "expired-but-not-cleaned" })).not.toBeNull();
});

it("keeps a terminal result hidden through delayed non-FULL_TIME updates and restores only its FULL_TIME projection", async () => {
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
  expect(afterResult?.liveRaceResultedAt).toBeTruthy();

  // An earlier live snapshot arrives late on its independent queue.
  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate(eventId, "2030-01-01T12:00:00.000Z", 0)
  );

  const afterDelayedLive = await Event.findOne({ eventId }).lean();
  expect(afterDelayedLive?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterDelayedLive?.live?.phase).toEqual(EventPhase.PRE_MATCH);
  expect(afterDelayedLive?.status).toEqual(EventStatus.RESULTED);
  expect(afterDelayedLive?.liveRaceResultedAt).toBeTruthy();

  const beforeFullTime = await listPublicEvents(
    new Date("2030-01-01T12:05:00.000Z")
  );
  expect(beforeFullTime.map((entry) => entry.eventId)).not.toContain(eventId);

  await applyLiveEventUpdate(
    buildFullTimeLiveUpdate(eventId, "2030-01-01T12:00:00.000Z")
  );

  const afterFullTime = await Event.findOne({ eventId }).lean();
  expect(afterFullTime?.visibility).toEqual(EventVisibility.ONLINE);
  expect(afterFullTime?.live?.phase).toEqual(EventPhase.FULL_TIME);
  expect(afterFullTime?.status).toEqual(EventStatus.RESULTED);
  expect(afterFullTime?.liveRaceResultedAt ?? null).toBeNull();

  const afterFullTimeList = await listPublicEvents(
    new Date("2030-01-01T13:46:00.000Z")
  );
  expect(afterFullTimeList.map((entry) => entry.eventId)).toContain(eventId);
});

it("keeps status RESULTED when the very first accepted live update after a result-before-live race is already FULL_TIME", async () => {
  const eventId = "result-before-live-full-time";
  await Event.create({
    eventId,
    name: "Result Before Live Full Time",
    time: new Date("2030-01-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
  });

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  await listener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, homeScore: 3, awayScore: 2, home: "Team C", away: "Team D" },
    },
    buildMessage()
  );

  const afterResult = await Event.findOne({ eventId }).lean();
  expect(afterResult?.status).toEqual(EventStatus.RESULTED);
  expect(afterResult?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterResult?.liveRaceResultedAt).toBeTruthy();

  // The very first live update this service ever observes for this event
  // is already the match's own FULL_TIME conclusion (e.g. every earlier
  // transition was missed/redelivered out of order) -- a genuine final
  // result, so `status` must stay RESULTED rather than being reversed to
  // NO_RESULT, while visibility is still restored so the retained
  // full-time card is not permanently hidden.
  await applyLiveEventUpdate({
    timestamp: new Date().toISOString(),
    data: {
      eventId,
      sequence: 180,
      occurredAt: "2030-01-01T13:45:00.000Z",
      kickoffAt: "2030-01-01T12:00:00.000Z",
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 3,
      awayScore: 2,
      bettingStatus: BettingStatus.CLOSED,
      incidents: [],
      markets: [],
      settlements: [],
      home: "Team C",
      away: "Team D",
    },
  } as unknown as ILiveEventUpdateEvent);

  const afterLive = await Event.findOne({ eventId }).lean();
  expect(afterLive?.visibility).toEqual(EventVisibility.ONLINE);
  expect(afterLive?.status).toEqual(EventStatus.RESULTED);
  expect(afterLive?.liveRaceResultedAt ?? null).toBeNull();
});

it("never auto-restores an intentionally OFFLINE admin/acceptance-gated fixture (onboarded via the real NewEventListener path) even when an accepted live update arrives after it is resulted", async () => {
  const eventId = "admin-gated-offline-fixture";
  // An explicit admin/backoffice visibility decision already governs this
  // event's OFFLINE state -- e.g. a synthetic production-acceptance
  // fixture onboarded OFFLINE through the real `NewEventListener` path --
  // independent of any result race. `visibilityInitialized` ends up true
  // here exactly as it would for an ordinary ONLINE onboarded event, so
  // the actual OFFLINE *visibility value* is what must gate the marker,
  // not `visibilityInitialized` alone.
  const newEventListener = new NewEventListener(messengerWrapper.connection);
  await newEventListener.init();
  await newEventListener.onMessage(
    {
      sender: "backoffice_new_event",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Admin Gated Offline Fixture",
        time: "2030-01-01T12:00:00.000Z",
        home: "Team C",
        away: "Team D",
        visibility: EventVisibility.OFFLINE,
      },
    } as unknown as INewEventEvent,
    buildMessage()
  );

  const onboarded = await Event.findOne({ eventId }).lean();
  expect(onboarded?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(onboarded?.visibilityInitialized).toBe(true);
  expect(onboarded?.visibilityDecision).toEqual(EventVisibility.OFFLINE);

  const listener = new EventResultListener(messengerWrapper.connection);
  await listener.init();
  await listener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, homeScore: 0, awayScore: 0, home: "Team C", away: "Team D" },
    },
    buildMessage()
  );

  const afterResult = await Event.findOne({ eventId }).lean();
  expect(afterResult?.status).toEqual(EventStatus.RESULTED);
  expect(afterResult?.visibility).toEqual(EventVisibility.OFFLINE);
  // No race marker: this OFFLINE state is admin-owned, not a race artifact.
  expect(afterResult?.liveRaceResultedAt ?? null).toBeNull();

  // An unexpected live update nonetheless arrives for this event id.
  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate(eventId, "2030-01-01T12:00:00.000Z", 0)
  );

  const afterLive = await Event.findOne({ eventId }).lean();
  // Still OFFLINE and admin-gated -- never silently exposed to the public.
  expect(afterLive?.visibility).toEqual(EventVisibility.OFFLINE);

  const listed = await listPublicEvents(new Date("2030-01-01T12:05:00.000Z"));
  expect(listed.map((entry) => entry.eventId)).not.toContain(eventId);
});

it("refuses to auto-restore when a currently explicit pending OFFLINE visibility decision governs the event, even though it was legitimately marked as a race", async () => {
  // Defense in depth: `liveRaceResultedAt` was legitimately stamped at
  // result time (a genuine race, no explicit decision existed then), but
  // an independent `EventVisibilityListener` decision landed afterward --
  // and before the live update -- leaving `pendingVisibility: OFFLINE`
  // queued. This proves a deliberate admin hide decision is now actively
  // in flight for this exact event, so resurrection must defer to it
  // rather than silently overriding it, even though the race marker is
  // present.
  const eventId = "race-then-pending-visibility-decision";
  await Event.create({
    eventId,
    name: "Race Then Pending Visibility Decision",
    time: new Date("2030-01-01T12:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.OFFLINE,
    liveRaceResultedAt: new Date("2030-01-01T11:00:00.000Z"),
    pendingVisibility: EventVisibility.OFFLINE,
    products: [],
  });

  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate(eventId, "2030-01-01T12:00:00.000Z", 0)
  );

  const afterLive = await Event.findOne({ eventId }).lean();
  expect(afterLive?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterLive?.status).toEqual(EventStatus.RESULTED);
  // The marker itself is left untouched -- resurrection never ran at all.
  expect(afterLive?.liveRaceResultedAt).toBeTruthy();
});

it("keeps a completed OFFLINE decision authoritative after it supersedes an earlier result-race marker", async () => {
  const eventId = "race-then-completed-offline-decision";
  await Event.create({
    eventId,
    name: "Race Then Completed Offline Decision",
    time: new Date("2030-01-01T12:00:00.000Z"),
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    visibilityInitialized: true,
    eventMetadataInitialized: true,
    products: [],
  });

  const resultListener = new EventResultListener(messengerWrapper.connection);
  await resultListener.init();
  await resultListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, homeScore: 1, awayScore: 0, home: "Team C", away: "Team D" },
    },
    buildMessage()
  );

  const visibilityListener = new EventVisibilityListener(
    messengerWrapper.connection
  );
  await visibilityListener.init();
  await visibilityListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, visibility: EventVisibility.OFFLINE },
    },
    buildMessage()
  );

  const afterVisibility = await Event.findOne({ eventId }).lean();
  expect(afterVisibility?.pendingVisibility).toBeUndefined();
  expect(afterVisibility?.visibilityDecision).toEqual(EventVisibility.OFFLINE);
  expect(afterVisibility?.liveRaceResultedAt).toBeTruthy();

  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate(eventId, "2030-01-01T12:00:00.000Z", 0)
  );
  await applyLiveEventUpdate(
    buildFullTimeLiveUpdate(eventId, "2030-01-01T12:00:00.000Z")
  );

  const afterFullTime = await Event.findOne({ eventId }).lean();
  expect(afterFullTime?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterFullTime?.status).toEqual(EventStatus.RESULTED);
  expect(afterFullTime?.live?.phase).toEqual(EventPhase.FULL_TIME);
  expect(afterFullTime?.liveRaceResultedAt ?? null).toBeNull();
});

it("keeps a concurrent admin OFFLINE decision authoritative during full-time race recovery", async () => {
  const eventId = "race-recovery-admin-offline-interleaving";
  await Event.create({
    eventId,
    name: "Race Recovery Admin Offline",
    time: new Date("2030-01-01T12:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.OFFLINE,
    visibilityInitialized: true,
    eventMetadataInitialized: true,
    liveRaceResultedAt: new Date("2030-01-01T13:40:00.000Z"),
    products: [],
  });

  const visibilityListener = new EventVisibilityListener(
    messengerWrapper.connection
  );
  await visibilityListener.init();

  const originalUpdateOne = Event.updateOne.bind(Event);
  let injectedOfflineDecision = false;
  (
    jest.spyOn(Event, "updateOne") as unknown as jest.Mock
  ).mockImplementation((...args: any[]) =>
    (async () => {
      const [filter, update, options] = args;
      if (
        !injectedOfflineDecision
        && Array.isArray(update)
        && (filter as { eventId?: string }).eventId === eventId
      ) {
        injectedOfflineDecision = true;
        await visibilityListener.onMessage(
          {
            timestamp: new Date().toISOString(),
            data: { eventId, visibility: EventVisibility.OFFLINE },
          },
          buildMessage()
        );
      }

      return originalUpdateOne(filter, update, options).exec();
    })()
  );

  const repairedSnapshot = await applyLiveEventUpdate(
    buildFullTimeLiveUpdate(eventId, "2030-01-01T12:00:00.000Z")
  );

  expect(repairedSnapshot?.status).toEqual(EventStatus.RESULTED);
  expect(repairedSnapshot?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(repairedSnapshot?.live?.phase).toEqual(EventPhase.FULL_TIME);

  const storedEvent = await Event.findOne({ eventId }).lean();
  expect(storedEvent?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(storedEvent?.visibilityDecision).toEqual(EventVisibility.OFFLINE);
  expect(storedEvent?.pendingVisibility).toBeUndefined();
  expect(storedEvent?.live?.phase).toEqual(EventPhase.FULL_TIME);
  expect(storedEvent?.liveRaceResultedAt ?? null).toBeNull();

  const listed = await listPublicEvents(new Date("2030-01-01T13:46:00.000Z"));
  expect(listed.map((entry) => entry.eventId)).not.toContain(eventId);
});

it("keeps a pending ONLINE result hidden until FULL_TIME, then restores the retained card without reopening the result", async () => {
  const eventId = "race-then-pending-online-decision";
  await Event.create({
    eventId,
    name: "Race Then Pending Online Decision",
    time: new Date("2030-01-01T12:00:00.000Z"),
    status: EventStatus.RESULTED,
    visibility: EventVisibility.OFFLINE,
    liveRaceResultedAt: new Date("2030-01-01T11:00:00.000Z"),
    pendingVisibility: EventVisibility.ONLINE,
    products: [],
  });

  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate(eventId, "2030-01-01T12:00:00.000Z", 0)
  );

  const afterDelayedLive = await Event.findOne({ eventId }).lean();
  expect(afterDelayedLive?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterDelayedLive?.status).toEqual(EventStatus.RESULTED);
  expect(afterDelayedLive?.liveRaceResultedAt).toBeTruthy();

  await applyLiveEventUpdate(
    buildFullTimeLiveUpdate(eventId, "2030-01-01T12:00:00.000Z")
  );

  const afterFullTime = await Event.findOne({ eventId }).lean();
  expect(afterFullTime?.visibility).toEqual(EventVisibility.ONLINE);
  expect(afterFullTime?.status).toEqual(EventStatus.RESULTED);
  expect(afterFullTime?.liveRaceResultedAt ?? null).toBeNull();
});

it("keeps a full-time pending-ONLINE placeholder hidden until NewEvent resolves authority", async () => {
  const eventId = "visibility-online-result-fulltime-before-newevent";

  const visibilityListener = new EventVisibilityListener(
    messengerWrapper.connection
  );
  await visibilityListener.init();
  await visibilityListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, visibility: EventVisibility.ONLINE },
    },
    buildMessage()
  );

  const resultListener = new EventResultListener(messengerWrapper.connection);
  await resultListener.init();
  await resultListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, homeScore: 1, awayScore: 0, home: "Team C", away: "Team D" },
    } as IEventResultEvent,
    buildMessage()
  );

  await applyLiveEventUpdate(
    buildFullTimeLiveUpdate(eventId, "2030-01-01T12:00:00.000Z")
  );

  const beforeOnboarding = await Event.findOne({ eventId }).lean();
  expect(beforeOnboarding?.status).toEqual(EventStatus.RESULTED);
  expect(beforeOnboarding?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(beforeOnboarding?.pendingVisibility).toEqual(EventVisibility.ONLINE);
  expect(beforeOnboarding?.live?.phase).toEqual(EventPhase.FULL_TIME);
  expect(beforeOnboarding?.liveRaceResultedAt ?? null).toBeNull();

  const hiddenList = await listPublicEvents(new Date("2030-01-01T13:46:00.000Z"));
  expect(hiddenList.map((entry) => entry.eventId)).not.toContain(eventId);

  const newEventListener = new NewEventListener(messengerWrapper.connection);
  await newEventListener.init();
  await newEventListener.onMessage(
    {
      sender: "other_service",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Team C - Team D",
        time: "2030-01-01T12:00:00.000Z",
        home: "Team C",
        away: "Team D",
      },
    } as INewEventEvent,
    buildMessage()
  );

  const afterOnboarding = await Event.findOne({ eventId }).lean();
  expect(afterOnboarding?.status).toEqual(EventStatus.RESULTED);
  expect(afterOnboarding?.visibility).toEqual(EventVisibility.ONLINE);
  expect(afterOnboarding?.pendingVisibility).toBeUndefined();
  expect(afterOnboarding?.eventMetadataInitialized).toBe(true);
  expect(afterOnboarding?.visibilityInitialized).toBe(true);
  expect(afterOnboarding?.live?.phase).toEqual(EventPhase.FULL_TIME);

  const visibleList = await listPublicEvents(new Date("2030-01-01T13:46:00.000Z"));
  expect(visibleList.map((entry) => entry.eventId)).toContain(eventId);
});

it("re-hides a delayed non-terminal update after NewEvent restored visibility, then exposes only FULL_TIME", async () => {
  const eventId = "visibility-online-result-newevent-live-ordering";

  const visibilityListener = new EventVisibilityListener(
    messengerWrapper.connection
  );
  await visibilityListener.init();
  await visibilityListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, visibility: EventVisibility.ONLINE },
    },
    buildMessage()
  );

  const afterVisibility = await Event.findOne({ eventId }).lean();
  expect(afterVisibility?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterVisibility?.pendingVisibility).toEqual(EventVisibility.ONLINE);

  const resultListener = new EventResultListener(messengerWrapper.connection);
  await resultListener.init();
  await resultListener.onMessage(
    {
      timestamp: new Date().toISOString(),
      data: { eventId, homeScore: 1, awayScore: 0, home: "Team C", away: "Team D" },
    },
    buildMessage()
  );

  const afterResult = await Event.findOne({ eventId }).lean();
  expect(afterResult?.status).toEqual(EventStatus.RESULTED);
  expect(afterResult?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterResult?.liveRaceResultedAt).toBeTruthy();

  const newEventListener = new NewEventListener(messengerWrapper.connection);
  await newEventListener.init();
  await newEventListener.onMessage(
    {
      sender: "other_service",
      timestamp: new Date().toISOString(),
      data: {
        id: eventId,
        name: "Team C - Team D",
        time: "2030-01-01T12:00:00.000Z",
        home: "Team C",
        away: "Team D",
      },
    } as unknown as INewEventEvent,
    buildMessage()
  );

  const afterNewEvent = await Event.findOne({ eventId }).lean();
  expect(afterNewEvent?.visibility).toEqual(EventVisibility.ONLINE);
  expect(afterNewEvent?.status).toEqual(EventStatus.RESULTED);
  expect(afterNewEvent?.liveRaceResultedAt).toBeTruthy();

  await applyLiveEventUpdate(
    buildPreMatchLiveUpdate(eventId, "2030-01-01T12:00:00.000Z", 0)
  );

  const afterDelayedLive = await Event.findOne({ eventId }).lean();
  expect(afterDelayedLive?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(afterDelayedLive?.status).toEqual(EventStatus.RESULTED);
  expect(afterDelayedLive?.liveRaceResultedAt).toBeTruthy();

  const beforeFullTime = await listPublicEvents(
    new Date("2030-01-01T11:55:00.000Z")
  );
  expect(beforeFullTime.map((entry) => entry.eventId)).not.toContain(eventId);

  await applyLiveEventUpdate(
    buildFullTimeLiveUpdate(eventId, "2030-01-01T12:00:00.000Z")
  );

  const afterFullTime = await Event.findOne({ eventId }).lean();
  expect(afterFullTime?.visibility).toEqual(EventVisibility.ONLINE);
  expect(afterFullTime?.status).toEqual(EventStatus.RESULTED);
  expect(afterFullTime?.liveRaceResultedAt ?? null).toBeNull();
});

it("keeps a retained finished event visible past the kickoff-time history bound until it is actually retired", async () => {
  const eventId = "retained-past-history-bound";
  const kickoffAt = new Date("2030-01-01T00:00:00.000Z");
  await Event.create({
    eventId,
    name: "Retained Past History Bound",
    time: kickoffAt,
    status: EventStatus.NO_RESULT,
    visibility: EventVisibility.ONLINE,
    products: [],
    live: {
      sequence: 40,
      occurredAt: "2030-01-01T01:45:00.000Z",
      kickoffAt: kickoffAt.toISOString(),
      minute: 90,
      phase: EventPhase.FULL_TIME,
      homeScore: 1,
      awayScore: 1,
      bettingStatus: BettingStatus.CLOSED,
      incidentHistory: [],
      currentMarkets: [],
    },
  });

  // Far beyond the default 240-minute history window (~9 hours later), with
  // no newer event having ever entered its own T-10 countdown -- the
  // retained card must still show, since nothing has retired it.
  const now = new Date(kickoffAt.getTime() + 9 * 60 * 60 * 1000);
  const listed = await listPublicEvents(now);
  expect(listed.map((entry) => entry.eventId)).toContain(eventId);

  // Once the tombstone is stamped (the next event's own accepted T-10
  // handoff), the retained card must stop leaking back in even though it
  // is already well past the ordinary history bound.
  await Event.updateOne(
    { eventId },
    {
      $set: {
        visibility: EventVisibility.OFFLINE,
        liveRetiredAt: new Date(),
      },
    }
  );

  const listedAfterRetirement = await listPublicEvents(now);
  expect(listedAfterRetirement.map((entry) => entry.eventId)).not.toContain(
    eventId
  );
});

it("keeps an intentionally retired event hidden when a late duplicate update is rejected", async () => {
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
  // sequence is rejected by the sequence gate and must not resurrect it.
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

  expect(lateDuplicate).toBeNull();

  const stillRetired = await Event.findOne({ eventId: "retired-event" }).lean();
  expect(stillRetired?.visibility).toEqual(EventVisibility.OFFLINE);
  expect(stillRetired?.liveRetiredAt).toBeTruthy();

  const listed = await listPublicEvents(new Date("2030-01-01T14:05:00.000Z"));
  expect(listed.map((entry) => entry.eventId)).not.toContain("retired-event");
});
