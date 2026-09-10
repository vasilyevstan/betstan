import { HealthService, ProbeTarget } from "../Health";

const targets: ProbeTarget[] = [
  { service: "auth", host: "auth", port: 3000 },
  { service: "backoffice", host: "backoffice", port: 3000 },
  { service: "bet", host: "bet", port: 3000 },
];

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
  const times = [0, 0, 0, 0, 250, 251, 1000, 1000];
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

it("single-flights concurrent checks and caches one complete nine-probe batch", async () => {
  const allTargets = [
    { service: "auth", host: "auth", port: 3000 },
    { service: "backoffice", host: "backoffice", port: 3000 },
    { service: "bet", host: "bet", port: 3000 },
    { service: "client", host: "client", port: 3000 },
    { service: "event", host: "event", port: 3000 },
    { service: "gamemaster", host: "gamemaster", port: 3000 },
    { service: "moderation", host: "moderation", port: 3000 },
    { service: "resulting", host: "resulting", port: 3000 },
    { service: "slip", host: "slip", port: 3000 },
  ] as ProbeTarget[];
  const resolvers: Array<() => void> = [];
  const probe = jest.fn(
    () => new Promise<void>((resolve) => resolvers.push(resolve))
  );
  const healthService = new HealthService(
    allTargets,
    probe,
    { nowMs: () => 0 },
    5000
  );

  const checks = Array.from({ length: 25 }, () => healthService.check());
  await Promise.resolve();
  expect(probe).toHaveBeenCalledTimes(9);
  resolvers.forEach((resolve) => resolve());
  const results = await Promise.all(checks);

  expect(results).toHaveLength(25);
  expect(results.every((result) => result === results[0])).toBe(true);
  expect(results[0]).toHaveLength(10);
});

it("reuses before expiry and refreshes once at expiry", async () => {
  let now = 0;
  const probe = jest.fn().mockResolvedValue(undefined);
  const healthService = new HealthService(
    targets,
    probe,
    { nowMs: () => now },
    5000
  );

  await healthService.check();
  expect(probe).toHaveBeenCalledTimes(3);
  now = 4999;
  await healthService.check();
  expect(probe).toHaveBeenCalledTimes(3);
  now = 5000;
  await healthService.check();
  expect(probe).toHaveBeenCalledTimes(6);
});

it("caches red results normally", async () => {
  let now = 0;
  const probe = jest.fn().mockRejectedValue(new Error("connection"));
  const healthService = new HealthService(
    [targets[0]],
    probe,
    { nowMs: () => now },
    5000
  );

  const first = await healthService.check();
  now = 4000;
  const second = await healthService.check();

  expect(first[0]).toEqual({ service: "auth", status: "red" });
  expect(second).toBe(first);
  expect(probe).toHaveBeenCalledTimes(1);
});
