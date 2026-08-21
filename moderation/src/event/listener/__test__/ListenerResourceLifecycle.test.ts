import { messengerWrapper } from "@betstan/common";
import EventResultListener from "../EventResultListener";
import LiveEventUpdateListener from "../LiveEventUpdateListener";
import PlaceBetListener from "../PlaceBetListener";
import {
  createEventResultEvent,
  createLiveUpdateEvent,
  createMessage,
  createPlaceBetEvent,
} from "./helpers";

const attachClosableResources = (listener: object) => {
  const publisher = {
    close: jest.fn(async () => undefined),
  };
  const channel = {
    close: jest.fn(async () => undefined),
  };

  Reflect.set(listener, "publisher", publisher);
  Reflect.set(listener, "_channel", channel);

  return { publisher, channel };
};

it("forwards place-bet messages and closes place-bet listener resources", async () => {
  const listener = new PlaceBetListener(messengerWrapper.connection);
  const moderationService = {
    handlePlaceBet: jest.fn(async () => undefined),
  };
  const ack = jest.fn();
  const { publisher, channel } = attachClosableResources(listener);
  const event = createPlaceBetEvent();
  const message = createMessage();

  Reflect.set(listener, "moderationService", moderationService);
  Reflect.set(listener, "ack", ack);

  await listener.onMessage(event, message);
  await listener.close();

  expect(moderationService.handlePlaceBet).toHaveBeenCalledWith(event);
  expect(ack).toHaveBeenCalledWith(message);
  expect(publisher.close).toHaveBeenCalledTimes(1);
  expect(channel.close).toHaveBeenCalledTimes(1);
});

it("skips replay for stale live snapshots and closes live listener resources", async () => {
  const listener = new LiveEventUpdateListener(messengerWrapper.connection);
  const moderationService = {
    upsertLiveEventMirror: jest.fn(async () => false),
    replayParkedForEvent: jest.fn(async () => undefined),
  };
  const ack = jest.fn();
  const { publisher, channel } = attachClosableResources(listener);
  const event = createLiveUpdateEvent();
  const message = createMessage();

  Reflect.set(listener, "moderationService", moderationService);
  Reflect.set(listener, "ack", ack);

  await listener.onMessage(event, message);
  await listener.close();

  expect(moderationService.upsertLiveEventMirror).toHaveBeenCalledWith(event);
  expect(moderationService.replayParkedForEvent).not.toHaveBeenCalled();
  expect(ack).toHaveBeenCalledWith(message);
  expect(publisher.close).toHaveBeenCalledTimes(1);
  expect(channel.close).toHaveBeenCalledTimes(1);
});

it("uses explicit result timestamps and closes event-result listener resources", async () => {
  const listener = new EventResultListener(messengerWrapper.connection);
  const moderationService = {
    upsertResulted: jest.fn(async () => undefined),
    replayParkedForEvent: jest.fn(async () => undefined),
  };
  const ack = jest.fn();
  const { publisher, channel } = attachClosableResources(listener);
  const event = {
    ...createEventResultEvent(),
    timestamp: "2025-01-01T12:34:56.000Z",
  };
  const message = createMessage();

  Reflect.set(listener, "moderationService", moderationService);
  Reflect.set(listener, "ack", ack);

  await listener.onMessage(event, message);
  await listener.close();

  expect(moderationService.upsertResulted).toHaveBeenCalledWith(
    event.data.eventId,
    event.timestamp
  );
  expect(moderationService.replayParkedForEvent).toHaveBeenCalledWith(
    event.data.eventId
  );
  expect(ack).toHaveBeenCalledWith(message);
  expect(publisher.close).toHaveBeenCalledTimes(1);
  expect(channel.close).toHaveBeenCalledTimes(1);
});

it("keeps listener close safe before publisher and channels are initialised", async () => {
  await expect(
    new PlaceBetListener(messengerWrapper.connection).close()
  ).resolves.toBeUndefined();
  await expect(
    new LiveEventUpdateListener(messengerWrapper.connection).close()
  ).resolves.toBeUndefined();
  await expect(
    new EventResultListener(messengerWrapper.connection).close()
  ).resolves.toBeUndefined();
});
