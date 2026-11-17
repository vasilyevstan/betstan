import http from "http";
import mongoose from "mongoose";
import { SERVICES, ServiceName } from "../domain/metrics";

export interface ProbeTarget {
  service: Exclude<ServiceName, "telemetry">;
  host: string;
  port: number;
}

export interface HealthClock {
  nowMs(): number;
}

export type HealthStatus = "green" | "yellow" | "red";
export interface ProbeResult {
  status: HealthStatus;
  liveBettingEnabled?: boolean;
}
export type HttpProbe = (target: ProbeTarget) => Promise<ProbeResult>;

export interface ServiceHealth {
  service: ServiceName;
  status: HealthStatus;
  liveBettingEnabled?: boolean | null;
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

export const createHttpProbe = (timeoutMs = 1000): HttpProbe =>
  (target) =>
    new Promise<ProbeResult>((resolve, reject) => {
      let settled = false;
      let response: http.IncomingMessage | undefined;
      const finish = (error?: Error, result?: ProbeResult) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        response?.destroy();
        request.destroy();
        if (error) {
          reject(error);
        } else if (result) {
          resolve(result);
        }
      };
      const request = http.get({
        host: target.host,
        port: target.port,
        path: target.service === "client" ? "/" : "/health",
        agent: false,
      }, (incoming) => {
        response = incoming;
        if (incoming.statusCode !== 200) {
          finish(new Error("not_ready"));
          return;
        }
        const client = target.service === "client";
        if (!incoming.headers["content-type"]?.startsWith(client ? "text/html" : "application/json")) {
          finish(new Error("invalid_response"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (client ? 65536 : 1024)) {
            finish(new Error("invalid_response"));
            return;
          }
          chunks.push(chunk);
        });
        incoming.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (client) {
            finish(body.trim() ? undefined : new Error("invalid_response"), { status: "green" });
            return;
          }
          try {
            const value = JSON.parse(body);
            if (!value || !["green", "yellow", "red"].includes(value.status)
              || (target.service === "gamemaster"
                && typeof value.liveBettingEnabled !== "boolean")) {
              finish(new Error("invalid_response"));
              return;
            }
            finish(undefined, {
              status: value.status,
              ...(target.service === "gamemaster"
                ? { liveBettingEnabled: value.liveBettingEnabled } : {}),
            });
          } catch {
            finish(new Error("invalid_response"));
          }
        });
        incoming.once("error", () => finish(new Error("connection")));
        incoming.once("aborted", () => finish(new Error("connection")));
      });
      const deadline = setTimeout(() => finish(new Error("timeout")), timeoutMs);
      request.once("error", () => finish(new Error("connection")));
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
  constructor(
    private readonly targets: ProbeTarget[] = defaultTargets(),
    private readonly probe: HttpProbe = createHttpProbe(),
    private readonly clock: HealthClock = { nowMs: () => Date.now() },
    private readonly selfReady: () => boolean = () => mongoose.connection.readyState === 1
  ) {}

  async check(): Promise<ServiceHealth[]> {
    const remote = await Promise.all(
      this.targets.map(async (target): Promise<ServiceHealth> => {
        const startedAt = this.clock.nowMs();
        try {
          const result = await this.probe(target);
          const elapsedStatus = classifyElapsed(this.clock.nowMs() - startedAt);
          return {
            service: target.service,
            status: result.status === "red" || elapsedStatus === "red" ? "red"
              : result.status === "yellow" || elapsedStatus === "yellow" ? "yellow" : "green",
            ...(target.service === "gamemaster"
              ? { liveBettingEnabled: result.liveBettingEnabled ?? null } : {}),
          };
        } catch {
          return {
            service: target.service,
            status: "red",
            ...(target.service === "gamemaster" ? { liveBettingEnabled: null } : {}),
          };
        }
      })
    );
    const byService = new Map(remote.map((health) => [health.service, health]));
    return SERVICES.map((service) =>
      service === "telemetry"
        ? { service, status: this.selfReady() ? "green" : "red" }
        : byService.get(service) ?? {
          service, status: "red",
          ...(service === "gamemaster" ? { liveBettingEnabled: null } : {}),
        }
    );
  }
}
