import { Channel } from "amqplib";
import { randomUUID } from "crypto";
import { IAmqpConnection } from "@betstan/common";

export interface DraftTelemetryReporter {
  initialize(): Promise<void>;
  reportSlipCreated(): void;
}

export class SlipTelemetryReporter implements DraftTelemetryReporter {
  private channel?: Channel;
  private initialized = false;

  constructor(
    private readonly connection: IAmqpConnection,
    private readonly logger: Pick<Console, "error"> = console,
    private readonly now: () => Date = () => new Date(),
    private readonly uuid: () => string = randomUUID
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    let channel: Channel | undefined;
    try {
      channel = await this.connection.createChannel();
      await channel.assertExchange("telemetry:event:v1", "fanout", {
        durable: true,
      });
      channel.on("error", () => {
        this.channel = undefined;
        this.logger.error("slip_telemetry_disabled");
      });
      channel.on("close", () => {
        this.channel = undefined;
      });
      this.channel = channel;
    } catch {
      this.channel = undefined;
      if (channel?.close) {
        await channel.close().catch(() => undefined);
      }
      this.logger.error("slip_telemetry_disabled");
    }
  }

  reportSlipCreated(): void {
    const channel = this.channel;
    if (!channel) {
      return;
    }

    try {
      const occurredAt = this.now().toISOString();
      const eventId = this.uuid().toLowerCase();
      channel.publish(
        "telemetry:event:v1",
        "",
        Buffer.from(
          JSON.stringify({
            data: {
              metric: "SLIP_CREATED",
              eventId,
              occurredAt,
            },
            timestamp: occurredAt,
            sender: "slip",
          })
        ),
        {
          contentType: "application/json",
          persistent: true,
        }
      );
    } catch {
      this.logger.error("slip_telemetry_publish_failed");
    }
  }
}
