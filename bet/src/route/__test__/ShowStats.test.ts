import { createHash } from "crypto";
import request from "supertest";
import mongoose from "mongoose";
import { app } from "../../app";
import { Bet } from "../../model/Bet";
import { BetKind, BetStatus, SlipRowStatus } from "@betstan/common";
import {
  LEGACY_PUBLIC_SCOREBOARD_LIMIT,
  PUBLIC_SCOREBOARD_LIMIT,
} from "../../service/publicBetStats";

const createPublicUserKey = (userId: string) =>
  createHash("sha256").update(userId).digest("hex").slice(0, 12);

const buildRow = (overrides: Record<string, unknown> = {}) => ({
  eventId: new mongoose.Types.ObjectId().toHexString(),
  eventName: "Team A - Team B",
  oddsId: new mongoose.Types.ObjectId().toHexString(),
  oddsValue: 1.5,
  oddsName: "Team A",
  productName: "1X2",
  productId: new mongoose.Types.ObjectId().toHexString(),
  timestamp: new Date().toISOString(),
  status: SlipRowStatus.NOT_SETTLED,
  id: new mongoose.Types.ObjectId().toHexString(),
  ...overrides,
});

const buildStoredBet = (overrides: Record<string, unknown> = {}) => ({
  status: BetStatus.CONFIRMED,
  userId: new mongoose.Types.ObjectId().toHexString(),
  userName: "private@example.com",
  slipId: new mongoose.Types.ObjectId().toHexString(),
  wager: 5,
  timestamp: new Date().toISOString(),
  rows: [buildRow()],
  ...overrides,
});

const createBet = async (overrides: Record<string, unknown> = {}) => {
  const bet = new Bet(buildStoredBet(overrides));
  await bet.save();
  return bet;
};

it("keeps the previous visible user names while hiding raw IDs and full emails", async () => {
  const aggregateRows = [
    {
      _id: "alpha-user",
      userName: "alpha@example.com",
      betCount: 2,
      wagerTotal: 5,
    },
    {
      _id: "beta-user",
      userName: "beta@example.com",
      betCount: 2,
      wagerTotal: 5,
    },
  ];

  const aggregateSpy = jest.spyOn(Bet, "aggregate").mockImplementation(
    ((..._args: unknown[]) => Promise.resolve(aggregateRows)) as any
  );

  try {
    const firstResponse = await request(app).get("/api/bet/stats/v2").send().expect(200);
    const secondResponse = await request(app).get("/api/bet/stats/v2").send().expect(200);

    expect(secondResponse.body).toEqual(firstResponse.body);
    expect(aggregateSpy).toHaveBeenCalledTimes(2);

    const pipeline = aggregateSpy.mock.calls[0][0];
    expect(pipeline).toEqual([
      {
        $match: {
          userId: {
            $type: "string",
            $ne: "",
          },
        },
      },
      {
        $group: {
          _id: "$userId",
          userName: { $max: "$userName" },
          betCount: { $sum: 1 },
          wagerTotal: {
            $sum: {
              $let: {
                vars: {
                  wagerNumber: {
                    $convert: {
                      input: "$wager",
                      to: "double",
                      onError: 0,
                      onNull: 0,
                    },
                  },
                },
                in: {
                  $cond: [{ $gte: ["$$wagerNumber", 0] }, "$$wagerNumber", 0],
                },
              },
            },
          },
        },
      },
      {
        $sort: {
          betCount: -1,
          wagerTotal: -1,
          _id: 1,
        },
      },
      {
        $limit: PUBLIC_SCOREBOARD_LIMIT,
      },
    ]);

    const firstUserKey = createPublicUserKey("alpha-user");
    const secondUserKey = createPublicUserKey("beta-user");
    expect(firstResponse.body).toEqual([
      {
        userKey: firstUserKey,
        displayName: "alpha",
        betCount: 2,
        wagerTotal: 5,
      },
      {
        userKey: secondUserKey,
        displayName: "beta",
        betCount: 2,
        wagerTotal: 5,
      },
    ]);
    expect(firstResponse.text).not.toContain("alpha-user");
    expect(firstResponse.text).not.toContain("beta-user");
    expect(firstResponse.text).not.toContain("@example.com");
    expect(firstResponse.text).not.toContain("_id");
  } finally {
    aggregateSpy.mockRestore();
  }
});

it("keeps the old client contract and its previous display-name truncation", async () => {
  const aggregateRows = [
    {
      userId: "alpha-user",
      userName: "abcdefghijklmnopq@example.com",
      wager: 5,
    },
  ];
  const aggregateSpy = jest.spyOn(Bet, "aggregate").mockImplementation(
    ((..._args: unknown[]) => Promise.resolve(aggregateRows)) as any
  );

  try {
    const response = await request(app).get("/api/bet/stats").send().expect(200);
    const userKey = createPublicUserKey("alpha-user");
    const pipeline = aggregateSpy.mock.calls[0][0] as unknown as Array<
      Record<string, Record<string, unknown> | number>
    >;

    expect(response.body).toEqual([
      {
        userId: userKey,
        userName: "abcdefghijklmnop…",
        wager: 5,
      },
    ]);
    expect(response.text).not.toContain("alpha-user");
    expect(pipeline.find((stage) => "$limit" in stage)?.$limit).toEqual(
      LEGACY_PUBLIC_SCOREBOARD_LIMIT
    );
    expect(pipeline.find((stage) => "$project" in stage)?.$project).toEqual(
      expect.objectContaining({
        _id: 0,
        userId: 1,
        userName: 1,
      })
    );
    expect(response.text).not.toContain("@example.com");
  } finally {
    aggregateSpy.mockRestore();
  }
});

