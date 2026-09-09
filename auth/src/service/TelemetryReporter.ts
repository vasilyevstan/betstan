import amqp, { Channel, ChannelModel } from "amqplib";
import { randomUUID } from "crypto";

export type AuthTelemetryMetric = "USER_CREATED" | "USER_LOGGED_IN";

interface ReporterDependencies {
  connect(uri: string, options?: Record<string, unknown>): Promise<ChannelModel>;
  now(): Date;
  uuid(): string;
  logger: Pick<Console, "error">;
  timeoutMs: number;
}

const defaults: ReporterDependencies = {
  connect: (uri, options) => amqp.connect(uri, options),
  now: () => new Date(),
  uuid: randomUUID,
  logger: console,
  timeoutMs: 1000,
};

const bounded = async <T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T> => {
  let handle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (handle) {
      clearTimeout(handle);
    }
  }
};

export class AuthTelemetryReporter {
  private channel?: Channel;
  private connection?: ChannelModel;
  private started = false;
  private disabled = false;
  private readonly dependencies: ReporterDependencies;

  constructor(overrides: Partial<ReporterDependencies> = {}) {
    this.dependencies = { ...defaults, ...overrides };
  }

  async initialize(uri: string | undefined): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    if (!uri) {
      this.disable();
      return;
    }

    try {
      const connectionOperation = this.dependencies
        .connect(uri, {
          timeout: this.dependencies.timeoutMs,
        })
        .then(async (connection) => {
          if (this.disabled) {
            await connection.close().catch(() => undefined);
          }
          return connection;
        });
      const connection = await bounded(
        connectionOperation,
        this.dependencies.timeoutMs
      );
      if (this.disabled) {
        await connection.close().catch(() => undefined);
        return;
      }
      this.connection = connection;
      connection.on("error", () => this.disable());
      connection.on("close", () => this.disable());

      const channelOperation = connection.createChannel().then(async (channel) => {
        if (this.disabled) {
          await channel.close().catch(() => undefined);
        }
        return channel;
      });
      const channel = await bounded(
        channelOperation,
        this.dependencies.timeoutMs
      );
      if (this.disabled) {
        await channel.close().catch(() => undefined);
        return;
      }
      channel.on("error", () => this.disable());
      channel.on("close", () => this.disable());
      await bounded(
        channel.assertExchange("telemetry:event:v1", "fanout", {
          durable: true,
        }),
        this.dependencies.timeoutMs
      );
      this.channel = channel;
    } catch {
      this.disable();
      await this.connection?.close().catch(() => undefined);
      this.connection = undefined;
    }
  }

  report(metric: AuthTelemetryMetric): void {
    const channel = this.channel;
    if (!channel || this.disabled) {
      return;
    }

    try {
      const occurredAt = this.dependencies.now().toISOString();
      const eventId = this.dependencies.uuid().toLowerCase();
      const payload = Buffer.from(
        JSON.stringify({
          data: {
            metric,
            eventId,
            occurredAt,
          },
          timestamp: occurredAt,
          sender: "auth",
        })
      );
      channel.publish("telemetry:event:v1", "", payload, {
        contentType: "application/json",
        persistent: true,
      });
    } catch {
      this.dependencies.logger.error("auth_telemetry_publish_failed");
    }
  }

  private disable(): void {
    if (this.disabled) {
      return;
    }
    this.disabled = true;
    this.channel = undefined;
    this.dependencies.logger.error("auth_telemetry_disabled");
  }
}

export const authTelemetryReporter = new AuthTelemetryReporter();
