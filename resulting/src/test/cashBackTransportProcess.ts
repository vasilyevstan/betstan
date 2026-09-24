import { createRequire } from "module";
import { resolve } from "path";
import { Server } from "http";
import { createHash } from "crypto";
import type { APublisher, IAmqpConnection, IEvent, QueueNames } from "@betstan/common";
import type { Application } from "express";

interface Listener { init(): Promise<void>; listen(): void }
interface Worker { init?(): Promise<void>; start(): Promise<void>; stop(): Promise<void> }
interface Command { id: number; action: string; data?: Record<string, unknown> }

const root = resolve(__dirname, "../../..");
const role = process.env.CASH_BACK_TEST_ROLE;
if (!role || !["backoffice", "gamemaster", "resulting", "bet"].includes(role)) {
  throw new Error("An explicit isolated cash-back test role is required");
}
const uri = process.env.CASH_BACK_TEST_MONGO_URI;
const broker = process.env.CASH_BACK_TEST_RABBIT_URI;
if (
  !uri || !/^mongodb:\/\/127\.0\.0\.1:\d+\/cashback_it_[a-z0-9_]+$/.test(uri)
  || !broker || !/^amqp:\/\/cashback_test:cashback_test@127\.0\.0\.1:\d+$/.test(broker)
) throw new Error("Only explicitly isolated loopback test infrastructure is allowed");
const load = createRequire(resolve(root, role, "package.json"));
const mongo: typeof import("mongoose") = load("mongoose");
const common: typeof import("@betstan/common") = load("@betstan/common");
let server: Server | undefined;
const workers: Worker[] = [];
let runtime: { shutdown(code: number): Promise<void> } | undefined;
let pausedResultEvent: string | undefined;
let pausedGrantOperation: string | undefined;
let pausedDecisionOperation: string | undefined;
let pausedLiveEvent: string | undefined;
let pausedLedgerEvent: string | undefined;
let resumePublication: (() => void) | undefined;
let publicationGate: Promise<void> | undefined;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const originalPublish = common.APublisher.prototype.publishWithConfirm;
common.APublisher.prototype.publishWithConfirm = async function (this: APublisher<IEvent>, event: IEvent) {
  const data = object(event.data) ? event.data : undefined;
  const request = object(data?.request) ? data.request : undefined;
  const operation = object(request?.operation) ? request.operation : undefined;
  const pause = role === "backoffice" && data?.eventId === pausedResultEvent && typeof data?.homeScore === "number"
    || role === "gamemaster" && data?.outcome === "GRANTED"
      && operation?.operationId === pausedGrantOperation;
  if (pause && publicationGate) {
    process.send?.({ type: "paused", role, operationId: operation?.operationId });
    await publicationGate;
  }
  await originalPublish.call(this, event);
  if (role === "gamemaster" && data?.eventId === pausedLiveEvent && typeof data?.sequence === "number" && publicationGate) {
    process.send?.({ type: "paused", role });
    await publicationGate;
  }
};

const listeners = async (paths: readonly [string, string][]) => {
  for (const [path, name] of paths) {
    const module: Record<string, new (connection: IAmqpConnection) => Listener> = load(path);
    const listener = new module[name](common.messengerWrapper.connection);
    await listener.init();
    listener.listen();
  }
};

class FixturePublisher extends common.APublisher<IEvent> {
  serviceName = "cashback_transport_fixture";
  constructor(public queue: QueueNames) { super(common.messengerWrapper.connection); }
}
const publishers = new Map<QueueNames, FixturePublisher>();
const publish = async (queue: QueueNames, data: unknown) => {
  if (!object(data)) throw new Error("Fixture message data must be an object");
  let publisher = publishers.get(queue);
  if (!publisher) {
    publisher = new FixturePublisher(queue);
    await publisher.initConfirmChannel();
    publishers.set(queue, publisher);
  }
  await publisher.publishWithConfirm({ data });
};

const close = async () => {
  resumePublication?.();
  for (const worker of workers) await worker.stop();
  if (server) await new Promise<void>((resolveClose, reject) =>
    server!.close(error => error ? reject(error) : resolveClose()));
  if (runtime) await runtime.shutdown(0);
  else {
    await common.messengerWrapper.connection.close();
    await mongo.disconnect();
    process.exit(0);
  }
};

