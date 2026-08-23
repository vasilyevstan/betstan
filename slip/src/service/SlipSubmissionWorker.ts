import {
  BetKind,
  IAmqpConnection,
  IPlaceBetEvent,
  SlipStatus,
} from "@betstan/common";
import { Types } from "mongoose";
import PlaceBetEventPublisher from "../event/publisher/PlaceBetEventPublisher";
import { Slip } from "../model/Slip";
import { SlipPublicationState } from "../model/SlipPublicationState";
import {
  PlainSlip,
  SubmittedEventData,
  buildBetKindScope,
  normalizeBetKind,
  normalizePlainSlip,
  toPublishedSubmittedEventData,
} from "../model/slipSupport";

export interface SlipSubmissionWorkerOptions {
  workerId: string;
  pollIntervalMs: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  confirmTimeoutMs: number;
  maxAttempts: number;
  maxAgeMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  batchSize: number;
  nowProvider?: () => Date;
}

export interface SubmitDraftSlipArgs {
  slipId: string;
  userId: string;
  userName: string;
  placementAttemptId: string;
  wager: number;
  betKind: BetKind;
}

export interface PublishSlipResult {
  claimed: boolean;
  outcome:
    | "published"
    | "rescheduled"
    | "exhausted"
    | "not-claimable"
    | "missing";
}

const DEFAULT_WORKER_OPTIONS: Omit<SlipSubmissionWorkerOptions, "workerId"> = {
  pollIntervalMs: 1000,
  leaseDurationMs: 30_000,
  heartbeatIntervalMs: 10_000,
  confirmTimeoutMs: 500,
  maxAttempts: 5,
  maxAgeMs: 15 * 60_000,
  baseBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  batchSize: 25,
};

const buildNormalizedRowBetKindExpression = (betKind: BetKind) =>
  betKind === BetKind.LIVE ? BetKind.LIVE : { $ifNull: ["$$row.betKind", BetKind.PRE_MATCH] };

const buildNormalizedRowsExpression = (betKind: BetKind) => ({
  $map: {
    input: { $ifNull: ["$rows", []] },
    as: "row",
    in: {
      _id: "$$row._id",
      eventId: "$$row.eventId",
      eventName: "$$row.eventName",
      oddsId: "$$row.oddsId",
      oddsValue: "$$row.oddsValue",
      oddsName: "$$row.oddsName",
      productName: "$$row.productName",
      productId: "$$row.productId",
      timestamp: "$$row.timestamp",
      eventTime: "$$row.eventTime",
      betKind: buildNormalizedRowBetKindExpression(betKind),
      marketId: "$$row.marketId",
      marketType: "$$row.marketType",
      marketVersion: "$$row.marketVersion",
      quoteVersion: "$$row.quoteVersion",
      selectionId: "$$row.selectionId",
      side: "$$row.side",
      selectedAt: "$$row.selectedAt",
      quoteValidUntil: "$$row.quoteValidUntil",
    },
  },
});

const buildSubmittedEventRowsExpression = (betKind: BetKind) => ({
  $map: {
    input: { $ifNull: ["$rows", []] },
    as: "row",
    in: {
      eventId: "$$row.eventId",
      eventName: "$$row.eventName",
      oddsId: "$$row.oddsId",
      oddsValue: "$$row.oddsValue",
      oddsName: "$$row.oddsName",
      productName: "$$row.productName",
      productId: "$$row.productId",
      timestamp: "$$row.timestamp",
      id: {
        $ifNull: ["$$row.id", { $toString: "$$row._id" }],
      },
      eventTime: "$$row.eventTime",
      betKind: buildNormalizedRowBetKindExpression(betKind),
      marketId: "$$row.marketId",
      marketType: "$$row.marketType",
      marketVersion: "$$row.marketVersion",
      quoteVersion: "$$row.quoteVersion",
      selectionId: "$$row.selectionId",
      side: "$$row.side",
      selectedAt: "$$row.selectedAt",
      quoteValidUntil: "$$row.quoteValidUntil",
    },
  },
});

const buildCompatibleDraftRowsFilter = (betKind: BetKind) =>
  betKind === BetKind.LIVE
    ? {
        rows: {
          $not: {
            $elemMatch: {
              betKind: {
                $ne: BetKind.LIVE,
              },
            },
          },
        },
      }
    : {
        rows: {
          $not: {
            $elemMatch: {
              betKind: BetKind.LIVE,
            },
          },
        },
      };

const asPlainSlip = (value: unknown): PlainSlip | null => {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as PlainSlip;
};

