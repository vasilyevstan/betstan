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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Local noon on a fixed day. Freezing the clock at midday keeps every fixture
// bet far from local midnight in both directions, so the "today" bucket cannot
// flip while the test runs, and no fixture bet sits on the exact 7-day or
// 30-day cut-off. The date-preset counts asserted below are therefore stable
// regardless of when, or in which timezone, the suite runs.
const FROZEN_CLOCK = new Date(2026, 4, 15, 12, 0, 0, 0);

// Bet index -> age at the frozen clock, strictly increasing so the default
// "Newest first" order matches fixture index order.
const BET_AGE_BY_INDEX = [
  1 * HOUR_MS, //    0  today (11:00)
  2 * HOUR_MS, //    1  today (10:00)
  3 * HOUR_MS, //    2  today (09:00)
  4 * HOUR_MS, //    3  today (08:00)
  5 * HOUR_MS, //    4  today (07:00)          -> TODAY = 5
  18 * HOUR_MS, //   5  yesterday 18:00: inside a rolling 24h window, not today
  30 * HOUR_MS, //   6  within 7 days
  null, //           7  invalid timestamp: excluded from every dated preset
  102 * HOUR_MS, //  8  within 7 days
  126 * HOUR_MS, //  9  within 7 days, 42h clear of the 7-day edge -> 7D = 9
  9 * DAY_MS, //    10  within 30 days, 2d clear of the 7-day edge
  11 * DAY_MS, //   11
  13 * DAY_MS, //   12
  15 * DAY_MS, //   13
  17 * DAY_MS, //   14
  19 * DAY_MS, //   15
  21 * DAY_MS, //   16
  23 * DAY_MS, //   17  7d clear of the 30-day edge                 -> 30D = 17
  35 * DAY_MS, //   18  older than 30 days, 5d clear of the edge
  38 * DAY_MS, //   19
  41 * DAY_MS, //   20
  44 * DAY_MS, //   21
  47 * DAY_MS, //   22
  50 * DAY_MS, //   23
  53 * DAY_MS, //   24                                              -> ALL = 25
];

// Exact expected result counts for the fixture above.
const EXPECTED_DATE_PRESET_COUNTS = [
  ['TODAY', 5],
  ['7D', 9],
  ['30D', 17],
  ['ALL', 25],
];

// Bet-level status -> the exact colour class MyBets must put on `.my-bets-status`.
const EXPECTED_BET_STATUS_CLASS = {
  PENDING: 'text-warning',
  CONFIRMED: 'text-info',
  DECLINED: 'text-danger',
  WIN: 'text-success',
  LOSS: 'text-danger',
  VOID: 'text-secondary',
  UNKNOWN: 'text-success', // default branch
};

const readBetStatusBadges = () =>
  Array.from(document.querySelectorAll('.my-bets-status')).map((element) => ({
    element,
    status: element.textContent,
  }));

const firstSelectionRow = (card) =>
  card.querySelector('.my-bets-row:not(.my-bets-row--header)');

describe('coverage components', () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
    axios.post.mockResolvedValue({});
  });

  afterEach(() => {
    jest.useRealTimers();
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
    jest.useFakeTimers();
    jest.setSystemTime(FROZEN_CLOCK);

    const now = FROZEN_CLOCK.getTime();
    const statuses = ['PENDING', 'CONFIRMED', 'DECLINED', 'WIN', 'LOSS', 'VOID', 'UNKNOWN'];
    const bets = Array.from({ length: 25 }, (_, index) => {
      const status = statuses[index % statuses.length];
      const age = BET_AGE_BY_INDEX[index];
      return {
        ...(index === 6 ? {} : { _id: `bet-${index}` }),
        slipId: `slip-${index}`,
        status,
        wager: index + 1,
        timestamp: age === null ? 'invalid' : new Date(now - age).toISOString(),
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

    // Bet-level status colours are asserted on the status badge itself, never on
    // an unrelated row, slip, or counter element that happens to share a class.
    const statusBadges = readBetStatusBadges();
    expect(statusBadges).toHaveLength(20);
    expect(new Set(statusBadges.map((badge) => badge.status))).toEqual(
      new Set(Object.keys(EXPECTED_BET_STATUS_CLASS)),
    );
    Object.entries(EXPECTED_BET_STATUS_CLASS).forEach(([status, expectedClass]) => {
      const badgesForStatus = statusBadges.filter((badge) => badge.status === status);
      expect(badgesForStatus.length).toBeGreaterThan(0);
      badgesForStatus.forEach(({ element }) => {
        expect(element).toHaveTextContent(status);
        expect(element).toHaveClass('my-bets-status', expectedClass, { exact: true });
      });
    });

    // Row-level settlement colouring is asserted inside the owning selection row.
    const cards = document.querySelectorAll('.my-bets-card');
    expect(cards).toHaveLength(20);
    expect(cards[0]).toHaveTextContent('Needle Match');
    expect(firstSelectionRow(cards[0]).querySelectorAll('.text-success')).toHaveLength(4);
    expect(cards[1]).toHaveTextContent('Event 1');
    expect(firstSelectionRow(cards[1]).querySelectorAll('.text-danger')).toHaveLength(4);
    expect(cards[2]).toHaveTextContent('Event 2');
    expect(
      firstSelectionRow(cards[2]).querySelectorAll('.text-success, .text-danger'),
    ).toHaveLength(0);

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
    const declinedBadges = readBetStatusBadges();
    expect(declinedBadges).toHaveLength(4);
    declinedBadges.forEach(({ element }) => {
      expect(element).toHaveTextContent('DECLINED');
      expect(element).toHaveClass('my-bets-status', 'text-danger', { exact: true });
    });

    fireEvent.click(screen.getByRole('button', { name: 'ALL' }));
    const dateSelect = screen.getByRole('combobox');
    for (const [preset, expectedCount] of EXPECTED_DATE_PRESET_COUNTS) {
      fireEvent.change(dateSelect, { target: { value: preset } });
      expect(await screen.findByText(`${expectedCount} bets found`)).toBeInTheDocument();
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
