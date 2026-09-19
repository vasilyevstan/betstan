import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import nativeUserEvent from '@testing-library/user-event';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import axios from 'axios';
import Telemetry from './Telemetry';

jest.mock('axios', () => ({
  get: jest.fn(),
}));

// The locked user-event v13 uses a separate DOM-testing-library instance.
// Wrap native interaction sequences in React's act, not just their assertions.
const userEvent = {
  click: (element) => act(() => { nativeUserEvent.click(element); }),
  keyboard: (keys) => act(() => { nativeUserEvent.keyboard(keys); }),
};

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

const DATE_CONTRACT_FAILURES = [
  ['reversed dates', (summary) => ({ ...summary, dates: [...summary.dates].reverse() })],
  ['duplicate dates', (summary) => ({
    ...summary,
    dates: [...summary.dates.slice(0, 13), summary.dates[12]],
  })],
  ['non-consecutive dates', (summary) => ({
    ...summary,
    dates: summary.dates.map((date, index) => (
      index === 6 ? '2026-09-20' : date
    )),
  })],
  ['impossible date', (summary) => ({
    ...summary,
    dates: summary.dates.map((date, index) => (
      index === 6 ? '2026-02-30' : date
    )),
  })],
  ['noncanonical date', (summary) => ({
    ...summary,
    dates: summary.dates.map((date, index) => (
      index === 6 ? '2026-9-03' : date
    )),
  })],
  ['parseable noncanonical generatedAt', (summary) => ({
    ...summary,
    generatedAt: '2026-09-10T00:15:00Z',
  })],
  ['final date differs from generatedAt UTC date', (summary) => ({
    ...summary,
    generatedAt: '2026-09-11T00:15:00.000Z',
  })],
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
    expect(screen.getByText('Overview and service health generated at')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Service health', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Activity', level: 2 })).toBeInTheDocument();

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
      const pairs = card.querySelectorAll('.telemetry-metric__values .telemetry-metric__pair');
      expect(pairs).toHaveLength(14);
      pairs.forEach((pair, valueIndex) => {
        const values = within(pair);
        expect(values.getByText(DATES[valueIndex])).toBeInTheDocument();
        expect(values.getByText(String((metricIndex * 100) + valueIndex))).toBeInTheDocument();
      });
    });
    expect(document.querySelectorAll('.telemetry-metric__values .telemetry-metric__pair')).toHaveLength(112);

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

    const values = document.querySelectorAll('.telemetry-metric__values .telemetry-metric__value');
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
    expect(axios.get).toHaveBeenLastCalledWith('/api/telemetry/summary', {
      timeout: 10000, signal: expect.any(AbortSignal),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Change telemetry query' }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(2));
    expect(axios.get).toHaveBeenLastCalledWith('/api/telemetry/summary', {
      timeout: 10000, signal: expect.any(AbortSignal),
    });
    expect(await screen.findByText('Telemetry refreshed.')).toBeInTheDocument();
  });

  const createHourly = (metric = METRIC_NAMES[0], date = DATES[0], values) => ({
    generatedAt: '2026-09-10T00:20:00.000Z',
    metric,
    date,
    hours: Array.from({ length: 24 }, (_, index) => `${date}T${String(index).padStart(2, '0')}:00:00.000Z`),
    values: values || Array.from({ length: 24 }, (_, index) => index),
  });
  const cardAt = (index = 0) => screen.getByRole('article', { name: METRIC_LABELS[index] });
  const dateButton = (index = 0, dayIndex = 0) => within(cardAt(index)).getByRole('button', {
    name: new RegExp(`${DATES[dayIndex]} UTC`),
  });
  const hourlyPath = (index = 0, dayIndex = 0) => (
    `/api/telemetry/metrics/${METRIC_NAMES[index]}/days/${DATES[dayIndex]}`
  );
  const renderSummary = async () => {
    axios.get.mockResolvedValueOnce({ data: createSummary() });
    const result = renderTelemetry();
    await screen.findByRole('heading', { name: 'Service health' });
    return result;
  };
  const settle = async (request, data) => act(async () => request.resolve({ data }));

  describe('tooltip bucket identity', () => {
    beforeEach(() => {
      // JSDOM has no layout; browser coverage independently measures actual bounds.
      jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
        const [left, top, width, height] = this.classList.contains('telemetry-metric__tooltip')
          ? [0, 0, 200, 60]
          : this.tagName.toLowerCase() === 'rect'
            ? [120, 200, 14, 40]
            : this.tagName.toLowerCase() === 'button'
              ? [100, 350, 120, 44]
              : [20, 40, 400, 650];
        return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
      });
    });
    afterEach(() => jest.restoreAllMocks());

    const expectTooltip = (card, bucket, label, count) => {
      const tooltip = within(card).getByRole('tooltip');
      const isDaily = bucket.length === 10;
      const time = tooltip.querySelector('time');
      const value = tooltip.querySelector('data');
      expect([...tooltip.children].map((element) => element.tagName)).toEqual(isDaily ? ['DATA'] : ['TIME', 'DATA']);
      if (isDaily) {
        expect(time).toBeNull();
        expect(tooltip.textContent).toBe(String(count));
      } else {
        expect(time.textContent).toBe(label);
        expect(time).toHaveAttribute('datetime', bucket);
        expect(card.querySelector('.telemetry-metric__day time')).toHaveTextContent(bucket.slice(0, 10));
      }
      expect(value.textContent).toBe(String(count));
      expect(value).toHaveAttribute('value', String(count));
      expect(tooltip).not.toHaveTextContent(/\d{4}-\d{2}-\d{2}/);
      expect(tooltip).not.toHaveAccessibleName(/\d{4}-\d{2}-\d{2}/);
      expect(tooltip).not.toHaveAccessibleDescription(/\d{4}-\d{2}-\d{2}/);
      expect(tooltip).not.toHaveAttribute('title');
      expect(tooltip.querySelector('[title]')).toBeNull();
      const listTime = [...card.querySelectorAll('.telemetry-metric__values time')]
        .find((element) => element.getAttribute('datetime') === bucket);
      expect(listTime).toHaveTextContent(isDaily ? bucket : label);
      if (isDaily) {
        expect(listTime.closest('button')).toHaveAccessibleName(
          `${card.querySelector('h3').textContent}, ${bucket} UTC, ${count}`,
        );
      }
    };

    it.each(['2026-09-10', '2027-01-10'])(
      'pairs every daily and hourly bucket across the month/year boundary ending %s',
      async (lastDay) => {
        const summary = createSummary({
          generatedAt: `${lastDay}T04:30:00.000Z`,
          valueFor: (metricIndex, index) => index === 13 ? Number.MAX_SAFE_INTEGER : metricIndex * 100 + index,
        });
        summary.dates = Array.from({ length: 14 }, (_, index) => (
          new Date(Date.parse(`${lastDay}T00:00:00.000Z`) - (13 - index) * 86400000).toISOString().slice(0, 10)
        ));
        axios.get.mockResolvedValueOnce({ data: summary });
        renderTelemetry();
        await screen.findByRole('heading', { name: 'Service health' });
        expect(screen.getByText(summary.generatedAt)).toBeInTheDocument();

        for (const metricIndex of [0, 1]) {
          const card = cardAt(metricIndex);
          const bars = card.querySelectorAll('rect');
          const buttons = card.querySelectorAll('.telemetry-metric__values button');
          for (let index = 0; index < 14; index += 1) {
            fireEvent.mouseEnter(bars[index]);
            expectTooltip(card, summary.dates[index], null, summary.metrics[metricIndex].values[index]);
            if (metricIndex === 1) {
              expectTooltip(cardAt(0), summary.dates[13], null, Number.MAX_SAFE_INTEGER);
            }
            fireEvent.mouseLeave(bars[index], { clientX: 0, clientY: 0 });
          }
          for (let index = 0; index < 14; index += 1) {
            act(() => buttons[index].focus());
            expect(buttons[index]).toHaveFocus();
            expectTooltip(card, summary.dates[index], null, summary.metrics[metricIndex].values[index]);
          }
          const listValues = card.querySelectorAll('.telemetry-metric__values data');
          expect(listValues).toHaveLength(14);
          expect([...listValues].map((value) => value.textContent)).toEqual(summary.metrics[metricIndex].values.map(String));
        }

        // Adjacent Aug 31/Sep 1 or Dec 31/Jan 1 selections stay card-local.
        for (const metricIndex of [0, 1]) {
          const day = summary.dates[3 + metricIndex];
          const values = Array.from({ length: 24 }, (_, hour) => hour === 23 ? Number.MAX_SAFE_INTEGER : metricIndex * 100 + hour);
          const detail = {
            ...createHourly(METRIC_NAMES[metricIndex], day, values),
            generatedAt: `${lastDay}T05:45:00.000Z`,
          };
          axios.get.mockResolvedValueOnce({ data: detail });
          userEvent.click(cardAt(metricIndex).querySelectorAll('.telemetry-metric__values button')[3 + metricIndex]);
          await within(cardAt(metricIndex)).findByRole('list', { name: /hourly UTC/ });
          expect(cardAt(metricIndex).querySelector('.telemetry-metric__generated time'))
            .toHaveTextContent(detail.generatedAt);
          if (metricIndex === 1) {
            fireEvent.mouseEnter(cardAt(0).querySelectorAll('rect')[23]);
            expectTooltip(cardAt(0), `${summary.dates[3]}T23:00:00.000Z`, '23:00 UTC', Number.MAX_SAFE_INTEGER);
          }
          const bars = cardAt(metricIndex).querySelectorAll('rect');
          for (let hour = 0; hour < 24; hour += 1) {
            fireEvent.mouseEnter(bars[hour]);
            expectTooltip(cardAt(metricIndex), detail.hours[hour], `${String(hour).padStart(2, '0')}:00 UTC`, values[hour]);
            expect(within(cardAt(metricIndex)).getByRole('tooltip')).not.toHaveTextContent(lastDay);
          }
          const listValues = cardAt(metricIndex).querySelectorAll('.telemetry-metric__values data');
          expect(listValues).toHaveLength(24);
          expect([...listValues].map((value) => value.textContent)).toEqual(values.map(String));
          expect(axios.get).toHaveBeenLastCalledWith(
            `/api/telemetry/metrics/${METRIC_NAMES[metricIndex]}/days/${day}`,
            { timeout: 10000, signal: expect.any(AbortSignal) },
          );
        }
        expect(axios.get).toHaveBeenCalledTimes(3);
      },
    );
  });

  describe('tooltip placement', () => {
    // Fixed measurements exercise the four-candidate policy independently of
    // content height. Browser coverage measures the actual one/two-row layouts.
    const viewportHeight = window.innerHeight;
    afterEach(() => {
      window.innerHeight = viewportHeight;
      jest.restoreAllMocks();
    });

    it.each([
      {
        name: 'clamps a measured tooltip when neither natural position fits',
        card: [12, 822.96875, 744, 398.09375],
        bar: [695.8928833007812, 883.5887451171875, 35.5, 116.84002685546875],
        control: [148.390625, 1145.625, 113.015625, 58.4375],
        headerHeight: 284.5625,
        expectedTop: 830.96875,
      },
      {
        name: 'keeps natural above ahead of natural below and clamps',
        card: [12, 100, 744, 700], bar: [695, 300, 35.5, 100],
        expectedTop: 237.15625,
      },
      {
        name: 'keeps natural below ahead of a valid clamped above',
        card: [12, 100, 744, 700], bar: [695, 150, 35.5, 50],
        expectedTop: 206,
      },
      {
        name: 'rejects a protected-control collision at natural above',
        card: [12, 100, 744, 700], bar: [695, 300, 35.5, 100],
        control: [690, 240, 44, 44],
        expectedTop: 406,
      },
      {
        name: 'uses clamped below when clamped above is control-blocked',
        card: [12, 300, 744, 300], bar: [695, 330, 35.5, 250],
        control: [690, 310, 44, 44],
        expectedTop: 535.15625,
      },
      {
        name: 'stays hidden when the available interval is too short',
        card: [12, 300, 744, 70], bar: [695, 325, 35.5, 25],
        expectedTop: null,
      },
      {
        name: 'stays hidden when every candidate is control-blocked',
        card: [12, 300, 744, 300], bar: [695, 330, 35.5, 250],
        control: [620, 300, 132, 300],
        expectedTop: null,
      },
    ])('$name', async ({ card, bar, control = [148, 1145, 113, 58], headerHeight = 64.59, expectedTop }) => {
      window.innerHeight = 1000;
      jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
        const [left, top, width, height] = this.classList.contains('telemetry-metric__tooltip')
          ? [0, 0, 123.0625, 56.84375]
          : this.classList.contains('telemetry-metric') ? card
            : this.classList.contains('app-navbar') ? [0, 0, 768, headerHeight]
              : this.tagName.toLowerCase() === 'rect' ? bar
                : this.tagName.toLowerCase() === 'button' ? control
                  : [0, 0, 768, 1000];
        return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
      });
      render(<header className="app-navbar" />);
      axios.get.mockResolvedValueOnce({ data: createSummary({ valueFor: (_, index) => index + 1 }) });
      renderTelemetry();
      await screen.findByRole('heading', { name: 'Service health' });
      act(() => dateButton(0, 13).focus());
      fireEvent.mouseEnter(cardAt().querySelectorAll('rect')[13]);

      const tooltip = within(cardAt()).getByRole('tooltip', { hidden: true });
      expect(dateButton(0, 13)).toHaveFocus();
      expect(tooltip.querySelector('time')).toBeNull();
      expect(tooltip.querySelector('data')).toHaveAttribute('value', '14');
      if (expectedTop === null) {
        expect(tooltip).not.toBeVisible();
        expect(tooltip).toHaveStyle({ visibility: 'hidden', left: '0px', top: '0px' });
      } else {
        expect(tooltip).toBeVisible();
        expect(Number.parseFloat(tooltip.style.top)).toBeCloseTo(expectedTop - card[1], 6);
      }
    });
  });

  describe('Telemetry hourly cards', () => {
    beforeEach(() => axios.get.mockReset());

    it('opens all eight metrics independently with exact native identities and 24 UTC pairs', async () => {
      await renderSummary();
      expect(screen.queryByRole('button', { name: 'Back to 14 days' })).not.toBeInTheDocument();
      for (let index = 0; index < METRIC_NAMES.length; index += 1) {
        const values = Array.from({ length: 24 }, (_, hour) => hour === 23 ? Number.MAX_SAFE_INTEGER : 0);
        axios.get.mockResolvedValueOnce({ data: createHourly(METRIC_NAMES[index], DATES[index], values) });
        const button = dateButton(index, index);
        expect(button).toHaveAccessibleName(`${METRIC_LABELS[index]}, ${DATES[index]} UTC, 0`);
        expect(button.parentElement.tagName).toBe('LI');
        expect(button.querySelector('time')).toHaveAttribute('datetime', DATES[index]);
        userEvent.click(button);
        await within(cardAt(index)).findByRole('list', { name: `${METRIC_LABELS[index]} hourly UTC values` });
        expect(axios.get).toHaveBeenLastCalledWith(hourlyPath(index, index), {
          timeout: 10000, signal: expect.any(AbortSignal),
        });
        const pairs = cardAt(index).querySelectorAll('.telemetry-metric__values .telemetry-metric__pair');
        expect(pairs).toHaveLength(24);
        pairs.forEach((pair, hour) => {
          expect(pair.querySelector('time')).toHaveAttribute('datetime', createHourly(METRIC_NAMES[index], DATES[index]).hours[hour]);
          expect(pair.querySelector('data')).toHaveTextContent(String(values[hour]));
          expect(pair.querySelector('button')).toBeNull();
        });
        const bars = cardAt(index).querySelectorAll('rect');
        expect(bars).toHaveLength(24);
        expect(Number(bars[0].getAttribute('width'))).toBeCloseTo(280 / 24 * 0.7);
        expect(bars[0]).toHaveAttribute('height', '2');
        expect(bars[23]).toHaveAttribute('height', '92');
        expect(cardAt(index).querySelector('svg [tabindex]')).toBeNull();
        fireEvent.click(bars[0]);
        expect(axios.get).toHaveBeenCalledTimes(index + 2);
      }
      expect(screen.getAllByRole('button', { name: 'Back to 14 days' })).toHaveLength(8);
      userEvent.click(within(cardAt(3)).getByRole('button', { name: 'Back to 14 days' }));
      expect(cardAt(3).querySelectorAll('rect')).toHaveLength(14);
      expect(cardAt(2).querySelectorAll('rect')).toHaveLength(24);
      expect(axios.get).toHaveBeenCalledTimes(9);
    });

    it.each(['{enter}', ' '])('uses native keyboard %s, focuses Back during load and restores the exact date', async (key) => {
      await renderSummary();
      const request = createDeferred();
      axios.get.mockReturnValueOnce(request.promise);
      const button = dateButton(0, 4);
      act(() => button.focus());
      userEvent.keyboard(key);
      expect(within(cardAt()).getByRole('status')).toHaveTextContent('Loading hourly data');
      const back = within(cardAt()).getByRole('button', { name: 'Back to 14 days' });
      expect(back).toHaveFocus();
      const signal = axios.get.mock.calls[1][1].signal;
      userEvent.click(back);
      expect(signal.aborted).toBe(true);
      expect(dateButton(0, 4)).toHaveFocus();
      await settle(request, createHourly(METRIC_NAMES[0], DATES[4]));
      expect(cardAt().querySelectorAll('rect')).toHaveLength(14);
      expect(axios.get).toHaveBeenCalledTimes(2);
    });

    it('does not force focus from SVG activation or any network completion', async () => {
      await renderSummary();
      const request = createDeferred();
      axios.get.mockReturnValueOnce(request.promise);
      const other = dateButton(1);
      act(() => other.focus());
      fireEvent.click(cardAt().querySelector('rect'));
      expect(other).toHaveFocus();
      await settle(request, createHourly());
      expect(other).toHaveFocus();
    });

    it.each([503, 429, 404, 'timeout'])('shows actionable transient %s errors and Retry focuses Back, not completion', async (status) => {
      await renderSummary();
      axios.get.mockRejectedValueOnce(status === 'timeout'
        ? { code: 'ECONNABORTED' } : { response: { status, data: { error: 'private' } } });
      userEvent.click(dateButton());
      expect(await within(cardAt()).findByRole('alert')).toHaveTextContent('Hourly data is unavailable');
      expect(cardAt().querySelector('rect')).toBeNull();
      expect(screen.queryByText('private')).not.toBeInTheDocument();
      const retry = within(cardAt()).getByRole('button', { name: 'Retry' });
      const request = createDeferred();
      axios.get.mockReturnValueOnce(request.promise);
      act(() => retry.focus());
      userEvent.keyboard('{enter}');
      expect(within(cardAt()).getByRole('button', { name: 'Back to 14 days' })).toHaveFocus();
      const other = dateButton(1);
      act(() => other.focus());
      await settle(request, createHourly());
      expect(other).toHaveFocus();
      expect(cardAt().querySelectorAll('rect')).toHaveLength(24);
      expect(axios.get).toHaveBeenCalledTimes(3);
    });

    it.each([
      ['extra key', (dto) => ({ ...dto, extra: true })],
      ['missing key', ({ generatedAt, ...dto }) => dto],
      ['wrong metric', (dto) => ({ ...dto, metric: METRIC_NAMES[1] })],
      ['wrong day', (dto) => ({ ...dto, date: DATES[1] })],
      ['noncanonical generatedAt', (dto) => ({ ...dto, generatedAt: '2026-09-10T00:20:00Z' })],
      ['invalid generatedAt', (dto) => ({ ...dto, generatedAt: 'bad' })],
      ['23 hours', (dto) => ({ ...dto, hours: dto.hours.slice(1) })],
      ['25 values', (dto) => ({ ...dto, values: [...dto.values, 0] })],
      ['duplicate hour', (dto) => ({ ...dto, hours: dto.hours.map(() => dto.hours[0]) })],
      ['reversed hours', (dto) => ({ ...dto, hours: [...dto.hours].reverse() })],
      ['misaligned hour', (dto) => ({ ...dto, hours: [dto.hours[0].replace(':00:00.', ':01:00.'), ...dto.hours.slice(1)] })],
      ['noncanonical hour', (dto) => ({ ...dto, hours: [dto.hours[0].replace('.000Z', 'Z'), ...dto.hours.slice(1)] })],
      ['wrong hour day', (dto) => ({ ...dto, hours: createHourly(METRIC_NAMES[0], DATES[1]).hours })],
      ...[-1, 0.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map((value) => [
        `invalid count ${value}`, (dto) => ({ ...dto, values: [value, ...dto.values.slice(1)] }),
      ]),
    ])('rejects malformed hourly DTO: %s without fabricated zeros', async (name, mutate) => {
      await renderSummary();
      axios.get.mockResolvedValueOnce({ data: mutate(createHourly()) });
      userEvent.click(dateButton());
      expect(await within(cardAt()).findByRole('alert')).toHaveTextContent('Hourly data is unavailable');
      expect(within(cardAt()).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
      expect(cardAt().querySelectorAll('rect')).toHaveLength(0);
      expect(cardAt(1).querySelectorAll('rect')).toHaveLength(14);
    });

    it('retains a stale first-open selection on 400, offers Back but never a futile Retry', async () => {
      await renderSummary();
      axios.get.mockRejectedValueOnce({ response: { status: 400 } });
      userEvent.click(dateButton());
      expect(await within(cardAt()).findByRole('alert')).toHaveTextContent('no longer available');
      expect(within(cardAt()).getByText(DATES[0])).toBeInTheDocument();
      expect(within(cardAt()).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      expect(within(cardAt()).getByRole('button', { name: 'Back to 14 days' })).toBeInTheDocument();
    });

    it.each(['resolve', 'reject'])('ignores stale %s and finally while a newer operation is loading', async (settlement) => {
      await renderSummary();
      const old = createDeferred();
      const current = createDeferred();
      axios.get.mockReturnValueOnce(old.promise);
      userEvent.click(dateButton());
      axios.get.mockResolvedValueOnce({ data: createSummary() }).mockReturnValueOnce(current.promise);
      userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(axios.get.mock.calls[1][1].signal.aborted).toBe(true);
      await act(async () => {
        if (settlement === 'resolve') old.resolve({ data: createHourly() });
        else old.reject({ response: { status: 400 } });
      });
      expect(within(cardAt()).getByRole('status')).toHaveTextContent('Loading hourly data');
      expect(within(cardAt()).queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
      await settle(current, createHourly(METRIC_NAMES[0], DATES[0], Array(24).fill(7)));
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
      expect(cardAt().querySelector('.telemetry-metric__values data')).toHaveTextContent('7');
    });

    it('Refresh fixes batch membership, includes initial loads, retains independent last-good data and reports partial failure', async () => {
      await renderSummary();
      axios.get.mockResolvedValueOnce({ data: createHourly() });
      userEvent.click(dateButton());
      await within(cardAt()).findByRole('list', { name: /hourly UTC/ });
      const initialOther = createDeferred();
      axios.get.mockReturnValueOnce(initialOther.promise);
      userEvent.click(dateButton(1, 1));
      const overview = createDeferred();
      const first = createDeferred();
      const second = createDeferred();
      axios.get.mockReturnValueOnce(overview.promise)
        .mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
      userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(cardAt().querySelectorAll('rect')).toHaveLength(24);
      expect(axios.get.mock.calls.map(([path]) => path)).toEqual([
        '/api/telemetry/summary', hourlyPath(), hourlyPath(1, 1),
        '/api/telemetry/summary', hourlyPath(), hourlyPath(1, 1),
      ]);
      const later = createDeferred();
      axios.get.mockReturnValueOnce(later.promise);
      userEvent.click(dateButton(2, 2));
      const laterBack = within(cardAt(2)).getByRole('button', { name: 'Back to 14 days' });
      expect(laterBack).toHaveFocus();
      await settle(overview, createSummary({ valueFor: () => 9 }));
      await settle(second, createHourly(METRIC_NAMES[1], DATES[1]));
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
      await act(async () => first.reject({ response: { status: 503 } }));
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
      expect(screen.getByText(/Refresh failed for some telemetry data/)).toBeInTheDocument();
      expect(within(cardAt()).getByRole('alert')).toHaveTextContent('last accepted hourly snapshot');
      expect(cardAt().querySelectorAll('rect')).toHaveLength(24);
      expect(cardAt(1).querySelectorAll('rect')).toHaveLength(24);
      expect(within(cardAt(2)).getByRole('status')).toHaveTextContent('Loading hourly data');
      expect(laterBack).toHaveFocus();
      expect(cardAt(3).querySelector('.telemetry-metric__values data')).toHaveTextContent('9');
      await act(async () => initialOther.reject(new Error('old')));
      await settle(later, createHourly(METRIC_NAMES[2], DATES[2]));
      expect(laterBack).toHaveFocus();
    });

    it('refreshes expired selections, retains their last-good detail, and Back uses heading if the date rolled off', async () => {
      await renderSummary();
      axios.get.mockResolvedValueOnce({ data: createHourly() });
      userEvent.click(dateButton());
      await within(cardAt()).findByRole('list', { name: /hourly UTC/ });
      const advanced = {
        ...createSummary({ generatedAt: '2026-09-11T00:01:00.000Z' }),
        dates: [...DATES.slice(1), '2026-09-11'],
      };
      axios.get.mockResolvedValueOnce({ data: advanced })
        .mockRejectedValueOnce({ response: { status: 400 } });
      userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      expect(await within(cardAt()).findByRole('alert')).toHaveTextContent('no longer available');
      expect(cardAt().querySelectorAll('rect')).toHaveLength(24);
      expect(within(cardAt()).getByText(createHourly().generatedAt)).toBeInTheDocument();
      expect(within(cardAt()).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
      axios.get.mockResolvedValueOnce({ data: advanced })
        .mockRejectedValueOnce({ response: { status: 400 } });
      userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
      expect(axios.get.mock.calls.filter(([path]) => path === hourlyPath())).toHaveLength(3);
      userEvent.click(within(cardAt()).getByRole('button', { name: 'Back to 14 days' }));
      expect(within(cardAt()).getByRole('heading')).toHaveFocus();
      expect(cardAt().querySelectorAll('rect')).toHaveLength(14);
    });

    it.each(['before', 'after'])(
      'retains today when hourly success settles %s a valid pre-midnight cached overview',
      async (order) => {
        await renderSummary();
        const day = DATES[13];
        axios.get.mockResolvedValueOnce({ data: {
          ...createHourly(METRIC_NAMES[0], day),
          generatedAt: '2026-09-10T00:16:00.000Z',
        } });
        userEvent.click(dateButton(0, 13));
        await within(cardAt()).findByRole('list', { name: /hourly UTC/ });

        const overview = createDeferred();
        const hourly = createDeferred();
        axios.get.mockReturnValueOnce(overview.promise).mockReturnValueOnce(hourly.promise);
        userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        expect(axios.get).toHaveBeenLastCalledWith(hourlyPath(0, 13), {
          timeout: 10000, signal: expect.any(AbortSignal),
        });
        const hourlySignal = axios.get.mock.calls[3][1].signal;
        const olderOverview = {
          ...createSummary({ generatedAt: '2026-09-09T23:59:59.000Z' }),
          dates: ['2026-08-27', ...DATES.slice(0, -1)],
        };
        const refreshedDetail = createHourly(METRIC_NAMES[0], day, Array(24).fill(7));
        if (order === 'before') await settle(hourly, refreshedDetail);
        expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
        await settle(overview, olderOverview);

        expect(screen.getByText(olderOverview.generatedAt)).toBeInTheDocument();
        expect(hourlySignal.aborted).toBe(false);
        expect(within(cardAt()).queryByRole('alert')).not.toBeInTheDocument();
        if (order === 'after') {
          expect(within(cardAt()).getByRole('status')).toHaveTextContent('Refreshing hourly data');
          expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
          await settle(hourly, refreshedDetail);
        }

        expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
        expect(screen.getByText('Telemetry refreshed.')).toBeInTheDocument();
        expect(within(cardAt()).getByText(day)).toBeInTheDocument();
        expect(within(cardAt()).getByText(refreshedDetail.generatedAt)).toBeInTheDocument();
        expect(within(cardAt()).getByRole('button', { name: 'Back to 14 days' })).toBeInTheDocument();
        expect(within(cardAt()).queryByRole('alert')).not.toBeInTheDocument();
        expect(cardAt().querySelectorAll('rect')).toHaveLength(24);
        cardAt().querySelectorAll('.telemetry-metric__values data').forEach((value) => expect(value).toHaveTextContent('7'));
        expect(cardAt(1).querySelectorAll('rect')).toHaveLength(14);
        expect(axios.get).toHaveBeenCalledTimes(4);
      },
    );

    it('Back cancellation is neutral in Refresh and an old finally cannot clear a reopened request', async () => {
      await renderSummary();
      axios.get.mockResolvedValueOnce({ data: createHourly() });
      userEvent.click(dateButton());
      await within(cardAt()).findByRole('list', { name: /hourly UTC/ });
      const cancelled = createDeferred();
      axios.get.mockResolvedValueOnce({ data: createSummary() }).mockReturnValueOnce(cancelled.promise);
      userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      userEvent.click(within(cardAt()).getByRole('button', { name: 'Back to 14 days' }));
      const reopened = createDeferred();
      axios.get.mockReturnValueOnce(reopened.promise);
      userEvent.click(dateButton(0, 2));
      await act(async () => cancelled.reject(new Error('cancelled')));
      expect(screen.getByText('Telemetry refreshed.')).toBeInTheDocument();
      expect(within(cardAt()).getByRole('status')).toHaveTextContent('Loading hourly');
      await settle(reopened, createHourly(METRIC_NAMES[0], DATES[2]));
      expect(cardAt().querySelectorAll('rect')).toHaveLength(24);
    });

    it('aborts overview and every selected detail on unmount; late handlers are inert', async () => {
      const { unmount } = await renderSummary();
      const first = createDeferred();
      const second = createDeferred();
      const summary = createDeferred();
      axios.get.mockReturnValueOnce(first.promise);
      userEvent.click(dateButton());
      axios.get.mockReturnValueOnce(summary.promise).mockReturnValueOnce(second.promise);
      userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
      unmount();
      axios.get.mock.calls.slice(1).forEach(([, options]) => expect(options.signal.aborted).toBe(true));
      await settle(first, createHourly());
      await settle(summary, createSummary());
      await act(async () => second.reject(new Error('late failure')));
      expect(screen.queryByRole('article')).not.toBeInTheDocument();
    });

    it('uses response UTC context for today, preserves daily zero stub geometry and has no automatic retries', async () => {
      await renderSummary();
      const bar = cardAt().querySelector('rect');
      expect(bar).toHaveAttribute('x', '3');
      expect(bar).toHaveAttribute('width', '14');
      expect(bar).toHaveAttribute('height', '2');
      axios.get.mockResolvedValueOnce({ data: createHourly(METRIC_NAMES[0], DATES[13], Array(24).fill(0)) });
      userEvent.click(dateButton(0, 13));
      expect(await within(cardAt()).findByText(/In progress/)).toHaveTextContent('2026-09-10 · UTC · In progress');
      await within(cardAt()).findByRole('list', { name: /hourly UTC/ });
      expect(axios.get).toHaveBeenCalledTimes(2);
      expect(cardAt().querySelectorAll('.telemetry-metric__values data')).toHaveLength(24);
    });

    it('does not call an old overview day in progress after the hourly server snapshot crosses midnight', async () => {
      await renderSummary();
      axios.get.mockResolvedValueOnce({ data: {
        ...createHourly(METRIC_NAMES[0], DATES[13]),
        generatedAt: '2026-09-11T00:01:00.000Z',
      } });
      userEvent.click(dateButton(0, 13));
      await within(cardAt()).findByRole('list', { name: /hourly UTC/ });
      expect(within(cardAt()).queryByText(/In progress/)).not.toBeInTheDocument();
      expect(within(cardAt()).getByText('2026-09-11T00:01:00.000Z')).toBeInTheDocument();
    });
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
    document.querySelectorAll('.telemetry-metric__values .telemetry-metric__value')
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

  it.each(DATE_CONTRACT_FAILURES)(
    'rejects malformed date inventory initially: %s',
    async (name, mutate) => {
      axios.get.mockResolvedValueOnce({ data: mutate(createSummary()) });
      renderTelemetry();

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Telemetry is unavailable. Try again.'
      );
      expect(screen.queryByRole('heading', { name: 'Service health' }))
        .not.toBeInTheDocument();
    },
  );

  it.each(DATE_CONTRACT_FAILURES)(
    'retains the prior snapshot after malformed refresh dates: %s',
    async (name, mutate) => {
      const initial = createSummary();
      axios.get
        .mockResolvedValueOnce({ data: initial })
        .mockResolvedValueOnce({ data: mutate(createSummary()) });
      renderTelemetry();
      await screen.findByText(initial.generatedAt);

      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        `Refresh failed. Showing data generated at ${initial.generatedAt}.`
      );
      expect(screen.getByText(initial.generatedAt)).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Service health' })).toBeInTheDocument();
      expect(document.querySelectorAll('.telemetry-metric__values .telemetry-metric__pair')).toHaveLength(112);
    },
  );
});
