const assert = require("node:assert/strict");
const test = require("node:test");

const common = require("../build");
const legacyCommon = require("legacy-common");

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
    return { durable: false, exclusive: true };
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
    ["assertQueue", "live-listener", { durable: false, exclusive: true }],
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
