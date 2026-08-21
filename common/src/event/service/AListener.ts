import { Channel, ConsumeMessage, Options } from "amqplib";
import { IEvent } from "../IEvent";
import { IAmqpConnection } from "./IAmqpConnection";
import { QueueNames } from "./QueueNames";

export type QueueOptions = Options.AssertQueue;
export type ListenerQueueOptions = QueueOptions;

export abstract class AListener<T extends IEvent> {
  abstract queue: QueueNames;
  abstract serviceName: string;
  private _channel?: Channel;
  connection: IAmqpConnection;

  abstract onMessage(event: T, msg: ConsumeMessage): void;

  constructor(connection: IAmqpConnection) {
    this.connection = connection;
  }

  protected get channel(): Channel {
    if (!this._channel) {
      throw Error("Channel must be initialised");
    }

    return this._channel;
  }

  protected set channel(channel: Channel) {
    this._channel = channel;
  }

  protected get queueName(): string {
    return this.serviceName;
  }

  protected get queueOptions(): QueueOptions {
    return {};
  }

  async init(): Promise<void> {
    try {
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(this.queue, "fanout");
      await this.channel.assertQueue(this.queueName, this.queueOptions);
      this.channel.bindQueue(this.queueName, this.queue, "");
    } catch (err) {
      console.log("error in listener", err);
    }
  }

  listen(): void {
    console.log("Listening queue", this.queue);
    this.channel.consume(this.queueName, (msg) => {
      if (msg !== null) {
        console.log("Recieved:", msg.content.toString(), "from queue", this.queue);
        const event = this.parseMessage(msg);
        this.onMessage(event, msg);
      } else {
        console.log("Consumer cancelled by server");
      }
    });
  }

  ack(msg: ConsumeMessage): void {
    if (this.channel) {
      this.channel.ack(msg);
    } else {
      console.log("Channel is undefined");
    }
  }

  parseMessage(msg: ConsumeMessage): any {
    const data = msg.content;
    return typeof data === "string"
      ? JSON.parse(data)
      : JSON.parse(data.toString("utf8"));
  }
}