const submittedEventOf = (slip: PlainSlip): SubmittedEventData | null => {
  const submittedEvent = slip.submittedEvent;
  if (!submittedEvent) {
    return null;
  }

  return submittedEvent;
};

const publicationStateOf = (slip: PlainSlip) =>
  slip.publication?.state ?? SlipPublicationState.PENDING;

const attemptCountOf = (slip: PlainSlip) => slip.publication?.attemptCount ?? 0;

const submissionTimestampOf = (slip: PlainSlip) => slip.submittedAt ?? slip.timestamp;

const toObjectId = (slipId: string) => new Types.ObjectId(slipId);

export const submitDraftSlipAtomically = async (
  args: SubmitDraftSlipArgs
): Promise<PlainSlip | null> => {
  const submittedAt = new Date().toISOString();
  const filter = {
    _id: toObjectId(args.slipId),
    userId: args.userId,
    status: SlipStatus.DRAFT,
    ...buildBetKindScope(args.betKind),
    "rows.0": {
      $exists: true,
    },
    ...buildCompatibleDraftRowsFilter(args.betKind),
  };
  const updatePipeline = [
    {
      $set: {
        status: SlipStatus.SUBMITTED,
        submittedAt,
        betKind: args.betKind,
        draftKey: args.betKind,
        rows: buildNormalizedRowsExpression(args.betKind),
        submittedEvent: {
          userId: args.userId,
          userName: args.userName,
          slipId: args.slipId,
          submittedAt,
          placementAttemptId: args.placementAttemptId,
          wager: args.wager,
          rows: buildSubmittedEventRowsExpression(args.betKind),
          betKind: args.betKind,
        },
        publication: {
          state: SlipPublicationState.PENDING,
          attemptCount: 0,
          nextAttemptAt: submittedAt,
        },
      },
    },
    {
      $unset: ["declineReason", "replacementSlipId"],
    },
  ];

  const updated = await Slip.collection.findOneAndUpdate(filter, updatePipeline, {
    returnDocument: "after",
  });
  const plainSlip = asPlainSlip((updated as { value?: unknown })?.value ?? updated);

  return plainSlip ? normalizePlainSlip(plainSlip, args.betKind) : null;
};

export class SlipSubmissionWorker {
  private readonly options: SlipSubmissionWorkerOptions;
  private publisher: PlaceBetEventPublisher | null = null;
  private running = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private readonly activeOperations = new Set<Promise<unknown>>();

  constructor(
    private readonly connection: IAmqpConnection,
    options: Partial<SlipSubmissionWorkerOptions> = {}
  ) {
    this.options = {
      workerId:
        options.workerId
        ?? `slip-submission-worker-${new Types.ObjectId().toHexString()}`,
      ...DEFAULT_WORKER_OPTIONS,
      ...options,
    };
  }

  async init() {
    if (!this.publisher) {
      this.publisher = new PlaceBetEventPublisher(this.connection);
      await this.publisher.initConfirmChannel();
    }
  }

  async start() {
    await this.init();
    if (this.running) {
      return;
    }

    this.running = true;
    await this.replayDueSubmissions();
    this.scheduleNextReplay();
  }

  async stop() {
    this.running = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    await this.drain();
  }

  async drain() {
    await Promise.all(Array.from(this.activeOperations));
  }

  async publishSlipNow(slipId: string): Promise<PublishSlipResult> {
    if (!Types.ObjectId.isValid(slipId)) {
      return {
        claimed: false,
        outcome: "missing",
      };
    }

    await this.init();
    const trackedOperation = this.trackOperation(this.processSpecificSlip(slipId));
    return trackedOperation;
  }

  async replayDueSubmissions() {
    let processed = 0;

    while (processed < this.options.batchSize) {
      const claimedSlip = await this.claimSubmission();
      if (!claimedSlip) {
        break;
      }

      await this.processClaimedSlip(claimedSlip);
      processed += 1;
    }

    return processed;
  }

  private now() {
    return this.options.nowProvider ? this.options.nowProvider() : new Date();
  }

  private nowIso() {
    return this.now().toISOString();
  }

  private plusMs(date: Date, milliseconds: number) {
    return new Date(date.getTime() + milliseconds).toISOString();
  }

  private scheduleNextReplay() {
    if (!this.running) {
      return;
    }

    this.loopTimer = setTimeout(() => {
      const trackedReplay = this.trackOperation(this.runReplayLoop());
      void trackedReplay;
    }, this.options.pollIntervalMs);

    if (typeof this.loopTimer.unref === "function") {
      this.loopTimer.unref();
    }
  }

  private async runReplayLoop() {
    try {
      await this.replayDueSubmissions();
    } finally {
      this.scheduleNextReplay();
    }
  }

