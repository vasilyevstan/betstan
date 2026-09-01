import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import EventList, { RETAINED_FINISHED_EVENT_STORAGE_KEY } from './EventList';
import useLiveEvents from './useLiveEvents';
import {
  COUNTDOWN_LIVE_MARKET_TYPE,
  getLiveSelectionKey,
  getPreMatchSelectionKey,
} from '../../liveBettingUtils';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('./useLiveEvents', () => jest.fn());

const buildLiveMarket = ({
  marketId,
  marketType,
  marketVersion,
  quoteVersion,
  status = 'OPEN',
  quoteValidUntil = new Date(Date.now() + 60_000).toISOString(),
  odds = 1.8,
}) => ({
  marketId,
  marketType,
  marketVersion,
  quoteVersion,
  status,
  quoteValidUntil,
  selections: [
    {
      selectionId: 'home',
      side: 'HOME',
      odds,
    },
  ],
});

const liveEvent = {
  eventId: 'live-1',
  name: 'Live Derby',
  time: '2030-01-01T12:00:00.000Z',
  visibility: 'ONLINE',
  status: 'NO_RESULT',
  home: 'Team A',
  away: 'Team B',
  products: [],
  live: {
    sequence: 7,
    occurredAt: '2030-01-01T12:33:00.000Z',
    kickoffAt: '2030-01-01T12:00:00.000Z',
    minute: 33,
    phase: 'FIRST_HALF',
    homeScore: 2,
    awayScore: 1,
    bettingStatus: 'OPEN',
    incidentHistory: [
      { type: 'GOAL', side: 'HOME', minute: 12 },
      { type: 'YELLOW_CARD', side: 'AWAY', minute: 24 },
    ],
    currentMarkets: [
      buildLiveMarket({ marketId: 'market-1', marketType: 'NEXT_CORNER', marketVersion: 1, quoteVersion: 1, odds: 1.8 }),
      buildLiveMarket({ marketId: 'market-2', marketType: 'NEXT_RED_CARD', marketVersion: 1, quoteVersion: 2, status: 'SUSPENDED', odds: 3.2 }),
      buildLiveMarket({ marketId: 'market-3', marketType: 'NEXT_YELLOW_CARD', marketVersion: 1, quoteVersion: 3, quoteValidUntil: '2000-01-01T00:00:00.000Z', odds: 2.4 }),
      buildLiveMarket({ marketId: 'market-4', marketType: 'NEXT_PENALTY', marketVersion: 1, quoteVersion: 4, quoteValidUntil: null, odds: 5.1 }),
      buildLiveMarket({ marketId: 'market-5', marketType: 'HALF_TIME_RESULT', marketVersion: 1, quoteVersion: 5, odds: 1.4 }),
      buildLiveMarket({ marketId: 'market-6', marketType: 'NEXT_CORNER', marketVersion: 2, quoteVersion: 6, odds: 2.1 }),
      buildLiveMarket({ marketId: 'market-7', marketType: 'NEXT_CORNER', marketVersion: 3, quoteVersion: 7, status: 'settled', odds: 9.9 }),
      buildLiveMarket({ marketId: 'market-8', marketType: 'NEXT_CORNER', marketVersion: 4, quoteVersion: 8, status: 'CLOSED', odds: 8.8 }),
    ],
  },
};

const preMatchEvent = {
  eventId: 'prematch-1',
  name: 'Pre-match Clash',
  time: '2030-01-02T12:00:00.000Z',
  visibility: 'ONLINE',
  status: 'NO_RESULT',
  products: [
    {
      id: 'product-1',
      type: '1X2',
      name: '1X2',
      odds: [
        { id: 'home', name: 'Team A', value: 1.5 },
        { id: 'draw', name: 'Draw', value: 3.1 },
        { id: 'away', name: 'Team B', value: 2.6 },
      ],
    },
  ],
};

