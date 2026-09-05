import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import App from './App';
import MyBets from './pages/account/MyBets';
import MyWallet from './pages/account/MyWallet';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('./Header', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'div',
    { 'data-testid': 'header' },
    `${props.currentUser?.role ?? 'guest'}:${props.uiVariant}:${props.theme}`,
  );
});

jest.mock('./pages/event/EventList', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'div',
    { 'data-testid': 'event-list' },
    ReactModule.createElement(
      'span',
      null,
      `${props.uiVariant}:${[...props.visibleOfflineEventIds].join(',')}:${props.selectedSelectionKeys.size}:${props.isScopedAccessResolved}`,
    ),
    ReactModule.createElement(
      'button',
      { type: 'button', onClick: props.onSelectionPlaced },
      'select-event',
    ),
    ReactModule.createElement(
      'button',
      { type: 'button', onClick: props.onScopedAccessFailure },
      'refresh-auth',
    ),
  );
});

jest.mock('./pages/Slip', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'div',
    { 'data-testid': 'slip' },
    ReactModule.createElement(
      'span',
      null,
      `${props.refreshSignal}:${props.uiVariant}:${props.currentUser?.role ?? 'guest'}`,
    ),
    ReactModule.createElement(
      'button',
      {
        type: 'button',
        onClick: () => props.onSelectionKeysChange(new Set(['selection'])),
      },
      'set-selection',
    ),
    ReactModule.createElement(
      'button',
      { type: 'button', onClick: props.onBoardSubmitted },
      'submit-board',
    ),
  );
});

jest.mock('./pages/account/Statistics', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'div',
    { 'data-testid': 'statistics' },
    `${props.refreshToken}:${props.uiVariant}`,
  );
});

jest.mock('./pages/account/Backoffice', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'button',
    { type: 'button', onClick: props.onChanged },
    `backoffice-${props.refreshToken}`,
  );
});

jest.mock('./pages/auth/NewUser', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'button',
    { type: 'button', onClick: props.callback },
    'signup',
  );
});

jest.mock('./pages/auth/LogIn', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'button',
    { type: 'button', onClick: props.callback },
    'login',
  );
});

jest.mock('./pages/auth/LogOut', () => {
  const ReactModule = require('react');
  return (props) => ReactModule.createElement(
    'button',
    { type: 'button', onClick: props.callback },
    'logout',
  );
});