const start = async () => {
  await mongo.connect(uri);
  await common.messengerWrapper.connect(broker);
  if (role === "resulting") {
    const models: typeof import("../model/Bet") = load("./src/model/Bet");
    const update = models.Bet.collection.updateOne.bind(models.Bet.collection);
    models.Bet.collection.updateOne = async (filter, changes, options) => {
      const first = Array.isArray(changes) && object(changes[0]) ? changes[0] : undefined;
      const set = object(first?.$set) ? first.$set : undefined;
      if (
        pausedDecisionOperation && filter["cashBackPending.operation.operationId"] === pausedDecisionOperation
        && set?.["cashBackPending.state"] === "ACCEPTED" && publicationGate
      ) {
        process.send?.({ type: "paused", role, operationId: pausedDecisionOperation });
        await publicationGate;
      }
      return update(filter, changes, options);
    };
    const ledgers: typeof import("../model/FinalScoreLedger") = load("./src/model/FinalScoreLedger");
    ledgers.default.collection.findOneAndUpdate = new Proxy(ledgers.default.collection.findOneAndUpdate, {
      apply: async (target, receiver, args) => {
        const stored: unknown = await Reflect.apply(target, receiver, args);
        const filter: unknown = args[0];
        if (pausedLedgerEvent && object(filter) && filter.eventId === pausedLedgerEvent && publicationGate) {
          process.send?.({ type: "paused", role });
          await publicationGate;
        }
        return stored;
      },
    });
    const module: typeof import("../service/startup") = load("./src/service/startup");
    runtime = await module.startResultingService({ mongoUri: uri, rabbitmqUri: broker }, {
      connectDb: async () => {}, connectBroker: async () => {},
      logger: { log: () => {}, error: (...args) => console.error(...args) },
    });
  } else if (role === "bet") {
    const module: { getCashBackFacade(connection: IAmqpConnection): Worker } = load("./src/service/CashBackFacade");
    const facade = module.getCashBackFacade(common.messengerWrapper.connection);
    await facade.init?.();
    workers.push(facade);
    const pendingModule: { PendingBetUpdateWorker: new () => Worker } = load("./src/service/PendingBetUpdateWorker");
    const pending = new pendingModule.PendingBetUpdateWorker();
    workers.push(pending);
    await pending.start();
    await listeners([
      ["./src/event/listener/PlaceBetListener", "default"],
      ["./src/event/listener/ModerationResultListener", "default"],
      ["./src/event/listener/SettleSlipListener", "default"],
      ["./src/event/listener/SettleSlipRowListener", "default"],
      ["./src/event/listener/CashBackOutcomeListener", "CashBackOutcomeListener"],
    ]);
    await facade.start();
  } else {
    await listeners([
      ["./src/event/listener/NewEventListener", "default"],
      ["./src/event/listener/EventResultListener", "default"],
      ["./src/event/listener/CashBackSourceListener", "CashBackSourceListener"],
    ]);
  }
  if (role === "backoffice" || role === "bet") {
    const module: { app: Application } = load("./src/app");
    server = await new Promise<Server>(resolveServer => {
      const listening = module.app.listen(0, "127.0.0.1", () => resolveServer(listening));
    });
  }
  const address = server?.address();
  process.send?.({ type: "ready", role, port: address && typeof address === "object" ? address.port : undefined });
};

