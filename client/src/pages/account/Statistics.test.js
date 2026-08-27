import React from 'react';
import '@testing-library/jest-dom';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import Statistics from './Statistics';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

describe('Statistics', () => {
  const renderStatistics = async () => {
    await act(async () => {
      render(<Statistics refreshToken={0} uiVariant="v2" />);
    });
  };

  beforeEach(() => {
    axios.get.mockReset();
  });

  it('renders the previous visible user name unchanged and redacts email-like values', async () => {
    axios.get.mockResolvedValue({
      data: [
        {
          userKey: 'safe-user',
          displayName: 'stanislav',
          betCount: 4,
          wagerTotal: 120,
        },
        {
          userKey: 'email-user',
          displayName: 'stan@example.com',
          betCount: 2,
          wagerTotal: 30,
        },
      ],
    });

    await renderStatistics();

    expect(axios.get).toHaveBeenCalledWith('/api/bet/stats/v2');
    const safeRow = (await screen.findByTitle('stanislav')).closest('.stat-row');
    expect(within(safeRow).getByText('stanislav')).toBeInTheDocument();
    expect(within(safeRow).getByText('4')).toBeInTheDocument();
    expect(within(safeRow).getByText('120')).toBeInTheDocument();
    expect(screen.getByText('Anonymous player')).toBeInTheDocument();
    expect(screen.queryByText('stan@example.com')).not.toBeInTheDocument();
  });

  it('renders an empty state when the leaderboard is empty', async () => {
    axios.get.mockResolvedValue({ data: [] });

    await renderStatistics();

    expect(await screen.findByText('No public betting activity yet.')).toBeInTheDocument();
  });

  it('renders an error state when aggregate stats cannot be loaded', async () => {
    axios.get.mockRejectedValue(new Error('network down'));

    await renderStatistics();

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Leaderboard unavailable.'));
  });
});
