import {
  Channel,
  ChannelModel,
  ConsumeMessage,
} from "amqplib";
import { EXCHANGES, validateExchangeEvent } from "./validator";
import { MetricRecorder } from "../service/Recorder";

export interface SafeLogger {
  error(code: string): void;
}

export class TelemetryConsumer {
  private channel?: Channel;

  constructor(
    private readonly connection: ChannelModel,
    private readonly recorder: MetricRecorder,
    private readonly logger: SafeLogger = console
  ) {}

  async start(): Promise<void> {
    const channel = await this.connection.createChannel();
    this.channel = channel;

    for (const exchange of EXCHANGES) {
      await channel.assertExchange(exchange, "fanout", { durable: true });
    }
    await channel.assertQueue("telemetry:events:v1", { durable: true });
    for (const exchange of EXCHANGES) {
      await channel.bindQueue("telemetry:events:v1", exchange, "");
    }
    await channel.prefetch(10);
    await channel.consume(
      "telemetry:events:v1",
      (message) => {
        if (message) {
          void this.handle(message);
        }
      },
      { noAck: false }
    );
  }

  async close(): Promise<void> {
    await this.channel?.close();
    this.channel = undefined;
  }

  async handle(message: ConsumeMessage): Promise<void> {
    const channel = this.channel;
    if (!channel) {
      throw new Error("telemetry_consumer_not_started");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.content.toString("utf8"));
    } catch {
      this.logger.error("telemetry_event_invalid");
      channel.ack(message);
      return;
    }

    const record = validateExchangeEvent(message.fields.exchange, parsed);
    if (!record) {
      this.logger.error("telemetry_event_invalid");
      channel.ack(message);
      return;
    }

    try {
      await this.recorder.record(record);
      channel.ack(message);
    } catch {
      this.logger.error("telemetry_record_failed");
      channel.nack(message, false, false);
    }
  }
}
