import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  applyLiveSnapshotUpdate,
  isFinishedLiveEvent,
  mergeAuthoritativeEventList,
} from '../../liveBettingUtils';

const MAX_RECONNECT_DELAY_MS = 30000;
const POLL_FALLBACK_MS = 15000;
const RECONCILE_DEBOUNCE_MS = 150;

const clearScheduledTask = (taskRef) => {
  if (taskRef.current) {
    clearTimeout(taskRef.current);
    taskRef.current = null;
  }
};

const clearScheduledInterval = (taskRef) => {
  if (taskRef.current) {
    clearInterval(taskRef.current);
    taskRef.current = null;
  }
};

const normalizeEventList = (payload) => (Array.isArray(payload) ? payload : []);

const buildAcceptanceQuery = (visibleOfflineEventIds) => {
  const eventIds = [...(visibleOfflineEventIds ?? [])]
    .filter((eventId) => /^[a-f0-9]{24}$/.test(eventId))
    .slice(0, 10)
    .sort();
  return eventIds.length > 0
    ? `?acceptanceEventIds=${encodeURIComponent(eventIds.join(','))}`
    : '';
};

const useLiveEvents = (visibleOfflineEventIds, onScopedAccessFailure) => {
  const [events, setEvents] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [feedState, setFeedState] = useState('connecting');

  const mountedRef = useRef(false);
  const eventSourceRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const pollTimerRef = useRef(null);
  const reconcileTimerRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const hasConnectedRef = useRef(false);
  const restRequestIdRef = useRef(0);
  const lastAppliedRestRequestIdRef = useRef(0);
  const scopedAccessGenerationRef = useRef(0);
  const acceptanceQuery = buildAcceptanceQuery(visibleOfflineEventIds);
  const eventApiUrl = `/api/event${acceptanceQuery}`;
  const eventStreamUrl = `/api/event/stream${acceptanceQuery}`;
  const revokeScopedEvents = useCallback(() => {
    if (!acceptanceQuery) {
      return;
    }

    scopedAccessGenerationRef.current += 1;
    setEvents((currentEvents) => currentEvents.filter(
      (event) => event.visibility !== 'OFFLINE',
    ));
    onScopedAccessFailure?.();
  }, [acceptanceQuery, onScopedAccessFailure]);

  const closeSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const fetchAuthoritativeEvents = useCallback(async () => {
    const requestId = restRequestIdRef.current + 1;
    const scopedAccessGeneration = scopedAccessGenerationRef.current;
    restRequestIdRef.current = requestId;

    try {
      const response = await axios.get(eventApiUrl);

      if (
        !mountedRef.current
        || requestId < lastAppliedRestRequestIdRef.current
        || scopedAccessGeneration !== scopedAccessGenerationRef.current
      ) {
        return;
      }

      lastAppliedRestRequestIdRef.current = requestId;
      setEvents((currentEvents) => mergeAuthoritativeEventList(
        currentEvents,
        normalizeEventList(response.data),
      ));
      setIsLoading(false);
    } catch (error) {
      if (mountedRef.current) {
        revokeScopedEvents();
        setIsLoading(false);
      }
    }
  }, [eventApiUrl, revokeScopedEvents]);

  const stopPollingFallback = useCallback(() => {
    clearScheduledInterval(pollTimerRef);
  }, []);

  const startPollingFallback = useCallback(() => {
    setFeedState('polling');
    if (pollTimerRef.current) {
      return;
    }

    pollTimerRef.current = setInterval(() => {
      fetchAuthoritativeEvents();
    }, POLL_FALLBACK_MS);
  }, [fetchAuthoritativeEvents]);

  const scheduleReconcile = useCallback(() => {
    if (reconcileTimerRef.current) {
      return;
    }

    reconcileTimerRef.current = setTimeout(() => {
      reconcileTimerRef.current = null;
      fetchAuthoritativeEvents();
    }, RECONCILE_DEBOUNCE_MS);
  }, [fetchAuthoritativeEvents]);

  const connect = useCallback((isReconnect = false) => {
    if (!mountedRef.current) {
      return;
    }

    closeSource();

    if (typeof EventSource !== 'function') {
      startPollingFallback();
      return;
    }

    setFeedState(isReconnect ? 'reconnecting' : 'connecting');

    const source = new EventSource(eventStreamUrl);
    eventSourceRef.current = source;

    source.addEventListener('snapshot', (message) => {
      if (eventSourceRef.current !== source || !mountedRef.current) {
        return;
      }

      try {
        const snapshot = JSON.parse(message.data);
        if (isFinishedLiveEvent(snapshot)) {
          scheduleReconcile();
        }
        setEvents((currentEvents) => {
          const update = applyLiveSnapshotUpdate(currentEvents, snapshot);
          if (update.hasGap) {
            scheduleReconcile();
          }
          return update.changed ? update.events : currentEvents;
        });
      } catch (error) {
        // ignore malformed snapshots
      }
    });

    source.onopen = () => {
      if (eventSourceRef.current !== source) {
        return;
      }

      reconnectAttemptsRef.current = 0;
      clearScheduledTask(reconnectTimerRef);
      setFeedState('open');
      setIsLoading(false);

      if (hasConnectedRef.current || isReconnect) {
        scheduleReconcile();
      }

      hasConnectedRef.current = true;
    };

    source.onerror = () => {
      if (eventSourceRef.current !== source || !mountedRef.current) {
        return;
      }

      revokeScopedEvents();
      closeSource();
      fetchAuthoritativeEvents();
      startPollingFallback();

      if (reconnectTimerRef.current) {
        return;
      }

      const nextAttempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = nextAttempt;
      const reconnectDelay = Math.min(
        1000 * (2 ** (nextAttempt - 1)),
        MAX_RECONNECT_DELAY_MS,
      );

      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect(true);
      }, reconnectDelay);
    };
  }, [
    closeSource,
    eventStreamUrl,
    fetchAuthoritativeEvents,
    revokeScopedEvents,
    scheduleReconcile,
    startPollingFallback,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    fetchAuthoritativeEvents();
    if (!pollTimerRef.current) {
      pollTimerRef.current = setInterval(() => {
        fetchAuthoritativeEvents();
      }, POLL_FALLBACK_MS);
    }
    connect(false);

    return () => {
      mountedRef.current = false;
      closeSource();
      stopPollingFallback();
      clearScheduledTask(reconnectTimerRef);
      clearScheduledTask(reconcileTimerRef);
    };
  }, [closeSource, connect, fetchAuthoritativeEvents, stopPollingFallback]);

  return {
    events,
    isLoading,
    feedState,
  };
};

export default useLiveEvents;
export {
  MAX_RECONNECT_DELAY_MS,
  POLL_FALLBACK_MS,
  RECONCILE_DEBOUNCE_MS,
  buildAcceptanceQuery,
};
