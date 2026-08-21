import { Channel, ConfirmChannel } from "amqplib";

export interface IAmqpConnection {
  createChannel(): Promise<Channel>;
  createConfirmChannel(): Promise<ConfirmChannel>;
  close(): Promise<void>;
}
