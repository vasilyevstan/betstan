import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
// import { app } from "../app";
import request from "supertest";
import jwt from "jsonwebtoken";
import { messengerWrapper } from "@betstan/common";
import Channel from "amqplib";
import SettleSlipPublisher from "../event/publisher/SettleSlipPublisher";

declare global {
  var signin: () => string[];
}

// jest.mock("@betstan/common", () => {
//   return {
//     __esModule: true,
//     ...jest.requireActual("@betstan/common"),
//     messengerWrapper: jest.fn(),
//     APublisher: {
//       init: jest.fn(),
//       getChannel: jest.fn(),
//     },
//     default: () => jest.fn(),
//   };
// });
jest.mock("@betstan/common");

// jest.mock("amqplib");

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

global.signin = () => {
  const id = new mongoose.Types.ObjectId().toHexString();
  // build JWT patload { id, email }
  const payload = {
    id: id,
    email: "test@test.com",
    timestamp: new Date(),
  };

  // create JWT
  const token = jwt.sign(payload, process.env.JWT_KEY!);

  // build session object { jwt: MY_JWT }
  const session = { jwt: token };

  // turn that session into json
  const sessionJSON = JSON.stringify(session);

  // take json and encode it as base64
  const base64 = Buffer.from(sessionJSON).toString("base64");

  // return a string that's a cookie
  return [`session=${base64}`];
};
