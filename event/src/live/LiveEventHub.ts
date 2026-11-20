import type { PublicEventSnapshot } from "./LiveEventReadModel";

type LiveEventSubscriber = (snapshot: PublicEventSnapshot) => void;

const MAX_CACHED_EVENTS = 128;

export class LiveEventHub {
  private readonly subscribers = new Set<LiveEventSubscriber>();
  private readonly lastSnapshotByEvent = new Map<
    string,
    { sequence: number; snapshot: PublicEventSnapshot }
  >();

  subscribe(subscriber: LiveEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  broadcast(snapshot: PublicEventSnapshot): boolean {
    const sequence = snapshot.live?.sequence;
    if (sequence === undefined) {
      return false;
    }

    const previousSequence =
      this.lastSnapshotByEvent.get(snapshot.eventId)?.sequence;
    if (previousSequence !== undefined && previousSequence >= sequence) {
      return false;
    }

    this.lastSnapshotByEvent.delete(snapshot.eventId);
    this.lastSnapshotByEvent.set(snapshot.eventId, { sequence, snapshot });
    if (this.lastSnapshotByEvent.size > MAX_CACHED_EVENTS) {
      const oldestEventId = this.lastSnapshotByEvent.keys().next().value;
      if (oldestEventId !== undefined) {
        this.lastSnapshotByEvent.delete(oldestEventId);
      }
    }

    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }

    return true;
  }

  getSnapshot(eventId: string): PublicEventSnapshot | undefined {
    return this.lastSnapshotByEvent.get(eventId)?.snapshot;
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  reset(): void {
    this.subscribers.clear();
    this.lastSnapshotByEvent.clear();
  }
}

export const liveEventHub = new LiveEventHub();
