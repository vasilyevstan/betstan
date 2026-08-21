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

const Harness = () => {
  const { events, feedState, isLoading } = useLiveEvents();

  return <div>
    <div data-testid="sequence">{events[0]?.live?.sequence ?? 'none'}</div>
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
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('deduplicates out-of-order snapshots, reconciles gaps, reconnects, and cleans up timers', async () => {
    axios.get
      .mockResolvedValueOnce({ data: [buildLiveEvent(1)] })
      .mockResolvedValueOnce({ data: [buildLiveEvent(4)] })
      .mockResolvedValueOnce({ data: [buildLiveEvent(4)] })
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

    await act(async () => {
      jest.advanceTimersByTime(POLL_FALLBACK_MS);
    });
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(3));

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
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(4));

    unmount();

    expect(secondSource.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(POLL_FALLBACK_MS + 1000 + RECONCILE_DEBOUNCE_MS);
    });

    expect(axios.get).toHaveBeenCalledTimes(4);
  });
});
