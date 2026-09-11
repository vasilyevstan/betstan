import { EventEmitter } from "events";
import { Channel, ChannelModel } from "amqplib";
import { AuthTelemetryReporter } from "../TelemetryReporter";

const createHarness = () => {
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockReturnValue(true),
  }) as unknown as jest.Mocked<Channel>;
  const connection = Object.assign(new EventEmitter(), {
    close: jest.fn().mockResolvedValue(undefined),
    createChannel: jest.fn().mockResolvedValue(channel),
  }) as unknown as jest.Mocked<ChannelModel>;
  const connect = jest.fn().mockResolvedValue(connection);
  const logger = { error: jest.fn() };
  const reporter = new AuthTelemetryReporter({
    connect,
    logger,
    now: () => new Date("2026-09-10T02:00:00.000Z"),
    timeoutMs: 20,
    uuid: () => "9A6B8A5F-D9EA-4F4C-8C0A-7D39B9A55C12",
  });
  return { channel, connect, connection, logger, reporter };
};

it("is a no-op without Rabbit and makes at most one initialization attempt", async () => {
  const harness = createHarness();
  await harness.reporter.initialize(undefined);
  await harness.reporter.initialize("amqp://later");
  harness.reporter.report("USER_CREATED");

  expect(harness.connect).not.toHaveBeenCalled();
  expect(harness.channel.publish).not.toHaveBeenCalled();
  expect(harness.logger.error).toHaveBeenCalledWith("auth_telemetry_disabled");
});

it("fails open after a refused bounded connection and never retries", async () => {
  const harness = createHarness();
  harness.connect.mockRejectedValueOnce(new Error("private uri refusal"));

  await expect(
    harness.reporter.initialize("amqp://private")
  ).resolves.toBeUndefined();
  await harness.reporter.initialize("amqp://private");
  harness.reporter.report("USER_LOGGED_IN");

  expect(harness.connect).toHaveBeenCalledTimes(1);
  expect(harness.channel.publish).not.toHaveBeenCalled();
  expect(harness.logger.error).toHaveBeenCalledWith("auth_telemetry_disabled");
  expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain(
    "private"
  );
});

it("asserts the durable fanout and publishes the exact anonymous envelope", async () => {
  const harness = createHarness();
  await harness.reporter.initialize("amqp://rabbit");
  harness.reporter.report("USER_CREATED");

  expect(harness.channel.assertExchange).toHaveBeenCalledWith(
    "telemetry:event:v1",
    "fanout",
    { durable: true }
  );
  expect(harness.channel.publish).toHaveBeenCalledTimes(1);
  const [exchange, key, content, options] =
    harness.channel.publish.mock.calls[0];
  expect(exchange).toBe("telemetry:event:v1");
  expect(key).toBe("");
  expect(options).toEqual({
    contentType: "application/json",
    persistent: true,
  });
  expect(JSON.parse(content.toString())).toEqual({
    data: {
      metric: "USER_CREATED",
      eventId: "9a6b8a5f-d9ea-4f4c-8c0a-7d39b9a55c12",
      occurredAt: "2026-09-10T02:00:00.000Z",
    },
    timestamp: "2026-09-10T02:00:00.000Z",
    sender: "auth",
  });
  expect(content.toString()).not.toContain("userId");
  expect(content.toString()).not.toContain("email");
});

it("contains synchronous publish failures and permanently disables on close", async () => {
  const harness = createHarness();
  await harness.reporter.initialize("amqp://rabbit");
  harness.channel.publish.mockImplementationOnce(() => {
    throw new Error("serialization");
  });
  expect(() => harness.reporter.report("USER_CREATED")).not.toThrow();
  expect(harness.logger.error).toHaveBeenCalledWith(
    "auth_telemetry_publish_failed"
  );

  (harness.channel as unknown as EventEmitter).emit("close");
  harness.reporter.report("USER_LOGGED_IN");
  expect(harness.channel.publish).toHaveBeenCalledTimes(1);
});

describe("bounded initialization timeouts", () => {
  const flushMicrotasks = async () => {
    for (let index = 0; index < 6; index += 1) {
      await Promise.resolve();
    }
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("settles a never-resolving connect, never retries, and closes a late connection", async () => {
    const harness = createHarness();
    let resolveConnection!: (connection: ChannelModel) => void;
    harness.connect.mockReturnValueOnce(
      new Promise<ChannelModel>((resolve) => {
        resolveConnection = resolve;
      })
    );

    const initializing = harness.reporter.initialize("amqp://rabbit");
    await jest.advanceTimersByTimeAsync(20);
    await expect(initializing).resolves.toBeUndefined();
    await harness.reporter.initialize("amqp://rabbit");
    harness.reporter.report("USER_CREATED");

    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(harness.channel.publish).not.toHaveBeenCalled();

    resolveConnection(harness.connection);
    await flushMicrotasks();
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
  });

  it("settles a never-resolving channel creation and closes a late channel", async () => {
    const harness = createHarness();
    let resolveChannel!: (channel: Channel) => void;
    harness.connection.createChannel.mockReturnValueOnce(
      new Promise<Channel>((resolve) => {
        resolveChannel = resolve;
      })
    );

    const initializing = harness.reporter.initialize("amqp://rabbit");
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(20);
    await expect(initializing).resolves.toBeUndefined();
    await harness.reporter.initialize("amqp://rabbit");
    harness.reporter.report("USER_CREATED");
    expect(harness.channel.publish).not.toHaveBeenCalled();
    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(harness.connection.createChannel).toHaveBeenCalledTimes(1);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);

    resolveChannel(harness.channel);
    await flushMicrotasks();
    expect(harness.channel.close).toHaveBeenCalledTimes(1);
  });

  it("settles a never-resolving exchange assertion and closes created resources", async () => {
    const harness = createHarness();
    harness.channel.assertExchange.mockReturnValueOnce(
      new Promise(() => undefined)
    );

    const initializing = harness.reporter.initialize("amqp://rabbit");
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(20);
    await expect(initializing).resolves.toBeUndefined();
    await harness.reporter.initialize("amqp://rabbit");
    harness.reporter.report("USER_CREATED");

    expect(harness.connect).toHaveBeenCalledTimes(1);
    expect(harness.channel.assertExchange).toHaveBeenCalledTimes(1);
    expect(harness.channel.publish).not.toHaveBeenCalled();
    expect(harness.channel.close).toHaveBeenCalledTimes(1);
    expect(harness.connection.close).toHaveBeenCalledTimes(1);
  });
});
