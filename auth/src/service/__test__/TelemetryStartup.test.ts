import { Server } from "http";
import { listenWithOptionalTelemetry } from "../../index";

it("attempts optional telemetry once and only after HTTP listening succeeds", async () => {
  let onListening: (() => void) | undefined;
  const server = {} as Server;
  const listen = jest.fn((callback: () => void) => {
    onListening = callback;
    return server;
  });
  const reporter = {
    initialize: jest.fn().mockResolvedValue(undefined),
  };

  expect(
    listenWithOptionalTelemetry(listen, reporter, "amqp://rabbit")
  ).toBe(server);
  expect(reporter.initialize).not.toHaveBeenCalled();

  onListening!();
  await Promise.resolve();
  expect(reporter.initialize).toHaveBeenCalledTimes(1);
  expect(reporter.initialize).toHaveBeenCalledWith("amqp://rabbit");
});

it("keeps listening and contains an unexpected reporter rejection", async () => {
  let onListening: (() => void) | undefined;
  const server = {} as Server;
  const listen = jest.fn((callback: () => void) => {
    onListening = callback;
    return server;
  });
  const reporter = {
    initialize: jest.fn().mockRejectedValue(new Error("private rabbit failure")),
  };
  const error = jest.spyOn(console, "error").mockImplementation(() => {});

  expect(
    listenWithOptionalTelemetry(listen, reporter, "amqp://rabbit")
  ).toBe(server);
  onListening!();
  await new Promise((resolve) => setImmediate(resolve));

  expect(reporter.initialize).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledWith("auth_telemetry_disabled");
  expect(JSON.stringify(error.mock.calls)).not.toContain(
    "private rabbit failure"
  );
});
