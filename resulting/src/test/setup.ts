import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

jest.mock("@betstan/common", () => {
  const mocked = jest.createMockFromModule<typeof import("@betstan/common")>("@betstan/common");
  class AListener<T> {
    ack = jest.fn();
    channel = { prefetch: jest.fn(), nack: jest.fn() };
    constructor(public connection: unknown) {}
    async init() {}
    listen = jest.fn();
  }
  return { ...mocked, AListener };
});
jest.setTimeout(60000);

let mongo: any;

beforeAll(async () => {
  if (process.env.CASH_BACK_INTEGRATION === "1") return;
  process.env.JWT_KEY = "qwerty";

  mongo = await MongoMemoryServer.create();
  const mongoUri = mongo.getUri();

  await mongoose.connect(mongoUri, {});
});

beforeEach(async () => {
  if (process.env.CASH_BACK_INTEGRATION === "1") return;
  jest.clearAllMocks();
  const collections = await mongoose.connection.db.collections();

  for (let collection of collections) {
    await collection.deleteMany({});
  }
});

afterAll(async () => {
  if (process.env.CASH_BACK_INTEGRATION === "1") return;
  if (mongo) {
    await mongo.stop();
  }
  await mongoose.connection.close();
});
