import { createHash, randomUUID } from "crypto";
import { INewEventEvent, messengerWrapper } from "@betstan/common";
import EventTemplate from "../data/EventTemplate";
import NewEventPublisher from "../messaging/publisher/NewEventPublisher";
import { Event } from "../model/Event";

export interface EventSchedulerConfig {
  enabled: boolean;
  poolSize: number;
  horizonMinutes: number;
  tickMs: number;
  maxInsertsPerTick: number;
}

export interface SchedulerPublisher {
  init(): Promise<void>;
  publish(event: INewEventEvent): void | Promise<void>;
}

interface EventSchedulerOptions {
  config?: EventSchedulerConfig;
  now?: () => Date;
  publisherFactory?: () => SchedulerPublisher;
}

const DEFAULT_CONFIG: EventSchedulerConfig = {
  enabled: true,
  poolSize: 9,
  horizonMinutes: 1440,
  tickMs: 60000,
  maxInsertsPerTick: 9,
};

const readBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  return fallback;
};

const readPositiveInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number
): number => {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, parsed) : fallback;
};

export const getEventSchedulerConfig = (
  env: NodeJS.ProcessEnv = process.env
): EventSchedulerConfig => {
  const poolSize = readPositiveInteger(
    env.EVENT_POOL_SIZE,
    DEFAULT_CONFIG.poolSize,
    1
  );
  const horizonMinutes = Math.max(
    poolSize,
    readPositiveInteger(
      env.EVENT_SCHEDULE_HORIZON_MINUTES,
      DEFAULT_CONFIG.horizonMinutes,
      1
    )
  );
  const maxInsertsPerTick =
    env.EVENT_SCHEDULE_MAX_INSERTS_PER_TICK === undefined
      ? poolSize
      : readPositiveInteger(
          env.EVENT_SCHEDULE_MAX_INSERTS_PER_TICK,
          poolSize,
          1
        );

  return {
    enabled: readBoolean(env.EVENT_SCHEDULER_ENABLED, DEFAULT_CONFIG.enabled),
    poolSize,
    horizonMinutes,
    tickMs: readPositiveInteger(
      env.EVENT_SCHEDULE_TICK_MS,
      DEFAULT_CONFIG.tickMs,
      1000
    ),
    maxInsertsPerTick: Math.min(poolSize, maxInsertsPerTick),
  };
};

const isDuplicateKeyError = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  err.code === 11000;

export class EventScheduler {
  private readonly config: EventSchedulerConfig;
  private readonly now: () => Date;
  private readonly publisherFactory: () => SchedulerPublisher;
  private publisher: SchedulerPublisher | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;

  constructor(options: EventSchedulerOptions = {}) {
    this.config = options.config || getEventSchedulerConfig();
    this.now = options.now || (() => new Date());
    this.publisherFactory =
      options.publisherFactory ||
      (() => new NewEventPublisher(messengerWrapper.connection));
  }

  async ensureSlotKeyIndex(): Promise<void> {
    await Event.collection.createIndex(
      { slotKey: 1 },
      {
        unique: true,
        partialFilterExpression: { slotKey: { $type: "string" } },
        name: "event_slot_key_unique",
      }
    );

    const indexes = await Event.collection.indexes();
    const slotKeyIndex = indexes.find(
      (index) =>
        index.name === "event_slot_key_unique" &&
        index.unique === true &&
        index.key.slotKey === 1 &&
        index.partialFilterExpression?.slotKey?.$type === "string"
    );

    if (!slotKeyIndex) {
      throw new Error("Unable to confirm the scheduler slotKey index");
    }
  }

  async start(): Promise<void> {
    if (this.started || !this.config.enabled) {
      return;
    }

    await this.ensureSlotKeyIndex();
    this.started = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    await this.inFlight;
  }

  runOnce(): Promise<void> {
    if (this.inFlight) {
      return this.inFlight;
    }

    const run = this.run();
    this.inFlight = run;
    const clearInFlight = () => {
      if (this.inFlight === run) {
        this.inFlight = null;
      }
    };
    void run.then(clearInFlight, clearInFlight);
    return run;
  }

  private schedule(delay: number) {
    this.timeout = setTimeout(() => {
      this.timeout = null;
      void this.runOnce()
        .catch((err) => {
          console.error("Event scheduler tick failed", err);
        })
        .then(() => {
          if (this.started) {
            this.schedule(this.config.tickMs);
          }
        });
    }, delay);
  }

