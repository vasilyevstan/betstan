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
  private closing = false;
  private closePromise?: Promise<void>;
  private fatalTriggered = false;

  constructor(
    private readonly connection: ChannelModel,
    private readonly recorder: MetricRecorder,
    private readonly onFatal: () => void,
    private readonly logger: SafeLogger = console
  ) {}

  async start(): Promise<void> {
    this.connection.on("error", this.handleLifecycleFailure);
    this.connection.on("close", this.handleLifecycleFailure);
    const channel = await this.connection.createChannel();
    this.channel = channel;
    channel.on("error", this.handleLifecycleFailure);
    channel.on("close", this.handleLifecycleFailure);

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
        if (!message) {
          this.triggerFatal();
          return;
        }
        void this.handle(message).catch(() => {
          this.triggerFatal();
        });
      },
      { noAck: false }
    );
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = (async () => {
        await this.channel?.close();
        this.channel = undefined;
      })();
    }
    await this.closePromise;
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
    } catch {
      this.logger.error("telemetry_record_failed");
      channel.nack(message, false, false);
      return;
    }
    channel.ack(message);
  }

  private readonly handleLifecycleFailure = () => {
    this.triggerFatal();
  };

  private triggerFatal(): void {
    if (this.closing || this.fatalTriggered) {
      return;
    }
    this.fatalTriggered = true;
    try {
      this.onFatal();
    } catch {
      this.logger.error("telemetry_fatal_callback_failed");
    }
  }
}