const handle = async ({ action, data = {} }: Command): Promise<unknown> => {
  if (action === "pause-decision-after-resume") {
    if (role !== "resulting") throw new Error("Wrong decision owner");
    const previous = resumePublication;
    pausedDecisionOperation = String(data.operationId);
    publicationGate = new Promise<void>(resolveGate => { resumePublication = resolveGate; });
    previous?.();
    return true;
  }
  if (["pause-result", "pause-grant", "pause-decision", "pause-after-live", "pause-ledger"].includes(action)) {
    pausedResultEvent = action === "pause-result" ? String(data.eventId) : undefined;
    pausedGrantOperation = action === "pause-grant" ? String(data.operationId) : undefined;
    pausedDecisionOperation = action === "pause-decision" ? String(data.operationId) : undefined;
    pausedLiveEvent = action === "pause-after-live" ? String(data.eventId) : undefined;
    pausedLedgerEvent = action === "pause-ledger" ? String(data.eventId) : undefined;
    publicationGate = new Promise<void>(resolveGate => { resumePublication = resolveGate; });
    return true;
  }
  if (action === "resume") {
    pausedResultEvent = undefined;
    pausedGrantOperation = undefined;
    pausedDecisionOperation = undefined;
    pausedLiveEvent = undefined;
    pausedLedgerEvent = undefined;
    resumePublication?.();
    publicationGate = undefined;
    return true;
  }
  if (action === "seed-event") {
    if (role !== "backoffice" && role !== "gamemaster") throw new Error("Wrong source database");
    const module: { Event: import("mongoose").Model<Record<string, unknown>> } = load("./src/model/Event");
    await module.Event.create(data);
    return true;
  }
  if (action === "event-state") {
    if (role !== "backoffice" && role !== "gamemaster") throw new Error("Wrong source database");
    const module: { Event: import("mongoose").Model<Record<string, unknown>> } = load("./src/model/Event");
    const event = await module.Event.findOne({ eventId: data.eventId })
      .select("+cashBackGeneration +cashBackHold +cashBackAuthorityIntent +cashBackArchived +cashBackAuthoritySnapshot").lean();
    const intent = object(event?.cashBackAuthorityIntent) ? event.cashBackAuthorityIntent : undefined;
    const message = object(intent?.message) ? intent.message : undefined;
    const snapshot = event?.cashBackAuthoritySnapshot ?? message?.data;
    return event ? {
      status: event.status, generation: event.cashBackGeneration,
      held: Boolean(event.cashBackHold), intent: Boolean(event.cashBackAuthorityIntent),
      archived: Boolean(event.cashBackArchived),
      preKickoffPublished: Boolean(event.livePreKickoffPublishedAt),
      snapshotHash: snapshot ? createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") : undefined,
    } : null;
  }
  if (action === "tick") {
    if (role !== "gamemaster") throw new Error("Only the owning Gamemaster may tick");
    const module: {
      GamemasterWorker: new (options: { leaseDurationMs: number; liveKickoffsEnabled(): boolean }) => {
        checkEventsOnce(): Promise<void>;
      };
    } = load("./src/worker/GamemasterWorker");
    await new module.GamemasterWorker({ leaseDurationMs: 150, liveKickoffsEnabled: () => true }).checkEventsOnce();
    return true;
  }
  if (action === "deadline-matrix") {
    if (role !== "resulting") throw new Error("Wrong decision authority");
    const expressions: typeof import("../service/cashBackState") = load("./src/service/cashBackState");
    const collection = mongo.connection.db.collection("cashbackclockprobes");
    await collection.deleteMany({});
    await collection.insertMany([-1, 0, 1].map(offset => ({ offset })));
    return collection.aggregate([
      { $set: { "cashBackPending.quote.expiresAt": {
        $dateToString: { date: { $add: ["$$NOW", "$offset"] }, format: "%Y-%m-%dT%H:%M:%S.%LZ", timezone: "UTC" },
      } } },
      { $project: {
        _id: 0, offset: 1, eligible: expressions.cashBackBeforeDeadline,
        expired: expressions.cashBackAtOrAfterDeadline, decisionTime: expressions.mongoDecisionTime,
        deadline: "$cashBackPending.quote.expiresAt",
      } },
      { $sort: { offset: 1 } },
    ]).toArray();
  }
  if (action === "ledger-state") {
    if (role !== "resulting") throw new Error("Wrong ledger owner");
    const module: typeof import("../model/FinalScoreLedger") = load("./src/model/FinalScoreLedger");
    return Boolean(await module.default.exists({ eventId: data.eventId }));
  }
  if (action === "bet-state") {
    const module: {
      Bet: import("mongoose").Model<Record<string, unknown>>;
      BetArchive?: import("mongoose").Model<Record<string, unknown>>;
    } = load("./src/model/Bet");
    const bet = await module.Bet.findOne({ slipId: data.slipId }).lean()
      ?? await module.BetArchive?.findOne({ slipId: data.slipId }).lean();
    const pending = object(bet?.cashBackPending) ? bet.cashBackPending : undefined;
    const operation = object(pending?.operation) ? pending.operation : undefined;
    return bet ? {
      status: bet.status, financial: bet.cashBackFinancial, wager: bet.wager,
      pending: pending ? { state: pending.state, operationId: operation?.operationId } : null,
    } : null;
  }
  if (action === "place") {
    await publish(common.QueueNames.SLIP_BET, data);
    await publish(common.QueueNames.MODERATION_RESULT, {
      slipId: data.slipId, result: common.ModerationStatus.APPROVED, betKind: data.betKind,
    });
    return true;
  }
  if (action === "result") {
    await publish(common.QueueNames.EVENT_RESULT, data);
    return true;
  }
  if (action === "stop") { await close(); return true; }
  throw new Error("Unknown isolated test command");
};

process.on("message", (message: Command) => {
  void handle(message).then(
    result => process.send?.({ type: "response", id: message.id, result }),
    error => process.send?.({ type: "response", id: message.id, error: error instanceof Error ? error.message : "unknown" })
  );
});
process.on("unhandledRejection", error => {
  console.error("cashback_transport_child_failed", error);
  process.exit(1);
});
process.on("SIGTERM", () => { void close(); });
void start().catch(error => {
  console.error("cashback_transport_child_start_failed", error);
  process.exit(1);
});
