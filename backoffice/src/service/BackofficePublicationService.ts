import {
  EventVisibility,
  IAmqpConnection,
} from "@betstan/common";
import EventVisibilityPublisher from "../event/publisher/EventVisibilityPublisher";
import NewEventPublisher from "../event/publisher/NewEventPublisher";
import ResultSetPublisher from "../event/publisher/ResultSetPublisher";
import { Event } from "../model/Event";

export type PublicationOutcome = "PUBLISHED" | "PENDING";

interface BackofficePublicationOptions {
  pollIntervalMs: number;
  confirmTimeoutMs: number;
  replayBatchSize: number;
}

const DEFAULT_OPTIONS: BackofficePublicationOptions = {
  pollIntervalMs: 5_000,
  confirmTimeoutMs: 1_000,
  replayBatchSize: 25,
};

export class BackofficePublicationService {
  private readonly options: BackofficePublicationOptions;
  private readonly newEventPublisher: NewEventPublisher;
  private readonly resultSetPublisher: ResultSetPublisher;
  private readonly eventVisibilityPublisher: EventVisibilityPublisher;
  private initialization: Promise<void> | null = null;
  private replayTimer: NodeJS.Timeout | null = null;
  private activeReplay: Promise<number> | null = null;
  private running = false;

  constructor(
    connection: IAmqpConnection,
    options: Partial<BackofficePublicationOptions> = {}
  ) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...options,
    };
    this.newEventPublisher = new NewEventPublisher(connection);
    this.resultSetPublisher = new ResultSetPublisher(connection);
    this.eventVisibilityPublisher = new EventVisibilityPublisher(connection);
  }

  async init() {
    if (!this.initialization) {
      this.initialization = Promise.all([
        this.newEventPublisher.initConfirmChannel(),
        this.resultSetPublisher.initConfirmChannel(),
        this.eventVisibilityPublisher.initConfirmChannel(),
      ])
        .then(() => undefined)
        .catch((error) => {
          this.initialization = null;
          throw error;
        });
    }

    await this.initialization;
  }

  async start() {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      await this.replayPending();
    } catch (error) {
      console.log("Backoffice publication startup replay failed", error);
    }
    this.scheduleReplay();
  }

  async stop() {
    this.running = false;
    if (this.replayTimer) {
      clearTimeout(this.replayTimer);
      this.replayTimer = null;
    }
    await this.activeReplay;
  }

  async publishNewEventNow(eventId: string): Promise<PublicationOutcome> {
    const event = await Event.findOne({
      eventId,
      newEventPublicationPending: true,
    }).select("+newEventPublicationPending");
    if (!event) {
      return "PUBLISHED";
    }

    const message = {
      data: {
        id: event.eventId,
        name: event.name,
        time: event.time,
        home: event.home,
        away: event.away,
        visibility: event.visibility,
      },
    };

    return this.publishAndClear(
      () => this.newEventPublisher.publishWithConfirm(message),
      () => Event.updateOne(
        { eventId, newEventPublicationPending: true },
        { $unset: { newEventPublicationPending: 1 } }
      ),
      "new event",
      eventId
    );
  }

  async publishResultNow(eventId: string): Promise<PublicationOutcome> {
    const event = await Event.findOne({
      eventId,
      resultPublicationPending: true,
    }).select("+resultPublicationPending +newEventPublicationPending");
    if (!event) {
      return "PUBLISHED";
    }
    if (event.newEventPublicationPending) {
      return "PENDING";
    }

    if (
      !Number.isInteger(event.homeResult)
      || !Number.isInteger(event.awayResult)
    ) {
      console.log(`Backoffice result publication is missing scores for ${eventId}`);
      return "PENDING";
    }

    return this.publishAndClear(
      () => this.resultSetPublisher.publishWithConfirm({
        data: {
          eventId: event.eventId,
          homeScore: event.homeResult!,
          awayScore: event.awayResult!,
          home: event.home,
          away: event.away,
        },
      }),
      () => Event.updateOne(
        { eventId, resultPublicationPending: true },
        { $unset: { resultPublicationPending: 1 } }
      ),
      "result",
      eventId
    );
  }

  async publishVisibilityNow(eventId: string): Promise<PublicationOutcome> {
    const event = await Event.findOne({
      eventId,
      visibilityPublicationPending: true,
    }).select(
      "+visibilityPublicationPending +visibilityPublicationTarget"
    );
    if (!event) {
      return "PUBLISHED";
    }

    const visibility = event.visibilityPublicationTarget;
    if (
      visibility !== EventVisibility.ONLINE
      && visibility !== EventVisibility.OFFLINE
    ) {
      console.log(
        `Backoffice visibility publication is missing a target for ${eventId}`
      );
      return "PENDING";
    }

    return this.publishAndClear(
      () => this.eventVisibilityPublisher.publishWithConfirm({
        data: {
          eventId,
          visibility,
        },
      }),
      () => Event.updateOne(
        {
          eventId,
          visibilityPublicationPending: true,
          visibilityPublicationTarget: visibility,
        },
        {
          $unset: {
            visibilityPublicationPending: 1,
            visibilityPublicationTarget: 1,
          },
        }
      ),
      "visibility",
      eventId
    );
  }

  async replayPending(): Promise<number> {
    if (this.activeReplay) {
      return this.activeReplay;
    }

    this.activeReplay = this.runReplay().finally(() => {
      this.activeReplay = null;
    });
    return this.activeReplay;
  }

  private async runReplay() {
    await this.init();
    // Downstream handlers are idempotent, so rolling pods may safely replay
    // the same pending marker to provide at-least-once delivery.
    const events = await Event.find({
      $or: [
        { newEventPublicationPending: true },
        { resultPublicationPending: true },
        { visibilityPublicationPending: true },
      ],
    })
      .select(
        "+newEventPublicationPending +resultPublicationPending "
        + "+visibilityPublicationPending +visibilityPublicationTarget"
      )
      .sort({ _id: 1 })
      .limit(this.options.replayBatchSize);

    let published = 0;
    for (const event of events) {
      if (event.newEventPublicationPending) {
        published +=
          (await this.publishNewEventNow(event.eventId)) === "PUBLISHED" ? 1 : 0;
      }
      if (event.visibilityPublicationPending) {
        published +=
          (await this.publishVisibilityNow(event.eventId)) === "PUBLISHED" ? 1 : 0;
      }
      if (event.resultPublicationPending) {
        published +=
          (await this.publishResultNow(event.eventId)) === "PUBLISHED" ? 1 : 0;
      }
    }

    return published;
  }

  private scheduleReplay() {
    if (!this.running) {
      return;
    }

    this.replayTimer = setTimeout(() => {
      void this.replayPending()
        .catch((error) => {
          console.log("Backoffice publication replay failed", error);
        })
        .finally(() => {
          this.scheduleReplay();
        });
    }, this.options.pollIntervalMs);

    this.replayTimer.unref?.();
  }

  private async publishAndClear(
    publish: () => Promise<void>,
    clear: () => Promise<unknown>,
    operation: string,
    eventId: string
  ): Promise<PublicationOutcome> {
    try {
      await this.init();
      await this.publishWithTimeout(publish);
      await clear();
      return "PUBLISHED";
    } catch (error) {
      // A failed or closed confirm channel must be recreated before replay.
      this.initialization = null;
      const reason = error instanceof Error ? error.message : "unknown error";
      console.log(
        `Backoffice ${operation} publication remains pending for ${eventId}: ${reason}`
      );
      return "PENDING";
    }
  }

  private async publishWithTimeout(publish: () => Promise<void>) {
    let timeout: NodeJS.Timeout | null = null;
    try {
      await Promise.race([
        publish(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error("Publish confirm timed out"));
          }, this.options.confirmTimeoutMs);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}

let publicationService: BackofficePublicationService | null = null;

export const getBackofficePublicationService = (
  connection: IAmqpConnection
) => {
  if (!publicationService) {
    publicationService = new BackofficePublicationService(connection);
  }
  return publicationService;
};
