import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import axios from 'axios';
import Telemetry from './Telemetry';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

const METRIC_NAMES = [
  'MAIN_PAGE_VISIT',
  'ADMIN_PAGE_VISIT',
  'SLIP_CREATED',
  'BET_PLACED',
  'RESULTING_SETTLED',
  'GAMECENTER_EVENT_EMITTED',
  'USER_CREATED',
  'USER_LOGGED_IN',
];

const METRIC_LABELS = [
  'Main page visits',
  'Backoffice page visits',
  'Slips created',
  'Bets placed',
  'Results settled',
  'Gamecenter events emitted',
  'Users created',
  'User logins',
];

const SERVICES = [
  ['auth', 'Authentication'],
  ['backoffice', 'Backoffice'],
  ['bet', 'Betting'],
  ['client', 'Client'],
  ['event', 'Events'],
  ['gamemaster', 'Game master'],
  ['moderation', 'Moderation'],
  ['resulting', 'Resulting'],
  ['slip', 'Slip'],
  ['telemetry', 'Telemetry'],
];

const DATES = [
  '2026-08-28',
  '2026-08-29',
  '2026-08-30',
  '2026-08-31',
  '2026-09-01',
  '2026-09-02',
  '2026-09-03',
  '2026-09-04',
  '2026-09-05',
  '2026-09-06',
  '2026-09-07',
  '2026-09-08',
  '2026-09-09',
  '2026-09-10',
];

const createSummary = ({
  generatedAt = '2026-09-10T00:15:00.000Z',
  valueFor = () => 0,
  statuses = ['green', 'yellow', 'red'],
} = {}) => ({
  generatedAt,
  dates: [...DATES],
  metrics: METRIC_NAMES.map((metric, metricIndex) => ({
    metric,
    values: DATES.map((date, valueIndex) => valueFor(metricIndex, valueIndex)),
  })),
  health: SERVICES.map(([service], index) => ({
    service,
    status: statuses[index % statuses.length],
  })),
});

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const QueryControl = () => {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/telemetry?ui=v3&theme=light')}>
    Change telemetry query
  </button>;
};

const renderTelemetry = (withQueryControl = false) => render(
  <MemoryRouter initialEntries={['/telemetry?ui=v1&theme=dark']}>
    {withQueryControl ? <QueryControl /> : null}
    <Telemetry />
  </MemoryRouter>
);

