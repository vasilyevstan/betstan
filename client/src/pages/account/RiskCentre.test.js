import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import axios from 'axios';
import RiskCentre, { describeChanges } from './RiskCentre';

jest.mock('axios', () => ({ get: jest.fn(), request: jest.fn() }));
const API = '/api/backoffice/risk-centre';
const rule = { id: 'default:MAX_STAKE', type: 'MAX_STAKE', enabled: false, scope: {}, parameters: { limit: 10000 } };
const snapshot = (revision = 1) => ({
  revision, defaultsVersion: 1, rules: [{ ...rule, parameters: { ...rule.parameters } }],
  builtinMarkets: [
    { id: 'PRE_MATCH:1X2', name: '1X2', betKind: 'PRE_MATCH' },
    { id: 'PRE_MATCH:CS', name: 'Correct Score', betKind: 'PRE_MATCH' },
    { id: 'LIVE:NEXT_CORNER', name: 'Next corner (live)', betKind: 'LIVE' },
  ],
  catalogue: [{
    type: 'MAX_STAKE', label: 'Maximum stake', description: 'Whole ticket limit.', category: 'admission',
    defaultParameters: { limit: 10000 }, defaultEnabled: false, defaultScope: {}, locked: false,
    parameterDefinitions: [{ name: 'limit', label: 'Limit', type: 'number', min: 0, max: 1000000, unit: 'minor units' }],
  }, {
    type: 'QUOTE_AUTHORITY', label: 'Quote authority', description: 'Original consent.', category: 'integrity',
    defaultParameters: {}, defaultEnabled: true, defaultScope: {}, parameterDefinitions: [], locked: true,
  }],
  readiness: { transactions: 'READY', accounting: { ready: false }, capabilities: { extensibleMarkets: false } },
});

it('groups rules by category with explicit status tags and readable activity settings', async () => {
  const data = activitySnapshot('MAX_SUBMISSIONS', { tracking: false, readyWindows: [], readyCooldownMs: 0 });
  data.catalogue[0].parameterDefinitions[0].unit = 'count';
  data.rules[0].parameters.perCustomer = false;
  axios.get.mockResolvedValue({ data });
  mount();
  const entry = await screen.findByRole('button', { name: /Bet frequency OFF All bets/ });
  expect(entry.closest('section')).toHaveAccessibleName('Betting activity');
  expect(entry.querySelector('.market-pill--danger')).toHaveTextContent('OFF');
  expect(entry).toHaveTextContent('10000 bets · Calendar day (UTC) · Across all customers');
  expect(entry).not.toHaveTextContent(/UTC_DAY|false/);
  expect(entry.closest('section').parentElement.closest('section')).toHaveAccessibleName('All events');
  expect(screen.queryByRole('button', { name: /Quote authority/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/Locked safeguard|Always-on safeguards/)).not.toBeInTheDocument();
});
const accountingSnapshot = (type, accounting) => {
  const data = snapshot();
  data.readiness.accounting = accounting;
  data.rules[0] = { ...data.rules[0], id: `default:${type}`, type };
  data.catalogue[0] = { ...data.catalogue[0], type, category: 'accounting' };
  if (type === 'MAX_CUSTOMER_LOSS') {
    data.rules[0].parameters.window = 'UTC_DAY';
    data.catalogue[0].defaultParameters = { limit: 10000, window: 'UTC_DAY' };
    data.catalogue[0].parameterDefinitions.push({
      name: 'window', label: 'Window', type: 'select', required: true,
      options: ['UTC_DAY', 'UTC_WEEK', 'ROLLING_24H'],
    });
  }
  return data;
};
const activitySnapshot = (type, activity) => {
  const data = snapshot();
  data.readiness.accounting.ready = true;
  if (activity !== undefined) data.readiness.activity = activity;
  data.rules[0] = { ...data.rules[0], id: `default:${type}`, type };
  data.catalogue[0] = { ...data.catalogue[0], type, category: 'activity' };
  if (type === 'REPEAT_BET_COOLDOWN_MS') {
    data.rules[0].parameters.limit = 0;
    data.catalogue[0].defaultParameters = { limit: 0 };
    data.catalogue[0].parameterDefinitions[0].unit = 'milliseconds';
  } else {
    data.rules[0].parameters.window = 'UTC_DAY';
    data.catalogue[0].defaultParameters = { limit: 10000, window: 'UTC_DAY' };
    data.catalogue[0].parameterDefinitions.push({
      name: 'window', label: 'Window', type: 'select', required: true, options: ['UTC_DAY', 'UTC_WEEK'],
    });
  }
  return data;
};
const mount = () => render(<MemoryRouter><RiskCentre /></MemoryRouter>);
const openTab = async name => fireEvent.click(await screen.findByRole('tab', { name, exact: true }));
const selectRule = async () => fireEvent.click(await screen.findByRole('button', { name: /OFF All bets/ }));
const editLimit = value => fireEvent.change(screen.getByLabelText('Limit (Stanbucks)'), { target: { value: value === '' ? '' : String(Number(value) / 100) } });
const result = config => ({
  data: { requestId: config.data.requestId, revision: config.data.expectedRevision + 1, defaultsVersion: 1,
    rules: config.data.rule ? [config.data.rule] : [rule], occurredAt: '2026-11-14T21:00:00.000Z' },
});
beforeEach(() => {
  axios.get.mockReset().mockResolvedValue({ data: snapshot() });
  axios.request.mockReset().mockImplementation(async config => result(config));
  Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: jest.fn(() => 'test-uuid') } });
});

