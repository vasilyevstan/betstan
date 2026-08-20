import amqp from "amqplib";

const { execSync } = require("child_process");
const CONNECT_RETRIES = 10;

class MessengerWrapper {
  private _connection?: amqp.ChannelModel;

  get connection(): amqp.ChannelModel {
    if (!this._connection) {
      throw new Error("Connection must be initialised before use");
    }

    return this._connection;
  }

  async connect(url: string): Promise<void> {
    let isConnected = false;

    for (let i = 0; i < CONNECT_RETRIES && !isConnected; i++) {
      console.log("Rabbit connection attempt", i + 1);

      await amqp
        .connect(url)
        .then((connection) => {
          console.log("Rabbit conncetion created");
          this._connection = connection;
          isConnected = true;
        })
        .catch((err) => {
          if (i == CONNECT_RETRIES - 1) {
            process.exit(1);
          }

          execSync("sleep 5");
        });
    }

    console.log("Connected to RabbitMQ");
  }

  async getChannel(): Promise<amqp.Channel> {
    return await this.connection.createChannel();
  }
}

export const messengerWrapper = new MessengerWrapper();
