const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const common = require("../build");
const legacyCommon = require("legacy-common");

test("repository owns common source while services consume one exact package", () => {
  const packageRoot = path.resolve(__dirname, "..");
  const repositoryRoot = path.resolve(packageRoot, "..");
  const serviceNames = [
    "auth",
    "backoffice",
    "bet",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
  ];

  assert.equal(fs.lstatSync(packageRoot).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(packageRoot, ".git")), false);

  const packageManifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  assert.equal(packageManifest.name, "@betstan/common");

  const pins = serviceNames.map((serviceName) => {
    const serviceRoot = path.join(repositoryRoot, serviceName);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(serviceRoot, "package.json"), "utf8"),
    );
    const lock = JSON.parse(
      fs.readFileSync(path.join(serviceRoot, "package-lock.json"), "utf8"),
    );
    const pin = manifest.dependencies?.["@betstan/common"];

    assert.match(pin, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
    assert.equal(lock.packages?.[""]?.dependencies?.["@betstan/common"], pin);
    assert.equal(lock.packages?.["node_modules/@betstan/common"]?.version, pin);
    return pin;
  });

  assert.equal(new Set(pins).size, 1);
});

class FakeChannel {
  constructor(confirmError) {
    this.confirmError = confirmError;
    this.calls = [];
  }

  async assertExchange(...args) {
    this.calls.push(["assertExchange", ...args]);
  }

  async assertQueue(...args) {
    this.calls.push(["assertQueue", ...args]);
  }

  bindQueue(...args) {
    this.calls.push(["bindQueue", ...args]);
  }

  consume(...args) {
    this.calls.push(["consume", ...args]);
  }

  ack(...args) {
    this.calls.push(["ack", ...args]);
  }

  publish(...args) {
    this.calls.push(["publish", ...args]);
    const callback = args[4];
    if (callback) {
      callback(this.confirmError ? new Error("nack") : null);
    }
    return true;
  }
}

class FakeConnection {
  constructor(confirmError = false) {
    this.channel = new FakeChannel();
    this.confirmChannel = new FakeChannel(confirmError);
  }

  async createChannel() {
    return this.channel;
  }

  async createConfirmChannel() {
    return this.confirmChannel;
  }
}

class DefaultListener extends common.AListener {
  queue = common.QueueNames.NEW_EVENT;
  serviceName = "legacy-listener";

  onMessage() {}
}

class OverriddenListener extends DefaultListener {
  get queueName() {
    return "live-listener";
  }

  get queueOptions() {
    return { durable: false, exclusive: true, autoDelete: true };
  }
}

class Publisher extends common.APublisher {
  queue = common.QueueNames.NEW_EVENT;
  serviceName = "publisher-service";
}

test("preserves every legacy runtime export and enum member", () => {
  for (const exportName of Object.keys(legacyCommon)) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(common, exportName),
      `missing legacy export ${exportName}`,
    );
  }

  for (const enumName of [
    "QueueNames",
    "BetStatus",
    "EventStatus",
    "EventVisibility",
    "ModerationStatus",
    "ResultingStatus",
    "SettlementStatus",
    "SlipRowStatus",
    "SlipStatus",
  ]) {
    for (const [key, value] of Object.entries(legacyCommon[enumName])) {
      assert.equal(common[enumName][key], value, `${enumName}.${key}`);
    }
  }
});

test("listener defaults retain the legacy service queue and durable behavior", async () => {
  const connection = new FakeConnection();
  const listener = new DefaultListener(connection);

  await listener.init();
  listener.listen();

  assert.deepEqual(connection.channel.calls.slice(0, 3), [
    ["assertExchange", common.QueueNames.NEW_EVENT, "fanout"],
    ["assertQueue", "legacy-listener", {}],
    ["bindQueue", "legacy-listener", common.QueueNames.NEW_EVENT, ""],
  ]);
  assert.equal(connection.channel.calls[3][0], "consume");
  assert.equal(connection.channel.calls[3][1], "legacy-listener");
  assert.equal(typeof connection.channel.calls[3][2], "function");
});

test("listener uses overridden queue name and queue options everywhere", async () => {
  const connection = new FakeConnection();
  const listener = new OverriddenListener(connection);

  await listener.init();
  listener.listen();

  assert.deepEqual(connection.channel.calls.slice(0, 3), [
    ["assertExchange", common.QueueNames.NEW_EVENT, "fanout"],
    [
      "assertQueue",
      "live-listener",
      { durable: false, exclusive: true, autoDelete: true },
    ],
    ["bindQueue", "live-listener", common.QueueNames.NEW_EVENT, ""],
  ]);
  assert.equal(connection.channel.calls[3][0], "consume");
  assert.equal(connection.channel.calls[3][1], "live-listener");
  assert.equal(typeof connection.channel.calls[3][2], "function");
});

