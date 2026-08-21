import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { liveEventHub } from "../live/LiveEventHub";

jest.mock("@betstan/common", () => {
  const actual = jest.requireActual("@betstan/common");
  const ack = jest.fn();
  const channel = {
    ack,
    nack: jest.fn(),
    assertExchange: jest.fn(),
    assertQueue: jest.fn(),
    bindQueue: jest.fn(),
    publish: jest.fn(),
  };

  class AListener<T> {
    public ack = ack;
    public channel = channel;
    constructor(public connection: unknown) {}

    get queueName() {
      return (this as any).serviceName;
    }

    get queueOptions() {
      return {};
    }

    async init() {
      await channel.assertExchange((this as any).queue, "fanout");
      await channel.assertQueue(this.queueName, this.queueOptions);
      channel.bindQueue(this.queueName, (this as any).queue, "");
    }
  }

  class APublisher<T> {
    constructor(public connection: unknown) {}
    async init() {}
    publish(_event: T) {}
  }
  APublisher.prototype.init = jest.fn(async () => {});
  APublisher.prototype.publish = jest.fn();

  return {
    ...actual,
    AListener,
    APublisher,
    messengerWrapper: { connection: {} },
  };
});

jest.setTimeout(60000);

let mongo: any;

beforeAll(async () => {
  process.env.JWT_KEY = "qwerty";

  mongo = await MongoMemoryServer.create();
  const mongoUri = mongo.getUri();

  await mongoose.connect(mongoUri, {});

  mongoose.connection.on("error", (e) => {
    console.log(e);
  });
});

beforeEach(async () => {
  jest.clearAllMocks();
  liveEventHub.reset();
  const collections = await mongoose.connection.db.collections();

  for (let collection of collections) {
    await collection.deleteMany({});
  }
});

afterAll(async () => {
  if (mongo) {
    await mongo.stop();
  }
  await mongoose.connection.close();
});
