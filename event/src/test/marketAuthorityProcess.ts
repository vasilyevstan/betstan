import { createRequire } from "module";
import { resolve } from "path";
import type { IEvent, IMarketPublishedEvent } from "@betstan/common";

if (process.env.MARKET_AUTHORITY_FIXTURE !== "1" || !process.send) {
  throw new Error("Market authority fixture requires an isolated IPC test process");
}
const load = createRequire(resolve(__dirname, "../../../backoffice/package.json"));
const common: typeof import("@betstan/common") = load("@betstan/common");
const mongoose: typeof import("mongoose") = load("mongoose");
const { MongoMemoryServer }: typeof import("mongodb-memory-server") = load("mongodb-memory-server");

// Only transport is simulated. HTTP, validation, Mongo CAS and publication handlers are real.
Object.defineProperty(common.messengerWrapper, "connection", { value: {} });
common.APublisher.prototype.initConfirmChannel = async () => {};
common.APublisher.prototype.publishWithConfirm = async function (event: IEvent) {
  process.send!({ type: "published", queue: this.queue, event });
};

const start = async () => {
  const mongo = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" } });
  await mongoose.connect(mongo.getUri());
  const { Event }: typeof import("../../../backoffice/src/model/Event") = load("./src/model/Event");
  const { MarketTemplate }: typeof import("../../../backoffice/src/model/MarketTemplate") = load("./src/model/MarketTemplate");
  const { MarketPublishedListener }: typeof import("../../../backoffice/src/event/listener/MarketPublishedListener") =
    load("./src/event/listener/MarketPublishedListener");
  const { getBackofficePublicationService }: typeof import("../../../backoffice/src/service/BackofficePublicationService") =
    load("./src/service/BackofficePublicationService");
  await Promise.all([Event.init(), MarketTemplate.init()]);
  const time = new Date(Date.now() + 600_000).toISOString();
  await Event.create({ eventId: "authority-fixture", name: "Home - Away", home: "Home", away: "Away", time });
  const { app }: typeof import("../../../backoffice/src/app") = load("./src/app");
  const server = app.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Fixture did not bind a loopback port");
    process.send!({ type: "ready", port: address.port, time });
  });
  process.on("message", (message: { id: number; publication: IMarketPublishedEvent["data"] }) => {
    void (async () => {
      const listener = new MarketPublishedListener(common.messengerWrapper.connection);
      Object.defineProperty(listener, "channel", { value: { ack: () => {} } });
      await listener.onMessage({ data: message.publication }, null!);
      process.send!({ type: "acknowledged", id: message.id });
    })().catch((error: Error) => process.send!({ type: "failed", error: error.message }));
  });
  process.once("SIGTERM", () => {
    void (async () => {
      await getBackofficePublicationService(common.messengerWrapper.connection).stop();
      await new Promise<void>((complete, reject) => server.close(error => error ? reject(error) : complete()));
      await mongoose.disconnect();
      await mongo.stop();
    })().then(() => process.exit(0), (error: Error) => {
      process.send!({ type: "failed", error: error.message });
      process.exit(1);
    });
  });
};
void start().catch((error: Error) => {
  process.send!({ type: "failed", error: error.message });
  process.exit(1);
});
