import { HealthService, ProbeTarget } from "../Health";
import { SERVICES } from "../../domain/metrics";

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

  expect(health.map(({ service }) => service)).toEqual(SERVICES);
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
