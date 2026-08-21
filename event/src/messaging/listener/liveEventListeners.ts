import { IAmqpConnection } from "@betstan/common";
import { liveEventHub, LiveEventHub } from "../../live/LiveEventHub";
import LiveEventProjectionListener from "./LiveEventProjectionListener";
import LiveEventUpdateListener from "./LiveEventUpdateListener";

export interface LiveEventListenerRegistry {
  projectionListener: LiveEventProjectionListener;
  fanoutListener: LiveEventUpdateListener;
  all: [LiveEventProjectionListener, LiveEventUpdateListener];
}

export interface LiveEventListenerRegistryOptions {
  hub?: LiveEventHub;
  podId?: string;
}

export const createLiveEventListeners = (
  connection: IAmqpConnection,
  options: LiveEventListenerRegistryOptions = {}
): LiveEventListenerRegistry => {
  const projectionListener = new LiveEventProjectionListener(connection);
  const fanoutListener = new LiveEventUpdateListener(connection, {
    hub: options.hub ?? liveEventHub,
    podId: options.podId,
  });

  return {
    projectionListener,
    fanoutListener,
    all: [projectionListener, fanoutListener],
  };
};
