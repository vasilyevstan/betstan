import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { currentUser, errorHandler, messengerWrapper } from "@betstan/common";

jest.mock("@betstan/common", () => {
  const mocked = jest.createMockFromModule<typeof import("@betstan/common")>("@betstan/common");
  const actual = jest.requireActual<typeof import("@betstan/common")>("@betstan/common");
  (mocked.AListener.prototype.init as jest.Mock).mockImplementation(async function(this: any) {
    if (!this.channel) Object.defineProperty(this, "channel", { configurable: true, writable: true, value: {
      prefetch: jest.fn(async () => undefined), nack: jest.fn(), ack: jest.fn(), close: jest.fn(async () => undefined),
    } });
  });
  return {
    ...mocked,
    marketKey: actual.marketKey,
    marketObject: actual.marketObject,
    marketText: actual.marketText,
    marketDomainTime: actual.marketDomainTime,
    parseMarketBet: actual.parseMarketBet,
    assertMarketSlipCompatibility: actual.assertMarketSlipCompatibility,
    assertMarketPlacementBudget: actual.assertMarketPlacementBudget,
    MarketValidationError: actual.MarketValidationError,
  };
});
jest.setTimeout(60000);

let mongo: any;
const mockedCurrentUser = currentUser as jest.Mock;
const mockedErrorHandler = errorHandler as jest.Mock;

beforeAll(async () => {
  process.env.JWT_KEY = "qwerty";

  mockedCurrentUser.mockImplementation((req, _res, next) => {
    const currentUserHeader = req.headers.currentuser as string | undefined;
    const sessionJwtHeader = req.headers[
      "x-test-session-jwt"
    ] as string | undefined;

    if (sessionJwtHeader) {
      req.session = {
        ...(req.session ?? {}),
        jwt: sessionJwtHeader,
      };
    }

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
      nack: jest.fn(),
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
