import { createHash } from "crypto";
import { EventEmitter } from "events";
import { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { TelemetryConsumer } from "../TelemetryConsumer";
import { validateExchangeEvent } from "../validator";
import { TelemetryRecordModel } from "../../model/TelemetryRecord";
import { MongoMetricRecorder } from "../../service/Recorder";
import {
  buildMetricSummary,
  MongoSummaryStore,
} from "../../service/Summary";

const message = (exchange: string, value: string): ConsumeMessage =>
  ({
    content: Buffer.from(value),
    fields: { exchange },
  } as ConsumeMessage);

const envelope = (
  data: Record<string, unknown>,
  sender: string,
  timestamp: string
) => ({
  data,
  sender,
  timestamp,
});

const sha = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("exchange event validation", () => {
  const timestamp = "2026-09-10T02:00:00.000Z";

  it("uses exact reused identities and the required time source", () => {
    expect(
      validateExchangeEvent(
        "slip:bet",
        envelope({ slipId: "slip-7" }, "slip_place_bet", timestamp)
      )
    ).toEqual({
      _id: sha(["BET_PLACED", "slip-7"]),
      metric: "BET_PLACED",
      occurredAt: new Date(timestamp),
    });
    expect(
      validateExchangeEvent(
        "resulting:slip:settle",
        envelope({ slipId: "slip-7" }, "resulting_settle_slip", timestamp)
      )
    ).toEqual({
      _id: sha(["RESULTING_SETTLED", "slip-7"]),
      metric: "RESULTING_SETTLED",
      occurredAt: new Date(timestamp),
    });
    expect(
      validateExchangeEvent(
        "gamemaster:event:live",
        envelope(
          {
            eventId: "event-9",
            sequence: 4,
            occurredAt: "2026-09-09T23:59:58.000Z",
          },
          "gamemaster_live_event_update",
          timestamp
        )
      )
    ).toEqual({
      _id: sha(["GAMECENTER_EVENT_EMITTED", "event-9", 4]),
      metric: "GAMECENTER_EVENT_EMITTED",
      occurredAt: new Date("2026-09-09T23:59:58.000Z"),
    });
  });

  it.each([
    {
      exchange: "slip:bet",
      sender: "slip_place_bet",
      immutableField: "submittedAt",
      metric: "BET_PLACED",
    },
    {
      exchange: "resulting:slip:settle",
      sender: "resulting_settle_slip",
      immutableField: "occurredAt",
      metric: "RESULTING_SETTLED",
    },
  ])(
    "uses immutable $immutableField for $metric across transport retries",
    ({ exchange, sender, immutableField, metric }) => {
      const immutableTime = "2026-09-10T23:59:58.000Z";
      const data = {
        slipId: "slip-midnight",
        [immutableField]: immutableTime,
      };
      const beforeMidnight = validateExchangeEvent(
        exchange,
        envelope(data, sender, "2026-09-10T23:59:59.999Z")
      );
      const afterMidnight = validateExchangeEvent(
        exchange,
        envelope(data, sender, "2026-09-11T00:00:00.001Z")
      );

      expect(beforeMidnight).toEqual({
        _id: sha([metric, "slip-midnight"]),
        metric,
        occurredAt: new Date(immutableTime),
      });
      expect(afterMidnight).toEqual(beforeMidnight);
    }
  );

  it.each([
    {
      exchange: "slip:bet",
      sender: "slip_place_bet",
      immutableField: "submittedAt",
    },
    {
      exchange: "resulting:slip:settle",
      sender: "resulting_settle_slip",
      immutableField: "occurredAt",
    },
  ])(
    "uses the legacy envelope timestamp for $exchange only when "
      + "$immutableField is absent",
    ({ exchange, sender, immutableField }) => {
      const legacy = validateExchangeEvent(
        exchange,
        envelope({ slipId: "legacy-slip" }, sender, timestamp)
      );
      expect(legacy?.occurredAt).toEqual(new Date(timestamp));

      for (const malformed of [
        "",
        "2026-09-10",
        "2026-09-10T02:00:00Z",
        null,
        7,
      ]) {
        expect(
          validateExchangeEvent(
            exchange,
            envelope(
              { slipId: "malformed-slip", [immutableField]: malformed },
              sender,
              timestamp
            )
          )
        ).toBeUndefined();
      }
    }
  );

  it.each([
    {
      exchange: "slip:bet",
      sender: "slip_place_bet",
      immutableField: "submittedAt",
      metric: "BET_PLACED",
    },
    {
      exchange: "resulting:slip:settle",
      sender: "resulting_settle_slip",
      immutableField: "occurredAt",
      metric: "RESULTING_SETTLED",
    },
  ])(
    "persists one $metric at immutable time in either retry order",
    async ({ exchange, sender, immutableField, metric }) => {
      const immutableTime = "2026-09-10T23:59:58.000Z";
      const transportTimes = [
        "2026-09-10T23:59:59.999Z",
        "2026-09-11T00:00:00.001Z",
      ];
      const recorder = new MongoMetricRecorder();

      for (const order of [transportTimes, [...transportTimes].reverse()]) {
        await TelemetryRecordModel.deleteMany({});
        for (const transportTime of order) {
          const record = validateExchangeEvent(
            exchange,
            envelope(
              {
                slipId: `persisted-${metric}`,
                [immutableField]: immutableTime,
              },
              sender,
              transportTime
            )
          );
          expect(record).toBeDefined();
          await recorder.record(record!);
        }

        expect(
          await TelemetryRecordModel.find({
            metric,
          }).lean()
        ).toEqual([
          {
            _id: sha([metric, `persisted-${metric}`]),
            metric,
            occurredAt: new Date(immutableTime),
          },
        ]);

        const summary = await buildMetricSummary(
          new Date("2026-09-11T12:00:00.000Z"),
          new MongoSummaryStore()
        );
        const values = summary.metrics.find(
          (metricValues) => metricValues.metric === metric
        )?.values;
        expect(values?.[summary.dates.indexOf("2026-09-10")]).toBe(1);
        expect(values?.[summary.dates.indexOf("2026-09-11")]).toBe(0);
      }
    }
  );

  it.each([
    ["auth", "USER_CREATED"],
    ["auth", "USER_LOGGED_IN"],
    ["slip", "SLIP_CREATED"],
  ])(
    "accepts the exact generic %s/%s pair with direct UUID and timestamp",
    (sender, metric) => {
      const eventId = "9a6b8a5f-d9ea-4f4c-8c0a-7d39b9a55c12";
      expect(
        validateExchangeEvent(
          "telemetry:event:v1",
          envelope({ metric, eventId, occurredAt: timestamp }, sender, timestamp)
        )
      ).toEqual({
        _id: eventId,
        metric,
        occurredAt: new Date(timestamp),
      });
    }
  );

  it("rejects non-exact generic envelopes and malformed reused payloads", () => {
    const eventId = "9a6b8a5f-d9ea-4f4c-8c0a-7d39b9a55c12";
    const invalid = [
      envelope(
        { metric: "USER_CREATED", eventId, occurredAt: timestamp, extra: true },
        "auth",
        timestamp
      ),
      {
        ...envelope(
          { metric: "USER_CREATED", eventId, occurredAt: timestamp },
          "auth",
          timestamp
        ),
        extra: true,
      },
      envelope(
        { metric: "SLIP_CREATED", eventId, occurredAt: timestamp },
        "auth",
        timestamp
      ),
      envelope(
        {
          metric: "USER_CREATED",
          eventId: eventId.toUpperCase(),
          occurredAt: timestamp,
        },
        "auth",
        timestamp
      ),
      envelope(
        { metric: "USER_CREATED", eventId, occurredAt: timestamp },
        "auth",
        "2026-09-10T02:00:01.000Z"
      ),
      [],
      null,
    ];
    for (const value of invalid) {
      expect(validateExchangeEvent("telemetry:event:v1", value)).toBeUndefined();
    }
    expect(validateExchangeEvent("unknown", invalid[0])).toBeUndefined();
    expect(
      validateExchangeEvent(
        "slip:bet",
        envelope({ slipId: "" }, "slip_place_bet", timestamp)
      )
    ).toBeUndefined();
    expect(
      validateExchangeEvent(
        "gamemaster:event:live",
        envelope(
          { eventId: "x", sequence: 1.5, occurredAt: timestamp },
          "gamemaster_live_event_update",
          timestamp
        )
      )
    ).toBeUndefined();
  });
});

describe("raw telemetry consumer supervision", () => {
  const createHarness = () => {
    let callback: ((message: ConsumeMessage | null) => void) | undefined;
    const channel = Object.assign(new EventEmitter(), {
      ack: jest.fn(),
      assertExchange: jest.fn().mockResolvedValue(undefined),
      assertQueue: jest.fn().mockResolvedValue(undefined),
      bindQueue: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      consume: jest.fn().mockImplementation((_queue, handler) => {
        callback = handler;
        return Promise.resolve({ consumerTag: "telemetry" });
      }),
      nack: jest.fn(),
      prefetch: jest.fn().mockResolvedValue(undefined),
    }) as unknown as jest.Mocked<Channel>;
    const connection = Object.assign(new EventEmitter(), {
      close: jest.fn().mockResolvedValue(undefined),
      createChannel: jest.fn().mockResolvedValue(channel),
    }) as unknown as jest.Mocked<ChannelModel>;
    const recorder = { record: jest.fn().mockResolvedValue(undefined) };
    const fatal = jest.fn();
    const logger = { error: jest.fn() };
    const consumer = new TelemetryConsumer(
      connection,
      recorder,
      fatal,
      logger
    );
    const dispatch = async (value: ConsumeMessage | null) => {
      callback!(value);
      await flush();
    };
    return {
      callback: () => callback,
      channel,
      connection,
      consumer,
      dispatch,
      fatal,
      logger,
      recorder,
    };
  };

  it("asserts exact durable bindings, prefetch 10, and manual consume", async () => {
    const harness = createHarness();
    await harness.consumer.start();

    const exchanges = [
      "slip:bet",
      "resulting:slip:settle",
      "gamemaster:event:live",
      "telemetry:event:v1",
    ];
    expect(harness.channel.assertExchange).toHaveBeenCalledTimes(4);
    for (const exchange of exchanges) {
      expect(harness.channel.assertExchange).toHaveBeenCalledWith(
        exchange,
        "fanout",
        { durable: true }
      );
      expect(harness.channel.bindQueue).toHaveBeenCalledWith(
        "telemetry:events:v1",
        exchange,
        ""
      );
    }
    expect(harness.channel.assertQueue).toHaveBeenCalledWith(
      "telemetry:events:v1",
      { durable: true }
    );
    expect(harness.channel.prefetch).toHaveBeenCalledWith(10);
    expect(harness.channel.consume).toHaveBeenCalledWith(
      "telemetry:events:v1",
      expect.any(Function),
      { noAck: false }
    );
  });

  it("drives valid, invalid, and DB-failure outcomes through consume", async () => {
    const harness = createHarness();
    await harness.consumer.start();
    const valid = message(
      "slip:bet",
      JSON.stringify(
        envelope(
          { slipId: "slip-1" },
          "slip_place_bet",
          "2026-09-10T02:00:00.000Z"
        )
      )
    );
    await harness.dispatch(valid);
    expect(harness.recorder.record).toHaveBeenCalledTimes(1);
    expect(harness.channel.ack).toHaveBeenCalledWith(valid);

    const invalid = message(
      "telemetry:event:v1",
      JSON.stringify({ username: "private-name" })
    );
    await harness.dispatch(invalid);
    expect(harness.channel.ack).toHaveBeenCalledWith(invalid);
    expect(harness.channel.nack).not.toHaveBeenCalled();

    harness.recorder.record.mockRejectedValueOnce(
      new Error("private database payload")
    );
    const dbFailure = message(
      "resulting:slip:settle",
      JSON.stringify(
        envelope(
          { slipId: "private-slip" },
          "resulting_settle_slip",
          "2026-09-10T02:00:00.000Z"
        )
      )
    );
    await harness.dispatch(dbFailure);
    expect(harness.channel.nack).toHaveBeenCalledWith(dbFailure, false, false);
    expect(harness.fatal).not.toHaveBeenCalled();
  });

  it("acks malformed JSON without recording, nacking, or logging raw data", async () => {
    const harness = createHarness();
    await harness.consumer.start();
    const malformed = message(
      "telemetry:event:v1",
      '{"username":"private-name"'
    );

    await harness.dispatch(malformed);

    expect(harness.channel.ack).toHaveBeenCalledWith(malformed);
    expect(harness.channel.nack).not.toHaveBeenCalled();
    expect(harness.recorder.record).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      "telemetry_event_invalid"
    );
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain(
      "private-name"
    );
  });

  it("acks a present malformed immutable timestamp without recording", async () => {
    const harness = createHarness();
    await harness.consumer.start();
    const malformed = message(
      "slip:bet",
      JSON.stringify(
        envelope(
          { slipId: "slip-invalid-time", submittedAt: "not-a-time" },
          "slip_place_bet",
          "2026-09-10T02:00:00.000Z"
        )
      )
    );

    await harness.dispatch(malformed);

    expect(harness.recorder.record).not.toHaveBeenCalled();
    expect(harness.channel.ack).toHaveBeenCalledWith(malformed);
    expect(harness.channel.nack).not.toHaveBeenCalled();
    expect(harness.logger.error).toHaveBeenCalledWith(
      "telemetry_event_invalid"
    );
  });

  it.each([
    ["channel", "error"],
    ["channel", "close"],
    ["connection", "error"],
    ["connection", "close"],
  ])("treats %s %s as fatal", async (source, event) => {
    const harness = createHarness();
    await harness.consumer.start();
    const emitter =
      source === "channel" ? harness.channel : harness.connection;
    (emitter as unknown as EventEmitter).emit(
      event,
      event === "error" ? new Error("private broker detail") : undefined
    );
    expect(harness.fatal).toHaveBeenCalledTimes(1);
  });

  it("treats broker consumer cancellation as fatal", async () => {
    const harness = createHarness();
    await harness.consumer.start();
    await harness.dispatch(null);
    expect(harness.fatal).toHaveBeenCalledTimes(1);
  });

  it("supervises ack failure without nacking as a fallback or leaking a rejection", async () => {
    const harness = createHarness();
    const unhandled = jest.fn();
    process.once("unhandledRejection", unhandled);
    harness.channel.ack.mockImplementationOnce(() => {
      throw new Error("channel closed");
    });
    await harness.consumer.start();
    const valid = message(
      "slip:bet",
      JSON.stringify(
        envelope(
          { slipId: "slip-ack" },
          "slip_place_bet",
          "2026-09-10T02:00:00.000Z"
        )
      )
    );

    await harness.dispatch(valid);

    expect(harness.fatal).toHaveBeenCalledTimes(1);
    expect(harness.channel.nack).not.toHaveBeenCalled();
    expect(unhandled).not.toHaveBeenCalled();
    process.removeListener("unhandledRejection", unhandled);
  });

  it("supervises nack failure and keeps exact non-requeue arguments", async () => {
    const harness = createHarness();
    harness.recorder.record.mockRejectedValueOnce(new Error("database"));
    harness.channel.nack.mockImplementationOnce(() => {
      throw new Error("channel closed");
    });
    await harness.consumer.start();
    const valid = message(
      "resulting:slip:settle",
      JSON.stringify(
        envelope(
          { slipId: "slip-nack" },
          "resulting_settle_slip",
          "2026-09-10T02:00:00.000Z"
        )
      )
    );

    await harness.dispatch(valid);

    expect(harness.channel.nack).toHaveBeenCalledWith(valid, false, false);
    expect(harness.channel.ack).not.toHaveBeenCalled();
    expect(harness.fatal).toHaveBeenCalledTimes(1);
  });

  it("fires the fatal callback exactly once across competing failures", async () => {
    const harness = createHarness();
    await harness.consumer.start();
    harness.callback()!(null);
    (harness.channel as unknown as EventEmitter).emit("close");
    (harness.connection as unknown as EventEmitter).emit(
      "error",
      new Error("broker")
    );
    await flush();
    expect(harness.fatal).toHaveBeenCalledTimes(1);
  });

  it("suppresses lifecycle fatal events during intentional shutdown", async () => {
    const harness = createHarness();
    harness.channel.close.mockImplementationOnce(async () => {
      (harness.channel as unknown as EventEmitter).emit("close");
    });
    await harness.consumer.start();

    await harness.consumer.close();
    (harness.connection as unknown as EventEmitter).emit("close");

    expect(harness.fatal).not.toHaveBeenCalled();
    expect(harness.channel.close).toHaveBeenCalledTimes(1);
  });
});
