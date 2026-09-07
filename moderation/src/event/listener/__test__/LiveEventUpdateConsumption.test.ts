jest.unmock("@betstan/common");
jest.mock("../../publisher/BetModerationResultPublisher", () => ({
  __esModule: true,
  default: class {
    async init() {}
    async initConfirmChannel() {}
    async close() {}
  },
}));

import { Channel, ConfirmChannel, ConsumeMessage } from "amqplib";
import { IAmqpConnection, ILiveEventUpdateEvent } from "@betstan/common";
import LiveEventUpdateListener from "../LiveEventUpdateListener";
import {
  createDeferred,
  createLiveMarket,
  createLiveUpdateEvent,
  createMessage,
} from "./helpers";

class BackpressuredChannel {
  private deliveryLimit = Number.POSITIVE_INFINITY;
  private unacknowledged = 0;
  private consumer?: (message: ConsumeMessage | null) => void;
  private readonly pending: ConsumeMessage[] = [];

  readonly acknowledged: ConsumeMessage[] = [];
  readonly assertExchange = jest.fn(async () => ({ exchange: "" }));
  readonly assertQueue = jest.fn(async (queue: string) => ({
    queue,
    messageCount: 0,
    consumerCount: 0,
  }));
  readonly bindQueue = jest.fn(async () => undefined);
  readonly close = jest.fn(async () => undefined);
  readonly prefetch = jest.fn(async (count: number) => {
    this.deliveryLimit = count;
    this.pump();
  });
  readonly consume = jest.fn(
    async (
      _queue: string,
      consumer: (message: ConsumeMessage | null) => void
    ) => {
      this.consumer = consumer;
      this.pump();
      return { consumerTag: "test-consumer" };
    }
  );

  enqueue(...messages: ConsumeMessage[]): void {
    this.pending.push(...messages);
    this.pump();
  }

  ack(message: ConsumeMessage): void {
    this.acknowledged.push(message);
    this.unacknowledged -= 1;
    this.pump();
  }

  private pump(): void {
    while (
      this.consumer
      && this.pending.length > 0
      && this.unacknowledged < this.deliveryLimit
    ) {
      const message = this.pending.shift();

      if (!message) {
        return;
      }

      this.unacknowledged += 1;
      this.consumer(message);
    }
  }
}

const brokerMessage = (
  event: ILiveEventUpdateEvent,
  deliveryTag: number
): ConsumeMessage => ({
  ...createMessage(),
  content: Buffer.from(JSON.stringify(event)),
  fields: {
    ...createMessage().fields,
    deliveryTag,
  },
});

it("keeps a broker burst serial until each live snapshot is acknowledged", async () => {
  const channel = new BackpressuredChannel();
  const connection: IAmqpConnection = {
    createChannel: async () => channel as unknown as Channel,
    createConfirmChannel: async () => channel as unknown as ConfirmChannel,
    close: async () => undefined,
  };
  const listener = new LiveEventUpdateListener(connection);
  const firstStarted = createDeferred();
  const releaseFirst = createDeferred();
  let inFlight = 0;
  let peakInFlight = 0;
  const upsertLiveEventMirror = jest.fn(
    async (event: ILiveEventUpdateEvent): Promise<boolean> => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);

      if (event.data.sequence === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }

      inFlight -= 1;
      return false;
    }
  );

  await listener.init();
  Reflect.set(listener, "moderationService", {
    upsertLiveEventMirror,
    replayParkedForEvent: jest.fn(async () => undefined),
  });
  listener.listen();

  const eventId = "64ca2e7545b7e21471358910";
  channel.enqueue(
    brokerMessage(
      createLiveUpdateEvent({
        eventId,
        sequence: 1,
        markets: [createLiveMarket(eventId, { quoteVersion: 1 })],
      }),
      1
    ),
    brokerMessage(
      createLiveUpdateEvent({
        eventId,
        sequence: 2,
        markets: [createLiveMarket(eventId, { quoteVersion: 2 })],
      }),
      2
    )
  );

  await firstStarted.promise;
  await new Promise((resolve) => setImmediate(resolve));

  expect(channel.prefetch).toHaveBeenCalledWith(1);
  expect(upsertLiveEventMirror).toHaveBeenCalledTimes(1);
  expect(channel.acknowledged).toHaveLength(0);

  releaseFirst.resolve();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (channel.acknowledged.length === 2) {
      break;
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  expect(upsertLiveEventMirror).toHaveBeenCalledTimes(2);
  expect(peakInFlight).toEqual(1);
  expect(channel.acknowledged).toHaveLength(2);
  await listener.close();
});
