import { EventEmitter } from "events";
import { Server } from "http";
import { ChannelModel } from "amqplib";
import {
  installTelemetryProcessHandlers,
  ManagedTelemetryConsumer,
  startTelemetry,
  TelemetryProcess,
  TelemetryRuntime,
  TelemetryStartupDependencies,
} from "../index";

const env = {
  MONGO_URI: "mongodb://telemetry.test/database",
  RABBITMQ_URI: "amqp://telemetry.test/broker",
  PORT: "3010",
} as NodeJS.ProcessEnv;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const createStartupHarness = () => {
  const order: string[] = [];
  let fatal: (() => void) | undefined;
  const server = {} as Server;
  const connection = Object.assign(new EventEmitter(), {
    close: jest.fn(async () => {
      order.push("rabbit:close");
    }),
  }) as unknown as ChannelModel;
  const consumer: ManagedTelemetryConsumer = {
    start: jest.fn(async () => {
      order.push("consumer:start");
    }),
    close: jest.fn(async () => {
      order.push("consumer:close");
    }),
  };
  const dependencies: TelemetryStartupDependencies = {
    closeServer: jest.fn(async () => {
      order.push("http:close");
    }),
    connectMongo: jest.fn(async () => {
      order.push("mongo:connect");
    }),
    connectRabbit: jest.fn(async () => {
      order.push("rabbit:connect");
      return connection;
    }),
    createConsumer: jest.fn((_connection, onFatal) => {
      order.push("consumer:create");
      fatal = onFatal;
      return consumer;
    }),
    disconnectMongo: jest.fn(async () => {
      order.push("mongo:close");
    }),
    initModel: jest.fn(async () => {
      order.push("model:init");
    }),
    listen: jest.fn(async () => {
      order.push("http:listen");
      return server;
    }),
  };
  return {
    connection,
    consumer,
    dependencies,
    fatal: () => fatal!,
    order,
    server,
  };
};

it("starts in exact dependency order and closes all resources", async () => {
  const harness = createStartupHarness();
  const runtime = await startTelemetry(env, harness.dependencies);

  expect(harness.order).toEqual([
    "mongo:connect",
    "model:init",
    "rabbit:connect",
    "consumer:create",
    "consumer:start",
    "http:listen",
  ]);
  expect(runtime.server).toBe(harness.server);

  await runtime.close();
  expect(harness.order.slice(6)).toEqual([
    "http:close",
    "consumer:close",
    "rabbit:close",
    "mongo:close",
  ]);
});

it("does not listen and closes partial resources after consumer startup failure", async () => {
  const harness = createStartupHarness();
  (harness.consumer.start as jest.Mock).mockRejectedValueOnce(
    new Error("consumer failed")
  );

  await expect(startTelemetry(env, harness.dependencies)).rejects.toThrow(
    "consumer failed"
  );

  expect(harness.dependencies.listen).not.toHaveBeenCalled();
  expect(harness.consumer.close).toHaveBeenCalledTimes(1);
  expect(harness.connection.close).toHaveBeenCalledTimes(1);
  expect(harness.dependencies.disconnectMongo).toHaveBeenCalledTimes(1);
});

it("handles a supervised fatal race before HTTP listen", async () => {
  const harness = createStartupHarness();
  (harness.consumer.start as jest.Mock).mockImplementationOnce(async () => {
    harness.fatal()();
  });

  await expect(startTelemetry(env, harness.dependencies)).rejects.toThrow(
    "telemetry_consumer_failed"
  );

  expect(harness.dependencies.listen).not.toHaveBeenCalled();
  expect(harness.consumer.close).toHaveBeenCalledTimes(1);
  expect(harness.connection.close).toHaveBeenCalledTimes(1);
  expect(harness.dependencies.disconnectMongo).toHaveBeenCalledTimes(1);
});

it("closes HTTP and all dependencies after a post-start consumer fatal", async () => {
  const harness = createStartupHarness();
  const runtime = await startTelemetry(env, harness.dependencies);

  harness.fatal()();
  await runtime.failed;
  await runtime.close();

  expect(harness.dependencies.closeServer).toHaveBeenCalledTimes(1);
  expect(harness.consumer.close).toHaveBeenCalledTimes(1);
  expect(harness.connection.close).toHaveBeenCalledTimes(1);
  expect(harness.dependencies.disconnectMongo).toHaveBeenCalledTimes(1);
});

it("keeps repeated signal handlers installed while one async cleanup completes", async () => {
  let resolveClose!: () => void;
  const close = jest.fn(
    () => new Promise<void>((resolve) => {
      resolveClose = resolve;
    })
  );
  const processEmitter = new EventEmitter() as EventEmitter & TelemetryProcess;
  processEmitter.exit = jest.fn();
  const runtime: TelemetryRuntime = {
    close,
    failed: new Promise<void>(() => undefined),
    server: {} as Server,
  };
  installTelemetryProcessHandlers(runtime, processEmitter);

  processEmitter.emit("SIGTERM");
  processEmitter.emit("SIGTERM");
  expect(close).toHaveBeenCalledTimes(1);
  expect(processEmitter.listenerCount("SIGTERM")).toBe(1);
  expect(processEmitter.exit).not.toHaveBeenCalled();

  resolveClose();
  await flush();
  expect(processEmitter.exit).toHaveBeenCalledTimes(1);
  expect(processEmitter.exit).toHaveBeenCalledWith(0);
});
