import { IAmqpConnection } from "@betstan/common";
import {
  ManagedResultingListener,
  ManagedBackgroundWorker,
  ResultingServiceConfig,
  ProcessLike,
  runResultingService,
  startResultingService,
} from "../startup";

const config: ResultingServiceConfig = {
  mongoUri: "mongodb://resulting.test/bootstrap",
  rabbitmqUri: "amqp://resulting.test/bootstrap",
};

const createProcessLike = () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const processLike: ProcessLike = {
    exit: jest.fn(),
    off: jest.fn().mockImplementation((event: string) => {
      handlers.delete(event);
      return processLike;
    }),
    on: jest.fn().mockImplementation((event: string, listener: (...args: any[]) => void) => {
      handlers.set(event, listener);
      return processLike;
    }),
    removeListener: jest.fn().mockImplementation((event: string) => {
      handlers.delete(event);
      return processLike;
    }),
  };

  return {
    handlers,
    processLike,
  };
};

const createConnection = (): IAmqpConnection => ({
  close: jest.fn().mockResolvedValue(undefined),
  createChannel: jest.fn().mockResolvedValue({}),
  createConfirmChannel: jest.fn().mockResolvedValue({}),
});

const createListener = (serviceName: string): ManagedResultingListener => ({
  init: jest.fn().mockResolvedValue(undefined),
  listen: jest.fn(),
  serviceName,
});

const createWorker = (): ManagedBackgroundWorker => ({
  init: jest.fn().mockResolvedValue(undefined),
  start: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
});

it("registers shutdown hooks before connecting and starts recovery before listeners listen", async () => {
  const order: string[] = [];
  const connection = createConnection();
  const { handlers, processLike } = createProcessLike();
  const listenerOne = createListener("listener-one");
  const listenerTwo = createListener("listener-two");
  const retryWorker = createWorker();
  const moderationWorker = createWorker();

  (listenerOne.init as jest.Mock).mockImplementation(async () => {
    order.push("listener-one:init");
  });
  (listenerOne.listen as jest.Mock).mockImplementation(() => {
    order.push("listener-one:listen");
  });
  (listenerTwo.init as jest.Mock).mockImplementation(async () => {
    order.push("listener-two:init");
  });
  (listenerTwo.listen as jest.Mock).mockImplementation(() => {
    order.push("listener-two:listen");
  });
  (retryWorker.init as jest.Mock).mockImplementation(async () => {
    order.push("retry:init");
  });
  (retryWorker.start as jest.Mock).mockImplementation(async () => {
    order.push("retry:start");
  });
  (moderationWorker.init as jest.Mock).mockImplementation(async () => {
    order.push("pending:init");
  });
  (moderationWorker.start as jest.Mock).mockImplementation(async () => {
    order.push("pending:start");
  });

  const runtime = await startResultingService(config, {
    closeBroker: jest.fn().mockResolvedValue(undefined),
    closeDb: jest.fn().mockResolvedValue(undefined),
    connectBroker: jest.fn().mockImplementation(async () => {
      expect(handlers.size).toEqual(3);
      order.push("connectBroker");
    }),
    connectDb: jest.fn().mockImplementation(async () => {
      order.push("connectDb");
    }),
    createListeners: jest.fn().mockReturnValue([listenerOne, listenerTwo]),
    createWorkers: jest
      .fn()
      .mockReturnValue([retryWorker, moderationWorker]),
    disconnectDb: jest.fn().mockResolvedValue(undefined),
    getBrokerConnection: jest.fn().mockReturnValue(connection),
    logger: {
      error: jest.fn(),
      log: jest.fn(),
    },
    processLike,
  });

  expect(order).toEqual([
    "connectBroker",
    "connectDb",
    "listener-one:init",
    "listener-two:init",
    "retry:init",
    "pending:init",
    "retry:start",
    "pending:start",
    "listener-one:listen",
    "listener-two:listen",
  ]);

  await runtime.shutdown(0);
});

it("fails closed on partial startup failure without starting any listener consumption and exits non-zero", async () => {
  const connection = createConnection();
  const { processLike } = createProcessLike();
  const listenerOne = createListener("listener-one");
  const listenerTwo = createListener("listener-two");
  const retryWorker = createWorker();
  const moderationWorker = createWorker();
  const closeBroker = jest.fn().mockResolvedValue(undefined);
  const closeDb = jest.fn().mockResolvedValue(undefined);
  const disconnectDb = jest.fn().mockResolvedValue(undefined);

  (moderationWorker.start as jest.Mock).mockRejectedValue(new Error("start failed"));

  const previousRabbit = process.env.RABBITMQ_URI;
  const previousMongo = process.env.MONGO_URI;
  process.env.RABBITMQ_URI = config.rabbitmqUri;
  process.env.MONGO_URI = config.mongoUri;

  try {
    await runResultingService({
      closeBroker,
      closeDb,
      connectBroker: jest.fn().mockResolvedValue(undefined),
      connectDb: jest.fn().mockResolvedValue(undefined),
      createListeners: jest.fn().mockReturnValue([listenerOne, listenerTwo]),
      createWorkers: jest
        .fn()
        .mockReturnValue([retryWorker, moderationWorker]),
      disconnectDb,
      getBrokerConnection: jest.fn().mockReturnValue(connection),
      logger: {
        error: jest.fn(),
        log: jest.fn(),
      },
      processLike,
    });
  } finally {
    process.env.RABBITMQ_URI = previousRabbit;
    process.env.MONGO_URI = previousMongo;
  }

  expect(listenerOne.listen).not.toHaveBeenCalled();
  expect(listenerTwo.listen).not.toHaveBeenCalled();
  expect(retryWorker.stop).toHaveBeenCalledTimes(1);
  expect(moderationWorker.stop).toHaveBeenCalledTimes(1);
  expect(closeBroker).toHaveBeenCalledTimes(1);
  expect(closeDb).toHaveBeenCalledTimes(1);
  expect(disconnectDb).toHaveBeenCalledTimes(1);
  expect(processLike.exit).toHaveBeenCalledWith(1);
});

it("shuts down idempotently", async () => {
  const connection = createConnection();
  const { processLike } = createProcessLike();
  const listener = createListener("listener-one");
  const retryWorker = createWorker();
  const moderationWorker = createWorker();
  const closeBroker = jest.fn().mockResolvedValue(undefined);
  const closeDb = jest.fn().mockResolvedValue(undefined);
  const disconnectDb = jest.fn().mockResolvedValue(undefined);

  const runtime = await startResultingService(config, {
    closeBroker,
    closeDb,
    connectBroker: jest.fn().mockResolvedValue(undefined),
    connectDb: jest.fn().mockResolvedValue(undefined),
    createListeners: jest.fn().mockReturnValue([listener]),
    createWorkers: jest
      .fn()
      .mockReturnValue([retryWorker, moderationWorker]),
    disconnectDb,
    getBrokerConnection: jest.fn().mockReturnValue(connection),
    logger: {
      error: jest.fn(),
      log: jest.fn(),
    },
    processLike,
  });

  await Promise.all([runtime.shutdown(0), runtime.shutdown(0)]);

  expect(retryWorker.stop).toHaveBeenCalledTimes(1);
  expect(moderationWorker.stop).toHaveBeenCalledTimes(1);
  expect(closeBroker).toHaveBeenCalledTimes(1);
  expect(closeDb).toHaveBeenCalledTimes(1);
  expect(disconnectDb).toHaveBeenCalledTimes(1);
  expect(processLike.exit).toHaveBeenCalledTimes(1);
});
