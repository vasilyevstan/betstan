import { EventEmitter } from "events";
import ModerationRuntime, {
  ManagedListener,
  ManagedPublisher,
  ManagedWorker,
  ModerationRuntimeDependencies,
  ModerationRuntimeLogger,
} from "../ModerationRuntime";
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
