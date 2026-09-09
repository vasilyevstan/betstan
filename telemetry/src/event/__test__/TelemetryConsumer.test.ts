import { createHash } from "crypto";
import { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { TelemetryConsumer } from "../TelemetryConsumer";
import { EXCHANGES, validateExchangeEvent } from "../validator";

const message = (exchange: string, value: string): ConsumeMessage =>
  ({
    content: Buffer.from(value),
    fields: { exchange },
  } as ConsumeMessage);

const envelope = (data: Record<string, unknown>, sender: string, timestamp: string) => ({
  data,
  sender,
  timestamp,
});

const sha = (parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

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

  it("accepts only exact generic envelopes, canonical UUIDs, and sender metrics", () => {
    const eventId = "9a6b8a5f-d9ea-4f4c-8c0a-7d39b9a55c12";
    expect(
      validateExchangeEvent(
        "telemetry:event:v1",
        envelope(
          { metric: "USER_CREATED", eventId, occurredAt: timestamp },
          "auth",
          timestamp
        )
      )
    ).toEqual({
      _id: eventId,
      metric: "USER_CREATED",
      occurredAt: new Date(timestamp),
    });

    const invalid = [
      envelope(
        { metric: "USER_CREATED", eventId, occurredAt: timestamp, extra: true },
        "auth",
        timestamp
      ),
      { ...envelope({ metric: "USER_CREATED", eventId, occurredAt: timestamp }, "auth", timestamp), extra: true },
      envelope({ metric: "SLIP_CREATED", eventId, occurredAt: timestamp }, "auth", timestamp),
      envelope({ metric: "USER_CREATED", eventId: eventId.toUpperCase(), occurredAt: timestamp }, "auth", timestamp),
      envelope({ metric: "USER_CREATED", eventId, occurredAt: timestamp }, "auth", "2026-09-10T02:00:01.000Z"),
      envelope({ metric: "USER_CREATED", eventId, occurredAt: "not-a-date" }, "auth", "not-a-date"),
      [],
      null,
    ];
    for (const value of invalid) {
      expect(validateExchangeEvent("telemetry:event:v1", value)).toBeUndefined();
    }
    expect(validateExchangeEvent("unknown", invalid[0])).toBeUndefined();
  });

  it("rejects malformed reused payloads and sender combinations", () => {
    expect(
      validateExchangeEvent(
        "slip:bet",
        envelope({ slipId: "" }, "slip_place_bet", timestamp)
      )
    ).toBeUndefined();
    expect(
      validateExchangeEvent(
        "resulting:slip:settle",
        envelope({ slipId: "x" }, "wrong", timestamp)
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

describe("raw telemetry consumer", () => {
  const createHarness = () => {
    let callback: ((message: ConsumeMessage | null) => void) | undefined;
    const channel = {
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
    } as unknown as jest.Mocked<Channel>;
    const connection = {
      createChannel: jest.fn().mockResolvedValue(channel),
    } as unknown as ChannelModel;
    const recorder = { record: jest.fn().mockResolvedValue(undefined) };
    const logger = { error: jest.fn() };
    const consumer = new TelemetryConsumer(connection, recorder, logger);
    return { callback: () => callback, channel, consumer, logger, recorder };
  };

  it("asserts one durable queue, four fanouts, prefetch 10, and manual consume", async () => {
    const harness = createHarness();
    await harness.consumer.start();

    expect(harness.channel.assertExchange).toHaveBeenCalledTimes(4);
    for (const exchange of EXCHANGES) {
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
    expect(harness.callback()).toEqual(expect.any(Function));
  });

  it("acks successful/idempotent writes and invalid events", async () => {
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
    await harness.consumer.handle(valid);
    expect(harness.recorder.record).toHaveBeenCalledTimes(1);
    expect(harness.channel.ack).toHaveBeenCalledWith(valid);

    const invalid = message("telemetry:event:v1", "{\"username\":\"private-name\"}");
    await harness.consumer.handle(invalid);
    expect(harness.channel.ack).toHaveBeenCalledWith(invalid);
    expect(harness.logger.error).toHaveBeenLastCalledWith("telemetry_event_invalid");
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain("private-name");
  });

  it("dead-letters a valid event exactly once on Mongo failure", async () => {
    const harness = createHarness();
    harness.recorder.record.mockRejectedValueOnce(new Error("private database payload"));
    await harness.consumer.start();
    const valid = message(
      "resulting:slip:settle",
      JSON.stringify(
        envelope(
          { slipId: "private-slip" },
          "resulting_settle_slip",
          "2026-09-10T02:00:00.000Z"
        )
      )
    );

    await harness.consumer.handle(valid);

    expect(harness.channel.ack).not.toHaveBeenCalled();
    expect(harness.channel.nack).toHaveBeenCalledWith(valid, false, false);
    expect(harness.logger.error).toHaveBeenCalledWith("telemetry_record_failed");
    expect(JSON.stringify(harness.logger.error.mock.calls)).not.toContain(
      "private-slip"
    );
  });
});