  private trackOperation<T>(operation: Promise<T>) {
    const trackedOperation = operation.finally(() => {
      this.activeOperations.delete(trackedOperation);
    });
    this.activeOperations.add(trackedOperation);
    return trackedOperation;
  }

  private claimableFilter(slipId?: string) {
    const nowIso = this.nowIso();
    const filter: Record<string, unknown> = {
      status: SlipStatus.SUBMITTED,
      $or: [
        {
          "publication.state": SlipPublicationState.PENDING,
          $or: [
            {
              "publication.nextAttemptAt": {
                $lte: nowIso,
              },
            },
            {
              "publication.nextAttemptAt": {
                $exists: false,
              },
            },
          ],
        },
        {
          "publication.state": {
            $exists: false,
          },
        },
        {
          "publication.state": SlipPublicationState.PROCESSING,
          $or: [
            {
              "publication.leaseUntil": {
                $lte: nowIso,
              },
            },
            {
              "publication.leaseUntil": {
                $exists: false,
              },
            },
          ],
        },
      ],
    };

    if (slipId) {
      filter._id = toObjectId(slipId);
    }

    return filter;
  }

  private async claimSubmission(slipId?: string): Promise<PlainSlip | null> {
    const now = this.now();
    const claimed = await Slip.collection.findOneAndUpdate(
      this.claimableFilter(slipId),
      {
        $set: {
          "publication.state": SlipPublicationState.PROCESSING,
          "publication.leaseOwner": this.options.workerId,
          "publication.leaseUntil": this.plusMs(now, this.options.leaseDurationMs),
          "publication.lastAttemptAt": now.toISOString(),
          "publication.heartbeatAt": now.toISOString(),
        },
        $inc: {
          "publication.attemptCount": 1,
        },
      },
      {
        returnDocument: "after",
        sort: slipId
          ? undefined
          : {
              "publication.nextAttemptAt": 1,
              submittedAt: 1,
              _id: 1,
            },
      }
    );
    const plainSlip = asPlainSlip((claimed as { value?: unknown })?.value ?? claimed);

    return plainSlip ? normalizePlainSlip(plainSlip, normalizeBetKind(plainSlip.betKind)) : null;
  }

  private async processSpecificSlip(slipId: string): Promise<PublishSlipResult> {
    const claimedSlip = await this.claimSubmission(slipId);

    if (!claimedSlip) {
      const existingSlip = await Slip.findById(slipId).lean();
      if (!existingSlip) {
        return {
          claimed: false,
          outcome: "missing",
        };
      }

      return {
        claimed: false,
        outcome: "not-claimable",
      };
    }

    return this.processClaimedSlip(claimedSlip);
  }

  private async processClaimedSlip(claimedSlip: PlainSlip): Promise<PublishSlipResult> {
    const slipId =
      typeof claimedSlip._id === "string"
        ? claimedSlip._id
        : claimedSlip._id?.toString();

    if (!slipId) {
      return {
        claimed: true,
        outcome: "missing",
      };
    }

    const submittedEvent = submittedEventOf(claimedSlip);
    if (!submittedEvent) {
      await this.markExhausted(
        slipId,
        claimedSlip,
        "Missing submitted event snapshot"
      );
      return {
        claimed: true,
        outcome: "exhausted",
      };
    }

    if (this.isTooOld(claimedSlip)) {
      await this.markExhausted(
        slipId,
        claimedSlip,
        "Submitted slip publication exceeded max age"
      );
      return {
        claimed: true,
        outcome: "exhausted",
      };
    }

    const heartbeatTimer = this.startHeartbeat(slipId);

    try {
      await this.publishWithConfirmTimeout(submittedEvent);
      await this.markPublished(slipId, claimedSlip);
      return {
        claimed: true,
        outcome: "published",
      };
    } catch (error) {
      const updatedSlip = await this.markRetryOrExhausted(slipId, claimedSlip, error);
      return {
        claimed: true,
        outcome:
          publicationStateOf(updatedSlip) === SlipPublicationState.EXHAUSTED
            ? "exhausted"
            : "rescheduled",
      };
    } finally {
      clearInterval(heartbeatTimer);
    }
  }

  private startHeartbeat(slipId: string) {
    const heartbeatTimer = setInterval(() => {
      const refreshed = this.trackOperation(this.refreshLease(slipId));
      void refreshed;
    }, this.options.heartbeatIntervalMs);

    if (typeof heartbeatTimer.unref === "function") {
      heartbeatTimer.unref();
    }

    return heartbeatTimer;
  }

