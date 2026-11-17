import http from "http";
import { AddressInfo } from "net";
import {
  createHttpProbe,
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

it.each([
  [200, "application/json", '{"status":"green"}', "green"],
  [200, "application/json", '{"status":"yellow"}', "yellow"],
  [503, "application/json", '{"status":"red"}', null],
  [204, "application/json", "", null],
  [200, "text/html", '<html>not readiness</html>', null],
  [200, "application/json", '{"status":"unknown"}', null],
  [200, "application/json", "not-json", null],
  [200, "application/json", "x".repeat(1025), null],
])("validates HTTP readiness %s %s", async (code, contentType, body, expected) => {
  const server = http.createServer((req, res) => {
    expect(req.url).toBe("/health");
    res.writeHead(code, { "Content-Type": contentType });
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = createHttpProbe()({
      service: "auth", host: "127.0.0.1", port: (server.address() as AddressInfo).port,
    });
    if (expected) await expect(result).resolves.toEqual({ status: expected });
    else await expect(result).rejects.toThrow();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("times out even when a listening socket never answers HTTP", async () => {
  const server = http.createServer(() => {});
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await expect(createHttpProbe(50)({
      service: "auth", host: "127.0.0.1", port: (server.address() as AddressInfo).port,
    })).rejects.toThrow("timeout");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each(["complete", "empty", "aborted", "headers-only"])("requires a complete client document (%s)", async mode => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.flushHeaders();
    if (mode === "complete") res.end("<html><body>BetStan</body></html>");
    if (mode === "empty") res.end();
    if (mode === "aborted") res.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const probe = createHttpProbe(100)({
      service: "client", host: "127.0.0.1", port: (server.address() as AddressInfo).port,
    });
    if (mode === "complete") await expect(probe).resolves.toEqual({ status: "green" });
    else await expect(probe).rejects.toThrow();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it.each([true, false, undefined])("requires an explicit live flag from Game master (%s)", async (enabled) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "green", liveBettingEnabled: enabled }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const probe = createHttpProbe()({
      service: "gamemaster", host: "127.0.0.1", port: (server.address() as AddressInfo).port,
    });
    if (enabled === undefined) await expect(probe).rejects.toThrow("invalid_response");
    else await expect(probe).resolves.toEqual({ status: "green", liveBettingEnabled: enabled });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("starts remote probes concurrently and returns exact service order", async () => {
  const resolvers: Array<() => void> = [];
  const probe = jest.fn(
    () => new Promise<{ status: "green" }>((resolve) => resolvers.push(() => resolve({ status: "green" })))
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
      .mockResolvedValueOnce({ status: "green" })
      .mockResolvedValueOnce({ status: "green" })
      .mockResolvedValueOnce({ status: "green" }),
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
  const probe = jest.fn().mockResolvedValue({ status: "green" });
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
    .mockResolvedValueOnce({ status: "green" });
  const healthService = new HealthService([targets[0]], probe, {
    nowMs: () => 0,
  });

  const first = await healthService.check();
  const second = await healthService.check();

  expect(first[0]).toEqual({ service: "auth", status: "red" });
  expect(second[0]).toEqual({ service: "auth", status: "green" });
  expect(probe).toHaveBeenCalledTimes(2);
});

it("does not turn a fast failed service or failed observer green", async () => {
  const health = await new HealthService(
    targets, jest.fn().mockResolvedValue({ status: "red" }),
    { nowMs: () => 0 }, () => false,
  ).check();
  expect(health.every(entry => entry.status === "red")).toBe(true);
});
