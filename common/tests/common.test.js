const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const common = require("../build");
const legacyCommon = require("legacy-common");
const predecessorCommon = require("predecessor-common");
const cashBack = require("./fixtures/cash-back-payloads");

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

test("preserves the actual published rc.1 exports and every enum wire member", () => {
  assert.equal(require("predecessor-common/package.json").version, "1.1.0-rc.1");
  assert.equal(require("legacy-common/package.json").version, "1.0.54");
  for (const [name, value] of Object.entries(predecessorCommon)) {
    assert.ok(Object.hasOwn(common, name), `missing predecessor export ${name}`);
    // Every published enum is an object of string wire values, not a class.
    if (value && typeof value === "object") {
      for (const [member, wireValue] of Object.entries(value)) {
        if (typeof wireValue === "string") {
          assert.equal(common[name][member], wireValue, `${name}.${member}`);
        }
      }
    }
  }
});

test("cash-back adds only the approved terminal states and four dedicated topics", () => {
  assert.deepEqual(common.BetStatus, {
    ...predecessorCommon.BetStatus,
    CASH_BACK: "CASH_BACK",
  });
  assert.deepEqual(common.ResultingStatus, {
    ...predecessorCommon.ResultingStatus,
    BET_CASH_BACK: "BET_CASH_BACK",
  });
  assert.deepEqual(common.QueueNames, {
    ...predecessorCommon.QueueNames,
    CASH_BACK_REQUEST: "bet:cash-back:request",
    CASH_BACK_OUTCOME: "resulting:cash-back:outcome",
    CASH_BACK_SOURCE_REQUEST: "resulting:cash-back:source:request",
    CASH_BACK_SOURCE_REPLY: "cash-back:source:reply",
  });
  assert.equal(new Set(Object.values(common.QueueNames)).size, Object.keys(common.QueueNames).length);
});

test("typed cash-back requests, offers, receipts and source variants survive JSON without identity loss", () => {
  for (const event of [
    ...cashBack.requests,
    ...cashBack.outcomes,
    ...cashBack.sourceRequests,
    ...cashBack.sourceReplies,
    cashBack.settlement,
  ]) {
    assert.deepEqual(JSON.parse(JSON.stringify(event)), event);
  }
  assert.deepEqual(cashBack.requests.map(({ data }) => data.action), ["QUOTE", "QUOTE", "CONFIRM"]);
  assert.deepEqual(cashBack.outcomes.map(({ data }) => data.outcome), [
    "QUOTED", "UNAVAILABLE", "ACCEPTED", "ACCEPTED", "REJECTED",
  ]);
  assert.deepEqual(cashBack.sourceReplies.map(({ data }) => data.outcome), [
    "SNAPSHOT", "GRANTED", "RELEASED", "FENCED", "FENCED", "DENIED",
  ]);
  const original = cashBack.quoteEvidence.originalManifest.selections[0];
  const current = cashBack.quoteEvidence.currentQuotes[0];
  for (const key of ["slipRowId", "eventId", "productId", "oddsId", "marketId", "marketVersion", "selectionId"]) {
    assert.equal(current[key], original[key], key);
  }
  assert.equal(original.acceptedOdds, "3");
  assert.equal(current.odds, "6");
  assert.equal(current.quoteVersion, 9);
  assert.equal(current.marketStatus, common.LiveMarketStatus.OPEN);
  assert.equal(cashBack.quoteEvidence.anySelectionResolved, false);
  assert.deepEqual(cashBack.quoteEvidence.sources.map(({ evidence }) => evidence.owner), [
    "BACKOFFICE", "GAMEMASTER",
  ]);
});

test("source grant and lost-ACK cancellation bind exact obligations, not expiring leases", () => {
  const { reserveRequest, releaseRequest, grant, fenced } = cashBack;
  assert.deepEqual(grant.request, reserveRequest);
  assert.equal(grant.grantedGeneration, reserveRequest.expected.baseGeneration + 1);
  assert.equal(releaseRequest.reserveRequestId, reserveRequest.requestId);
  assert.deepEqual(releaseRequest.operation, reserveRequest.operation);
  assert.deepEqual(releaseRequest.participant, reserveRequest.participant);
  assert.equal(releaseRequest.baseGeneration, reserveRequest.expected.baseGeneration);
  assert.equal(releaseRequest.grantedGeneration, reserveRequest.expected.baseGeneration + 1);
  assert.equal(releaseRequest.decision.quoteFingerprint, reserveRequest.quote.quoteFingerprint);
  assert.equal(releaseRequest.decision.expectedRevision, reserveRequest.quote.expectedRevision);
  assert.equal(releaseRequest.decision.decisionId, cashBack.partialReceipt.decisionId);
  assert.equal(releaseRequest.decision.outcome, "ACCEPTED");
  assert.equal(fenced.fenceGeneration, releaseRequest.baseGeneration + 2);
  // The proof intentionally does not assert that a different, newer hold is empty.
  assert.ok(fenced.observedGeneration > fenced.fenceGeneration);
  assert.equal(Object.hasOwn(fenced, "noHold"), false);
  assert.equal(Object.hasOwn(releaseRequest, "grant"), false);
  assert.equal(Object.hasOwn(reserveRequest, "leaseExpiresAt"), false);
  assert.equal(Object.hasOwn(grant, "expiresAt"), false);
  const cancellation = cashBack.cancellationRequest;
  assert.equal(cancellation.decision.outcome, "REJECTED");
  assert.equal(cancellation.grantedGeneration, cancellation.baseGeneration + 1);
  assert.equal(cancellation.reserveRequestId, reserveRequest.requestId);
  assert.equal(Object.hasOwn(cancellation, "grant"), false);
});

