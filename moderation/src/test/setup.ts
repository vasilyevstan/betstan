import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

jest.mock("@betstan/common", () => {
  const mocked = jest.createMockFromModule<typeof import("@betstan/common")>("@betstan/common");
  const actual = jest.requireActual<typeof import("@betstan/common")>("@betstan/common");
  return {
    ...mocked,
    parseMarketBet: actual.parseMarketBet,
    assertMarketSlipCompatibility: actual.assertMarketSlipCompatibility,
    MarketValidationError: actual.MarketValidationError,
  };
});
jest.setTimeout(60000);

let mongo: any;

beforeAll(async () => {
  process.env.JWT_KEY = "qwerty";

  mongo = await MongoMemoryServer.create();
  const mongoUri = mongo.getUri();

  await mongoose.connect(mongoUri, {});
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