  private async refreshLease(slipId: string) {
    const now = this.now();
    await Slip.updateOne(
      {
        _id: toObjectId(slipId),
        status: SlipStatus.SUBMITTED,
        "publication.state": SlipPublicationState.PROCESSING,
        "publication.leaseOwner": this.options.workerId,
      },
      {
        $set: {
          "publication.leaseUntil": this.plusMs(now, this.options.leaseDurationMs),
          "publication.heartbeatAt": now.toISOString(),
        },
      }
    );
  }

  private async publishWithConfirmTimeout(submittedEvent: SubmittedEventData) {
    if (!this.publisher) {
      throw new Error("Submission publisher is not initialised");
    }

    let timeoutId: NodeJS.Timeout | null = null;

    try {
      await Promise.race([
        this.publisher.publishWithConfirm({
          data: toPublishedSubmittedEventData(submittedEvent),
        } as IPlaceBetEvent),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error("Publish confirm timed out"));
          }, this.options.confirmTimeoutMs);
          if (typeof timeoutId.unref === "function") {
            timeoutId.unref();
          }
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async markPublished(slipId: string, claimedSlip: PlainSlip) {
    const nowIso = this.nowIso();
    const publication = {
      ...claimedSlip.publication,
      state: SlipPublicationState.PUBLISHED,
      publishedAt: nowIso,
      leaseOwner: undefined,
      leaseUntil: undefined,
      heartbeatAt: undefined,
      nextAttemptAt: undefined,
      lastError: undefined,
      exhaustedAt: undefined,
    };

    await Slip.updateOne(
      {
        _id: toObjectId(slipId),
        status: SlipStatus.SUBMITTED,
        "publication.state": SlipPublicationState.PROCESSING,
        "publication.leaseOwner": this.options.workerId,
      },
      {
        $set: {
          publication,
        },
      }
    );
  }

  private isTooOld(claimedSlip: PlainSlip) {
    const submittedTimestamp = submissionTimestampOf(claimedSlip);
    const submittedAt = new Date(submittedTimestamp);
    return this.now().getTime() - submittedAt.getTime() >= this.options.maxAgeMs;
  }

  private errorMessageOf(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private backoffMs(attemptCount: number) {
    return Math.min(
      this.options.baseBackoffMs * 2 ** Math.max(attemptCount - 1, 0),
      this.options.maxBackoffMs
    );
  }

  private async markRetryOrExhausted(
    slipId: string,
    claimedSlip: PlainSlip,
    error: unknown
  ) {
    const attemptCount = attemptCountOf(claimedSlip);
    const errorMessage = this.errorMessageOf(error);

    if (attemptCount >= this.options.maxAttempts || this.isTooOld(claimedSlip)) {
      return this.markExhausted(slipId, claimedSlip, errorMessage);
    }

    const now = this.now();
    const publication = {
      ...claimedSlip.publication,
      state: SlipPublicationState.PENDING,
      nextAttemptAt: this.plusMs(now, this.backoffMs(attemptCount)),
      leaseOwner: undefined,
      leaseUntil: undefined,
      heartbeatAt: undefined,
      lastError: errorMessage,
      exhaustedAt: undefined,
      publishedAt: claimedSlip.publication?.publishedAt,
      lastAttemptAt: now.toISOString(),
    };

    await Slip.updateOne(
      {
        _id: toObjectId(slipId),
        status: SlipStatus.SUBMITTED,
        "publication.state": SlipPublicationState.PROCESSING,
        "publication.leaseOwner": this.options.workerId,
      },
      {
        $set: {
          publication,
        },
      }
    );

    const refreshedSlip = await Slip.findById(slipId).lean();
    return refreshedSlip ? normalizePlainSlip(refreshedSlip as PlainSlip) : claimedSlip;
  }

  private async markExhausted(
    slipId: string,
    claimedSlip: PlainSlip,
    errorMessage: string
  ) {
    const publication = {
      ...claimedSlip.publication,
      state: SlipPublicationState.EXHAUSTED,
      exhaustedAt: this.nowIso(),
      leaseOwner: undefined,
      leaseUntil: undefined,
      heartbeatAt: undefined,
      nextAttemptAt: undefined,
      lastError: errorMessage,
    };

    await Slip.updateOne(
      {
        _id: toObjectId(slipId),
        status: SlipStatus.SUBMITTED,
        "publication.state": SlipPublicationState.PROCESSING,
        "publication.leaseOwner": this.options.workerId,
      },
      {
        $set: {
          publication,
        },
      }
    );

    const refreshedSlip = await Slip.findById(slipId).lean();
    return refreshedSlip ? normalizePlainSlip(refreshedSlip as PlainSlip) : claimedSlip;
  }
}