describe('EventList', () => {
  beforeEach(() => {
    axios.post.mockReset();
    axios.post.mockResolvedValue({});
    window.sessionStorage.clear();
  });

  it('renders live events first, shows accessible live markets, disables stale markets, and highlights both boards', async () => {
    useLiveEvents.mockReturnValue({
      events: [preMatchEvent, liveEvent],
      feedState: 'polling',
      isLoading: false,
    });

    const onSelectionPlaced = jest.fn();
    const selectedSelectionKeys = new Set([
      getPreMatchSelectionKey({ eventId: 'prematch-1', productId: 'product-1', oddsId: 'home' }),
      getLiveSelectionKey({ eventId: 'live-1', marketId: 'market-1', marketVersion: 1, selectionId: 'home' }),
    ]);

    render(
      <EventList
        onSelectionPlaced={onSelectionPlaced}
        selectedSelectionKeys={selectedSelectionKeys}
        uiVariant="v2"
      />,
    );

    const articles = screen.getAllByRole('article');
    expect(articles[0]).toHaveAccessibleName('Live Derby');
    expect(articles[1]).toHaveAccessibleName('Pre-match Clash');
    // The single live surface uses the full stage; a sparse pre-match card keeps its bounded width.
    expect(articles[0].parentElement).toHaveClass('col-12');
    expect(articles[0].parentElement).not.toHaveClass('col-xl-8');
    expect(articles[0].parentElement).not.toHaveClass('col-xl-4');
    expect(articles[1].parentElement).toHaveClass('col-12', 'col-xl-8');
    expect(articles[1].parentElement).not.toHaveClass('col-xl-4');
    expect(articles[0].querySelector('.event-market-grid')).toHaveClass('event-market-grid--compact');
    expect(articles[0].querySelectorAll('.event-market-card')).toHaveLength(6);

    expect(screen.getByRole('heading', { name: 'Live now' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pre-match' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Next live event' })).toBeNull();
    expect(screen.getByRole('progressbar', { name: 'Match progress' })).toHaveAttribute('aria-valuenow', '33');
    expect(screen.getByRole('status')).toHaveTextContent('Live feed reconnecting. Polling fallback is active.');

    const liveSelection = screen.getByRole('button', { name: 'Select Next Corner: Team A at 1.8' });
    const preMatchSelection = screen.getByRole('button', { name: 'Select 1X2 Team A at 1.5' });
    const suspendedSelection = screen.getByRole('button', { name: 'Select Next Red Card: Team A at 3.2' });
    const staleSelection = screen.getByRole('button', { name: 'Select Next Yellow Card: Team A at 2.4' });
    const missingExpirySelection = screen.getByRole('button', { name: 'Select Next Penalty: Team A at 5.1' });

    expect(liveSelection).toHaveClass('product-button--selected');
    expect(preMatchSelection).toHaveClass('product-button--selected');
    expect(suspendedSelection).toBeDisabled();
    expect(staleSelection).toBeDisabled();
    expect(missingExpirySelection).toBeDisabled();
    expect(screen.getByText('Quote v5')).toBeInTheDocument();
    expect(screen.getByText('Quote v6')).toBeInTheDocument();
    // Terminal (SETTLED/CLOSED, case-insensitively) markets are excluded from the rendered card
    // list entirely -- the count reflects only the 6 non-terminal markets out of the 8 supplied.
    expect(screen.queryByText('Quote v7')).toBeNull();
    expect(screen.queryByText('Quote v8')).toBeNull();
    expect(screen.getByText('6 markets')).toBeInTheDocument();

    fireEvent.click(liveSelection);

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/event/odds', {
      eventId: 'live-1',
      marketId: 'market-1',
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: 'home',
    }));
    await waitFor(() => expect(onSelectionPlaced).toHaveBeenCalledTimes(1));
  });

  it('shows an explicitly scoped offline event only to the acceptance view', () => {
    useLiveEvents.mockReturnValue({
      events: [{ ...preMatchEvent, visibility: 'OFFLINE' }],
      feedState: 'open',
      isLoading: false,
    });

    const { rerender } = render(
      <EventList
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
      />,
    );
    expect(screen.queryByRole('article', { name: preMatchEvent.name })).toBeNull();

    rerender(
      <EventList
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
        visibleOfflineEventIds={new Set([preMatchEvent.eventId])}
      />,
    );
    expect(
      screen.getByRole('article', { name: preMatchEvent.name }),
    ).toBeInTheDocument();
  });

  it.each(['v1', 'v2', 'v3'])(
    'shows the earliest scheduled live event when no match is live in %s',
    (uiVariant) => {
      const laterEvent = {
        ...preMatchEvent,
        eventId: 'prematch-later',
        name: 'Later Match',
        time: '2030-01-03T12:00:00.000Z',
      };
      const nextEvent = {
        ...preMatchEvent,
        eventId: 'prematch-next',
        name: 'Next Match',
        time: '2030-01-01T18:30:00.000Z',
      };
      useLiveEvents.mockReturnValue({
        events: [laterEvent, nextEvent],
        feedState: 'open',
        isLoading: false,
      });

      render(
        <EventList
          selectedSelectionKeys={new Set()}
          uiVariant={uiVariant}
        />,
      );

      const heading = screen.getByRole('heading', { name: 'Next live event' });
      const nextLiveCard = heading.closest('aside');
      expect(nextLiveCard).toHaveTextContent('Next Match');
      expect(nextLiveCard).not.toHaveTextContent('Later Match');
      expect(nextLiveCard.querySelector('time')).toHaveAttribute(
        'datetime',
        nextEvent.time,
      );
      expect(nextLiveCard).toHaveTextContent(
        'Pre-match markets are open now. Pre-kickoff live markets open in the final countdown; '
          + 'in-play markets follow at kickoff.',
      );
    },
  );
});

