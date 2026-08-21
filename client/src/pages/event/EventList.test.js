import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import axios from 'axios';
import EventList from './EventList';
import useLiveEvents from './useLiveEvents';
import {
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
  quoteValidUntil,
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
      buildLiveMarket({ marketId: 'market-4', marketType: 'NEXT_PENALTY', marketVersion: 1, quoteVersion: 4, odds: 5.1 }),
      buildLiveMarket({ marketId: 'market-5', marketType: 'HALF_TIME_RESULT', marketVersion: 1, quoteVersion: 5, odds: 1.4 }),
      buildLiveMarket({ marketId: 'market-6', marketType: 'NEXT_CORNER', marketVersion: 2, quoteVersion: 6, odds: 2.1 }),
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

    expect(screen.getByRole('heading', { name: 'Live now' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Pre-match' })).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Match progress' })).toHaveAttribute('aria-valuenow', '33');
    expect(screen.getByRole('status')).toHaveTextContent('Live feed reconnecting. Polling fallback is active.');

    const liveSelection = screen.getByRole('button', { name: 'Select Next Corner: Team A at 1.8' });
    const preMatchSelection = screen.getByRole('button', { name: 'Select 1X2 Team A at 1.5' });
    const suspendedSelection = screen.getByRole('button', { name: 'Select Next Red Card: Team A at 3.2' });
    const staleSelection = screen.getByRole('button', { name: 'Select Next Yellow Card: Team A at 2.4' });

    expect(liveSelection).toHaveClass('product-button--selected');
    expect(preMatchSelection).toHaveClass('product-button--selected');
    expect(suspendedSelection).toBeDisabled();
    expect(staleSelection).toBeDisabled();
    expect(screen.getByText('Quote v5')).toBeInTheDocument();
    expect(screen.queryByText('Quote v6')).toBeNull();

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
});