  private async run(): Promise<void> {
    const now = this.now();
    await this.insertMissingSlots(now);
    await this.markPastPendingSlotsAsPublished(now);
    await this.publishFutureSlots(now);
  }

  private async insertMissingSlots(now: Date): Promise<void> {
    const horizonMs = this.config.horizonMinutes * 60 * 1000;
    const slotMs = Math.max(
      60 * 1000,
      Math.floor(horizonMs / this.config.poolSize)
    );
    const firstIndex = Math.floor(now.getTime() / slotMs) + 1;
    let inserted = 0;

    for (
      let index = firstIndex;
      index < firstIndex + this.config.poolSize &&
      inserted < this.config.maxInsertsPerTick;
      index++
    ) {
      const slotKey = `${slotMs}:${index}`;
      const eventId = createHash("sha256")
        .update(slotKey)
        .digest("hex")
        .slice(0, 24);
      const template = new EventTemplate(
        eventId,
        undefined,
        undefined,
        new Date(index * slotMs).toISOString()
      );

      try {
        const result = await Event.updateOne(
          { slotKey },
          {
            $setOnInsert: {
              eventId: template.eventId,
              name: template.name,
              time: template.time,
              home: template.home,
              away: template.away,
              products: template.products,
              source: "SCHEDULER",
              slotKey,
              newEventPublishedAt: null,
              newEventPublishAttempts: 0,
            },
          },
          { upsert: true }
        );
        if (result.upsertedCount === 1) {
          inserted++;
        }
      } catch (err: unknown) {
        if (!isDuplicateKeyError(err)) {
          throw err;
        }
      }
    }
  }

  private async markPastPendingSlotsAsPublished(now: Date): Promise<void> {
    await Event.updateMany(
      {
        source: "SCHEDULER",
        slotKey: { $type: "string" },
        newEventPublishedAt: null,
        time: { $lt: now },
      },
      {
        $set: { newEventPublishedAt: now },
        $unset: {
          newEventPublishClaimedAt: 1,
          newEventPublishClaimToken: 1,
        },
      }
    );
  }

  private async publishFutureSlots(now: Date): Promise<void> {
    const claimExpiredBefore = new Date(
      now.getTime() - Math.max(60000, this.config.tickMs * 2)
    );
    const pendingEvents = await Event.find({
      source: "SCHEDULER",
      slotKey: { $type: "string" },
      newEventPublishedAt: null,
      time: { $gte: now },
    }).sort({ time: 1 });

    for (const event of pendingEvents) {
      const claimToken = randomUUID();
      const claimedAt = this.now();
      const claimedEvent = await Event.findOneAndUpdate(
        {
          _id: event._id,
          newEventPublishedAt: null,
          $or: [
            { newEventPublishClaimedAt: null },
            { newEventPublishClaimedAt: { $lte: claimExpiredBefore } },
          ],
        },
        {
          $set: {
            newEventPublishClaimedAt: claimedAt,
            newEventPublishClaimToken: claimToken,
          },
          $inc: { newEventPublishAttempts: 1 },
        },
        { new: true }
      );
      if (!claimedEvent) {
        continue;
      }

      try {
        const publisher = await this.getPublisher();
        await Promise.resolve(
          publisher.publish({
            data: {
              id: claimedEvent.eventId,
              name: claimedEvent.name,
              time: claimedEvent.time.toISOString(),
              home: claimedEvent.home as string,
              away: claimedEvent.away as string,
            },
          })
        );
        await Event.updateOne(
          {
            _id: claimedEvent._id,
            newEventPublishedAt: null,
            newEventPublishClaimToken: claimToken,
          },
          {
            $set: { newEventPublishedAt: this.now() },
            $unset: {
              newEventPublishClaimedAt: 1,
              newEventPublishClaimToken: 1,
            },
          }
        );
      } catch (err) {
        this.publisher = null;
        await Event.updateOne(
          {
            _id: claimedEvent._id,
            newEventPublishedAt: null,
            newEventPublishClaimToken: claimToken,
          },
          {
            $unset: {
              newEventPublishClaimedAt: 1,
              newEventPublishClaimToken: 1,
            },
          }
        );
        return;
      }
    }
  }

  private async getPublisher(): Promise<SchedulerPublisher> {
    if (!this.publisher) {
      const publisher = this.publisherFactory();
      await publisher.init();
      this.publisher = publisher;
    }
    return this.publisher;
  }
}