describe('Telemetry', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  it('shows the bounded initial loading and sanitized initial error states', async () => {
    const request = createDeferred();
    axios.get.mockReturnValueOnce(request.promise);

    renderTelemetry();

    expect(screen.getByRole('heading', { name: 'Telemetry and service health', level: 1 }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Loading telemetry...');

    await act(async () => {
      request.reject(new Error('private upstream detail'));
    });

    expect(screen.getByRole('alert')).toHaveTextContent('Telemetry is unavailable. Try again.');
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    expect(screen.queryByText(/private upstream detail/)).not.toBeInTheDocument();
  });

  it('renders the complete ordered snapshot without exposing raw inventory values', async () => {
    const summary = createSummary({
      valueFor: (metricIndex, valueIndex) => (metricIndex * 100) + valueIndex,
    });
    axios.get.mockResolvedValueOnce({ data: summary });

    renderTelemetry();

    expect(await screen.findByText(summary.generatedAt)).toBeInTheDocument();
    expect(screen.getByText('Generated at')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Service health', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Daily activity', level: 2 })).toBeInTheDocument();

    const metricHeadings = screen.getAllByRole('heading', { level: 3 });
    expect(metricHeadings.map((heading) => heading.textContent)).toEqual(METRIC_LABELS);

    const healthItems = document.querySelectorAll('.telemetry-health__item');
    expect(healthItems).toHaveLength(10);
    healthItems.forEach((item, index) => {
      expect(item).toHaveTextContent(SERVICES[index][1]);
      expect(item).toHaveTextContent(['Healthy', 'Degraded', 'Unavailable'][index % 3]);
    });

    const cards = document.querySelectorAll('.telemetry-metric');
    expect(cards).toHaveLength(8);
    cards.forEach((card, metricIndex) => {
      const pairs = card.querySelectorAll('.telemetry-metric__pair');
      expect(pairs).toHaveLength(14);
      pairs.forEach((pair, valueIndex) => {
        const values = within(pair);
        expect(values.getByText(DATES[valueIndex])).toBeInTheDocument();
        expect(values.getByText(String((metricIndex * 100) + valueIndex))).toBeInTheDocument();
      });
    });
    expect(document.querySelectorAll('.telemetry-metric__pair')).toHaveLength(112);

    METRIC_NAMES.forEach((metric) => {
      expect(screen.queryByText(metric, { exact: true })).not.toBeInTheDocument();
    });
    SERVICES.forEach(([service]) => {
      expect(screen.queryByText(service, { exact: true })).not.toBeInTheDocument();
    });
    ['green', 'yellow', 'red'].forEach((status) => {
      expect(screen.queryByText(status, { exact: true })).not.toBeInTheDocument();
    });

    const figures = screen.getAllByRole('figure');
    expect(figures).toHaveLength(8);
    document.querySelectorAll('.telemetry-metric__graph').forEach((graph) => {
      expect(graph).toHaveAttribute('aria-hidden', 'true');
      expect(graph).toHaveAttribute('focusable', 'false');
    });
    expect(document.querySelectorAll('.telemetry-metric__bar')).toHaveLength(112);
    document.querySelectorAll('.telemetry-metric__bar').forEach((bar) => {
      expect(bar).not.toHaveAttribute('tabindex');
    });
  });

  it('renders all-zero snapshots with finite graph geometry and 112 visible zero values', async () => {
    axios.get.mockResolvedValueOnce({ data: createSummary() });

    renderTelemetry();
    await screen.findByRole('heading', { name: 'Service health' });

    const values = document.querySelectorAll('.telemetry-metric__value');
    expect(values).toHaveLength(112);
    values.forEach((value) => expect(value).toHaveTextContent('0'));
    document.querySelectorAll('.telemetry-metric__bar').forEach((bar) => {
      for (const attribute of ['x', 'y', 'width', 'height']) {
        expect(Number.isFinite(Number(bar.getAttribute(attribute)))).toBe(true);
      }
    });
  });

  it('fetches once on mount, ignores query-only navigation, and fetches once per Refresh', async () => {
    axios.get.mockResolvedValue({ data: createSummary() });
    renderTelemetry(true);
    await screen.findByRole('heading', { name: 'Service health' });

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenLastCalledWith('/api/telemetry/summary');

    fireEvent.click(screen.getByRole('button', { name: 'Change telemetry query' }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    expect(axios.get).toHaveBeenLastCalledWith('/api/telemetry/summary');
    expect(await screen.findByText('Telemetry refreshed.')).toBeInTheDocument();
  });

  it('retains the prior snapshot, button focus, and bounded status during refresh failure', async () => {
    const initial = createSummary();
    const refresh = createDeferred();
    axios.get
      .mockResolvedValueOnce({ data: initial })
      .mockReturnValueOnce(refresh.promise);
    renderTelemetry();
    await screen.findByText(initial.generatedAt);

    const refreshButton = screen.getByRole('button', { name: 'Refresh' });
    refreshButton.focus();
    fireEvent.click(refreshButton);

    expect(refreshButton).toBeDisabled();
    expect(refreshButton).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Refreshing...');
    expect(screen.getByText(initial.generatedAt)).toBeInTheDocument();
    expect(document.querySelector('.telemetry-page')).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      refresh.reject(new Error('network detail'));
    });

    expect(screen.getByText(initial.generatedAt)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      `Refresh failed. Showing data generated at ${initial.generatedAt}.`
    );
    expect(screen.queryByText(/network detail/)).not.toBeInTheDocument();
    expect(refreshButton).toBeEnabled();
    expect(refreshButton).toHaveFocus();
  });

  it('atomically replaces the prior snapshot after a successful refresh', async () => {
    const initial = createSummary();
    const refreshed = createSummary({
      generatedAt: '2026-09-10T00:20:00.000Z',
      valueFor: () => 9,
    });
    const refresh = createDeferred();
    axios.get
      .mockResolvedValueOnce({ data: initial })
      .mockReturnValueOnce(refresh.promise);
    renderTelemetry();
    await screen.findByText(initial.generatedAt);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await act(async () => {
      refresh.resolve({ data: refreshed });
    });

    expect(screen.queryByText(initial.generatedAt)).not.toBeInTheDocument();
    expect(screen.getByText(refreshed.generatedAt)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Telemetry refreshed.');
    document.querySelectorAll('.telemetry-metric__value')
      .forEach((value) => expect(value).toHaveTextContent('9'));
  });

  it.each([
    ['invalid timestamp', (summary) => ({ ...summary, generatedAt: 'not-a-timestamp' })],
    ['wrong date count', (summary) => ({ ...summary, dates: summary.dates.slice(1) })],
    ['wrong metric order', (summary) => ({
      ...summary,
      metrics: [summary.metrics[1], summary.metrics[0], ...summary.metrics.slice(2)],
    })],
    ['wrong value count', (summary) => ({
      ...summary,
      metrics: [
        { ...summary.metrics[0], values: summary.metrics[0].values.slice(1) },
        ...summary.metrics.slice(1),
      ],
    })],
    ['negative metric value', (summary) => ({
      ...summary,
      metrics: [
        { ...summary.metrics[0], values: [-1, ...summary.metrics[0].values.slice(1)] },
        ...summary.metrics.slice(1),
      ],
    })],
    ['wrong service order', (summary) => ({
      ...summary,
      health: [summary.health[1], summary.health[0], ...summary.health.slice(2)],
    })],
    ['unknown health status', (summary) => ({
      ...summary,
      health: [{ ...summary.health[0], status: 'blue' }, ...summary.health.slice(1)],
    })],
    ['extra contract field', (summary) => ({ ...summary, extra: true })],
  ])('rejects malformed inventory: %s', async (name, mutate) => {
    axios.get.mockResolvedValueOnce({ data: mutate(createSummary()) });
    renderTelemetry();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Telemetry is unavailable. Try again.'
    );
    expect(screen.queryByRole('heading', { name: 'Service health' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Invalid telemetry summary/)).not.toBeInTheDocument();
  });
});
