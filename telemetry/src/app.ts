import { randomUUID } from "crypto";
import express, { NextFunction, Request, Response } from "express";
import { HealthService } from "./service/Health";
import { MetricRecorder, MongoMetricRecorder } from "./service/Recorder";
import {
  buildMetricSummary,
  MongoSummaryStore,
  SummaryStore,
} from "./service/Summary";

export interface AppDependencies {
  clock: {
    now(): Date;
  };
  health: HealthService;
  recorder: MetricRecorder;
  summaryStore: SummaryStore;
  uuid(): string;
}

const defaultDependencies = (): AppDependencies => ({
  clock: { now: () => new Date() },
  health: new HealthService(),
  recorder: new MongoMetricRecorder(),
  summaryStore: new MongoSummaryStore(),
  uuid: randomUUID,
});

const invalidRequest = (res: Response) =>
  res.status(400).send({ error: "Invalid request" });

const isMalformedJson = (error: unknown): boolean =>
  typeof error === "object"
  && error !== null
  && Reflect.get(error, "status") === 400
  && Reflect.get(error, "type") === "entity.parse.failed";

export const telemetryErrorHandler = (
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  if (isMalformedJson(error)) {
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

  app.use(express.json({ strict: true }));

  app.post("/api/telemetry/page-view", async (req, res) => {
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
  });

  app.get("/api/telemetry/summary", async (req, res) => {
    if (Object.keys(req.query).length !== 0) {
      return invalidRequest(res);
    }

    const generatedAt = dependencies.clock.now();
    try {
      const [summary, health] = await Promise.all([
        buildMetricSummary(generatedAt, dependencies.summaryStore),
        dependencies.health.check(),
      ]);
      return res.send({
        generatedAt: generatedAt.toISOString(),
        dates: summary.dates,
        metrics: summary.metrics,
        health,
      });
    } catch {
      return res
        .status(503)
        .send({ error: "Telemetry temporarily unavailable" });
    }
  });

  app.use(telemetryErrorHandler);

  return app;
};

export const app = createApp();
