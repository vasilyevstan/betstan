import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, within } from '@testing-library/react';
import axios from 'axios';
import MyBets from './MyBets';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

describe('MyBets', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  it('labels live and legacy pre-match bets while rendering outcomes and decline reasons', async () => {
    axios.get.mockResolvedValue({
      data: [
        {
          _id: 'bet-live',
          slipId: 'live-slip-1',
          status: 'DECLINED',
          wager: 10,
          timestamp: '2030-01-01T12:00:00.000Z',
          betKind: 'LIVE',
          declineReason: 'STALE_QUOTE',
          rows: [
            {
              _id: 'row-live',
              eventName: 'Live Derby',
              eventTime: '2030-01-01T11:30:00.000Z',
              oddsName: 'Team A',
              oddsValue: 2.1,
              productName: '',
              marketType: 'NEXT_CORNER',
              betKind: 'LIVE',
              status: 'VOID',
              settlementReason: 'MANUAL_VOID',
              declineReason: 'STALE_QUOTE',
            },
          ],
        },
        {
          _id: 'bet-legacy',
          slipId: 'legacy-slip-1',
          status: 'CONFIRMED',
          wager: 5,
          timestamp: '2030-01-02T12:00:00.000Z',
          rows: [
            {
              _id: 'row-legacy',
              eventName: 'Legacy Match',
              eventTime: '2030-01-02T18:00:00.000Z',
              oddsName: 'Draw',
              oddsValue: 3.4,
              productName: '1X2',
              status: 'NOT_SETTLED',
            },
          ],
        },
      ],
    });

    render(<MyBets currentUser={{ id: 'test-owner' }} />);

    await screen.findByText('Live Derby');
    screen.getAllByRole('button', { name: /^Bet details/ }).forEach((button) => fireEvent.click(button));

    expect(screen.getAllByText('Live')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Pre-match')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Next Corner Kick')[0]).toBeInTheDocument();
    expect(screen.getByText('Declined: Quote changed')).toBeInTheDocument();
    expect(screen.getByText('Void · Manual void')).toBeInTheDocument();
    expect(screen.getByText('Pending result')).toBeInTheDocument();
  });

  it('normalizes a legacy raw live-selection identifier into a human label instead of rendering it verbatim', async () => {
    const rawIdentifier = 'event-77:NEXT_CORNER:1:HOME';
    axios.get.mockResolvedValue({
      data: [
        {
          _id: 'bet-legacy-live',
          slipId: 'legacy-live-slip-1',
          status: 'WIN',
          wager: 8,
          timestamp: '2030-01-03T12:00:00.000Z',
          betKind: 'LIVE',
          rows: [
            {
              _id: 'row-legacy-live',
              eventName: 'Raptors - Sharks',
              eventTime: '2030-01-03T11:30:00.000Z',
              oddsName: rawIdentifier,
              oddsValue: 1.8,
              productName: '',
              marketType: 'NEXT_CORNER',
              side: 'HOME',
              selectionId: 'home',
              betKind: 'LIVE',
              status: 'WIN',
              winningSelection: rawIdentifier,
            },
          ],
        },
      ],
    });

    render(<MyBets currentUser={{ id: 'test-owner' }} />);

    await screen.findByText('Raptors - Sharks');
    fireEvent.click(screen.getByRole('button', { name: /^Bet details/ }));

    // The raw stored identifier is never rendered verbatim; it is normalized into a readable
    // "<market>: <side>" label derived from the row's own structured live fields.
    expect(screen.queryByText(rawIdentifier, { exact: false })).toBeNull();
    expect(screen.getAllByText('Next Corner Kick: Raptors', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText('Won · Winner: Next Corner Kick: Raptors')).toBeInTheDocument();
  });

  it('filters independently by bet type and composes the type with the status filter', async () => {
    axios.get.mockResolvedValue({
      data: [
        {
          _id: 'bet-live',
          slipId: 'live-slip-1',
          status: 'DECLINED',
          wager: 10,
          timestamp: '2030-01-01T12:00:00.000Z',
          betKind: 'LIVE',
          rows: [{ _id: 'row-live', eventName: 'Live Derby', oddsValue: 2, marketType: 'NEXT_CORNER', betKind: 'LIVE' }],
        },
        {
          _id: 'bet-prematch',
          slipId: 'prematch-slip-1',
          status: 'CONFIRMED',
          wager: 5,
          timestamp: '2030-01-02T12:00:00.000Z',
          betKind: 'PRE_MATCH',
          rows: [{ _id: 'row-prematch', eventName: 'Scheduled Derby', oddsValue: 3, productName: '1X2', betKind: 'PRE_MATCH' }],
        },
      ],
    });

    render(<MyBets currentUser={{ id: 'test-owner' }} />);
    await screen.findByText('Live Derby');

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const liveFilter = screen.getByRole('button', { name: 'LIVE' });
    fireEvent.click(liveFilter);
    expect(liveFilter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Live Derby')).toBeInTheDocument();
    expect(screen.queryByText('Scheduled Derby')).toBeNull();
    expect(screen.getByText('1 bets found')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'CONFIRMED' }));
    expect(screen.getByText('No bets match the active filters.')).toBeInTheDocument();
    expect(screen.getByText('0 bets found')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'ALL TYPES' }));
    expect(screen.getByText('Scheduled Derby')).toBeInTheDocument();
    expect(screen.queryByText('Live Derby')).toBeNull();
  });

  it('keeps all filter capabilities in a labelled disclosure and the active context visible when closed', async () => {
    const now = Date.now();
    axios.get.mockResolvedValue({ data: [
      { _id: 'today', slipId: 'today', status: 'WIN', wager: 10, betKind: 'LIVE',
        timestamp: new Date(now).toISOString(), rows: [{ _id: 'today-row', eventName: 'Today match', oddsName: 'Home', oddsValue: 2 }] },
      { _id: 'week', slipId: 'week', status: 'CONFIRMED', wager: 5,
        timestamp: new Date(now - 4 * 86400000).toISOString(), rows: [{ _id: 'week-row', eventName: 'Recent match', oddsName: 'Draw', oddsValue: 3 }] },
      { _id: 'old', slipId: 'old', status: 'LOSS', wager: 5,
        timestamp: new Date(now - 40 * 86400000).toISOString(), rows: [{ _id: 'old-row', eventName: 'Older match', oddsName: 'Away', oddsValue: 4 }] },
    ] });
    render(<MyBets currentUser={{ id: 'test-owner' }} />);
    await screen.findByText('3 bets found');
    const disclosure = screen.getByRole('button', { name: 'Filters' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Filter bets by status' })).not.toBeInTheDocument();
    expect(document.querySelector('.my-bets-filter-context')).toHaveTextContent('All statuses · All types · All dates · Newest first');
    fireEvent.click(disclosure);
    expect(within(screen.getByRole('group', { name: 'Filter bets by status' })).getAllByRole('button')).toHaveLength(8);
    expect(within(screen.getByRole('group', { name: 'Filter bets by type' })).getAllByRole('button')).toHaveLength(3);
    const dates = screen.getByRole('combobox', { name: 'Filter bets by date' });
    expect(within(dates).getAllByRole('option').map((option) => option.value)).toEqual(['ALL', 'TODAY', '7D', '30D']);
    fireEvent.change(dates, { target: { value: '7D' } });
    expect(screen.getByText('2 bets found')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Newest first' }));
    expect([...document.querySelectorAll('.my-bets-card')].map((node) => node.dataset.slipId)).toEqual(['week', 'today']);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search bets' }), { target: { value: 'Draw' } });
    expect(screen.getByText('1 bets found')).toBeInTheDocument();
    fireEvent.click(disclosure);
    expect(document.querySelector('.my-bets-filter-context')).toHaveTextContent('Last 7 days · Oldest first');
    expect(screen.getByRole('searchbox', { name: 'Search bets' })).toHaveValue('Draw');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByText('3 bets found')).toBeInTheDocument();
    expect(document.querySelector('.my-bets-filter-context')).toHaveTextContent('All dates · Oldest first');
  });
});
