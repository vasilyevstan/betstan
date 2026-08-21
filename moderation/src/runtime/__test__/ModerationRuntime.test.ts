import { EventEmitter } from "events";
import mongoose from "mongoose";
import { messengerWrapper } from "@betstan/common";
import EventResultListener from "../../event/listener/EventResultListener";
import LiveEventUpdateListener from "../../event/listener/LiveEventUpdateListener";
import PlaceBetListener from "../../event/listener/PlaceBetListener";
import BetModerationResultPublisher from "../../event/publisher/BetModerationResultPublisher";
import ModerationRuntime, {
  createDefaultModerationRuntime,
  ManagedListener,
  ManagedPublisher,
  ManagedWorker,
  ModerationRuntimeDependencies,
  ModerationRuntimeLogger,
} from "../ModerationRuntime";
import ParkedPlaceBetReplayWorker from "../../worker/ParkedPlaceBetReplayWorker";
import { createDeferred } from "../../event/listener/__test__/helpers";

class TestProcess extends EventEmitter {
  exit = jest.fn();

  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

const createLogger = (): ModerationRuntimeLogger => ({
  log: jest.fn(),
  error: jest.fn(),
});

const createListener = (
  name: string,
  events: string[],
  initError?: Error
): ManagedListener & { close: jest.Mock<Promise<void>, []> } => ({
  init: jest.fn(async () => {
    events.push(`${name}:init`);
    if (initError) {
      throw initError;
    }
  }),
  listen: jest.fn(() => {
    events.push(`${name}:listen`);
  }),
  close: jest.fn(async () => {
    events.push(`${name}:close`);
  }),
});

const createPublisher = (events: string[]): ManagedPublisher & {
  close: jest.Mock<Promise<void>, []>;
} => ({
  init: jest.fn(async () => {
    events.push("replay-publisher:init");
  }),
  initConfirmChannel: jest.fn(async () => {
    events.push("replay-publisher:init-confirm");
  }),
  publishWithConfirm: jest.fn(async () => undefined),
  close: jest.fn(async () => {
    events.push("replay-publisher:close");
  }),
});

const createWorker = (
  events: string[],
  overrides: Partial<ManagedWorker> = {}
): ManagedWorker & { stop: jest.Mock<Promise<void>, []> } => ({
  start: overrides.start ?? jest.fn(async () => {
    events.push("worker:start");
  }),
  stop: (overrides.stop as jest.Mock<Promise<void>, []>)
    ?? jest.fn(async () => {
      events.push("worker:stop");
    }),
});

const createDependencies = (
  overrides: Partial<ModerationRuntimeDependencies> = {},
  decorateProcess?: (runtimeProcess: TestProcess, events: string[]) => void,
  createWorkerOverride?: (
    events: string[],
    replayPublisher: ManagedPublisher
  ) => ManagedWorker
) => {
  const {
    createWorker: overrideCreateWorker,
    ...dependencyOverrides
  } = overrides;
  const events: string[] = [];
  const runtimeProcess = new TestProcess();
  decorateProcess?.(runtimeProcess, events);
  const logger = createLogger();
  const replayPublisher = createPublisher(events);
  const listeners = [
    createListener("place-bet-listener", events),
    createListener("live-update-listener", events),
  ];
  const listenerRefs = [...listeners];
  const worker = createWorker(events);
  let createdWorker = worker;

  const dependencies: ModerationRuntimeDependencies = {
    env: {
      RABBITMQ_URI: "amqp://rabbitmq",
      MONGO_URI: "mongodb://mongo",
    },
    process: runtimeProcess,
    logger,
    connectMessaging: async () => {
      events.push("connect:messaging");
    },
    closeMessaging: async () => {
      events.push("close:messaging");
    },
    connectDatabase: async () => {
      events.push("connect:database");
    },
    closeDatabase: async () => {
      events.push("close:database");
    },
    disconnectDatabase: async () => {
      events.push("disconnect:database");
    },
    createReplayPublisher: () => replayPublisher,
    createWorker: () => {
      const nextWorker =
        createWorkerOverride?.(events, replayPublisher)
        ?? overrideCreateWorker?.(replayPublisher)
        ?? worker;
      createdWorker = nextWorker as typeof worker;
      return nextWorker;
    },
    createListeners: () => listeners,
    ...dependencyOverrides,
  };

  const runtime = new ModerationRuntime(dependencies);

  return {
    events,
    runtime,
    runtimeProcess,
    logger,
    replayPublisher,
    listeners: listenerRefs,
    getWorker: () => createdWorker,
  };
};

it("starts all resources before any listener begins consuming", async () => {
  const { runtime, events, runtimeProcess } = createDependencies(
    {},
    (process, events) => {
      const on = process.on.bind(process);
      process.on = ((event: string, listener: (...args: any[]) => void) => {
        events.push(`hook:${event}`);
        return on(event, listener);
      }) as typeof process.on;
    }
  );

  await runtime.start();

  expect(events).toEqual([
    "hook:SIGINT",
    "hook:SIGTERM",
    "hook:uncaughtException",
    "connect:messaging",
    "connect:database",
    "replay-publisher:init",
    "replay-publisher:init-confirm",
    "place-bet-listener:init",
    "live-update-listener:init",
    "worker:start",
    "place-bet-listener:listen",
    "live-update-listener:listen",
  ]);
  expect(runtimeProcess.exit).not.toHaveBeenCalled();
});

it("fails closed on partial startup and never calls listen", async () => {
  const { runtime, events, listeners, replayPublisher, getWorker } = createDependencies(
    {},
    undefined,
    (events) =>
      createWorker(events, {
        start: jest.fn(async () => {
          events.push("worker:start");
          throw new Error("worker init failed");
        }),
      })
  );

  await expect(runtime.start()).rejects.toThrow("worker init failed");

  expect(listeners[0].listen).not.toHaveBeenCalled();
  expect(listeners[1].listen).not.toHaveBeenCalled();
  expect(replayPublisher.close).toHaveBeenCalledTimes(1);
  expect(listeners[0].close).toHaveBeenCalledTimes(1);
  expect(listeners[1].close).toHaveBeenCalledTimes(1);
  expect((getWorker().stop as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(1);
  expect(events).toEqual([
    "connect:messaging",
    "connect:database",
    "replay-publisher:init",
    "replay-publisher:init-confirm",
    "place-bet-listener:init",
    "live-update-listener:init",
    "worker:start",
    "worker:stop",
    "live-update-listener:close",
    "place-bet-listener:close",
    "replay-publisher:close",
    "close:messaging",
    "close:database",
    "disconnect:database",
  ]);
});

it("awaits in-flight shutdown exactly once for signals", async () => {
  const workerStop = createDeferred<void>();
  const { runtime, runtimeProcess, getWorker, listeners, replayPublisher } = createDependencies(
    {},
    undefined,
    () =>
      createWorker([], {
        start: jest.fn(async () => undefined),
        stop: jest.fn(async () => {
          await workerStop.promise;
        }),
      }),
  );

  await runtime.start();

  runtimeProcess.emit("SIGTERM");
  await Promise.resolve();
  runtimeProcess.emit("SIGINT");
  await Promise.resolve();

  expect(runtimeProcess.exit).not.toHaveBeenCalled();
  expect(getWorker().stop).toHaveBeenCalledTimes(1);

  workerStop.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  expect(listeners[0].close).toHaveBeenCalledTimes(1);
  expect(listeners[1].close).toHaveBeenCalledTimes(1);
  expect(replayPublisher.close).toHaveBeenCalledTimes(1);
  expect(runtimeProcess.exit).toHaveBeenCalledTimes(1);
  expect(runtimeProcess.exit).toHaveBeenCalledWith(0);
});

it("fails fast when RABBITMQ_URI is missing", async () => {
  const { runtime, events, listeners, replayPublisher } = createDependencies({
    env: {
      MONGO_URI: "mongodb://mongo",
    },
  });

  await expect(runtime.start()).rejects.toThrow("Missing RABBITMQ_URI variable");

  expect(events).toEqual([
    "close:messaging",
    "close:database",
    "disconnect:database",
  ]);
  expect(replayPublisher.init).not.toHaveBeenCalled();
  expect(listeners[0].init).not.toHaveBeenCalled();
});

it("fails fast when MONGO_URI is missing", async () => {
  const { runtime, events, listeners, replayPublisher } = createDependencies({
    env: {
      RABBITMQ_URI: "amqp://rabbitmq",
    },
  });

  await expect(runtime.start()).rejects.toThrow("Missing MONGO_URI variable");

  expect(events).toEqual([
    "close:messaging",
    "close:database",
    "disconnect:database",
  ]);
  expect(replayPublisher.init).not.toHaveBeenCalled();
  expect(listeners[0].init).not.toHaveBeenCalled();
});

it("memoizes shutdown and falls back to removeListener when off is unavailable", async () => {
  const { runtime, runtimeProcess, getWorker } = createDependencies();
  const removeListener = jest.fn((event: string, listener: (...args: any[]) => void) =>
    EventEmitter.prototype.removeListener.call(runtimeProcess, event, listener)
  );

  Object.defineProperty(runtimeProcess, "off", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(runtimeProcess, "removeListener", {
    configurable: true,
    value: removeListener,
  });

  await runtime.start();

  const firstShutdown = runtime.shutdown();
  const secondShutdown = runtime.shutdown();

  expect((runtime as any).shutdownPromise).not.toBeNull();

  await Promise.all([firstShutdown, secondShutdown]);

  expect(getWorker().stop).toHaveBeenCalledTimes(1);
  expect(removeListener).toHaveBeenCalledTimes(3);
});

it("reports startup and cleanup failures together", async () => {
  const { runtime } = createDependencies(
    {
      closeMessaging: async () => {
        throw "close messaging failed";
      },
    },
    undefined,
    (events) =>
      createWorker(events, {
        start: jest.fn(async () => {
          events.push("worker:start");
          throw new Error("worker init failed");
        }),
      })
  );

  await expect(runtime.start()).rejects.toThrow(
    "Runtime startup failed: worker init failed; cleanup failed: close messaging failed"
  );
});

it("does not install duplicate signal hooks", async () => {
  const { runtime, runtimeProcess } = createDependencies();

  (runtime as any).installHooks();
  (runtime as any).installHooks();

  expect(runtimeProcess.listenerCount("SIGINT")).toEqual(1);
  expect(runtimeProcess.listenerCount("SIGTERM")).toEqual(1);
  expect(runtimeProcess.listenerCount("uncaughtException")).toEqual(1);

  await runtime.shutdown();
});

it("logs uncaught exceptions and exits after shutdown", async () => {
  const { runtime, runtimeProcess, logger, getWorker } = createDependencies();

  await runtime.start();
  runtimeProcess.emit("uncaughtException", new Error("fatal boom"));
  await new Promise((resolve) => setImmediate(resolve));

  expect(logger.error).toHaveBeenCalledWith(
    "logging general error",
    expect.any(Error)
  );
  expect(getWorker().stop).toHaveBeenCalledTimes(1);
  expect(runtimeProcess.exit).toHaveBeenCalledWith(1);
});

it("logs shutdown failures and exits nonzero for signals", async () => {
  const { runtime, runtimeProcess, logger, listeners, replayPublisher } = createDependencies(
    {},
    undefined,
    (events) =>
      createWorker(events, {
        stop: jest.fn(async () => {
          events.push("worker:stop");
          throw new Error("stop failed");
        }),
      })
  );

  await runtime.start();
  runtimeProcess.emit("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));

  expect(listeners[0].close).toHaveBeenCalledTimes(1);
  expect(listeners[1].close).toHaveBeenCalledTimes(1);
  expect(replayPublisher.close).toHaveBeenCalledTimes(1);
  expect(logger.error).toHaveBeenCalledWith(
    "runtime shutdown failed",
    expect.any(Error)
  );
  expect(runtimeProcess.exit).toHaveBeenCalledWith(1);
});

it("wires default runtime helpers for messaging, database, worker, and listeners", async () => {
  const defaultRuntime = createDefaultModerationRuntime();
  const runtimeProcess = new TestProcess();
  const logger = createLogger();
  const runtime = createDefaultModerationRuntime(
    {
      RABBITMQ_URI: "amqp://rabbitmq",
      MONGO_URI: "mongodb://mongo",
      MODERATION_PARKING_BATCH_SIZE: "2",
    },
    runtimeProcess,
    logger
  ) as any;
  const dependencies = runtime.dependencies as ModerationRuntimeDependencies;
  const originalConnection = Reflect.get(messengerWrapper, "_connection");
  const originalRuntimeConnection = Reflect.get(messengerWrapper, "connection");
  const connectMock = messengerWrapper.connect as unknown as jest.Mock;
  const connectSpy = jest.spyOn(mongoose, "connect").mockResolvedValue(mongoose as any);
  const disconnectSpy = jest
    .spyOn(mongoose, "disconnect")
    .mockResolvedValue(mongoose as any);
  const closeSpy = jest
    .spyOn(mongoose.connection, "close")
    .mockResolvedValue(mongoose.connection as any);
  const readyStateDescriptor = Object.getOwnPropertyDescriptor(
    mongoose.connection,
    "readyState"
  );
  const connectionClose = jest.fn(async () => undefined);

  expect(defaultRuntime).toBeInstanceOf(ModerationRuntime);

  connectMock.mockResolvedValue(undefined);
  Reflect.set(messengerWrapper, "_connection", {
    close: connectionClose,
  });
  Reflect.set(messengerWrapper, "connection", {
    connection: "runtime",
  });

  try {
    await dependencies.connectMessaging("amqp://rabbitmq");
    await dependencies.closeMessaging();

    Reflect.set(messengerWrapper, "_connection", undefined);
    await dependencies.closeMessaging();

    await dependencies.connectDatabase("mongodb://mongo");

    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      get: () => 0,
    });
    await dependencies.closeDatabase();
    await dependencies.disconnectDatabase();

    Object.defineProperty(mongoose.connection, "readyState", {
      configurable: true,
      get: () => 1,
    });
    await dependencies.closeDatabase();
    await dependencies.disconnectDatabase();

    const replayPublisher = dependencies.createReplayPublisher();
    const worker = dependencies.createWorker(replayPublisher);
    const listeners = dependencies.createListeners();

    expect(logger.log).toHaveBeenCalledWith("Connecting to: ", "amqp://rabbitmq");
    expect(connectMock).toHaveBeenCalledWith("amqp://rabbitmq");
    expect(connectionClose).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledWith("mongodb://mongo");
    expect(logger.log).toHaveBeenCalledWith("Connected to database");
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(replayPublisher).toBeInstanceOf(BetModerationResultPublisher);
    expect(worker).toBeInstanceOf(ParkedPlaceBetReplayWorker);
    expect(listeners).toHaveLength(3);
    expect(listeners[0]).toBeInstanceOf(PlaceBetListener);
    expect(listeners[1]).toBeInstanceOf(LiveEventUpdateListener);
    expect(listeners[2]).toBeInstanceOf(EventResultListener);
  } finally {
    if (readyStateDescriptor) {
      Object.defineProperty(mongoose.connection, "readyState", readyStateDescriptor);
    } else {
      delete (mongoose.connection as { readyState?: number }).readyState;
    }

    Reflect.set(messengerWrapper, "_connection", originalConnection);
    Reflect.set(messengerWrapper, "connection", originalRuntimeConnection);
    connectSpy.mockRestore();
    disconnectSpy.mockRestore();
    closeSpy.mockRestore();
  }
});