describe('coverage components', () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
    axios.post.mockResolvedValue({});
  });

  it('drives App defaults, accepted parameters, scoped IDs, and refresh callbacks', async () => {
    const validId = '0123456789abcdef01234567';
    axios.get.mockResolvedValue({ data: { currentUser: { role: 'ADMIN' } } });

    render(
      <MemoryRouter initialEntries={[`/?ui=v3&theme=light&acceptanceEventIds=${validId},bad`]}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('header')).toHaveTextContent('ADMIN:v3:light');
    });
    expect(document.documentElement).toHaveAttribute('data-bs-theme', 'light');
    expect(screen.getByTestId('event-list')).toHaveTextContent(`${validId}:0:true`);

    fireEvent.click(screen.getByRole('button', { name: 'select-event' }));
    expect(screen.getByTestId('slip')).toHaveTextContent('1:v3:ADMIN');

    fireEvent.click(screen.getByRole('button', { name: 'set-selection' }));
    expect(screen.getByTestId('event-list')).toHaveTextContent(`${validId}:1:true`);

    fireEvent.click(screen.getByRole('button', { name: 'submit-board' }));
    expect(screen.getByTestId('statistics')).toHaveTextContent('1:v3');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'refresh-auth' }));
    });
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
  });

  it('falls back to default UI settings and recovers from auth failure', async () => {
    axios.get.mockRejectedValue(new Error('offline'));

    render(
      <MemoryRouter initialEntries={['/unknown?ui=unsafe&theme=unsafe']}>
        <App />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('event-list')).toHaveTextContent('v1::0:true'),
    );
    expect(screen.getByTestId('header')).toHaveTextContent('guest:v1:dark');
    expect(document.documentElement).toHaveAttribute('data-bs-theme', 'dark');
  });

  it('refreshes Backoffice state through the routed callback', async () => {
    axios.get.mockResolvedValue({ data: { currentUser: null } });

    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/backoffice']}>
          <App />
        </MemoryRouter>,
      );
    });

    const button = await screen.findByRole('button', { name: 'backoffice-0' });
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'backoffice-1' })).toBeInTheDocument();
  });

  it('renders the wallet placeholder', () => {
    render(<MyWallet />);
    expect(screen.getByRole('heading', { name: 'My bets' })).toBeInTheDocument();
  });

  it('covers My Bets filters, sorting, pagination, status colors, and row fallbacks', async () => {
    const now = Date.now();
    const statuses = ['PENDING', 'CONFIRMED', 'DECLINED', 'WIN', 'LOSS', 'VOID', 'UNKNOWN'];
    const bets = Array.from({ length: 25 }, (_, index) => {
      const status = statuses[index % statuses.length];
      return {
        ...(index === 6 ? {} : { _id: `bet-${index}` }),
        slipId: `slip-${index}`,
        status,
        wager: index + 1,
        timestamp:
          index === 7
            ? 'invalid'
            : new Date(now - index * 3 * 24 * 60 * 60 * 1000).toISOString(),
        betKind: index % 2 === 0 ? 'LIVE' : 'PRE_MATCH',
        ...(status === 'DECLINED' ? { declineReason: 'STALE_QUOTE' } : {}),
        rows:
          index === 8
            ? undefined
            : Array.from({ length: index === 0 ? 5 : 1 }, (_, rowIndex) => ({
                ...(rowIndex === 0 && index === 6
                  ? { id: `row-${index}-${rowIndex}` }
                  : { _id: `row-${index}-${rowIndex}` }),
                eventName: index === 0 ? 'Needle Match' : `Event ${index}`,
                ...(rowIndex % 2 === 0
                  ? { eventTime: new Date(now).toISOString() }
                  : { timestamp: 'invalid' }),
                oddsName: 'HOME',
                ...(rowIndex === 1 ? {} : { oddsValue: 2 }),
                productName: index % 2 === 0 ? '' : '1X2',
                marketType: index % 2 === 0 ? 'NEXT_CORNER' : undefined,
                side: 'HOME',
                betKind: index % 2 === 0 ? 'LIVE' : undefined,
                status:
                  rowIndex === 0
                    ? index % 3 === 0
                      ? 'WIN'
                      : index % 3 === 1
                        ? 'LOSS'
                        : 'NOT_SETTLED'
                    : 'NOT_SETTLED',
                ...(rowIndex === 2
                  ? { winningSelection: 'AWAY' }
                  : {}),
                ...(rowIndex === 3
                  ? { declineReason: 'MARKET_SUSPENDED' }
                  : {}),
              })),
      };
    });
    axios.get.mockResolvedValue({ data: bets });

    render(<MyBets />);

    await screen.findByText('25 bets found');
    expect(screen.getByRole('button', { name: 'Load more' })).toBeInTheDocument();
    expect(document.querySelector('.text-warning')).not.toBeNull();
    expect(document.querySelector('.text-info')).not.toBeNull();
    expect(document.querySelector('.text-danger')).not.toBeNull();
    expect(document.querySelector('.text-success')).not.toBeNull();
    expect(document.querySelector('.text-secondary')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all selections (5)' }));
    expect(screen.getByRole('button', { name: 'Show less selections' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show less selections' }));

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();

    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: 'needle match' },
    });
    expect(await screen.findByText('1 bets found')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'DECLINED' }));
    expect(await screen.findByText(/bets found/)).toHaveTextContent('4 bets found');

    fireEvent.click(screen.getByRole('button', { name: 'ALL' }));
    const dateSelect = screen.getByRole('combobox');
    for (const preset of ['TODAY', '7D', '30D']) {
      fireEvent.change(dateSelect, { target: { value: preset } });
      await waitFor(() => {
        expect(screen.getByText(/bets found/)).toBeInTheDocument();
      });
    }

    fireEvent.click(screen.getByRole('button', { name: 'Newest first' }));
    expect(screen.getByRole('button', { name: 'Oldest first' })).toBeInTheDocument();
  });

  it('keeps My Bets empty when the response is malformed or unavailable', async () => {
    axios.get.mockResolvedValueOnce({ data: null });
    const first = render(<MyBets />);
    expect(
      await screen.findByText('No bets match the active filters.'),
    ).toBeInTheDocument();
    first.unmount();

    axios.get.mockRejectedValueOnce(new Error('offline'));
    render(<MyBets />);
    expect(
      await screen.findByText('No bets match the active filters.'),
    ).toBeInTheDocument();
  });
});
