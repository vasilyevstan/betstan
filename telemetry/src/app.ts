import { randomUUID } from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { METRICS, MetricName } from "./domain/metrics";
import { HealthService, ServiceHealth } from "./service/Health";
import { MetricRecorder, MongoMetricRecorder } from "./service/Recorder";
import {
  buildMetricSummary,
  buildHourlyMetricSummary,
  HourlyMetricSummary,
  HourlySummaryStore,
  MetricValues,
  MongoSummaryStore,
  parseHourlyDay,
  SummaryStore,
} from "./service/Summary";

export interface AppDependencies {
  clock: {
    now(): Date;
  };
  health: HealthService;
  hourlyStore: HourlySummaryStore;
  processClock: {
    nowMs(): number;
  };
  recorder: MetricRecorder;
  summaryStore: SummaryStore;
  uuid(): string;
}

const defaultDependencies = (): AppDependencies => ({
  clock: { now: () => new Date() },
  health: new HealthService(),
  hourlyStore: new MongoSummaryStore(),
  processClock: { nowMs: () => Date.now() },
  recorder: new MongoMetricRecorder(),
  summaryStore: new MongoSummaryStore(),
  uuid: randomUUID,
});

interface SummaryResponse {
  generatedAt: string;
  dates: string[];
  metrics: MetricValues[];
  health: ServiceHealth[];
}

const SUMMARY_CACHE_DURATION_MS = 5000;

const createTokenBucket = (
  capacity: number,
  refillPerSecond: number,
  nowMs: () => number
) => {
  let availableTokens = capacity;
  let lastRefillAt = nowMs();

  return (): boolean => {
    const now = nowMs();
    if (now > lastRefillAt) {
      availableTokens = Math.min(
        capacity,
        availableTokens + ((now - lastRefillAt) * refillPerSecond) / 1000
      );
      lastRefillAt = now;
    }
    if (availableTokens < 1) {
      return false;
    }
    availableTokens -= 1;
    return true;
  };
};

const rateLimit = (takeToken: () => boolean) =>
  (_req: Request, res: Response, next: NextFunction) => {
    if (!takeToken()) {
      return res
        .set("Retry-After", "1")
        .status(429)
        .send({ error: "Too many requests" });
    }
    return next();
  };

const invalidRequest = (res: Response) =>
  res.status(400).send({ error: "Invalid request" });

const isBoundedClientBodyError = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const status = Reflect.get(error, "status");
  const type = Reflect.get(error, "type");
  return Number.isInteger(status)
    && status >= 400
    && status < 500
    && typeof type === "string"
    && /^(charset|encoding|entity|request)\./.test(type);
};

export const telemetryErrorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (
    isBoundedClientBodyError(error)
    || (error instanceof URIError && Reflect.get(error, "status") === 400)
  ) {
    return invalidRequest(res);
  }

  console.error("telemetry_http_unexpected_error");
  return res.status(500).send({ error: "Internal server error" });
};

