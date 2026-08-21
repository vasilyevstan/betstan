import { messengerWrapper } from "@betstan/common";
import EventResultListener from "../EventResultListener";
import LiveEventUpdateListener from "../LiveEventUpdateListener";
import ModerationResultListener from "../ModerationResultListener";
import PlaceBetListener from "../PlaceBetListener";
import * as resultingService from "../../../service/resulting";
import RetryRecord from "../../../model/RetryRecord";
import * as retryService from "../../../service/retry";
import {
  createFinalScoreEvent,
  createLiveRow,
  createLiveSettlement,
  createLiveUpdateEvent,
  createMessage,
  createModerationEvent,
  createPlaceBetEvent,
  setupPublisherSpies,
} from "../../../test/resultingTestUtils";

setupPublisherSpies();

afterEach(() => {
  jest.restoreAllMocks();
});

const listenerCases = [
  {
    createEvent: () => createPlaceBetEvent(),
    createListener: async () => {
      const listener = new PlaceBetListener(messengerWrapper.connection);
      await listener.init();
      return listener;
    },
    identity: (event: ReturnType<typeof createPlaceBetEvent>) => event.data.slipId,
    kind: "PLACE_BET",
    processSpy: () =>
      jest
        .spyOn(resultingService, "upsertPlaceBet")
        .mockRejectedValue(new Error("place failed")),
    title: "PlaceBetListener",
  },
  {
    createEvent: () => createModerationEvent("moderation-slip"),
    createListener: async () => {
      const listener = new ModerationResultListener(messengerWrapper.connection);
      await listener.init();
      return listener;
    },
    identity: (event: ReturnType<typeof createModerationEvent>) => event.data.slipId,
    kind: "MODERATION_RESULT",
    processSpy: () =>
      jest
        .spyOn(resultingService, "applyModerationResult")
        .mockRejectedValue(new Error("moderation failed")),
    title: "ModerationResultListener",
  },
  {
    createEvent: () => createFinalScoreEvent({ eventId: "failed-event-result" }),
    createListener: async () => {
      const listener = new EventResultListener(messengerWrapper.connection);
      await listener.init();
      return listener;
    },
    identity: (event: ReturnType<typeof createFinalScoreEvent>) => event.data.eventId,
    kind: "EVENT_RESULT",
    processSpy: () =>
      jest
        .spyOn(resultingService, "processFinalScore")
        .mockRejectedValue(new Error("event result failed")),
    title: "EventResultListener",
  },
  {
    createEvent: () => {
      const row = createLiveRow();
      return createLiveUpdateEvent({
        eventId: row.eventId,
        sequence: 11,
        settlements: [
          createLiveSettlement({
            eventId: row.eventId,
            marketId: row.marketId,
            marketType: row.marketType,
            marketVersion: row.marketVersion,
            winningSide: row.side,
            winningSelection: row.selectionId,
            settlementSequence: 11,
          }),
        ],
      });
    },
    createListener: async () => {
      const listener = new LiveEventUpdateListener(messengerWrapper.connection);
      await listener.init();
      return listener;
    },
    identity: (event: ReturnType<typeof createLiveUpdateEvent>) =>
      `${event.data.eventId}:${event.data.sequence}`,
    kind: "LIVE_EVENT_UPDATE",
    processSpy: () =>
      jest
        .spyOn(resultingService, "processLiveUpdate")
        .mockRejectedValue(new Error("live update failed")),
    title: "LiveEventUpdateListener",
  },
] as const;

it.each(listenerCases)(
  "$title parks failed work durably and acknowledges only after parking succeeds",
  async ({ createEvent, createListener, identity, kind, processSpy }) => {
    processSpy();
    const listener = await createListener();
    const event = createEvent();
    const retryKey = retryService.buildRetryKey(kind, identity(event as never));

    await listener.onMessage(event as never, createMessage());

    const retryRecord = await RetryRecord.findOne({ key: retryKey });

    expect(retryRecord).not.toBeNull();
    expect(retryRecord!.status).toEqual("PENDING");
    expect(retryRecord!.kind).toEqual(kind);
    expect(retryRecord!.identity).toEqual(identity(event as never));
    expect(listener.ack).toHaveBeenCalledTimes(1);
  }
);

it.each(listenerCases)(
  "$title leaves the message unacked when durable parking itself fails",
  async ({ createEvent, createListener, processSpy }) => {
    processSpy();
    jest
      .spyOn(retryService, "parkFailedEvent")
      .mockRejectedValue(new Error("parking failed"));
    const listener = await createListener();

    await listener.onMessage(createEvent() as never, createMessage());

    expect(listener.ack).not.toHaveBeenCalled();
  }
);
