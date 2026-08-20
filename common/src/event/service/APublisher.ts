import { Channel, ChannelModel, ConfirmChannel, Options } from "amqplib";
import { IEvent } from "../IEvent";
import { QueueNames } from "./QueueNames";

export type PublishOptions = Options.Publish;

export abstract class APublisher<T extends IEvent> {
  abstract queue: QueueNames;
  abstract serviceName: string;
  private _channel?: Channel;
  private _confirmChannel?: ConfirmChannel;
  connection: ChannelModel;

  constructor(connection: ChannelModel) {
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

  protected get confirmChannel(): ConfirmChannel {
    if (!this._confirmChannel) {
      throw Error("Confirm channel must be initialised");
    }

    return this._confirmChannel;
  }

  protected set confirmChannel(channel: ConfirmChannel) {
    this._confirmChannel = channel;
  }

  async init(): Promise<void> {
    try {
      this.channel = await this.connection.createChannel();
      await this.channel.assertExchange(this.queue, "fanout");
    } catch (err) {
      console.log("error in publisher", err);
    }
  }

  async initConfirmChannel(): Promise<void> {
    this.confirmChannel = await this.connection.createConfirmChannel();
    await this.confirmChannel.assertExchange(this.queue, "fanout");
  }

  publish(data: T): void {
    data.timestamp = new Date().toISOString();
    data.sender = this.serviceName;
    const stringData = JSON.stringify(data);
    this.channel.publish(this.queue, "", Buffer.from(stringData));
    console.log("Sent", stringData, "to queue", this.queue);
  }

  async publishWithConfirm(
    data: T,
    publishOptions: PublishOptions = {},
  ): Promise<void> {
    data.timestamp = new Date().toISOString();
    data.sender = this.serviceName;
    const stringData = JSON.stringify(data);
    const channel = this.confirmChannel;

    await new Promise<void>((resolve, reject) => {
      channel.publish(
        this.queue,
        "",
        Buffer.from(stringData),
        { ...publishOptions, persistent: true },
        (err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        },
      );
    });
  }
}
