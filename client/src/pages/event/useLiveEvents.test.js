import React from 'react';
import '@testing-library/jest-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import useLiveEvents, {
  POLL_FALLBACK_MS,
  RECONCILE_DEBOUNCE_MS,
} from './useLiveEvents';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const createdSources = [];

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.close = jest.fn();
    this.listeners = {};
    this.onopen = null;
    this.onerror = null;
    createdSources.push(this);
  }

  addEventListener(name, handler) {
    this.listeners[name] = handler;
  }

  emitOpen() {
    this.onopen?.();
  }

  emitError() {
    this.onerror?.();
  }

  emitSnapshot(snapshot) {
    this.listeners.snapshot?.({ data: JSON.stringify(snapshot) });
  }
}

const buildLiveEvent = (sequence) => ({
  eventId: 'event-1',
  name: 'Team A - Team B',
  time: '2030-01-01T12:00:00.000Z',
  visibility: 'ONLINE',
  status: 'NO_RESULT',
  products: [],
  home: 'Team A',
  away: 'Team B',
  live: {
    sequence,
    kickoffAt: '2030-01-01T12:00:00.000Z',
    occurredAt: '2030-01-01T12:10:00.000Z',
    minute: 10 + sequence,
    phase: 'FIRST_HALF',
    homeScore: sequence > 1 ? 1 : 0,
    awayScore: 0,
    bettingStatus: 'OPEN',
    incidentHistory: [],
    currentMarkets: [],
  },
});

const Harness = ({ visibleOfflineEventIds, onScopedAccessFailure }) => {
  const { events, feedState, isLoading } = useLiveEvents(
    visibleOfflineEventIds,
    onScopedAccessFailure,
  );

  return <div>
    <div data-testid="sequence">{events[0]?.live?.sequence ?? 'none'}</div>
    <div data-testid="event-count">{events.length}</div>
    <div data-testid="feed-state">{feedState}</div>
    <div data-testid="loading-state">{String(isLoading)}</div>
    <div data-testid="visibility">{events[0]?.visibility ?? 'none'}</div>
    <div data-testid="status">{events[0]?.status ?? 'none'}</div>
  </div>;
};