test("legacy publish remains a transient three-argument call", async () => {
  const connection = new FakeConnection();
  const publisher = new Publisher(connection);
  const data = { data: {} };

  await publisher.init();
  assert.equal(publisher.publish(data), undefined);

  const publishCall = connection.channel.calls[1];
  assert.equal(publishCall.length, 4);
  assert.deepEqual(publishCall.slice(0, 3), [
    "publish",
    common.QueueNames.NEW_EVENT,
    "",
  ]);
  assert.equal(Buffer.isBuffer(publishCall[3]), true);
  assert.deepEqual(JSON.parse(publishCall[3].toString()), data);
  assert.equal(data.sender, "publisher-service");
  assert.match(data.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("confirm publishing is persistent and resolves or rejects on broker confirmation", async () => {
  const acknowledgedConnection = new FakeConnection();
  const acknowledgedPublisher = new Publisher(acknowledgedConnection);

  await assert.rejects(
    acknowledgedPublisher.publishWithConfirm({ data: {} }),
    /Confirm channel must be initialised/,
  );

  await acknowledgedPublisher.initConfirmChannel();
  await acknowledgedPublisher.publishWithConfirm(
    { data: {} },
    { expiration: "1000", persistent: false },
  );

  const confirmCall = acknowledgedConnection.confirmChannel.calls[1];
  assert.deepEqual(confirmCall.slice(0, 3), [
    "publish",
    common.QueueNames.NEW_EVENT,
    "",
  ]);
  assert.equal(Buffer.isBuffer(confirmCall[3]), true);
  assert.deepEqual(confirmCall[4], { persistent: true, expiration: "1000" });
  assert.equal(typeof confirmCall[5], "function");

  const rejectedConnection = new FakeConnection(true);
  const rejectedPublisher = new Publisher(rejectedConnection);
  await rejectedPublisher.initConfirmChannel();
  await assert.rejects(
    rejectedPublisher.publishWithConfirm({ data: {} }),
    /nack/,
  );
});

test("moderation decline keeps authoritative metadata scoped to each row", () => {
  const event = {
    data: {
      slipId: "slip-id",
      result: "DECLINED",
      betKind: common.BetKind.LIVE,
      declineReason: common.ModerationDeclineReason.STALE_QUOTE,
      affectedRows: [
        {
          rowId: "row-one",
          declineReason: common.ModerationDeclineReason.STALE_QUOTE,
          marketId: "event-one:NEXT_CORNER",
          marketVersion: 2,
          quoteVersion: 4,
          currentOdds: 2.1,
          marketStatus: common.LiveMarketStatus.OPEN,
          selectionId: "event-one:NEXT_CORNER:2:HOME",
        },
        {
          rowId: "row-two",
          declineReason: common.ModerationDeclineReason.MARKET_SUSPENDED,
          marketId: "event-two:NEXT_RED_CARD",
          marketVersion: 1,
          quoteVersion: 3,
          marketStatus: common.LiveMarketStatus.SUSPENDED,
          selectionId: "event-two:NEXT_RED_CARD:1:AWAY",
        },
      ],
    },
  };

  assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
  assert.notEqual(
    event.data.affectedRows[0].quoteVersion,
    event.data.affectedRows[1].quoteVersion,
  );
});

test("live update payload keeps legacy incident and additive incidents history", () => {
  const event = {
    data: {
      eventId: "event-id",
      sequence: 3,
      occurredAt: "2026-08-20T17:03:00.000Z",
      kickoffAt: "2026-08-20T16:00:00.000Z",
      minute: 63,
      phase: common.EventPhase.SECOND_HALF,
      homeScore: 2,
      awayScore: 1,
      bettingStatus: common.BettingStatus.OPEN,
      incident: {
        id: "incident-3",
        type: common.LiveIncidentType.GOAL,
        side: common.TeamSide.HOME,
        occurredAt: "2026-08-20T17:03:00.000Z",
        minute: 63,
      },
      incidentsComplete: true,
      incidents: [
        {
          id: "incident-1",
          type: common.LiveIncidentType.KICK_OFF,
          occurredAt: "2026-08-20T16:00:00.000Z",
          minute: 0,
        },
        {
          id: "incident-2",
          type: common.LiveIncidentType.YELLOW_CARD,
          side: common.TeamSide.AWAY,
          occurredAt: "2026-08-20T17:02:00.000Z",
          minute: 62,
        },
        {
          id: "incident-3",
          type: common.LiveIncidentType.GOAL,
          side: common.TeamSide.HOME,
          occurredAt: "2026-08-20T17:03:00.000Z",
          minute: 63,
        },
      ],
      markets: [],
      settlements: [],
    },
  };

  assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
  assert.equal(event.data.incident.id, "incident-3");
  assert.equal(event.data.incidentsComplete, true);
  assert.equal(event.data.incidents.length, 3);
});

test("live contracts expose rotating incidents and Second Half Score labels", () => {
  assert.equal(common.LiveIncidentType.THROW_IN, "THROW_IN");
  assert.equal(common.LiveIncidentType.GOAL_KICK, "GOAL_KICK");
  assert.equal(common.LiveMarketType.NEXT_THROW_IN, "NEXT_THROW_IN");
  assert.equal(common.LiveMarketType.NEXT_FREE_KICK, "NEXT_FREE_KICK");
  assert.equal(common.LiveMarketType.NEXT_GOAL_KICK, "NEXT_GOAL_KICK");
  assert.equal(common.LiveMarketType.SECOND_HALF_SCORE, "SECOND_HALF_SCORE");
  assert.equal(
    common.LiveSettlementReason.SECOND_HALF_SCORE,
    "SECOND_HALF_SCORE",
  );
});