describe('event stress and choice switches', () => {
  const choiceId = 'a'.repeat(64);
  const mount = () => render(<MemoryRouter><RiskCentre eventAnalysis /></MemoryRouter>);
  const fixture = () => {
    const policy = snapshot();
    policy.readiness.capabilities.selectionBlocking = true;
    policy.readiness.accounting = { ready: false, openPositionsReady: true, readyLossWindows: [] };
    policy.catalogue.push({
      type: 'DENY', label: 'Block bets', description: 'Block matching bets.', category: 'admission',
      defaultParameters: {}, defaultEnabled: false, defaultScope: {}, locked: false, parameterDefinitions: [],
    });
    const event = { eventId: 'event-a', name: 'Open event', time: '2099-01-01T12:00:00.000Z', phase: 'PRE_MATCH' };
    const metrics = { exposureMinor: '12345', openTickets: 2, pendingTickets: 1 };
    const report = { asOf: '2026-11-14T21:00:00.000Z', policyRevision: 1, analysis: { ready: true, code: 'READY' } };
    const state = {
      policy, operation: null,
      list: { ...report, events: [{ ...event, metrics }], nextAfter: null },
      detail: { ...report, event, metrics, stakeMinor: 100, choices: [{
        id: choiceId, origin: 'TEMPLATE', marketId: 'award', marketName: 'Match award', label: 'Nominee A',
        odds: 3, betKind: 'PRE_MATCH', sourceOpen: true, off: false, switchConflict: false,
        singleBlockedByOtherRule: false, stressReturnMinor: '300', headroomMinor: '250',
        advice: 'LOWER_ODDS', suggestedOdds: 2.5,
      }] },
    };
    const response = data => ({ data: JSON.parse(JSON.stringify(data)) });
    axios.get.mockImplementation(async url => {
      if (url === API) return response(state.policy);
      if (url === `${API}/events`) return response(state.list);
      if (url.startsWith(`${API}/events/event-a?`)) return response({
        ...state.detail, stakeMinor: Number(new URL(url, 'http://test').searchParams.get('stakeMinor')),
      });
      if (url.startsWith(`${API}/operations/`)) return response(state.operation);
      return response(state.policy);
    });
    return state;
  };
  const review = async () => {
    fireEvent.click(await screen.findByRole('button', { name: 'Review risk for Open event' }));
    await screen.findByLabelText('Test stake (Stanbucks)');
  };

  it('keeps global rules in Risk Centre without an event tab or background analysis reads', async () => {
    fixture();
    render(<MemoryRouter><RiskCentre /></MemoryRouter>);
    await selectRule(); editLimit('2000');
    expect(axios.get.mock.calls.some(([url]) => url.startsWith(`${API}/events`))).toBe(false);
    expect(screen.queryByRole('tab', { name: 'Events' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(20);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('loads open-event analysis without global switch endpoints or a global rule editor', async () => {
    fixture(); mount(); await review();
    expect(screen.getByRole('heading', { level: 1, name: 'Black swan analysis' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Risk Centre rules' })).toHaveAttribute('href', '/backoffice/risk-centre');
    expect(screen.queryByRole('heading', { name: 'All-events switches' })).not.toBeInTheDocument();
    expect(axios.get.mock.calls.every(([url]) => url === API || url.startsWith(`${API}/events`))).toBe(true);
  });

  it('opens the selected event directly without fetching another event catalogue and preserves the view query', async () => {
    fixture();
    render(<MemoryRouter initialEntries={['/backoffice/events/event-a/analysis?ui=v3&theme=light']}>
      <Routes><Route path="/backoffice/events/:eventId/analysis" element={<RiskCentre eventAnalysis />} /></Routes>
    </MemoryRouter>);
    expect(await screen.findByRole('heading', { level: 2, name: 'Open event' })).toBeVisible();
    expect(screen.getByText('Lower odds to 2.50 or less')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Event markets' }))
      .toHaveAttribute('href', '/backoffice/events/event-a/markets?ui=v3&theme=light');
    expect(axios.get.mock.calls.some(([url]) => url === `${API}/events`)).toBe(false);
    await act(async () => { fireEvent.click(screen.getByRole('switch')); });
    await waitFor(() => expect(axios.request).toHaveBeenCalledTimes(1));
    expect(axios.request.mock.calls[0][0].data.rule.scope).toEqual({
      betKind: 'PRE_MATCH', eventIds: ['event-a'], selectionIds: [choiceId],
    });
  });

  it('ignores an old event response after direct navigation and switches only the current event choice', async () => {
    const state = fixture();
    let finishOldRead;
    const oldRead = new Promise(resolve => { finishOldRead = resolve; });
    const next = { ...state.detail, event: { ...state.detail.event, eventId: 'event-b', name: 'Second event' },
      choices: [{ ...state.detail.choices[0], id: 'b'.repeat(64), label: 'Nominee B' }] };
    axios.get.mockImplementation(async url => {
      if (url === API) return { data: state.policy };
      if (url.startsWith(`${API}/events/event-a?`)) return oldRead;
      if (url.startsWith(`${API}/events/event-b?`)) return { data: next };
      throw new Error(`Unexpected request: ${url}`);
    });
    const Navigate = () => {
      const navigate = useNavigate();
      return <button onClick={() => navigate('/backoffice/events/event-b/analysis')}>Next event</button>;
    };
    render(<MemoryRouter initialEntries={['/backoffice/events/event-a/analysis']}>
      <Navigate /><Routes><Route path="/backoffice/events/:eventId/analysis" element={<RiskCentre eventAnalysis />} /></Routes>
    </MemoryRouter>);
    await screen.findByText('Calculating event stress...');
    fireEvent.click(screen.getByRole('button', { name: 'Next event' }));
    await screen.findByRole('heading', { level: 2, name: 'Second event' });
    await act(async () => { finishOldRead({ data: state.detail }); });
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Open event' })).not.toBeInTheDocument());
    await act(async () => { fireEvent.click(screen.getByRole('switch', { name: 'Allow Nominee B in Match award for Second event' })); });
    await waitFor(() => expect(axios.request).toHaveBeenCalledTimes(1));
    expect(axios.request.mock.calls[0][0].data.rule.scope).toEqual({
      betKind: 'PRE_MATCH', eventIds: ['event-b'], selectionIds: ['b'.repeat(64)],
    });
  });

  it('shows precise large loss bounds and sends only valid minor-unit stress stakes', async () => {
    const state = fixture();
    state.detail.metrics.exposureMinor = '900719925474099123';
    mount(); await review();
    expect(await screen.findByText(/^Existing loss bound:/)).toHaveTextContent('9,007,199,254,740,991.23 Stanbucks');
    expect(screen.getByText('Lower odds to 2.50 or less')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Manage odds' })).toHaveAttribute('href', '/backoffice/events/event-a/markets');
    const reads = axios.get.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Test stake (Stanbucks)'), { target: { value: '0.001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at most two decimal places');
    expect(axios.get).toHaveBeenCalledTimes(reads);
    state.detail.choices[0] = { ...state.detail.choices[0], stressReturnMinor: '87', advice: 'WITHIN_CEILING', suggestedOdds: null };
    fireEvent.change(screen.getByLabelText('Test stake (Stanbucks)'), { target: { value: '0.29' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate' }));
    expect(await screen.findByText('Tested stake: 0.29 Stanbucks')).toBeVisible();
    expect(axios.get).toHaveBeenLastCalledWith(`${API}/events/event-a?stakeMinor=29`, expect.any(Object));
  });

  it('uses revision-bound choice writes and removes only its own deny when turned back on', async () => {
    const state = fixture();
    const broader = { id: 'book-closed', type: 'DENY', enabled: true, scope: {}, parameters: {} };
    state.policy.rules.push(broader);
    state.detail.choices[0].singleBlockedByOtherRule = true;
    window.crypto.randomUUID.mockReturnValueOnce('off-uuid').mockReturnValueOnce('on-uuid');
    axios.request.mockImplementation(async config => {
      const off = config.method === 'POST';
      state.policy = { ...state.policy, revision: state.policy.revision + 1,
        rules: off ? [...state.policy.rules, config.data.rule] : state.policy.rules.filter(item => item.id !== `choice:${choiceId}`) };
      state.detail = { ...state.detail, policyRevision: state.policy.revision,
        choices: [{ ...state.detail.choices[0], off, advice: off ? 'OFF' : 'LOWER_ODDS', suggestedOdds: off ? null : 2.5 }] };
      return { data: { ...result(config).data, rules: state.policy.rules } };
    });
    mount(); await review();
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
    expect(axios.request.mock.calls[0][0]).toMatchObject({
      method: 'POST', url: `${API}/rules`, data: { expectedRevision: 1, requestId: 'save:off-uuid', rule: {
        id: `choice:${choiceId}`, type: 'DENY', enabled: true, parameters: {},
        scope: { betKind: 'PRE_MATCH', eventIds: ['event-a'], selectionIds: [choiceId] },
      } },
    });
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'));
    expect(axios.request.mock.calls[1][0]).toMatchObject({
      method: 'DELETE', url: `${API}/rules/choice:${choiceId}`, data: { expectedRevision: 2, requestId: 'save:on-uuid' },
    });
    expect(state.policy.rules).toContainEqual(broader);
    expect(screen.getByText('Another rule still blocks this single')).toBeVisible();
  });

  it('recovers a lost choice-save response by its original operation without optimistically changing the switch', async () => {
    const state = fixture();
    axios.request.mockImplementationOnce(async config => {
      state.operation = { ...result(config).data, rules: [...state.policy.rules, config.data.rule] };
      state.policy = { ...state.policy, ...state.operation };
      state.detail = { ...state.detail, policyRevision: 2,
        choices: [{ ...state.detail.choices[0], off: true, advice: 'OFF', suggestedOdds: null }] };
      throw new Error('response lost');
    });
    mount(); await review();
    fireEvent.click(await screen.findByRole('switch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('uncertain');
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check save result' }));
    await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'));
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(`${API}/operations/save:test-uuid`, expect.any(Object));
  });

  it.each([
    [false, 'UNAVAILABLE', /Missing evidence is not zero exposure/],
    [true, 'NO_LIMIT', /No book-wide exposure ceiling applies/],
  ])('does not imply safe odds when accounting or a book ceiling is missing (%s, %s)', async (ready, advice, message) => {
    const state = fixture();
    state.list.analysis = state.detail.analysis = { ready, code: ready ? 'READY' : 'HISTORICAL_RECONCILIATION_REQUIRED' };
    if (!ready) { state.list.events[0].metrics = null; state.detail.metrics = null; }
    state.detail.choices[0] = { ...state.detail.choices[0], advice, headroomMinor: null, suggestedOdds: null };
    mount(); await review();
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText(/Within exposure ceiling|Lower odds to/)).not.toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeEnabled();
  });

  it('requires a current policy read before enabling switches on a stale analysis', async () => {
    const state = fixture();
    state.detail.policyRevision = 2;
    mount(); await review();
    expect(await screen.findByRole('switch')).toBeDisabled();
    state.policy = { ...state.policy, revision: 2 };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh active policy' }));
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('removes stale financial advice and switches after a failed analysis refresh', async () => {
    fixture(); mount(); await review();
    expect(await screen.findByRole('switch')).toBeEnabled();
    axios.get.mockRejectedValueOnce(new Error('source unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Recalculate' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be refreshed');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Existing loss bound:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Lower odds to/)).not.toBeInTheDocument();
    expect(axios.request).not.toHaveBeenCalled();
  });
});

it('omits the unavailable integrations panel without hiding existing safeguards', async () => {
  const data = snapshot();
  data.catalogue.push({ ...data.catalogue[1], type: 'WALLET', label: 'Wallet integration', category: 'unavailable' });
  axios.get.mockResolvedValue({ data });
  mount();
  expect(await screen.findByRole('button', { name: /Maximum stake OFF All bets/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Quote authority/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Unavailable integrations' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Wallet, balance, deposit and withdrawal limits/)).not.toBeInTheDocument();
  expect(screen.queryByText(/These controls have no authoritative integration/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Wallet integration/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('option', { name: 'unavailable' })).not.toBeInTheDocument();
});

it('uses Stanbucks without rounding invalid precision and hides advanced fields for global rules', async () => {
  mount(); await selectRule();
  expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(100);
  expect(screen.getByLabelText('Event IDs')).not.toBeVisible();
  expect(screen.queryByText(/^Accounting unavailable:/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Limit (Stanbucks)'), { target: { value: '0.001' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('two decimal places');
  expect(axios.request).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Limit (Stanbucks)'), { target: { value: '0.29' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[0][0].data.rule.parameters.limit).toBe(29);
  expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(0.29);
});

it('opens new delay settings directly and saves seconds as exact milliseconds', async () => {
  const data = snapshot();
  data.rules[0] = { ...rule, id: 'default:DELAY_MS', type: 'DELAY_MS', enabled: true, parameters: { limit: 0 } };
  data.catalogue[0] = { ...data.catalogue[0], type: 'DELAY_MS', defaultParameters: { limit: 0 },
    parameterDefinitions: [{ name: 'limit', label: 'Limit', type: 'number', min: 0, max: 300000, unit: 'milliseconds' }] };
  axios.get.mockResolvedValue({ data });
  mount();
  fireEvent.change(await screen.findByLabelText('Search rules'), { target: { value: 'Acceptance delay' } });
  expect(screen.getByRole('button', { name: /Acceptance delay ON/ })).toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText('Add rule for all events'), { target: { value: 'DELAY_MS' } });
  expect(screen.getByRole('heading', { name: 'Acceptance delay' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Configure new rule' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Limit (seconds)'), { target: { value: '2.125' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save as off', exact: true }));
  await screen.findByText('Acceptance delay saved as off — it has no effect on bets. Revision 2 saved.');
  expect(axios.request.mock.calls[0][0]).toMatchObject({
    method: 'POST', data: { rule: { type: 'DELAY_MS', enabled: false, parameters: { limit: 2125 } } },
  });
  expect(screen.getByLabelText('Limit (seconds)')).toHaveValue(2.125);
});

it('loads anonymously, focuses the editor, validates and explicitly saves complete settings', async () => {
  mount();
  await selectRule();
  expect(screen.getByRole('heading', { name: 'Maximum stake' })).toHaveFocus();
  editLimit('2500');
  fireEvent.change(screen.getByLabelText('Bet kind'), { target: { value: 'LIVE' } });
  fireEvent.change(screen.getByLabelText('Event IDs'), { target: { value: 'event:1, event:2' } });
  expect(axios.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  expect(await screen.findByText('Maximum stake is on: 25 Stanbucks · Live; Event IDs: event:1, event:2. Applies to new bets. Revision 2 saved.')).toBeInTheDocument();
  expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
    method: 'PUT', url: `${API}/rules/default:MAX_STAKE`,
    data: { expectedRevision: 1, requestId: 'save:test-uuid',
      rule: { ...rule, enabled: true, parameters: { limit: 2500 }, scope: { betKind: 'LIVE', eventIds: ['event:1', 'event:2'] } } },
  }));
  await waitFor(() => expect(screen.getByText(/Revision 2 saved/).closest('[role="status"]')).toHaveFocus());
});

it('rejects invalid scope and values without discarding input or calling the API', async () => {
  mount(); await selectRule();
  editLimit('');
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('two decimal places');
  expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(null);
  editLimit('500');
  fireEvent.change(screen.getByLabelText('Event IDs'), { target: { value: 'bad id' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  expect(screen.getByRole('alert')).toHaveTextContent('stable IDs');
  expect(axios.request).not.toHaveBeenCalled();
});

it('retains input on revision conflict and refresh until explicitly rebased', async () => {
  axios.request.mockRejectedValueOnce({ response: { status: 409, data: { code: 'REVISION_CONFLICT' } } });
  mount(); await selectRule(); editLimit('2000');
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Refresh');
  const latest = snapshot(2); latest.rules[0].parameters.limit = 3000;
  axios.get.mockResolvedValue({ data: latest });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh rules' }));
  await screen.findByText(/active revision is 2/);
  expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(20);
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Use refreshed revision' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  await screen.findByText(/Revision 3 saved/);
  expect(axios.request.mock.calls[1][0].data.expectedRevision).toBe(2);
});

it('retries ambiguous saves with exactly the same operation and freezes editable input', async () => {
  axios.request.mockRejectedValueOnce(new Error('response lost'));
  mount(); await selectRule(); editLimit('1200');
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('uncertain');
  expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(12);
  expect(screen.getByLabelText('Limit (Stanbucks)')).toBeDisabled();
  const first = axios.request.mock.calls[0][0];
  fireEvent.click(screen.getByRole('button', { name: 'Retry same save' }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[1][0]).toEqual(first);
});

it('recovers an operation result rather than issuing a second mutation', async () => {
  axios.request.mockRejectedValueOnce({ response: { status: 503, data: { code: 'RISK_UNAVAILABLE' } } });
  mount(); await selectRule(); editLimit('1300');
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  await screen.findByText(/Save outcome is uncertain/);
  axios.get.mockResolvedValue(result(axios.request.mock.calls[0][0]));
  fireEvent.click(screen.getByRole('button', { name: 'Check save result' }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request).toHaveBeenCalledTimes(1);
  expect(axios.get).toHaveBeenLastCalledWith(`${API}/operations/save:test-uuid`, expect.any(Object));
});

it('creates custom rules off only when saved as off, guards unsaved switching and removes only after confirmation', async () => {
  mount(); await selectRule(); editLimit('600');
  fireEvent.change(screen.getByLabelText('Add live rule'), { target: { value: 'MAX_STAKE' } });
  expect(screen.getByRole('alert')).toHaveTextContent('Discard');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(6);
  fireEvent.change(screen.getByLabelText('Add rule for all events'), { target: { value: 'MAX_STAKE' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discard input and continue' }));
  expect(screen.queryByRole('button', { name: 'Configure new rule' })).not.toBeInTheDocument();
  expect(screen.getByText('Not saved', { selector: '.risk-status strong' }).closest('p')).toHaveTextContent('Not saved — no effect yet');
  fireEvent.click(screen.getByRole('button', { name: 'Save as off', exact: true }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[0][0].method).toBe('POST');
  fireEvent.click(screen.getByRole('button', { name: 'Remove', exact: true }));
  expect(axios.request).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm remove' }));
  await waitFor(() => expect(axios.request).toHaveBeenCalledTimes(2));
  expect(axios.request.mock.calls[1][0].method).toBe('DELETE');
});

it('previews factory restore and requires confirmation', async () => {
  mount(); await selectRule();
  fireEvent.click(screen.getByRole('button', { name: 'Restore default', exact: true }));
  expect(screen.getByRole('alert')).toHaveTextContent('Exposure, usage history and pending policies are not reset');
  expect(axios.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[0][0].data.ruleId).toBe('default:MAX_STAKE');
});

it('never rebases a destructive confirmation silently during refresh', async () => {
  mount(); await selectRule();
  fireEvent.click(screen.getByRole('button', { name: 'Restore all defaults' }));
  axios.get.mockResolvedValue({ data: snapshot(2) });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh rules' }));
  await screen.findByText(/Policy changed while this confirmation/);
  expect(screen.getByRole('button', { name: 'Confirm restore' })).toBeDisabled();
  expect(axios.request).not.toHaveBeenCalled();
});

it('shows unavailable authority without fabricating an active policy and preserves input on refresh failure', async () => {
  axios.get.mockRejectedValueOnce(new Error('offline'));
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
  expect(screen.queryByText(/Active revision/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh rules' }));
  await selectRule(); editLimit('800');
  axios.get.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh rules' }));
  await screen.findByText(/could not be loaded/);
  expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(8);
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeDisabled();
});

it('never enables accounting controls until readiness is authoritative', async () => {
  const data = snapshot();
  data.rules[0] = { ...rule, id: 'default:MAX_OPEN_STAKE', type: 'MAX_OPEN_STAKE' };
  data.catalogue[0] = { ...data.catalogue[0], type: 'MAX_OPEN_STAKE', category: 'accounting' };
  axios.get.mockResolvedValue({ data });
  mount(); await selectRule();
  expect(screen.getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled();
  expect(screen.getByText(/Can't turn on yet: accounting history is not ready/)).toBeInTheDocument();
  editLimit('4000');
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save as off', exact: true }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[0][0].data.rule.enabled).toBe(false);
});

it.each(['MAX_OPEN_STAKE', 'MAX_OPEN_RETURN', 'MAX_OPERATOR_EXPOSURE'])(
  'permits %s with ready open positions despite incomplete loss history', async type => {
    axios.get.mockResolvedValue({ data: accountingSnapshot(type, {
      ready: false, openPositionsReady: true, readyLossWindows: [],
    }) });
    mount(); await selectRule();
    expect(screen.getByText(/Accounting partially ready/)).toHaveTextContent('Ready loss windows: none');
    expect(screen.queryByText(/^Accounting unavailable:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on', exact: true }));
    await screen.findByText(/Revision 2 saved/);
    expect(axios.request.mock.calls[0][0].data.rule.enabled).toBe(true);
  },
);

it('uses server-ready loss windows and blocks an enabled rule switched to an unready window', async () => {
  axios.get.mockResolvedValue({ data: accountingSnapshot('MAX_CUSTOMER_LOSS', {
    ready: false, openPositionsReady: true, readyLossWindows: ['UTC_DAY', 'ROLLING_24H'],
  }) });
  mount(); await selectRule();
  fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'UTC_WEEK' } });
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('Window').closest('form'));
  expect(screen.getByRole('alert')).toHaveTextContent('accounting history is not ready');
  expect(axios.request).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Window')).toHaveValue('UTC_WEEK');
  fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'ROLLING_24H' } });
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[0][0].data.rule.parameters.window).toBe('ROLLING_24H');
  expect(axios.request.mock.calls[0][0].data.rule.enabled).toBe(true);
});

it('requires ready open positions even when the selected loss window is ready', async () => {
  axios.get.mockResolvedValue({ data: accountingSnapshot('MAX_CUSTOMER_LOSS', {
    ready: false, openPositionsReady: false, readyLossWindows: ['UTC_DAY'],
  }) });
  mount(); await selectRule();
  expect(screen.getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled();
  expect(screen.getByText(/Open-position accounting unavailable:/)).toBeInTheDocument();
});

it.each([
  ['MAX_OPEN_STAKE', false], ['MAX_OPEN_STAKE', true],
  ['MAX_CUSTOMER_LOSS', false], ['MAX_CUSTOMER_LOSS', true],
])('retains legacy aggregate readiness for %s when ready=%s', async (type, ready) => {
  axios.get.mockResolvedValue({ data: accountingSnapshot(type, { ready }) });
  mount(); await selectRule();
  if (ready) expect(screen.getByRole('button', { name: 'Turn on', exact: true })).toBeEnabled();
  else expect(screen.getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled();
});

it.each([
  ['open positions only', { openPositionsReady: true }],
  ['loss windows only', { readyLossWindows: ['UTC_DAY'] }],
  ['non-boolean open positions', { openPositionsReady: 'true', readyLossWindows: ['UTC_DAY'] }],
  ['non-array windows', { openPositionsReady: true, readyLossWindows: 'UTC_DAY' }],
  ['null windows', { openPositionsReady: true, readyLossWindows: null }],
  ['non-string window', { openPositionsReady: true, readyLossWindows: [123] }],
  ['empty window identifier', { openPositionsReady: true, readyLossWindows: [''] }],
  ['present undefined fields', { openPositionsReady: undefined, readyLossWindows: undefined }],
])('rejects malformed granular readiness without aggregate fallback: %s', async (_description, fields) => {
  axios.get.mockResolvedValue({ data: accountingSnapshot('MAX_OPEN_STAKE', { ready: true, ...fields }) });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Risk Centre could not be loaded');
  expect(screen.queryByText(/Active revision/)).not.toBeInTheDocument();
  expect(axios.request).not.toHaveBeenCalled();
});

it.each([
  ['null rule ID', data => { data.rules[0].id = null; }],
  ['missing rule ID', data => { delete data.rules[0].id; }],
  ['numeric rule ID', data => { data.rules[0].id = 123; }],
  ['missing capabilities', data => { delete data.readiness.capabilities; }],
  ['missing writer capability', data => { delete data.readiness.capabilities.extensibleMarkets; }],
  ['non-boolean writer capability', data => { data.readiness.capabilities.extensibleMarkets = 'false'; }],
])('rejects malformed policy evidence: %s', async (_description, corrupt) => {
  const data = snapshot();
  corrupt(data);
  axios.get.mockResolvedValue({ data });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Risk Centre could not be loaded');
  expect(screen.queryByText(/Active revision/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Extensible market writer:/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save', exact: true })).not.toBeInTheDocument();
  expect(axios.request).not.toHaveBeenCalled();
});

it.each(['MAX_SUBMISSIONS', 'MAX_TURNOVER'])(
  'does not substitute accounting readiness for missing %s activity evidence', async type => {
    axios.get.mockResolvedValue({ data: activitySnapshot(type) });
    mount(); await selectRule();
    expect(screen.getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled();
    expect(screen.getByLabelText('Window')).toBeEnabled();
    expect(screen.getByText(/Activity history unavailable:/)).toBeInTheDocument();
    editLimit('2000');
    fireEvent.click(screen.getByRole('button', { name: 'Save as off', exact: true }));
    await screen.findByText(/Revision 2 saved/);
    expect(axios.request.mock.calls[0][0].data.rule.enabled).toBe(false);
  },
);

it.each(['MAX_SUBMISSIONS', 'MAX_TURNOVER'])(
  'uses only server-ready windows for %s and leaves window selection editable', async type => {
    axios.get.mockResolvedValue({ data: activitySnapshot(type, {
      tracking: true, readyWindows: ['UTC_DAY'], trackedSince: '2026-11-14T00:00:00.000Z', readyCooldownMs: 500,
    }) });
    mount(); await selectRule();
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'UTC_WEEK' } });
    expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeDisabled();
    fireEvent.submit(screen.getByLabelText('Window').closest('form'));
    expect(screen.getByRole('alert')).toHaveTextContent('activity history is not ready');
    expect(axios.request).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Window')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: 'UTC_DAY' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
    await screen.findByText(/Revision 2 saved/);
    expect(axios.request.mock.calls[0][0].data.rule).toMatchObject({ enabled: true, parameters: { window: 'UTC_DAY' } });
  },
);

it.each([
  ['missing activity', undefined],
  ['tracking off', { tracking: false, readyWindows: [], readyCooldownMs: 0 }],
])('allows only the explicit zero cooldown without activity protection: %s', async (_description, activity) => {
  axios.get.mockResolvedValue({ data: activitySnapshot('REPEAT_BET_COOLDOWN_MS', activity) });
  mount(); await selectRule();
  expect(screen.getByRole('button', { name: 'Turn on', exact: true })).toBeEnabled();
  expect(screen.getByText(/A zero cooldown is a no-op/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Limit (seconds)'), { target: { value: '0.001' } });
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Limit (seconds)'), { target: { value: '' } });
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Limit (seconds)'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[0][0].data.rule).toMatchObject({ enabled: true, parameters: { limit: 0 } });
});

it('uses the exact server cooldown boundary rather than elapsed browser time', async () => {
  axios.get.mockResolvedValue({ data: activitySnapshot('REPEAT_BET_COOLDOWN_MS', {
    tracking: true, readyWindows: [], readyCooldownMs: 500, trackedSince: '2000-01-01T00:00:00.000Z',
  }) });
  mount(); await selectRule();
  fireEvent.change(screen.getByLabelText('Limit (seconds)'), { target: { value: '0.501' } });
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Limit (seconds)'), { target: { value: '0.500' } });
  expect(screen.getByRole('button', { name: 'Save and turn on', exact: true })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Save and turn on', exact: true }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[0][0].data.rule.parameters.limit).toBe(500);
});

it.each([
  ['null', null],
  ['present undefined', undefined],
  ['partial', { tracking: true }],
  ['non-boolean tracking', { tracking: 'true', readyWindows: [], readyCooldownMs: 0 }],
  ['non-array windows', { tracking: true, readyWindows: 'UTC_DAY', readyCooldownMs: 0 }],
  ['unknown window', { tracking: true, readyWindows: ['UNKNOWN_WINDOW'], readyCooldownMs: 0 }],
  ['negative cooldown', { tracking: true, readyWindows: [], readyCooldownMs: -1 }],
  ['excessive cooldown', { tracking: true, readyWindows: [], readyCooldownMs: 2592000001 }],
  ['non-finite cooldown', { tracking: true, readyWindows: [], readyCooldownMs: Infinity }],
  ['string cooldown', { tracking: true, readyWindows: [], readyCooldownMs: '500' }],
  ['invalid tracked timestamp', { tracking: true, readyWindows: [], readyCooldownMs: 0, trackedSince: 'not-a-date' }],
])('rejects malformed present activity readiness: %s', async (_description, activity) => {
  const data = activitySnapshot('MAX_SUBMISSIONS');
  data.readiness.activity = activity;
  axios.get.mockResolvedValue({ data });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Risk Centre could not be loaded');
  expect(screen.queryByText(/Active revision/)).not.toBeInTheDocument();
  expect(axios.request).not.toHaveBeenCalled();
});

it('rejects loss readiness windows outside the catalogue options', async () => {
  axios.get.mockResolvedValue({ data: accountingSnapshot('MAX_CUSTOMER_LOSS', {
    ready: true, openPositionsReady: true, readyLossWindows: ['UNKNOWN_WINDOW'],
  }) });
  mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('Risk Centre could not be loaded');
  expect(axios.request).not.toHaveBeenCalled();
});

describe('explicit on/off activation', () => {
  const minStake = () => {
    const data = snapshot();
    data.rules[0] = { ...rule, id: 'default:MIN_STAKE', type: 'MIN_STAKE', parameters: { limit: 10000 } };
    data.catalogue[0] = { ...data.catalogue[0], type: 'MIN_STAKE', label: 'Minimum stake' };
    return data;
  };
  const button = name => screen.getByRole('button', { name, exact: true });

  it('replays the incident: an Off minimum stake edited to 5 and saved is turned on', async () => {
    axios.get.mockResolvedValue({ data: minStake() });
    mount(); await selectRule();
    expect(document.body).not.toHaveTextContent(/Enabled|Disabled/);
    expect(screen.getByText('OFF', { selector: '.risk-status .market-pill' }).closest('p')).toHaveTextContent('OFF — has no effect on bets');
    fireEvent.change(screen.getByLabelText('Limit (Stanbucks)'), { target: { value: '5' } });
    fireEvent.click(button('Save and turn on'));
    expect(await screen.findByText('Minimum stake is on: 5 Stanbucks · All bets. Applies to new bets. Revision 2 saved.')).toBeInTheDocument();
    expect(axios.request.mock.calls[0][0].data.rule).toMatchObject({ enabled: true, parameters: { limit: 500 } });
    expect(screen.getByText('ON', { selector: '.risk-status .market-pill' }).closest('p')).toHaveTextContent('ON — checked on new bets · All bets');
    fireEvent.click(button('Turn off'));
    expect(await screen.findByText('Minimum stake is off — it no longer affects new bets. Revision 3 saved.')).toBeInTheDocument();
    expect(axios.request.mock.calls[1][0].data.rule).toMatchObject({ enabled: false, parameters: { limit: 500 } });
    expect(button('Turn on')).toBeEnabled();
  });

  it('saves edits as off only through the explicit off action', async () => {
    axios.get.mockResolvedValue({ data: minStake() });
    mount(); await selectRule();
    fireEvent.change(screen.getByLabelText('Limit (Stanbucks)'), { target: { value: '5' } });
    fireEvent.click(button('Save as off'));
    expect(await screen.findByText('Minimum stake saved as off — it has no effect on bets. Revision 2 saved.')).toBeInTheDocument();
    expect(axios.request.mock.calls[0][0].data.rule).toMatchObject({ enabled: false, parameters: { limit: 500 } });
  });

  it('turns a saved rule on without edits and keeps it on when edited and submitted with Enter', async () => {
    axios.get.mockResolvedValue({ data: minStake() });
    mount(); await selectRule();
    fireEvent.submit(screen.getByLabelText('Limit (Stanbucks)').closest('form'));
    expect(axios.request).not.toHaveBeenCalled();
    fireEvent.click(button('Turn on'));
    await screen.findByText(/Minimum stake is on: 100 Stanbucks/);
    expect(axios.request.mock.calls[0][0].data.rule).toMatchObject({ enabled: true, parameters: { limit: 10000 } });
    fireEvent.change(screen.getByLabelText('Limit (Stanbucks)'), { target: { value: '7' } });
    expect(button('Save and turn off')).toBeEnabled();
    fireEvent.submit(screen.getByLabelText('Limit (Stanbucks)').closest('form'));
    await screen.findByText(/Minimum stake is on: 7 Stanbucks/);
    expect(axios.request.mock.calls[1][0].data.rule).toMatchObject({ enabled: true, parameters: { limit: 700 } });
  });
});

describe('sections, history and all-events switches', () => {
  const templateId = 'a'.repeat(32);
  const routes = overrides => axios.get.mockImplementation(async url => ({
    data: url in overrides ? JSON.parse(JSON.stringify(overrides[url])) : snapshot(),
  }));
  const templates = { enabled: true, starters: [], templates: [
    { templateId, revision: 1, archived: false, versions: [{ id: templateId, version: 1, definition: { name: 'Total goals' } }] },
    { templateId: 'b'.repeat(32), revision: 2, archived: true, versions: [{ id: 'b', version: 1, definition: { name: 'Archived market' } }] },
  ] };
  const deny = (id, scope) => ({ id, type: 'DENY', enabled: true, parameters: {}, scope });
  // Like the server, return the complete revision, without echoing the read-only catalogues.
  const policyWrites = policy => axios.request.mockImplementation(async ({ data, method, url }) => {
    const id = data.rule?.id || url.split('/').pop();
    policy.rules = policy.rules.filter(item => item.id !== id);
    if (method !== 'DELETE') policy.rules.push(data.rule);
    policy.revision += 1;
    return { data: { revision: policy.revision, requestId: data.requestId, defaultsVersion: 1, rules: [...policy.rules] } };
  });

  it('keeps keyboard navigation, rule input and its original revision across workspaces', async () => {
    mount(); await selectRule(); editLimit('2100');
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map(tab => tab.textContent)).toEqual(['Rules', 'Markets', 'Accounts & cash back', 'History']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(tabs[1]).toHaveFocus();
    expect(screen.getByRole('tabpanel', { name: 'Markets' })).toHaveAttribute('id', tabs[1].getAttribute('aria-controls'));
    expect(screen.queryByRole('button', { name: 'Save and turn on' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause live betting' }));
    await screen.findByText(/Live betting paused.*Revision 2 saved/);
    fireEvent.keyDown(tabs[1], { key: 'End' });
    expect(tabs[3]).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Load recent revisions' })).toBeVisible();
    expect(axios.get.mock.calls.some(([url]) => url === `${API}/history`)).toBe(false);
    fireEvent.keyDown(tabs[3], { key: 'Home' });
    expect(tabs[0]).toHaveFocus();
    expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(21);
    expect(screen.getByText(/input is based on revision 1; active revision is 2/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save and turn on' })).toBeDisabled();
    expect(axios.request).toHaveBeenCalledTimes(1);
  });

  it.each([['PRE_MATCH', 'Pre-match', 'Total goals'], ['LIVE', 'Live', 'Next corner (live)']])(
    'pauses and reopens %s with one exact rule, not an enumeration', async (key, title, member) => {
      const policy = snapshot();
      const narrow = deny('other-event', { eventIds: ['event-a'], betKind: key });
      policy.rules.push(narrow);
      routes({ [API]: policy, '/api/backoffice/market-templates': templates });
      policyWrites(policy);
      mount(); await openTab('Markets');
      const pre = screen.getByRole('region', { name: 'Pre-match' });
      const live = screen.getByRole('region', { name: 'Live' });
      expect(within(pre).getByText('Archived market')).toBeVisible();
      expect(within(live).queryByText('Total goals')).toBeNull();
      const group = key === 'LIVE' ? live : pre;
      const other = key === 'LIVE' ? pre : live;
      expect(group).toHaveTextContent('Narrower blocks still apply');
      fireEvent.click(within(group).getByRole('button', { name: `Pause ${title.toLowerCase()} betting` }));
      await screen.findByText(`${title} betting paused for new bets. Revision 2 saved.`);
      expect(axios.request.mock.calls[0][0]).toMatchObject({
        url: `${API}/rules`, method: 'POST', data: { expectedRevision: 1, requestId: 'save:test-uuid',
          rule: deny(`betting:${key}`, { betKind: key }) },
      });
      const memberRow = within(group).getAllByRole('listitem').find(row => within(row).queryByText(member));
      expect(memberRow).toHaveTextContent(`${title} betting is paused`);
      expect(within(memberRow).queryByRole('button')).toBeNull();
      expect(within(other).getByRole('button', { name: /^Pause / })).toBeEnabled();
      fireEvent.click(within(group).getByRole('button', { name: `Reopen ${title.toLowerCase()} betting` }));
      await screen.findByText(`${title} betting block removed. Other restrictions still apply. Revision 3 saved.`);
      expect(axios.request.mock.calls[1][0]).toMatchObject({
        url: `${API}/rules/betting:${key}`, method: 'DELETE', data: { expectedRevision: 2, requestId: 'save:test-uuid' },
      });
      expect(axios.request).toHaveBeenCalledTimes(2);
      expect(policy.rules).toContainEqual(narrow);
    },
  );

  it('removes only an owned pause under a foreign global block and never offers to reopen blocked markets', async () => {
    const policy = snapshot();
    policy.rules.push(deny('other-global', {}), deny('betting:LIVE', { betKind: 'LIVE' }));
    routes({ [API]: policy });
    policyWrites(policy);
    mount(); await openTab('Markets');
    const live = screen.getByRole('region', { name: 'Live' });
    expect(live).toHaveTextContent('All betting is closed');
    expect(screen.queryByRole('button', { name: /Reopen|Open betting|Turn on/ })).not.toBeInTheDocument();
    fireEvent.click(within(live).getByRole('button', { name: 'Remove own block: Live betting' }));
    await screen.findByText(/Live betting block removed/);
    expect(within(live).queryByRole('button')).toBeNull();
    expect(axios.request.mock.calls[0][0].url).toBe(`${API}/rules/betting:LIVE`);
    expect(policy.rules).toContainEqual(deny('other-global', {}));
  });

  it('can pause a kind without either catalogue, reusing its disabled exact rule for newly listed markets', async () => {
    const policy = snapshot();
    delete policy.builtinMarkets;
    const managed = deny('betting:PRE_MATCH', { betKind: 'PRE_MATCH' });
    policy.rules.push({ ...managed, enabled: false });
    routes({ [API]: policy });
    policyWrites(policy);
    mount(); await openTab('Markets');
    expect(screen.getByText(/Built-in market switches are unavailable/)).toBeVisible();
    expect(screen.getByText(/Custom market templates are unavailable/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Pause pre-match betting' }));
    await screen.findByText(/Pre-match betting paused for new bets\. Revision 2 saved/);
    expect(axios.request.mock.calls[0][0]).toMatchObject({
      method: 'PUT', url: `${API}/rules/betting:PRE_MATCH`, data: { expectedRevision: 1, rule: managed },
    });
    policy.builtinMarkets = snapshot().builtinMarkets;
    routes({ [API]: policy, '/api/backoffice/market-templates': templates });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh rules' }));
    const pre = screen.getByRole('region', { name: 'Pre-match' });
    for (const name of ['1X2', 'Correct Score', 'Archived market', 'Total goals']) {
      await within(pre).findByText(name);
      const row = within(pre).getAllByRole('listitem').find(item => within(item).queryByText(name));
      expect(row).toHaveTextContent('Pre-match betting is paused');
      expect(within(row).queryByRole('button')).toBeNull();
    }
    expect(axios.request).toHaveBeenCalledTimes(1);
  });

  it('keeps an acknowledged but unverified scoped result in recovery, not a success state', async () => {
    axios.request.mockImplementationOnce(async config => ({
      data: { ...result(config).data, rules: [deny('betting:LIVE', { betKind: 'PRE_MATCH' })] },
    }));
    mount(); await openTab('Markets');
    fireEvent.click(screen.getByRole('button', { name: 'Pause live betting' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('outcome is uncertain');
    expect(screen.queryByText(/Live betting paused for new bets\./)).toBeNull();
    expect(screen.getByRole('button', { name: 'Check save result' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Close betting for all events' })).toBeDisabled();
  });

  it('does not present a writable or open switch when transactions are unavailable', async () => {
    const policy = snapshot();
    policy.readiness.transactions = 'UNAVAILABLE';
    routes({ [API]: policy });
    mount(); await openTab('Markets');
    const panel = screen.getByRole('tabpanel', { name: 'Markets' });
    expect(within(panel).queryAllByText(/^(ON|OFF)$/)).toHaveLength(0);
    expect(within(panel).getByRole('button', { name: 'Pause pre-match betting' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Pause live betting' })).toBeDisabled();
    expect(within(panel).getByRole('button', { name: 'Close betting for all events' })).toBeDisabled();
  });

  it('recognizes foreign group pauses and refuses modified group and all-betting IDs even when off', async () => {
    const policy = snapshot();
    policy.rules.push(deny('another-live-rule', { betKind: 'LIVE' }),
      { ...deny('betting:PRE_MATCH', { betKind: 'PRE_MATCH', structure: 'SINGLE' }), enabled: false },
      { ...rule, id: 'betting:all' });
    routes({ [API]: policy });
    mount(); await openTab('Markets');
    const pre = screen.getByRole('region', { name: 'Pre-match' });
    expect(pre).toHaveTextContent('Switch rule changed; manage it in Rules');
    expect(within(pre).queryByRole('button', { name: /Pause pre-match/ })).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Betting' })).queryByRole('button')).toBeNull();
    const live = screen.getByRole('region', { name: 'Live' });
    expect(live).toHaveTextContent('Live betting is paused');
    expect(within(live).queryByRole('button')).toBeNull();
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('does not report an uncertain group pause as open or applied; recovery remains reachable from another tab', async () => {
    const policy = snapshot();
    const saved = { ...snapshot(2), requestId: 'save:test-uuid', rules: [deny('betting:LIVE', { betKind: 'LIVE' })] };
    routes({ [API]: policy, [`${API}/operations/save:test-uuid`]: saved });
    axios.request.mockRejectedValueOnce(new Error('lost response'));
    mount(); await openTab('Markets');
    fireEvent.click(screen.getByRole('button', { name: 'Pause live betting' }));
    expect(await screen.findByRole('alert')).toHaveFocus();
    const live = screen.getByRole('region', { name: 'Live' });
    expect(live).toHaveTextContent('Awaiting save result');
    expect(within(live).queryAllByText(/^(ON|OFF)$/)).toHaveLength(0);
    expect(within(live).getByRole('button', { name: 'Pause live betting' })).toBeDisabled();
    await openTab('Accounts & cash back');
    // A later policy read beats even the correctly identified, eventually recovered write.
    routes({ [API]: snapshot(3), [`${API}/operations/save:test-uuid`]: saved });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh rules' }));
    await screen.findByText(/Last read revision 3/);
    fireEvent.click(screen.getByRole('button', { name: 'Check save result' }));
    await screen.findByText(/revision 3 is now active/);
    expect(screen.getByRole('status')).toHaveFocus();
    await openTab('Markets');
    expect(screen.getByRole('button', { name: 'Pause live betting' })).toBeEnabled();
    expect(axios.request).toHaveBeenCalledTimes(1);
  });

  it('marks switch status unavailable after a conflict and failed read, with no second write', async () => {
    const policy = snapshot();
    routes({ [API]: policy });
    axios.request.mockRejectedValueOnce({ response: { status: 409, data: { code: 'REVISION_CONFLICT' } } });
    mount(); await openTab('Markets');
    axios.get.mockRejectedValueOnce(new Error('policy offline'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause pre-match betting' }));
    await screen.findByText(/could not be loaded/);
    const group = screen.getByRole('region', { name: 'Pre-match' });
    expect(group).toHaveTextContent('Unavailable');
    expect(within(group).queryAllByText(/^(ON|OFF)$/)).toHaveLength(0);
    expect(within(group).getByRole('button', { name: 'Pause pre-match betting' })).toBeDisabled();
    expect(axios.request).toHaveBeenCalledTimes(1);
  });

  it('groups rules into all-events, pre-match and live sections and prefills the section bet kind', async () => {
    mount();
    for (const name of ['All events', 'Pre-match', 'Live']) {
      expect(await screen.findByRole('region', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('region', { name: 'All events' })).toHaveTextContent('Maximum stake');
    expect(screen.getByRole('region', { name: 'Live' })).toHaveTextContent('No live rules yet');
    expect(screen.getByRole('region', { name: 'Live' })).toHaveTextContent('the event is in play, the market is open and the price has not changed');
    fireEvent.change(screen.getByLabelText('Add pre-match rule'), { target: { value: 'MAX_STAKE' } });
    expect(screen.getByLabelText('Bet kind')).toHaveValue('PRE_MATCH');
    fireEvent.click(screen.getByRole('button', { name: 'Save as off', exact: true }));
    await screen.findByText(/Revision 2 saved/);
    expect(axios.request.mock.calls[0][0]).toMatchObject({
      method: 'POST', data: { rule: { type: 'MAX_STAKE', enabled: false, scope: { betKind: 'PRE_MATCH' } } },
    });
    expect(await screen.findByRole('button', { name: /Maximum stake OFF All pre-match bets/ })).toBeInTheDocument();
  });

  it('shows which overlapping rules also apply and that the stricter limit wins', async () => {
    const data = snapshot();
    data.rules[0].enabled = true;
    routes({ [API]: data });
    mount();
    fireEvent.change(await screen.findByLabelText('Add live rule'), { target: { value: 'MAX_STAKE' } });
    expect(screen.getByRole('note', { name: 'Other rules that also apply' })).toHaveTextContent(
      'Maximum stake (All events): 100 Stanbucks',
    );
    expect(screen.getByRole('note', { name: 'Other rules that also apply' })).toHaveTextContent('the stricter limit wins');
  });

  it('expands each revision to show exactly what changed', async () => {
    const at = '2026-11-14T21:00:00.000Z';
    const revision = (number, rules) => ({ revision: number, defaultsVersion: 1, occurredAt: at, rules });
    routes({ [`${API}/history`]: { items: [
      revision(3, [{ ...rule, enabled: true, parameters: { limit: 5000 } },
        { id: 'rule:live', type: 'MAX_STAKE', enabled: false, scope: { betKind: 'LIVE' }, parameters: { limit: 100 } }]),
      revision(2, [{ ...rule, enabled: true }]),
    ] } });
    mount(); await openTab('History');
    fireEvent.click(await screen.findByRole('button', { name: 'Load recent revisions' }));
    const latest = (await screen.findByText('Revision 3')).closest('details');
    expect(latest.querySelector('summary')).toHaveTextContent(/^Revision 3 · .*2026.* · 2 changes$/);
    expect(latest.querySelector('summary')).toHaveTextContent('· 2 changes');
    expect(latest).toHaveTextContent('Maximum stake (All events): 100 Stanbucks → 50 Stanbucks');
    expect(latest).toHaveTextContent('Added Maximum stake (Live): Off · 1 Stanbucks');
    expect(latest).toHaveTextContent('All 2 rules in this revision');
    expect(screen.getByText('Revision 2').closest('summary')).toHaveTextContent('Changes not loaded');
  });

  it('turns a custom market off and back on for all events through a block rule', async () => {
    routes({ '/api/backoffice/market-templates': templates });
    mount(); await openTab('Markets');
    expect(await screen.findByText('Total goals')).toBeInTheDocument();
    expect(screen.getByText('Archived market').closest('li')).toHaveTextContent('Template / Archived');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off Total goals for all events' }));
    await screen.findByText('Total goals is off for all events. New bets on it are declined. Revision 2 saved.');
    expect(axios.request.mock.calls[0][0]).toMatchObject({
      method: 'POST', url: `${API}/rules`,
      data: { expectedRevision: 1, rule: { id: `market:${templateId}`, type: 'DENY', enabled: true, scope: { templateIds: [templateId] }, parameters: {} } },
    });
    expect(screen.getByText('Total goals').closest('li').querySelector('.market-pill')).toHaveTextContent('OFF');
    await openTab('Rules');
    expect(screen.getByRole('button', { name: /ON Market: Total goals/ })).toBeInTheDocument();
    await openTab('Markets');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Total goals for all events' }));
    await screen.findByText('Total goals market block removed. Other restrictions still apply. Revision 3 saved.');
    expect(axios.request.mock.calls[1][0]).toMatchObject({ method: 'DELETE', url: `${API}/rules/market:${templateId}`, data: { expectedRevision: 2 } });
  });

  it('includes built-in pre-match and live markets and switches them without requiring the template catalogue', async () => {
    mount(); await openTab('Markets');
    for (const name of ['1X2', 'Correct Score', 'Next corner (live)']) {
      expect(await screen.findByRole('button', { name: `Turn off ${name} for all events` })).toBeInTheDocument();
    }
    expect(screen.getByText('1X2').closest('li')).toHaveTextContent('Built-in / Pre-match');
    expect(screen.getByText('Next corner (live)').closest('li')).toHaveTextContent('Built-in / Live');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off 1X2 for all events' }));
    await screen.findByText('1X2 is off for all events. New bets on it are declined. Revision 2 saved.');
    expect(axios.request.mock.calls[0][0]).toMatchObject({
      method: 'POST', url: `${API}/rules`,
      data: { expectedRevision: 1, rule: { id: 'market:PRE_MATCH:1X2', type: 'DENY', enabled: true, scope: { marketTypes: ['PRE_MATCH:1X2'] }, parameters: {} } },
    });
    expect(screen.getByText('1X2').closest('li').querySelector('.market-pill')).toHaveTextContent('OFF');
    fireEvent.click(screen.getByRole('button', { name: 'Turn on 1X2 for all events' }));
    await screen.findByText('1X2 market block removed. Other restrictions still apply. Revision 3 saved.');
    expect(axios.request.mock.calls[1][0]).toMatchObject({ method: 'DELETE', url: `${API}/rules/market:PRE_MATCH:1X2`, data: { expectedRevision: 2 } });
  });

  it('keeps a same-name saved template distinct from its built-in market', async () => {
    routes({ '/api/backoffice/market-templates': { ...templates, templates: [{
      ...templates.templates[0], versions: [{ definition: { name: '1X2' } }],
    }] } });
    mount(); await openTab('Markets');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off 1X2 (Template) for all events' }));
    await screen.findByText(/1X2 \(Template\) is off for all events/);
    expect(axios.request.mock.calls[0][0].data.rule.scope).toEqual({ templateIds: [templateId] });
    const native = screen.getByRole('button', { name: 'Turn off 1X2 (Built-in / Pre-match) for all events' }).closest('li');
    expect(native.querySelector('.market-pill')).toHaveTextContent('ON');
  });

  it('does not overwrite a changed switch or remove another native Block bets rule', async () => {
    const data = snapshot();
    data.rules.push(
      { id: 'another:deny', type: 'DENY', enabled: true, scope: { marketTypes: ['PRE_MATCH:1X2'] }, parameters: {} },
      { id: 'market:PRE_MATCH:CS', type: 'DENY', enabled: true, scope: { marketTypes: ['LIVE:NEXT_CORNER'] }, parameters: {} },
    );
    routes({ [API]: data });
    mount(); await openTab('Markets');
    const blocked = (await screen.findByText('1X2')).closest('li');
    expect(blocked).toHaveTextContent('OFF');
    expect(blocked).toHaveTextContent('Off by a Block bets rule');
    expect(blocked.querySelector('button')).toBeNull();
    const changed = screen.getByText('Correct Score').closest('li');
    expect(changed).toHaveTextContent('Switch rule changed; manage it in Rules');
    expect(changed.querySelector('button')).toBeNull();
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('reconciles an uncertain native switch using the original operation and keeps its catalogue', async () => {
    const saved = {
      requestId: 'save:test-uuid', revision: 2, defaultsVersion: 1, occurredAt: '2026-11-14T21:00:00.000Z',
      rules: [{ id: 'market:PRE_MATCH:1X2', type: 'DENY', enabled: true, scope: { marketTypes: ['PRE_MATCH:1X2'] }, parameters: {} }],
    };
    routes({ [`${API}/operations/save:test-uuid`]: saved });
    axios.request.mockRejectedValueOnce(new Error('response lost'));
    mount(); await openTab('Markets');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off 1X2 for all events' }));
    const check = await screen.findByRole('button', { name: 'Check save result' });
    await waitFor(() => expect(check).toBeEnabled());
    fireEvent.click(check);
    await screen.findByText(/1X2 is off for all events.*Revision 2 saved/);
    expect(axios.request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Turn on 1X2 for all events' })).toBeInTheDocument();
    expect(screen.getByText('Correct Score')).toBeInTheDocument();
  });

  it('does not invent native switches for an older reader and keeps saved templates usable', async () => {
    const data = snapshot();
    delete data.builtinMarkets;
    routes({ [API]: data, '/api/backoffice/market-templates': templates });
    mount(); await openTab('Markets');
    expect(await screen.findByText('Built-in market switches are unavailable in this deployment.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Turn off Total goals for all events' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn off 1X2 for all events' })).not.toBeInTheDocument();
  });

  it('switches cash back for all events with the expected current value', async () => {
    routes({ '/api/backoffice/cash-back-setting': { enabled: true, revision: 0 } });
    axios.request.mockResolvedValueOnce({ data: { enabled: false, revision: 1, updatedAt: '2026-11-14T21:00:00.000Z' } });
    mount(); await openTab('Accounts & cash back');
    const panel = await screen.findByRole('region', { name: 'Cash back' });
    expect(await screen.findByRole('button', { name: 'Turn off cash back for all events' })).toBeInTheDocument();
    expect(panel.querySelector('.market-pill')).toHaveTextContent('ON');
    fireEvent.click(screen.getByRole('button', { name: 'Turn off cash back for all events' }));
    await screen.findByText(/Cash back is off for all events/);
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'PUT', url: '/api/backoffice/cash-back-setting', data: { enabled: false, expectedEnabled: true },
    }));
    expect(panel.querySelector('.market-pill')).toHaveTextContent('OFF');
    expect(screen.getByRole('button', { name: 'Turn on cash back for all events' })).toBeInTheDocument();
  });

  it('names a market switch rule whose template was deleted without hiding other unknown template IDs', async () => {
    const deletedId = 'c'.repeat(32);
    const policy = snapshot();
    policy.rules.push({ id: `market:${deletedId}`, type: 'DENY', enabled: true, scope: { templateIds: [deletedId] }, parameters: {} });
    policy.rules.push({ ...rule, id: 'custom:builder', enabled: true, scope: { templateIds: ['northport-1x2'] } });
    routes({ [API]: policy, '/api/backoffice/market-templates': templates });
    const view = mount();
    expect(await screen.findByRole('button', { name: /ON Market: Deleted market/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Market: northport-1x2/ })).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(deletedId))).not.toBeInTheDocument();
    view.unmount();
    routes({ [API]: policy });
    mount(); await openTab('Markets');
    await screen.findByText('Custom market templates are unavailable. Try refreshing.');
    await openTab('Rules');
    expect(await screen.findByRole('button', { name: new RegExp(`ON Market: ${deletedId}`) })).toBeInTheDocument();
  });

  it('closes and reopens all betting through one unscoped block rule', async () => {
    mount(); await openTab('Markets');
    const panel = await screen.findByRole('region', { name: 'Betting' });
    expect(panel.querySelector('.market-pill')).toHaveTextContent('ON');
    fireEvent.click(screen.getByRole('button', { name: 'Close betting for all events' }));
    await screen.findByText('Betting is closed for all events. New pre-match and live bets are declined. Revision 2 saved.');
    expect(axios.request.mock.calls[0][0]).toMatchObject({
      method: 'POST', url: `${API}/rules`,
      data: { expectedRevision: 1, rule: { id: 'betting:all', type: 'DENY', enabled: true, scope: {}, parameters: {} } },
    });
    expect(panel.querySelector('.market-pill')).toHaveTextContent('OFF');
    fireEvent.click(screen.getByRole('button', { name: 'Open betting for all events' }));
    await screen.findByText('All-events betting block removed. Other restrictions still apply. Revision 3 saved.');
    expect(axios.request.mock.calls[1][0]).toMatchObject({ method: 'DELETE', url: `${API}/rules/betting:all`, data: { expectedRevision: 2 } });
  });

  it('shows betting closed by another unscoped block rule without offering to open it', async () => {
    const policy = snapshot();
    policy.rules.push({ id: 'default:DENY', type: 'DENY', enabled: true, scope: {}, parameters: {} });
    routes({ [API]: policy });
    mount(); await openTab('Markets');
    const panel = await screen.findByRole('region', { name: 'Betting' });
    expect(panel.querySelector('.market-pill')).toHaveTextContent('OFF');
    expect(panel).toHaveTextContent('Closed by a Block bets rule');
    expect(screen.queryByRole('button', { name: /betting for all events/ })).not.toBeInTheDocument();
  });

  it('describes betting switches in revision history', () => {
    const closed = { id: 'betting:all', type: 'DENY', enabled: true, scope: {}, parameters: {} };
    expect(describeChanges({ rules: [rule] }, { rules: [rule, closed] }, [], new Map())).toEqual(['Betting closed for all events']);
    expect(describeChanges({ rules: [rule, closed] }, { rules: [rule] }, [], new Map())).toEqual(['All-events betting block removed']);
  });

  it('stops and allows customer sign-in and registration with the expected current value', async () => {
    routes({ '/api/backoffice/access-controls': { registrationEnabled: true, loginEnabled: true, revision: 0 } });
    axios.request.mockResolvedValueOnce({ data: { registrationEnabled: true, loginEnabled: false, revision: 1 } });
    mount(); await openTab('Accounts & cash back');
    const panel = await screen.findByRole('region', { name: 'Accounts' });
    fireEvent.click(await screen.findByRole('button', { name: 'Stop customer sign-in' }));
    await screen.findByText(/Customer sign-in is stopped\. .*administrators can still sign in/);
    expect(axios.request).toHaveBeenCalledWith(expect.objectContaining({
      method: 'PUT', url: '/api/backoffice/access-controls/login', data: { enabled: false, expectedEnabled: true },
    }));
    expect(panel).toHaveTextContent('Paused while sign-in is stopped');
    expect(screen.getByRole('button', { name: 'Allow customer sign-in' })).toBeInTheDocument();

    axios.request.mockRejectedValueOnce({ response: { status: 409 } });
    fireEvent.click(screen.getByRole('button', { name: 'Stop new registrations' }));
    await screen.findByText('The new registrations setting was changed by someone else. The current setting is shown; try again if needed.');
    expect(axios.request).toHaveBeenLastCalledWith(expect.objectContaining({
      url: '/api/backoffice/access-controls/registration', data: { enabled: false, expectedEnabled: true },
    }));
  });

  it('keeps rules usable when switch settings are unavailable', async () => {
    mount();
    await screen.findByRole('button', { name: /Maximum stake OFF All bets/ });
    await openTab('Accounts & cash back');
    expect(await screen.findByText('Cash-back setting is unavailable. Try refreshing.')).toBeInTheDocument();
    expect(screen.getByText('Account switches are unavailable. Try refreshing.')).toBeInTheDocument();
    await openTab('Markets');
    expect(screen.getByText('Custom market templates are unavailable. Try refreshing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn off 1X2 for all events' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
