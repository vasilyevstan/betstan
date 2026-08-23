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
});
