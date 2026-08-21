import type { PublicEventSnapshot } from "./LiveEventReadModel";

type LiveEventSubscriber = (snapshot: PublicEventSnapshot) => void;

export class LiveEventHub {
  private readonly subscribers = new Set<LiveEventSubscriber>();
  private readonly lastSequenceByEvent = new Map<string, number>();
  private readonly lastSnapshotByEvent = new Map<string, PublicEventSnapshot>();

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

    const previousSequence = this.lastSequenceByEvent.get(snapshot.eventId);
    if (previousSequence !== undefined && previousSequence >= sequence) {
      return false;
    }

    this.lastSequenceByEvent.set(snapshot.eventId, sequence);
    this.lastSnapshotByEvent.set(snapshot.eventId, snapshot);

    for (const subscriber of this.subscribers) {
      subscriber(snapshot);
    }

    return true;
  }

  getSnapshot(eventId: string): PublicEventSnapshot | undefined {
    return this.lastSnapshotByEvent.get(eventId);
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  reset(): void {
    this.subscribers.clear();
    this.lastSequenceByEvent.clear();
    this.lastSnapshotByEvent.clear();
  }
}

export const liveEventHub = new LiveEventHub();
