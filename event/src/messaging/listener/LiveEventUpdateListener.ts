import { ConsumeMessage } from "amqplib";
import {
  AListener,
  ILiveEventUpdateEvent,
  ListenerQueueOptions,
  QueueNames,
} from "@betstan/common";
import { liveEventHub, LiveEventHub } from "../../live/LiveEventHub";
import {
  createPublicEventSnapshotFromLiveUpdate,
  getStoredPublicEventSnapshot,
} from "../../live/LiveEventReadModel";

export interface LiveEventUpdateListenerOptions {
  hub?: LiveEventHub;
  podId?: string;
}

const POD_SCOPED_QUEUE_OPTIONS: ListenerQueueOptions = {
  durable: false,
  exclusive: true,
  autoDelete: true,
};

const sanitizeQueueSegment = (value: string): string =>
  value.replace(/[^A-Za-z0-9_.:-]+/g, "-");

export const buildPodScopedQueueName = (podId?: string): string => {
  const rawPodId =
    podId ??
    process.env.EVENT_POD_ID ??
    process.env.HOSTNAME ??
    `pid-${process.pid}`;

  return `event_live_update.${sanitizeQueueSegment(rawPodId)}`;
};

class LiveEventUpdateListener extends AListener<ILiveEventUpdateEvent> {
  serviceName: string = "event_live_update";
  queue: QueueNames.LIVE_EVENT_UPDATE = QueueNames.LIVE_EVENT_UPDATE;
  private readonly hub: LiveEventHub;
  private readonly podId?: string;

  constructor(
    connection: any,
    options: LiveEventUpdateListenerOptions = {}
  ) {
    super(connection);
    this.hub = options.hub ?? liveEventHub;
    this.podId = options.podId;
  }

  protected get queueName(): string {
    return buildPodScopedQueueName(this.podId);
  }

  protected get queueOptions(): ListenerQueueOptions {
    return POD_SCOPED_QUEUE_OPTIONS;
  }

  async onMessage(event: ILiveEventUpdateEvent, msg: ConsumeMessage) {
    const localSnapshot = this.hub.getSnapshot(event.data.eventId);
    const storedSnapshot = await getStoredPublicEventSnapshot(event.data.eventId);
    const seedSnapshot =
      localSnapshot && storedSnapshot
        ? { ...localSnapshot, visibility: storedSnapshot.visibility }
        : localSnapshot ?? storedSnapshot;
    const snapshot = createPublicEventSnapshotFromLiveUpdate(
      event,
      seedSnapshot
    );

    this.hub.broadcast(snapshot);

    this.ack(msg);
  }
}

export default LiveEventUpdateListener;
