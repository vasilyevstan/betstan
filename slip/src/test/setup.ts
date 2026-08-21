import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { currentUser, errorHandler, messengerWrapper } from "@betstan/common";

jest.mock("@betstan/common");
jest.setTimeout(60000);

let mongo: any;
const mockedCurrentUser = currentUser as jest.Mock;
const mockedErrorHandler = errorHandler as jest.Mock;

beforeAll(async () => {
  process.env.JWT_KEY = "qwerty";

  mockedCurrentUser.mockImplementation((req, _res, next) => {
    const currentUserHeader = req.headers.currentuser as string | undefined;
    if (currentUserHeader) {
      req.currentUser = JSON.parse(currentUserHeader);
    }
    next();
  });

  mockedErrorHandler.mockImplementation((_req, _res, next) => {
    next();
  });

  (messengerWrapper as any).connection = {
    createChannel: jest.fn().mockResolvedValue({
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn(),
      consume: jest.fn(),
      ack: jest.fn(),
      publish: jest.fn(),
    }),
    createConfirmChannel: jest.fn().mockResolvedValue({
      assertExchange: jest.fn().mockResolvedValue(undefined),
      publish: jest.fn((_exchange, _routingKey, _content, _options, callback) =>
        callback(undefined)
      ),
    }),
  };

  mongo = await MongoMemoryServer.create();
  const mongoUri = mongo.getUri();

  await mongoose.connect(mongoUri, {
    autoIndex: false,
  });

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
