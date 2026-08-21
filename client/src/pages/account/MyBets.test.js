import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
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

    render(<MyBets />);

    await screen.findByText('Live Derby');

    expect(screen.getAllByText('Live')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Pre-match')[0]).toBeInTheDocument();
    expect(screen.getAllByText('Next Corner')[0]).toBeInTheDocument();
    expect(screen.getByText('Declined: Quote changed')).toBeInTheDocument();
    expect(screen.getByText('Void · Manual void')).toBeInTheDocument();
    expect(screen.getByText('Pending result')).toBeInTheDocument();
  });
});