describe('EventList kickoff countdown', () => {
  const KICKOFF_ISO = '2030-06-01T15:00:00.000Z';
  const KICKOFF_TIME = Date.parse(KICKOFF_ISO);

  const buildCountdownMarket = ({
    marketId,
    marketType,
    status = 'OPEN',
    quoteValidUntil = new Date(KICKOFF_TIME + 5 * 60_000).toISOString(),
    selections,
  }) => ({
    marketId,
    marketType,
    marketVersion: 1,
    quoteVersion: 1,
    status,
    quoteValidUntil,
    selections,
  });

  const kickoffTeamMarket = buildCountdownMarket({
    marketId: 'countdown-market-1',
    marketType: COUNTDOWN_LIVE_MARKET_TYPE.KICKOFF_TEAM,
    selections: [
      { selectionId: 'home', side: 'HOME', odds: 2.1 },
      { selectionId: 'away', side: 'AWAY', odds: 3.4 },
    ],
  });

  const firstMinuteGoalMarket = buildCountdownMarket({
    marketId: 'countdown-market-2',
    marketType: COUNTDOWN_LIVE_MARKET_TYPE.FIRST_MINUTE_GOAL,
    selections: [
      { selectionId: 'yes', side: 'YES', odds: 6.5 },
      { selectionId: 'no', side: 'NO', odds: 1.1 },
    ],
  });

  const buildCountdownEvent = (overrides = {}) => ({
    eventId: 'countdown-1',
    name: 'Countdown Derby',
    time: KICKOFF_ISO,
    visibility: 'ONLINE',
    status: 'NO_RESULT',
    home: 'Team A',
    away: 'Team B',
    products: [],
    live: {
      bettingStatus: 'OPEN',
      currentMarkets: [kickoffTeamMarket, firstMinuteGoalMarket],
    },
    ...overrides,
  });

  beforeEach(() => {
    axios.post.mockReset();
    axios.post.mockResolvedValue({});
    jest.useFakeTimers();
    // The retained-finished-card persistence (sessionStorage) must not leak between tests.
    window.sessionStorage.clear();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
    window.sessionStorage.clear();
  });

  it('keeps an event out of the live area before T-10 (still a normal pre-match card)', () => {
    jest.setSystemTime(KICKOFF_TIME - 10 * 60_000 - 60_000);
    useLiveEvents.mockReturnValue({
      events: [buildCountdownEvent()],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    expect(screen.queryByRole('heading', { name: 'Live now' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Pre-match' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Countdown Derby' })).toBeInTheDocument();
  });

  it('shows the event in the live area with an accessible countdown starting exactly at T-10', () => {
    jest.setSystemTime(KICKOFF_TIME - 10 * 60_000);
    useLiveEvents.mockReturnValue({
      events: [buildCountdownEvent()],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    expect(screen.getByRole('heading', { name: 'Live now' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Pre-match' })).toBeNull();

    const timer = screen.getByRole('timer');
    const countdownArticle = screen.getByRole('article', { name: 'Countdown Derby' });
    expect(timer).toHaveAccessibleName('Kickoff countdown: 10:00');
    expect(screen.getByText('KICKOFF SOON')).toBeInTheDocument();
    expect(countdownArticle.parentElement).toHaveClass('col-12');
    expect(countdownArticle.querySelector('.event-market-grid')).toHaveClass('event-market-grid--compact');
  });

  it('ticks the countdown down every second without leaking timers', async () => {
    jest.setSystemTime(KICKOFF_TIME - 5 * 60_000);
    useLiveEvents.mockReturnValue({
      events: [buildCountdownEvent()],
      feedState: 'open',
      isLoading: false,
    });

    const { unmount } = render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    expect(screen.getByRole('timer')).toHaveAccessibleName('Kickoff countdown: 05:00');

    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(screen.getByRole('timer')).toHaveAccessibleName('Kickoff countdown: 04:59');

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(screen.getByRole('timer')).toHaveAccessibleName('Kickoff countdown: 04:56');

    const pendingTimersBeforeUnmount = jest.getTimerCount();
    expect(pendingTimersBeforeUnmount).toBeGreaterThan(0);
    unmount();
    expect(jest.getTimerCount()).toBe(pendingTimersBeforeUnmount - 1);
  });

  it('renders the two countdown-only markets and routes selections through the existing live-slip mechanism', async () => {
    jest.setSystemTime(KICKOFF_TIME - 5 * 60_000);
    useLiveEvents.mockReturnValue({
      events: [buildCountdownEvent()],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList onSelectionPlaced={jest.fn()} selectedSelectionKeys={new Set()} uiVariant="v2" />);

    const kickoffTeamButton = screen.getByRole('button', { name: 'Select Kickoff Team: Team A at 2.1' });
    const firstMinuteGoalButton = screen.getByRole('button', { name: 'Select Goal in First Minute: Yes at 6.5' });
    expect(kickoffTeamButton).toBeEnabled();
    expect(firstMinuteGoalButton).toBeEnabled();

    fireEvent.click(firstMinuteGoalButton);

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/event/odds', {
      eventId: 'countdown-1',
      marketId: 'countdown-market-2',
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: 'yes',
    }));
  });

  it('renders ordinary pre-match products alongside the new live-slip markets during the countdown, routing each to its own board without remount', async () => {
    jest.setSystemTime(KICKOFF_TIME - 5 * 60_000);
    const event = buildCountdownEvent({
      products: [
        {
          id: 'product-1',
          type: '1X2',
          name: '1X2',
          odds: [
            { id: 'home', name: 'Team A', value: 1.5 },
            { id: 'draw', name: 'Draw', value: 3.1 },
            { id: 'away', name: 'Team B', value: 2.6 },
          ],
        },
      ],
    });
    useLiveEvents.mockReturnValue({
      events: [event],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList onSelectionPlaced={jest.fn()} selectedSelectionKeys={new Set()} uiVariant="v2" />);

    // Both product families are visible together on the same countdown card, each with its own
    // existing visual distinction (pre-match badge vs pre-kickoff live-slip section).
    expect(screen.getByText('PRE-MATCH')).toBeInTheDocument();
    expect(screen.getByText('Pre-match markets')).toBeInTheDocument();
    expect(screen.getByText('Pre-kickoff markets')).toBeInTheDocument();

    const preMatchButton = screen.getByRole('button', {
      name: 'Select 1X2 1: Team A in Countdown Derby at 1.5',
    });
    const kickoffTeamButton = screen.getByRole('button', { name: 'Select Kickoff Team: Team A at 2.1' });
    const firstMinuteGoalButton = screen.getByRole('button', { name: 'Select Goal in First Minute: Yes at 6.5' });
    expect(preMatchButton).toBeEnabled();
    expect(kickoffTeamButton).toBeEnabled();
    expect(firstMinuteGoalButton).toBeEnabled();

    // Selecting the pre-match product routes through the existing Product1X2/ProductsList board...
    fireEvent.click(preMatchButton);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/event/odds', {
      eventId: 'countdown-1',
      productId: 'product-1',
      oddsId: 'home',
    }));

    // ...while the new live-slip market routes through the existing generic market/selection board,
    // independently (different request shape, same generic mechanism used by ordinary live markets).
    fireEvent.click(kickoffTeamButton);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/event/odds', {
      eventId: 'countdown-1',
      marketId: 'countdown-market-1',
      marketVersion: 1,
      quoteVersion: 1,
      selectionId: 'home',
    }));

    // Neither click unmounted/remounted the card: the same button elements are still present and
    // enabled afterward, proving no state loss from routing to two independent boards.
    expect(screen.getByRole('button', {
      name: 'Select 1X2 1: Team A in Countdown Derby at 1.5',
    })).toBe(preMatchButton);
    expect(screen.getByRole('button', { name: 'Select Kickoff Team: Team A at 2.1' })).toBe(kickoffTeamButton);
  });

  it('excludes a countdown market card entirely once the server closes it (terminal status), even though the client clock is still pre-kickoff', () => {
    jest.setSystemTime(KICKOFF_TIME - 5 * 60_000);
    const event = buildCountdownEvent({
      live: {
        bettingStatus: 'OPEN',
        currentMarkets: [
          { ...kickoffTeamMarket, status: 'CLOSED' },
          firstMinuteGoalMarket,
        ],
      },
    });
    useLiveEvents.mockReturnValue({
      events: [event],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    // CLOSED is a terminal market status: the card is dropped entirely rather than shown disabled.
    expect(screen.queryByRole('button', { name: 'Select Kickoff Team: Team A at 2.1' })).toBeNull();
    expect(screen.queryByText('Closed')).toBeNull();
    // The still-open sibling market is unaffected.
    expect(screen.getByRole('button', { name: 'Select Goal in First Minute: Yes at 6.5' })).toBeEnabled();
  });

  it('keeps a suspended (non-terminal) countdown market card visible but disabled', () => {
    jest.setSystemTime(KICKOFF_TIME - 5 * 60_000);
    const event = buildCountdownEvent({
      live: {
        bettingStatus: 'OPEN',
        currentMarkets: [
          { ...kickoffTeamMarket, status: 'SUSPENDED' },
          firstMinuteGoalMarket,
        ],
      },
    });
    useLiveEvents.mockReturnValue({
      events: [event],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    const kickoffTeamButton = screen.getByRole('button', { name: 'Select Kickoff Team: Team A at 2.1' });
    expect(kickoffTeamButton).toBeDisabled();
    expect(screen.getByText('Temporarily suspended')).toBeInTheDocument();
  });

  it('keeps a market with an actually unknown, non-terminal status (e.g. SETTLEMENT_PENDING) visible rather than excluding it like a terminal SETTLED/CLOSED market', () => {
    jest.setSystemTime(KICKOFF_TIME - 5 * 60_000);
    const event = buildCountdownEvent({
      live: {
        bettingStatus: 'OPEN',
        currentMarkets: [
          { ...kickoffTeamMarket, status: 'SETTLEMENT_PENDING' },
          firstMinuteGoalMarket,
        ],
      },
    });
    useLiveEvents.mockReturnValue({
      events: [event],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    // Unlike a terminal SETTLED/CLOSED market, an unrecognized status is not excluded from the
    // rendered card list -- it stays visible, is treated as not currently selectable (per the
    // existing selectability rule, which only ever allows the exact OPEN status), and is labelled
    // with a clear, non-contradictory "Temporarily unavailable" rather than "Open".
    const kickoffTeamButton = screen.getByRole('button', { name: 'Select Kickoff Team: Team A at 2.1' });
    expect(kickoffTeamButton).toBeInTheDocument();
    expect(kickoffTeamButton).toBeDisabled();
    const kickoffTeamCard = kickoffTeamButton.closest('.event-market-card');
    expect(kickoffTeamCard).toHaveTextContent('Temporarily unavailable');
    // The sibling market genuinely is OPEN, so "Open" legitimately appears elsewhere on the page;
    // it must specifically not appear on *this* unknown-status market's own card.
    expect(kickoffTeamCard).not.toHaveTextContent('Open');
  });

  it('transitions cleanly to the live clock/scoreboard at kickoff based on authoritative server data', () => {
    jest.setSystemTime(KICKOFF_TIME - 30_000);
    useLiveEvents.mockReturnValue({
      events: [buildCountdownEvent()],
      feedState: 'open',
      isLoading: false,
    });

    const { rerender } = render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);
    expect(screen.getByText('KICKOFF SOON')).toBeInTheDocument();
    expect(screen.queryByText('LIVE')).toBeNull();

    // Server marks the event as live even though, by client clock, it is only just at/near kickoff.
    const liveEvent = buildCountdownEvent({
      live: {
        phase: 'FIRST_HALF',
        kickoffAt: KICKOFF_ISO,
        minute: 0,
        homeScore: 0,
        awayScore: 0,
        bettingStatus: 'OPEN',
        incidentHistory: [],
        currentMarkets: [],
      },
    });
    useLiveEvents.mockReturnValue({
      events: [liveEvent],
      feedState: 'open',
      isLoading: false,
    });
    rerender(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    expect(screen.queryByText('KICKOFF SOON')).toBeNull();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Match progress' })).toBeInTheDocument();
  });

  it('is backward compatible when the countdown event has no live block or markets yet', () => {
    jest.setSystemTime(KICKOFF_TIME - 5 * 60_000);
    useLiveEvents.mockReturnValue({
      events: [{
        eventId: 'countdown-bare',
        name: 'Bare Countdown Event',
        time: KICKOFF_ISO,
        visibility: 'ONLINE',
        status: 'NO_RESULT',
        home: 'Team A',
        away: 'Team B',
        products: [],
      }],
      feedState: 'open',
      isLoading: false,
    });

    expect(() => render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />)).not.toThrow();

    expect(screen.getByRole('heading', { name: 'Live now' })).toBeInTheDocument();
    expect(screen.getByText('Pre-kickoff markets opening soon…')).toBeInTheDocument();
  });

  it('retains the most recently finished live event, grouped under Recently finished (not Live now), with its final score and scheduled kickoff time', () => {
    jest.setSystemTime(KICKOFF_TIME + 2 * 60 * 60 * 1000);
    const finishedEvent = {
      eventId: 'finished-1',
      name: 'Finished Match',
      time: KICKOFF_ISO,
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      home: 'Team A',
      away: 'Team B',
      products: [],
      live: {
        phase: 'FULL_TIME',
        kickoffAt: KICKOFF_ISO,
        occurredAt: '2030-06-01T16:48:00.000Z',
        homeScore: 3,
        awayScore: 1,
        bettingStatus: 'SUSPENDED',
        incidentHistoryComplete: true,
        incidentHistory: [
          { id: 'kickoff', type: 'KICK_OFF', minute: 0 },
          { id: 'goal', type: 'GOAL', side: 'HOME', minute: 12 },
          { id: 'yellow', type: 'YELLOW_CARD', side: 'AWAY', minute: 30 },
          { id: 'full-time', type: 'FULL_TIME', minute: 90 },
        ],
        currentMarkets: [],
      },
    };
    useLiveEvents.mockReturnValue({
      events: [finishedEvent],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    expect(screen.queryByRole('heading', { name: 'Live now' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Recently finished' })).toBeInTheDocument();
    expect(screen.getByText('FULL-TIME')).toBeInTheDocument();
    const finishedCard = screen.getByRole('article', { name: 'Finished Match' });
    expect(finishedCard).toHaveTextContent('3');
    expect(finishedCard).toHaveTextContent('1');
    expect(finishedCard.parentElement).toHaveClass('col-12');
    expect(finishedCard.parentElement).not.toHaveClass('col-xl-8');
    expect(finishedCard.parentElement).not.toHaveClass('col-xl-4');
    expect(finishedCard.querySelector('time')).toHaveAttribute('datetime', KICKOFF_ISO);
    expect(finishedCard).toHaveTextContent('Key moments');
    expect(finishedCard.querySelector('.event-incidents')).toHaveTextContent("12' Team A goal");
    const timeline = finishedCard.querySelector('details');
    expect(timeline).not.toHaveAttribute('open');
    expect(screen.getByText('Full timeline (4)')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Full timeline (4)'));
    expect(timeline).toHaveAttribute('open');
    expect(Array.from(timeline.querySelectorAll('li')).map((item) => item.textContent)).toEqual([
      'Kick-off',
      "12' Team A goal",
      "30' Team B yellow card",
      'Full-time',
    ]);
  });

  it('keeps showing the retained finished card even after the server stops returning that event', async () => {
    jest.setSystemTime(KICKOFF_TIME + 2 * 60 * 60 * 1000);
    const finishedEvent = {
      eventId: 'finished-2',
      name: 'Finished Match Two',
      time: KICKOFF_ISO,
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      home: 'Team A',
      away: 'Team B',
      products: [],
      live: {
        phase: 'FULL_TIME',
        kickoffAt: KICKOFF_ISO,
        occurredAt: '2030-06-01T16:48:00.000Z',
        homeScore: 0,
        awayScore: 0,
        bettingStatus: 'SUSPENDED',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    useLiveEvents.mockReturnValue({
      events: [finishedEvent],
      feedState: 'open',
      isLoading: false,
    });

    const { rerender } = render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);
    expect(screen.getByRole('article', { name: 'Finished Match Two' })).toBeInTheDocument();

    useLiveEvents.mockReturnValue({
      events: [],
      feedState: 'open',
      isLoading: false,
    });
    await act(async () => {
      rerender(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);
    });

    expect(screen.getByRole('article', { name: 'Finished Match Two' })).toBeInTheDocument();
    expect(screen.getByText('FULL-TIME')).toBeInTheDocument();
  });

  it('replaces the retained finished card once the next event enters its own T-10 countdown window', async () => {
    const finishedEvent = {
      eventId: 'finished-3',
      name: 'Finished Match Three',
      time: KICKOFF_ISO,
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      home: 'Team A',
      away: 'Team B',
      products: [],
      live: {
        phase: 'FULL_TIME',
        kickoffAt: KICKOFF_ISO,
        occurredAt: '2030-06-01T16:48:00.000Z',
        homeScore: 2,
        awayScore: 2,
        bettingStatus: 'SUSPENDED',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    jest.setSystemTime(KICKOFF_TIME + 2 * 60 * 60 * 1000);
    useLiveEvents.mockReturnValue({
      events: [finishedEvent],
      feedState: 'open',
      isLoading: false,
    });

    const { rerender } = render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);
    expect(screen.getByRole('article', { name: 'Finished Match Three' })).toBeInTheDocument();

    const nextKickoffIso = new Date(KICKOFF_TIME + 3 * 60 * 60 * 1000).toISOString();
    const incomingCountdownEvent = buildCountdownEvent({
      eventId: 'countdown-next',
      name: 'Next Countdown Match',
      time: nextKickoffIso,
    });
    useLiveEvents.mockReturnValue({
      events: [finishedEvent, incomingCountdownEvent],
      feedState: 'open',
      isLoading: false,
    });
    // Advance the fake clock and let `useNow`'s own interval fire so the component
    // recomputes bucketing against the new "now", the same way it would in the browser.
    await act(async () => {
      jest.setSystemTime(KICKOFF_TIME + 3 * 60 * 60 * 1000 - 5 * 60_000);
      jest.advanceTimersByTime(1000);
    });
    rerender(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    expect(screen.queryByRole('article', { name: 'Finished Match Three' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Next Countdown Match' })).toBeInTheDocument();
    expect(screen.getByText('KICKOFF SOON')).toBeInTheDocument();
    // The retained card was replaced, so its persisted snapshot must not linger either.
    expect(window.sessionStorage.getItem(RETAINED_FINISHED_EVENT_STORAGE_KEY)).toBeNull();
  });

  it('rehydrates the retained finished card from sessionStorage after a refresh/reconnect remounts the component', async () => {
    jest.setSystemTime(KICKOFF_TIME + 2 * 60 * 60 * 1000);
    const finishedEvent = {
      eventId: 'finished-refresh',
      name: 'Finished Match Refresh',
      time: KICKOFF_ISO,
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      home: 'Team A',
      away: 'Team B',
      products: [],
      live: {
        phase: 'FULL_TIME',
        kickoffAt: KICKOFF_ISO,
        occurredAt: '2030-06-01T16:48:00.000Z',
        homeScore: 4,
        awayScore: 2,
        bettingStatus: 'SUSPENDED',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    useLiveEvents.mockReturnValue({
      events: [finishedEvent],
      feedState: 'open',
      isLoading: false,
    });

    const { unmount } = render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);
    expect(screen.getByRole('article', { name: 'Finished Match Refresh' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RETAINED_FINISHED_EVENT_STORAGE_KEY)).not.toBeNull();

    // Simulate a full page refresh/reconnect: the component tree is torn down and a brand new one
    // mounts, and by that point the backend's EventResultListener has already flipped the event to
    // OFFLINE so the public feed no longer returns it at all.
    unmount();
    useLiveEvents.mockReturnValue({
      events: [],
      feedState: 'open',
      isLoading: false,
    });
    render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    expect(screen.getByRole('article', { name: 'Finished Match Refresh' })).toBeInTheDocument();
    expect(screen.getByText('FULL-TIME')).toBeInTheDocument();
  });

  it('does not resurrect a stale retained finished card on remount once the next event is already live (past its own T-10 countdown)', async () => {
    jest.setSystemTime(KICKOFF_TIME + 2 * 60 * 60 * 1000);
    const finishedEvent = {
      eventId: 'finished-stale',
      name: 'Finished Match Stale',
      time: KICKOFF_ISO,
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      home: 'Team A',
      away: 'Team B',
      products: [],
      live: {
        phase: 'FULL_TIME',
        kickoffAt: KICKOFF_ISO,
        occurredAt: '2030-06-01T16:48:00.000Z',
        homeScore: 1,
        awayScore: 1,
        bettingStatus: 'SUSPENDED',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    useLiveEvents.mockReturnValue({
      events: [finishedEvent],
      feedState: 'open',
      isLoading: false,
    });

    const { unmount } = render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);
    expect(screen.getByRole('article', { name: 'Finished Match Stale' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RETAINED_FINISHED_EVENT_STORAGE_KEY)).not.toBeNull();

    // Simulate a full page refresh/reconnect that lands well after the next event's own T-10
    // countdown has *already* elapsed into a genuinely in-progress match -- i.e. the client never
    // observes that event's countdown window at all, only its already-live snapshot. The server
    // retired the previous finished event as soon as that next event's own PRE_MATCH snapshot
    // landed (well before it went live), so the public feed here never returns the stale card.
    unmount();
    const nextKickoffIso = new Date(KICKOFF_TIME + 3 * 60 * 60 * 1000).toISOString();
    const alreadyLiveEvent = {
      eventId: 'already-live-next',
      name: 'Already Live Next Match',
      time: nextKickoffIso,
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      home: 'Team C',
      away: 'Team D',
      products: [],
      live: {
        sequence: 12,
        occurredAt: new Date(KICKOFF_TIME + 3 * 60 * 60 * 1000 + 20 * 60_000).toISOString(),
        kickoffAt: nextKickoffIso,
        minute: 20,
        phase: 'FIRST_HALF',
        homeScore: 0,
        awayScore: 0,
        bettingStatus: 'OPEN',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    useLiveEvents.mockReturnValue({
      events: [alreadyLiveEvent],
      feedState: 'open',
      isLoading: false,
    });
    await act(async () => {
      jest.setSystemTime(KICKOFF_TIME + 3 * 60 * 60 * 1000 + 20 * 60_000);
      render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);
      jest.advanceTimersByTime(1000);
    });

    expect(screen.queryByRole('article', { name: 'Finished Match Stale' })).toBeNull();
    expect(screen.getByRole('article', { name: 'Already Live Next Match' })).toBeInTheDocument();
    expect(window.sessionStorage.getItem(RETAINED_FINISHED_EVENT_STORAGE_KEY)).toBeNull();
  });

  it('clears a retained finished card once its acceptance-view authorization is revoked', async () => {
    jest.setSystemTime(KICKOFF_TIME + 2 * 60 * 60 * 1000);
    const offlineFinishedEvent = {
      eventId: 'finished-offline',
      name: 'Finished Offline Match',
      time: KICKOFF_ISO,
      visibility: 'OFFLINE',
      status: 'NO_RESULT',
      home: 'Team A',
      away: 'Team B',
      products: [],
      live: {
        phase: 'FULL_TIME',
        kickoffAt: KICKOFF_ISO,
        occurredAt: '2030-06-01T16:48:00.000Z',
        homeScore: 1,
        awayScore: 1,
        bettingStatus: 'SUSPENDED',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    useLiveEvents.mockReturnValue({
      events: [offlineFinishedEvent],
      feedState: 'open',
      isLoading: false,
    });

    const { rerender } = render(<EventList
      selectedSelectionKeys={new Set()}
      uiVariant="v2"
      visibleOfflineEventIds={new Set(['finished-offline'])}
    />);
    expect(screen.getByRole('article', { name: 'Finished Offline Match' })).toBeInTheDocument();

    await act(async () => {
      rerender(<EventList
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
        visibleOfflineEventIds={new Set()}
      />);
    });

    expect(screen.queryByRole('article', { name: 'Finished Offline Match' })).toBeNull();
    expect(window.sessionStorage.getItem(RETAINED_FINISHED_EVENT_STORAGE_KEY)).toBeNull();
  });

  it('does not render or erase a retained OFFLINE event before scoped authorization resolves', async () => {
    jest.setSystemTime(KICKOFF_TIME + 2 * 60 * 60 * 1000);
    const offlineFinishedEvent = {
      eventId: 'finished-auth-pending',
      name: 'Pending Authorization Match',
      time: KICKOFF_ISO,
      visibility: 'OFFLINE',
      status: 'RESULTED',
      home: 'Team A',
      away: 'Team B',
      products: [],
      live: {
        phase: 'FULL_TIME',
        kickoffAt: KICKOFF_ISO,
        occurredAt: '2030-06-01T16:48:00.000Z',
        homeScore: 2,
        awayScore: 0,
        bettingStatus: 'CLOSED',
        incidentHistory: [],
        currentMarkets: [],
      },
    };
    window.sessionStorage.setItem(
      RETAINED_FINISHED_EVENT_STORAGE_KEY,
      JSON.stringify(offlineFinishedEvent),
    );
    useLiveEvents.mockReturnValue({
      events: [],
      feedState: 'open',
      isLoading: false,
    });

    const { rerender } = render(<EventList
      isScopedAccessResolved={false}
      selectedSelectionKeys={new Set()}
      uiVariant="v2"
      visibleOfflineEventIds={new Set()}
    />);

    expect(screen.queryByRole('article', { name: offlineFinishedEvent.name })).toBeNull();
    expect(JSON.parse(
      window.sessionStorage.getItem(RETAINED_FINISHED_EVENT_STORAGE_KEY),
    )).toMatchObject({ eventId: offlineFinishedEvent.eventId });

    await act(async () => {
      rerender(<EventList
        isScopedAccessResolved
        selectedSelectionKeys={new Set()}
        uiVariant="v2"
        visibleOfflineEventIds={new Set([offlineFinishedEvent.eventId])}
      />);
    });

    expect(screen.getByRole('article', { name: offlineFinishedEvent.name }))
      .toBeInTheDocument();
  });

  it('suppresses the "Next live event" banner while a countdown event occupies the upper live area', () => {
    jest.setSystemTime(KICKOFF_TIME - 5 * 60_000);
    const laterPreMatchEvent = {
      eventId: 'prematch-later',
      name: 'Later Pre-match Fixture',
      time: new Date(KICKOFF_TIME + 4 * 60 * 60 * 1000).toISOString(),
      visibility: 'ONLINE',
      status: 'NO_RESULT',
      home: 'Team C',
      away: 'Team D',
      products: [],
    };
    useLiveEvents.mockReturnValue({
      events: [buildCountdownEvent(), laterPreMatchEvent],
      feedState: 'open',
      isLoading: false,
    });

    render(<EventList selectedSelectionKeys={new Set()} uiVariant="v2" />);

    expect(screen.getByText('KICKOFF SOON')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Next live event' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Pre-match' })).toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Later Pre-match Fixture' })).toBeInTheDocument();
  });
});
