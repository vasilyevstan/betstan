import net from "net";
import { SERVICES, ServiceName } from "../domain/metrics";

export interface ProbeTarget {
  service: Exclude<ServiceName, "telemetry">;
  host: string;
  port: number;
}

export interface HealthClock {
  nowMs(): number;
}

export type TcpProbe = (target: ProbeTarget) => Promise<void>;
export type HealthStatus = "green" | "yellow" | "red";

export interface ServiceHealth {
  service: ServiceName;
  status: HealthStatus;
}

const REMOTE_SERVICES = SERVICES.filter(
  (service): service is Exclude<ServiceName, "telemetry"> =>
    service !== "telemetry"
);

export const defaultTargets = (
  env: NodeJS.ProcessEnv = process.env
): ProbeTarget[] =>
  REMOTE_SERVICES.map((service) => ({
    service,
    host: env[`${service.toUpperCase()}_HOST`] ?? service,
    port: Number(env[`${service.toUpperCase()}_PORT`] ?? 3000),
  }));

export const createTcpProbe = (timeoutMs = 1000): TcpProbe =>
  (target) =>
    new Promise<void>((resolve, reject) => {
      const socket = net.createConnection({
        host: target.host,
        port: target.port,
      });
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => finish());
      socket.once("timeout", () => finish(new Error("timeout")));
      socket.once("error", () => finish(new Error("connection")));
    });

const classifyElapsed = (elapsed: number): HealthStatus => {
  if (elapsed <= 250) {
    return "green";
  }
  if (elapsed < 1000) {
    return "yellow";
  }
  return "red";
};

export class HealthService {
  private cached?: {
    expiresAt: number;
    health: ServiceHealth[];
  };
  private inFlight?: Promise<ServiceHealth[]>;

  constructor(
    private readonly targets: ProbeTarget[] = defaultTargets(),
    private readonly probe: TcpProbe = createTcpProbe(),
    private readonly clock: HealthClock = { nowMs: () => Date.now() },
    private readonly cacheDurationMs = 5000
  ) {}

  async check(): Promise<ServiceHealth[]> {
    const now = this.clock.nowMs();
    if (this.cached && now < this.cached.expiresAt) {
      return this.cached.health;
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const refresh = this.probeAll().then((health) => {
      this.cached = {
        expiresAt: this.clock.nowMs() + this.cacheDurationMs,
        health,
      };
      return health;
    });
    this.inFlight = refresh;
    const clearInFlight = () => {
      if (this.inFlight === refresh) {
        this.inFlight = undefined;
      }
    };
    void refresh.then(clearInFlight, clearInFlight);
    return refresh;
  }

  private async probeAll(): Promise<ServiceHealth[]> {
    const remote = await Promise.all(
      this.targets.map(async (target): Promise<ServiceHealth> => {
        const startedAt = this.clock.nowMs();
        try {
          await this.probe(target);
          return {
            service: target.service,
            status: classifyElapsed(this.clock.nowMs() - startedAt),
          };
        } catch {
          return {
            service: target.service,
            status: "red",
          };
        }
      })
    );
    const byService = new Map(remote.map((health) => [health.service, health]));
    return SERVICES.map((service) =>
      service === "telemetry"
        ? { service, status: "green" }
        : byService.get(service) ?? { service, status: "red" }
    );
  }
}
