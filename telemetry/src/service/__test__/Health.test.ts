import { EventEmitter } from "events";
import net from "net";
import {
  createTcpProbe,
  defaultTargets,
  HealthService,
  ProbeTarget,
} from "../Health";

const targets: ProbeTarget[] = [
  { service: "auth", host: "auth", port: 3000 },
  { service: "backoffice", host: "backoffice", port: 3000 },
  { service: "bet", host: "bet", port: 3000 },
];

it("builds default and explicitly configured probe targets", () => {
  const configured = defaultTargets({
    AUTH_HOST: "auth.internal",
    AUTH_PORT: "4010",
  });

  expect(configured[0]).toEqual({
    service: "auth",
    host: "auth.internal",
    port: 4010,
  });
  expect(configured[1]).toEqual({
    service: "backoffice",
    host: "backoffice",
    port: 3000,
  });
});

it("uses one bounded socket and settles only its first terminal event", async () => {
  const createSocket = () =>
    Object.assign(new EventEmitter(), {
      destroy: jest.fn(),
      setTimeout: jest.fn(),
    });
  const connectedSocket = createSocket();
  const timedOutSocket = createSocket();
  const connect = jest
    .spyOn(net, "createConnection")
    .mockReturnValueOnce(connectedSocket as any)
    .mockReturnValueOnce(timedOutSocket as any);
  const probe = createTcpProbe(750);

  try {
    const connected = probe(targets[0]);
    connectedSocket.emit("connect");
    connectedSocket.emit("timeout");
    await expect(connected).resolves.toBeUndefined();
    expect(connectedSocket.setTimeout).toHaveBeenCalledWith(750);
    expect(connectedSocket.destroy).toHaveBeenCalledTimes(1);

    const timedOut = probe(targets[1]);
    timedOutSocket.emit("timeout");
    await expect(timedOut).rejects.toThrow("timeout");
    expect(timedOutSocket.destroy).toHaveBeenCalledTimes(1);
  } finally {
    connect.mockRestore();
  }
});

it("starts remote probes concurrently and returns exact service order", async () => {
  const resolvers: Array<() => void> = [];
  const probe = jest.fn(
    () => new Promise<void>((resolve) => resolvers.push(resolve))
  );
  const healthPromise = new HealthService(targets, probe, {
    nowMs: () => 0,
  }).check();

  await Promise.resolve();
  expect(probe).toHaveBeenCalledTimes(3);
  resolvers.forEach((resolve) => resolve());
  const health = await healthPromise;

  expect(health.map(({ service }) => service)).toEqual([
    "auth",
    "backoffice",
    "bet",
    "client",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
    "telemetry",
  ]);
  expect(health[0]).toEqual({ service: "auth", status: "green" });
  expect(health[9]).toEqual({ service: "telemetry", status: "green" });
});

it("classifies exact elapsed boundaries and probe errors", async () => {
  const times = [0, 0, 0, 250, 251, 1000];
  const health = await new HealthService(
    targets,
    jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined),
    { nowMs: () => times.shift()! }
  ).check();
  expect(health.slice(0, 3)).toEqual([
    { service: "auth", status: "green" },
    { service: "backoffice", status: "yellow" },
    { service: "bet", status: "red" },
  ]);

  const failed = await new HealthService(
    [targets[0]],
    jest.fn().mockRejectedValue(new Error("dns")),
    { nowMs: () => 0 }
  ).check();
  expect(failed[0]).toEqual({ service: "auth", status: "red" });
  expect(failed[9]).toEqual({ service: "telemetry", status: "green" });
});

it("executes one new direct concurrent probe fan-out for every check", async () => {
  const probe = jest.fn().mockResolvedValue(undefined);
  const healthService = new HealthService(targets, probe, { nowMs: () => 0 });

  const first = await healthService.check();
  const second = await healthService.check();

  expect(probe).toHaveBeenCalledTimes(6);
  expect(second).not.toBe(first);
  expect(second).toEqual(first);
});

it("does not retain a failed probe result for the next check", async () => {
  const probe = jest
    .fn()
    .mockRejectedValueOnce(new Error("connection"))
    .mockResolvedValueOnce(undefined);
  const healthService = new HealthService([targets[0]], probe, {
    nowMs: () => 0,
  });

  const first = await healthService.check();
  const second = await healthService.check();

  expect(first[0]).toEqual({ service: "auth", status: "red" });
  expect(second[0]).toEqual({ service: "auth", status: "green" });
  expect(probe).toHaveBeenCalledTimes(2);
});