it("returns grouped previous display names across live and legacy bets", async () => {
  const firstUserId = "alpha-user";
  const secondUserId = "beta-user";
  const firstLegacySlipId = new mongoose.Types.ObjectId().toHexString();

  await createBet({
    userId: firstUserId,
    userName: "alpha@example.com",
    wager: 5,
    betKind: BetKind.LIVE,
  });
  await Bet.collection.insertOne(
    buildStoredBet({
      userId: firstUserId,
      userName: "alpha@example.com",
      slipId: firstLegacySlipId,
      wager: "not-a-number",
      rows: [buildRow({ eventName: "Legacy Event" })],
    })
  );
  await createBet({
    userId: secondUserId,
    userName: "beta@example.com",
    wager: 3,
    betKind: BetKind.PRE_MATCH,
  });
  await createBet({
    userId: secondUserId,
    userName: "beta@example.com",
    wager: 2,
    betKind: BetKind.LIVE,
  });
  await createBet({
    userId: "third-user",
    userName: "third@example.com",
    wager: 1,
  });

  const firstResponse = await request(app).get("/api/bet/stats/v2").send().expect(200);
  const secondResponse = await request(app).get("/api/bet/stats/v2").send().expect(200);

  expect(secondResponse.body).toEqual(firstResponse.body);
  expect(Array.isArray(firstResponse.body)).toBe(true);
  expect(firstResponse.body).toHaveLength(3);

  const firstUserKey = createPublicUserKey(firstUserId);
  const secondUserKey = createPublicUserKey(secondUserId);
  expect(firstResponse.body[0]).toEqual({
    userKey: firstUserKey,
    displayName: "alpha",
    betCount: 2,
    wagerTotal: 5,
  });
  expect(firstResponse.body[1]).toEqual({
    userKey: secondUserKey,
    displayName: "beta",
    betCount: 2,
    wagerTotal: 5,
  });

  for (const statRow of firstResponse.body) {
    expect(Object.keys(statRow).sort()).toEqual([
      "betCount",
      "displayName",
      "userKey",
      "wagerTotal",
    ]);
    expect(statRow).not.toHaveProperty("userId");
    expect(statRow).not.toHaveProperty("userName");
    expect(statRow).not.toHaveProperty("slipId");
    expect(statRow).not.toHaveProperty("rows");
  }

  expect(firstResponse.text).not.toContain("alpha@example.com");
  expect(firstResponse.text).not.toContain("beta@example.com");
  expect(firstResponse.text).not.toContain(firstLegacySlipId);
});

it("caps the public scoreboard to the configured top users in deterministic rank order", async () => {
  const betDocuments = Array.from(
    { length: PUBLIC_SCOREBOARD_LIMIT + 5 },
    (_value, index) =>
      buildStoredBet({
        userId: `cap-user-${index}`,
        userName: `private${index}@example.com`,
        wager: PUBLIC_SCOREBOARD_LIMIT + 5 - index,
      })
  );

  await Bet.collection.insertMany(betDocuments);

  const response = await request(app).get("/api/bet/stats/v2").send().expect(200);

  expect(response.body).toHaveLength(PUBLIC_SCOREBOARD_LIMIT);

  const highestRankedUserKey = createPublicUserKey("cap-user-0");
  const lastIncludedUserKey = createPublicUserKey(
    `cap-user-${PUBLIC_SCOREBOARD_LIMIT - 1}`
  );
  const excludedUserKey = createPublicUserKey(`cap-user-${PUBLIC_SCOREBOARD_LIMIT}`);

  expect(response.body[0]).toEqual({
    userKey: highestRankedUserKey,
    displayName: "private0",
    betCount: 1,
    wagerTotal: PUBLIC_SCOREBOARD_LIMIT + 5,
  });
  expect(response.body[PUBLIC_SCOREBOARD_LIMIT - 1]).toEqual({
    userKey: lastIncludedUserKey,
    displayName: `private${PUBLIC_SCOREBOARD_LIMIT - 1}`,
    betCount: 1,
    wagerTotal: 6,
  });
  expect(
    response.body.some(
      (row: { userKey: string }) => row.userKey === excludedUserKey
    )
  ).toBe(false);
});

it("returns empty array when no bets exist", async () => {
  const legacyResponse = await request(app).get("/api/bet/stats").send().expect(200);
  const response = await request(app).get("/api/bet/stats/v2").send().expect(200);

  expect(legacyResponse.body).toEqual([]);
  expect(Array.isArray(response.body)).toBe(true);
  expect(response.body.length).toEqual(0);
});