test("cash-back financial evidence distinguishes partial history, full closure and settlement basis", () => {
  const { partialReceipt, fullReceipt, rejectedReceipt, settlement } = cashBack;
  for (const snapshot of [
    cashBack.initialFinancial,
    partialReceipt.financial,
    fullReceipt.financial,
    rejectedReceipt.financial,
    settlement.data.cashBack.financial,
  ]) {
    for (const field of ["originalStakeMinor", "remainingStakeMinor", "cumulativeClosedStakeMinor", "cumulativeReturnMinor"]) {
      assert.equal(Number.isSafeInteger(snapshot[field]), true, field);
      assert.ok(snapshot[field] >= 0, field);
    }
    assert.equal(snapshot.originalStakeMinor, snapshot.remainingStakeMinor + snapshot.cumulativeClosedStakeMinor);
  }
  assert.equal(partialReceipt.financial.status, common.BetStatus.CONFIRMED);
  assert.equal(partialReceipt.financial.remainingStakeMinor, 6000);
  assert.equal(fullReceipt.financial.status, common.BetStatus.CASH_BACK);
  assert.equal(fullReceipt.financial.remainingStakeMinor, 0);
  assert.equal(fullReceipt.quote.closedStakeMinor, partialReceipt.financial.remainingStakeMinor);
  assert.equal(settlement.data.cashBack.settlementBasisStakeMinor, 6000);
  assert.equal(settlement.data.cashBack.financial.status, common.BetStatus.WIN);
  assert.ok(settlement.data.cashBack.financial.revision > partialReceipt.financial.revision);
  // Late immutable receipts retain their own identity and before/after revisions.
  assert.equal(partialReceipt.decisionId, "decision-partial");
  assert.equal(partialReceipt.quote.financial.revision, 4);
  assert.equal(partialReceipt.financial.revision, 5);
  assert.equal(settlement.data.cashBack.financial.revision, 6);
  assert.equal(rejectedReceipt.reason, "SELECTION_RESOLVED");
});

test("publisher retries restamp only envelope metadata, not cash-back domain evidence", async (t) => {
  const stamps = ["2026-09-23T12:01:00.000Z", "2026-09-23T12:02:00.000Z"];
  t.mock.method(Date.prototype, "toISOString", () => stamps.shift());
  class CashBackPublisher extends common.APublisher {
    queue = common.QueueNames.CASH_BACK_OUTCOME;
    serviceName = "resulting";
  }
  const connection = new FakeConnection();
  const publisher = new CashBackPublisher(connection);
  const event = JSON.parse(JSON.stringify(cashBack.outcomes[2]));
  const immutableData = JSON.parse(JSON.stringify(event.data));
  await publisher.initConfirmChannel();
  await publisher.publishWithConfirm(event);
  await publisher.publishWithConfirm(event);
  const sends = connection.confirmChannel.calls.filter(([method]) => method === "publish");
  const first = JSON.parse(sends[0][3].toString());
  const retry = JSON.parse(sends[1][3].toString());
  assert.notEqual(first.timestamp, retry.timestamp);
  assert.equal(first.sender, "resulting");
  assert.deepEqual(first.data, immutableData);
  assert.deepEqual(retry.data, immutableData);
  assert.equal(retry.data.receipt.decisionTime, "2026-09-23T12:00:02.000Z");
  assert.equal(retry.data.receipt.quote.expiresAt, "2026-09-23T12:00:06.000Z");
  assert.equal(retry.data.operation.fingerprint, cashBack.operation.fingerprint);
});

test("legacy and predecessor envelope readers tolerate optional settlement evidence", () => {
  const legacy = { data: { slipId: "historical-slip", result: "legacy-result" } };
  assert.equal(
    cashBack.settlement.data.result,
    predecessorCommon.ResultingStatus.BET_WIN,
  );
  for (const api of [legacyCommon, predecessorCommon, common]) {
    class Reader extends api.AListener {
      queue = api.QueueNames.SETTLE_SLIP;
      serviceName = "compatibility-reader";
      onMessage() {}
    }
    const reader = new Reader(new FakeConnection());
    for (const event of [legacy, cashBack.settlement]) {
      const parsed = reader.parseMessage({ content: Buffer.from(JSON.stringify(event)) });
      assert.deepEqual(parsed, event);
      assert.deepEqual(
        { slipId: parsed.data.slipId, result: parsed.data.result },
        { slipId: event.data.slipId, result: event.data.result },
      );
    }
  }
  assert.equal(Object.hasOwn(legacy.data, "cashBack"), false);
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

test("live contracts expose rotating incidents and versioned second-half markets", () => {
  assert.equal(common.LiveIncidentType.THROW_IN, "THROW_IN");
  assert.equal(common.LiveIncidentType.GOAL_KICK, "GOAL_KICK");
  assert.equal(common.LiveMarketType.NEXT_THROW_IN, "NEXT_THROW_IN");
  assert.equal(common.LiveMarketType.NEXT_FREE_KICK, "NEXT_FREE_KICK");
  assert.equal(common.LiveMarketType.NEXT_GOAL_KICK, "NEXT_GOAL_KICK");
  assert.equal(
    common.LiveMarketType.SECOND_HALF_TIME_RESULT,
    "SECOND_HALF_TIME_RESULT",
  );
  assert.equal(common.LiveMarketType.SECOND_HALF_SCORE, "SECOND_HALF_SCORE");
  assert.equal(
    common.LiveSettlementReason.SECOND_HALF_TIME_RESULT,
    "SECOND_HALF_TIME_RESULT",
  );
  assert.equal(
    common.LiveSettlementReason.SECOND_HALF_SCORE,
    "SECOND_HALF_SCORE",
  );
});