export const createApp = (
  overrides: Partial<AppDependencies> = {}
): express.Express => {
  const dependencies = {
    ...defaultDependencies(),
    ...overrides,
  };
  const app = express();
  const takePageViewToken = createTokenBucket(
    20,
    1,
    () => dependencies.processClock.nowMs()
  );
  const takeSummaryToken = createTokenBucket(
    10,
    2,
    () => dependencies.processClock.nowMs()
  );
  const takeHourlyToken = createTokenBucket(
    16,
    2,
    () => dependencies.processClock.nowMs()
  );
  const hourlyInFlight = new Map<string, Promise<HourlyMetricSummary>>();
  let cachedSummary:
    | {
      expiresAt: number;
      response: SummaryResponse;
    }
    | undefined;
  let summaryInFlight: Promise<SummaryResponse> | undefined;

  const getSummary = (): Promise<SummaryResponse> => {
    const now = dependencies.processClock.nowMs();
    if (cachedSummary && now < cachedSummary.expiresAt) {
      return Promise.resolve(cachedSummary.response);
    }
    if (summaryInFlight) {
      return summaryInFlight;
    }

    const refresh = Promise.resolve().then(async () => {
      const generatedAt = dependencies.clock.now();
      const [summary, health] = await Promise.all([
        buildMetricSummary(generatedAt, dependencies.summaryStore),
        dependencies.health.check(),
      ]);
      const response: SummaryResponse = {
        generatedAt: generatedAt.toISOString(),
        dates: summary.dates,
        metrics: summary.metrics,
        health,
      };
      cachedSummary = {
        expiresAt:
          dependencies.processClock.nowMs() + SUMMARY_CACHE_DURATION_MS,
        response,
      };
      return response;
    });
    summaryInFlight = refresh.finally(() => {
      summaryInFlight = undefined;
    });
    return summaryInFlight;
  };

  app.post(
    "/api/telemetry/page-view",
    rateLimit(takePageViewToken),
    express.json({ strict: true }),
    async (req, res) => {
      if (
        !req.is("application/json")
        || typeof req.body !== "object"
        || req.body === null
        || Array.isArray(req.body)
        || Object.keys(req.body).length !== 1
        || !Object.prototype.hasOwnProperty.call(req.body, "page")
        || (req.body.page !== "main" && req.body.page !== "admin")
      ) {
        return invalidRequest(res);
      }

      const occurredAt = dependencies.clock.now();
      const eventId = dependencies.uuid().toLowerCase();
      try {
        await dependencies.recorder.record({
          _id: eventId,
          metric:
            req.body.page === "main" ? "MAIN_PAGE_VISIT" : "ADMIN_PAGE_VISIT",
          occurredAt,
        });
        return res.status(202).send({ accepted: true });
      } catch {
        return res
          .status(503)
          .send({ error: "Telemetry temporarily unavailable" });
      }
    }
  );

  app.get(
    "/api/telemetry/summary",
    rateLimit(takeSummaryToken),
    async (req, res) => {
      if (Object.keys(req.query).length !== 0) {
        return invalidRequest(res);
      }

      try {
        return res.send(await getSummary());
      } catch {
        return res
          .status(503)
          .send({ error: "Telemetry temporarily unavailable" });
      }
    }
  );

  app.get(
    "/api/telemetry/metrics/:metric/days/:date",
    rateLimit(takeHourlyToken),
    (req, res, next) => {
      const generatedAt = dependencies.clock.now();
      const { metric, date } = req.params;
      if (
        // Reject raw query syntax too: Express can discard keys such as __proto__.
        req.originalUrl.includes("?")
        || !METRICS.includes(metric as MetricName)
        || !parseHourlyDay(date, generatedAt)
      ) {
        return invalidRequest(res);
      }

      // Validate even joiners at UTC midnight; join before testing the ceiling.
      const key = `${metric}/${date}`;
      let computation = hourlyInFlight.get(key);
      if (!computation) {
        if (hourlyInFlight.size >= 8) {
          return res
            .set("Retry-After", "1")
            .status(429)
            .send({ error: "Too many requests" });
        }
        const reserved = Promise.resolve()
          .then(() => buildHourlyMetricSummary(
            generatedAt,
            metric as MetricName,
            date,
            dependencies.hourlyStore
          ))
          .finally(() => {
            if (hourlyInFlight.get(key) === reserved) {
              hourlyInFlight.delete(key);
            }
          });
        // Reserve synchronously; only actual settlement releases the slot,
        // never a client abort or a separate HTTP deadline.
        hourlyInFlight.set(key, reserved);
        computation = reserved;
      }
      return computation.then(
        (summary) => res.send(summary),
        () => res
          .status(503)
          .send({ error: "Telemetry temporarily unavailable" })
      ).catch(next);
    }
  );

  app.use("/api/telemetry", (_req, res) =>
    res.status(404).send({ error: "Not found" })
  );

  app.use(telemetryErrorHandler);

  return app;
};

export const app = createApp();