describe('useLiveEvents', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    createdSources.length = 0;
    axios.get.mockReset();
    global.EventSource = jest.fn((url) => new MockEventSource(url));
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('deduplicates out-of-order snapshots, reconciles gaps, reconnects, and cleans up timers', async () => {
    axios.get
      .mockResolvedValueOnce({ data: [buildLiveEvent(1)] })
      .mockResolvedValueOnce({ data: [buildLiveEvent(4)] })
      .mockResolvedValueOnce({ data: [buildLiveEvent(4)] })
      .mockResolvedValueOnce({ data: [buildLiveEvent(5)] })
      .mockResolvedValueOnce({ data: [buildLiveEvent(5)] });

    const { unmount } = render(<Harness />);

    await waitFor(() => expect(screen.getByTestId('sequence')).toHaveTextContent('1'));
    expect(createdSources).toHaveLength(1);

    const firstSource = createdSources[0];
    act(() => {
      firstSource.emitOpen();
    });

    expect(screen.getByTestId('feed-state')).toHaveTextContent('open');
    expect(screen.getByTestId('loading-state')).toHaveTextContent('false');

    act(() => {
      firstSource.emitSnapshot(buildLiveEvent(2));
    });
    expect(screen.getByTestId('sequence')).toHaveTextContent('2');

    act(() => {
      firstSource.emitSnapshot(buildLiveEvent(2));
      firstSource.emitSnapshot(buildLiveEvent(1));
    });
    expect(screen.getByTestId('sequence')).toHaveTextContent('2');

    act(() => {
      firstSource.emitSnapshot(buildLiveEvent(4));
    });
    expect(screen.getByTestId('sequence')).toHaveTextContent('4');

    await act(async () => {
      jest.advanceTimersByTime(RECONCILE_DEBOUNCE_MS);
    });
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));

    act(() => {
      firstSource.emitError();
    });

    expect(firstSource.close).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('feed-state')).toHaveTextContent('polling');
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(3));

    await act(async () => {
      jest.advanceTimersByTime(POLL_FALLBACK_MS);
    });
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(4));

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });

    expect(createdSources).toHaveLength(2);
    const secondSource = createdSources[1];

    act(() => {
      secondSource.emitOpen();
    });

    await act(async () => {
      jest.advanceTimersByTime(RECONCILE_DEBOUNCE_MS);
    });
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(5));

    unmount();

    expect(secondSource.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(POLL_FALLBACK_MS + 1000 + RECONCILE_DEBOUNCE_MS);
    });

    expect(axios.get).toHaveBeenCalledTimes(5);
  });

  it('schedules one prompt authoritative reconcile for repeated FULL_TIME snapshots', async () => {
    const finishedEvent = {
      ...buildLiveEvent(2),
      status: 'RESULTED',
      live: {
        ...buildLiveEvent(2).live,
        phase: 'FULL_TIME',
        bettingStatus: 'CLOSED',
      },
    };
    axios.get
      .mockResolvedValueOnce({ data: [buildLiveEvent(1)] })
      .mockResolvedValueOnce({ data: [finishedEvent] });

    const { unmount } = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('sequence')).toHaveTextContent('1'));

    act(() => {
      createdSources[0].emitOpen();
      createdSources[0].emitSnapshot(finishedEvent);
      createdSources[0].emitSnapshot(finishedEvent);
    });

    expect(axios.get).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(RECONCILE_DEBOUNCE_MS);
    });
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));

    await act(async () => {
      jest.advanceTimersByTime(RECONCILE_DEBOUNCE_MS);
    });
    expect(axios.get).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('scopes both REST and SSE requests to authorized acceptance event IDs', async () => {
    const eventIds = `${'a'.repeat(24)},${'b'.repeat(24)}`;
    axios.get.mockResolvedValue({ data: [] });

    const { unmount } = render(
      <Harness visibleOfflineEventIds={new Set(eventIds.split(','))} />,
    );
    const encodedScope = encodeURIComponent(eventIds);

    await waitFor(() => {
      expect(axios.get).toHaveBeenCalledWith(
        `/api/event?acceptanceEventIds=${encodedScope}`,
      );
    });
    expect(createdSources[0].url).toBe(
      `/api/event/stream?acceptanceEventIds=${encodedScope}`,
    );

    unmount();
  });

  it('authoritatively removes events hidden while SSE remains healthy', async () => {
    axios.get
      .mockResolvedValueOnce({ data: [buildLiveEvent(1)] })
      .mockResolvedValueOnce({ data: [] });

    const { unmount } = render(<Harness />);
    await waitFor(() => expect(screen.getByTestId('event-count')).toHaveTextContent('1'));

    act(() => {
      createdSources[0].emitOpen();
    });
    expect(screen.getByTestId('feed-state')).toHaveTextContent('open');

    await act(async () => {
      jest.advanceTimersByTime(POLL_FALLBACK_MS);
    });

    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('event-count')).toHaveTextContent('0');
    expect(screen.getByTestId('feed-state')).toHaveTextContent('open');

    unmount();
  });

  it('immediately removes scoped offline events when stream authorization is lost', async () => {
    const eventId = 'a'.repeat(24);
    const offlineEvent = {
      ...buildLiveEvent(1),
      eventId,
      visibility: 'OFFLINE',
    };
    const onScopedAccessFailure = jest.fn();
    axios.get
      .mockResolvedValueOnce({ data: [offlineEvent] })
      .mockRejectedValueOnce({ response: { status: 403 } });

    const { unmount } = render(
      <Harness
        visibleOfflineEventIds={new Set([eventId])}
        onScopedAccessFailure={onScopedAccessFailure}
      />,
    );

    await waitFor(() => expect(screen.getByTestId('sequence')).toHaveTextContent('1'));

    act(() => {
      createdSources[0].emitError();
    });

    expect(screen.getByTestId('sequence')).toHaveTextContent('none');
    expect(onScopedAccessFailure).toHaveBeenCalled();
    act(() => {
      createdSources[0].emitSnapshot({ ...offlineEvent, live: {
        ...offlineEvent.live,
        sequence: 2,
      } });
    });
    expect(screen.getByTestId('sequence')).toHaveTextContent('none');
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));

    unmount();
  });

  it('replaces a stale RESULTED/OFFLINE snapshot cached from SSE with a same-sequence authoritative REST read once server-side recovery settles', async () => {
    // Regression: `LiveEventProjectionListener` (the durable projection
    // writer) and `LiveEventUpdateListener` (the per-pod SSE broadcaster)
    // are independent listeners with no ordering guarantee between them.
    // If the SSE broadcast for a live update reaches the client *before*
    // `applyLiveEventUpdate`'s result-before-live race recovery has fully
    // settled `status`/`visibility` in the projection, the client can cache
    // a stale RESULTED/OFFLINE snapshot at that live sequence. A later
    // authoritative REST read (via polling/reconcile) reflecting the now-
    // settled projection must still be able to replace it, even though the
    // live sequence itself has not advanced.
    const staleRaceSnapshot = {
      eventId: 'race-event',
      name: 'Team A - Team B',
      time: '2030-01-01T12:00:00.000Z',
      visibility: 'OFFLINE',
      status: 'RESULTED',
      products: [],
      home: 'Team A',
      away: 'Team B',
      live: {
        sequence: 0,
        kickoffAt: '2030-01-01T12:00:00.000Z',
        occurredAt: '2030-01-01T12:00:00.000Z',
        minute: 0,
        phase: 'PRE_MATCH',
        homeScore: 0,
        awayScore: 0,
        bettingStatus: 'OPEN',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    const settledRecoverySnapshot = {
      ...staleRaceSnapshot,
      visibility: 'ONLINE',
      status: 'NO_RESULT',
    };

    // The client's very first authoritative REST read (on mount) can itself
    // land while the race is still unresolved -- independent listeners give
    // no guarantee the projection's recovery has settled by the time any
    // given reader observes it.
    axios.get
      .mockResolvedValueOnce({ data: [staleRaceSnapshot] })
      .mockResolvedValueOnce({ data: [settledRecoverySnapshot] });

    const { unmount } = render(<Harness />);
    // A positive, non-default signal (not just "still empty") proves the
    // first REST response has actually resolved and been applied before
    // any further steps run.
    await waitFor(() => expect(screen.getByTestId('sequence')).toHaveTextContent('0'));
    expect(screen.getByTestId('visibility')).toHaveTextContent('OFFLINE');
    expect(screen.getByTestId('status')).toHaveTextContent('RESULTED');

    act(() => {
      createdSources[0].emitOpen();
    });

    // The SSE broadcast for this same live sequence also still reflects the
    // pre-recovery projection (the per-pod SSE broadcaster and the durable
    // projection writer are independent listeners with no ordering
    // guarantee between them) -- applying it is a no-op here, exactly
    // mirroring the dedicated same-sequence dedupe SSE already guarantees.
    act(() => {
      createdSources[0].emitSnapshot(staleRaceSnapshot);
    });
    expect(screen.getByTestId('sequence')).toHaveTextContent('0');
    expect(screen.getByTestId('visibility')).toHaveTextContent('OFFLINE');
    expect(screen.getByTestId('status')).toHaveTextContent('RESULTED');

    // A subsequent authoritative REST poll, at the very same live sequence,
    // reflects the now fully-settled projection and must replace the stale
    // cached metadata rather than being ignored for lacking a strictly
    // greater sequence.
    await act(async () => {
      jest.advanceTimersByTime(POLL_FALLBACK_MS);
    });
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));

    expect(screen.getByTestId('sequence')).toHaveTextContent('0');
    expect(screen.getByTestId('visibility')).toHaveTextContent('ONLINE');
    expect(screen.getByTestId('status')).toHaveTextContent('NO_RESULT');

    unmount();
  });

  it('does not regress a healthy same-sequence SSE state when a slower, earlier-issued REST response resolves later with stale RESULTED/OFFLINE data', async () => {
    // Regression: same-sequence authoritative replacement must be a
    // one-directional repair, never an unconditional "last write wins".
    // Two independent reads of the server's projection can resolve out of
    // order relative to when they were issued (a slower request reflecting
    // an older, pre-recovery Mongo read can finish *after* a faster read --
    // or SSE -- already observed and applied the settled, healthy state at
    // the very same live sequence). Accepting that late, stale response
    // unconditionally would regress a correct cached snapshot back into
    // the premature RESULTED/OFFLINE race signature.
    const healthySnapshot = {
      eventId: 'race-event-reverse',
      name: 'Team A - Team B',
      time: '2030-01-01T12:00:00.000Z',
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      products: [],
      home: 'Team A',
      away: 'Team B',
      live: {
        sequence: 3,
        kickoffAt: '2030-01-01T12:00:00.000Z',
        occurredAt: '2030-01-01T12:20:00.000Z',
        minute: 20,
        phase: 'FIRST_HALF',
        homeScore: 0,
        awayScore: 0,
        bettingStatus: 'OPEN',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    const staleSnapshot = {
      ...healthySnapshot,
      visibility: 'OFFLINE',
      status: 'RESULTED',
    };

    // The client's very first REST request is issued on mount but resolves
    // later, under manual control, so its (stale) response can be made to
    // arrive strictly after the SSE snapshot below.
    let resolveMountFetch;
    axios.get.mockImplementationOnce(() => new Promise((resolve) => {
      resolveMountFetch = resolve;
    }));

    const { unmount } = render(<Harness />);
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));

    act(() => {
      createdSources[0].emitOpen();
    });

    // The per-pod SSE broadcaster independently observes the already-
    // settled, healthy projection and delivers it first -- accepted
    // because there is no cached entry for this event yet.
    act(() => {
      createdSources[0].emitSnapshot(healthySnapshot);
    });
    expect(screen.getByTestId('sequence')).toHaveTextContent('3');
    expect(screen.getByTestId('visibility')).toHaveTextContent('ONLINE');
    expect(screen.getByTestId('status')).toHaveTextContent('NO_RESULT');

    // The slower, earlier-issued mount REST request now finally resolves,
    // reflecting a Mongo read taken before the race recovery ever settled,
    // at the very same live sequence.
    await act(async () => {
      resolveMountFetch({ data: [staleSnapshot] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId('sequence')).toHaveTextContent('3');
    expect(screen.getByTestId('visibility')).toHaveTextContent('ONLINE');
    expect(screen.getByTestId('status')).toHaveTextContent('NO_RESULT');

    unmount();
  });
});
