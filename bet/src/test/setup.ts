import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

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
    async init() {}
  }

  return {
    ...actual,
    AListener,
    messengerWrapper: { connection: {} },
    currentUser: (req: any, _res: any, next: () => void) => {
      const user = req.headers["currentuser"];
      if (user) {
        req.currentUser = JSON.parse(Array.isArray(user) ? user[0] : user);
      }
      next();
    },
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
