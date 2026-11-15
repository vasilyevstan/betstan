import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";

jest.mock("@betstan/common", () => {
  const mocked = jest.createMockFromModule<typeof import("@betstan/common")>("@betstan/common");
  const actual = jest.requireActual<typeof import("@betstan/common")>("@betstan/common");
  (mocked.AListener.prototype.init as jest.Mock).mockImplementation(async function(this: any) {
    if (!this.channel) Object.defineProperty(this, "channel", { configurable: true, value: {
      prefetch: jest.fn(async () => undefined), nack: jest.fn(), ack: jest.fn(), close: jest.fn(async () => undefined),
    } });
  });
  return {
    ...mocked,
    parseMarketBet: actual.parseMarketBet,
    assertMarketSlipCompatibility: actual.assertMarketSlipCompatibility,
    MarketValidationError: actual.MarketValidationError,
    nominalStakeMinor: actual.nominalStakeMinor,
    fixedOddsReturnMinor: actual.fixedOddsReturnMinor,
    realisedLossMinor: actual.realisedLossMinor,
    assertBetAccountingEvidence: actual.assertBetAccountingEvidence,
  };
});
jest.setTimeout(60000);

let mongo: any;

beforeAll(async () => {
  process.env.JWT_KEY = "qwerty";

  mongo = process.env.RISK_TEST_REPLSET === "true" || /[/\\]risk[/\\]/.test(expect.getState().testPath ?? "")
    ? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } })
    : await MongoMemoryServer.create();
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
