import { EventEmitter } from "events";
import { Channel } from "amqplib";
import { IAmqpConnection } from "@betstan/common";
import { SlipTelemetryReporter } from "../TelemetryReporter";

const harness = () => {
  const channel = Object.assign(new EventEmitter(), {
    assertExchange: jest.fn().mockResolvedValue(undefined),
    publish: jest.fn().mockReturnValue(true),
  }) as unknown as jest.Mocked<Channel>;
  const connection = {
    createChannel: jest.fn().mockResolvedValue(channel),
  } as unknown as IAmqpConnection;
  const logger = { error: jest.fn() };
  const reporter = new SlipTelemetryReporter(
    connection,
    logger,
    () => new Date("2026-09-10T03:00:00.000Z"),
    () => "9A6B8A5F-D9EA-4F4C-8C0A-7D39B9A55C12"
  );
  return { channel, connection, logger, reporter };
};

it("owns one channel and publishes the exact anonymous Slip envelope", async () => {
  const { channel, connection, reporter } = harness();
  await reporter.initialize();
  await reporter.initialize();
  reporter.reportSlipCreated();

  expect(connection.createChannel).toHaveBeenCalledTimes(1);
  expect(channel.assertExchange).toHaveBeenCalledWith(
    "telemetry:event:v1",
    "fanout",
    { durable: true }
  );
  const [exchange, key, content, options] = channel.publish.mock.calls[0];
  expect([exchange, key, options]).toEqual([
    "telemetry:event:v1",
    "",
    { contentType: "application/json", persistent: true },
  ]);
  expect(JSON.parse(content.toString())).toEqual({
    data: {
      metric: "SLIP_CREATED",
      eventId: "9a6b8a5f-d9ea-4f4c-8c0a-7d39b9a55c12",
      occurredAt: "2026-09-10T03:00:00.000Z",
    },
    timestamp: "2026-09-10T03:00:00.000Z",
    sender: "slip",
  });
  expect(content.toString()).not.toContain("slipId");
  expect(content.toString()).not.toContain("userId");
});

it("contains init and publish failures with fixed diagnostics", async () => {
  const failed = harness();
  (failed.connection.createChannel as jest.Mock).mockRejectedValueOnce(
    new Error("private broker")
  );
  await expect(failed.reporter.initialize()).resolves.toBeUndefined();
  expect(() => failed.reporter.reportSlipCreated()).not.toThrow();
  expect(failed.logger.error).toHaveBeenCalledWith("slip_telemetry_disabled");

  const publishing = harness();
  await publishing.reporter.initialize();
  publishing.channel.publish.mockImplementationOnce(() => {
    throw new Error("private payload");
  });
  expect(() => publishing.reporter.reportSlipCreated()).not.toThrow();
  expect(publishing.logger.error).toHaveBeenCalledWith(
    "slip_telemetry_publish_failed"
  );
});
