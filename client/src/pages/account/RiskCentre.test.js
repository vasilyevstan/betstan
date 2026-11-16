import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import RiskCentre from './RiskCentre';

jest.mock('axios', () => ({ get: jest.fn(), request: jest.fn() }));
const API = '/api/backoffice/risk-centre';
const rule = { id: 'default:MAX_STAKE', type: 'MAX_STAKE', enabled: false, scope: {}, parameters: { limit: 10000 } };
const snapshot = (revision = 1) => ({
  revision, defaultsVersion: 1, rules: [{ ...rule, parameters: { ...rule.parameters } }],
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
const selectRule = async () => fireEvent.click(await screen.findByRole('button', { name: /Off · All bets/ }));
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

it('omits the unavailable integrations panel without hiding existing safeguards', async () => {
  const data = snapshot();
  data.catalogue.push({ ...data.catalogue[1], type: 'WALLET', label: 'Wallet integration', category: 'unavailable' });
  axios.get.mockResolvedValue({ data });
  mount();
  expect(await screen.findByRole('button', { name: /Quote authority Locked/ })).toBeInTheDocument();
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
  expect(screen.getByRole('button', { name: /Acceptance delay On/ })).toBeInTheDocument();
  fireEvent.change(await screen.findByLabelText('Add a rule'), { target: { value: 'DELAY_MS' } });
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
  fireEvent.click(screen.getByRole('button', { name: /Quote authority Locked/ }));
  expect(screen.getByRole('alert')).toHaveTextContent('Discard');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByLabelText('Limit (Stanbucks)')).toHaveValue(6);
  fireEvent.change(screen.getByLabelText('Add a rule'), { target: { value: 'MAX_STAKE' } });
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

it('previews factory restore and requires confirmation, with locked safeguards read-only', async () => {
  mount(); await selectRule();
  fireEvent.click(screen.getByRole('button', { name: 'Restore default', exact: true }));
  expect(screen.getByRole('alert')).toHaveTextContent('Exposure, usage history and pending policies are not reset');
  expect(axios.request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm restore' }));
  await screen.findByText(/Revision 2 saved/);
  expect(axios.request.mock.calls[0][0].data.ruleId).toBe('default:MAX_STAKE');
  fireEvent.click(screen.getByRole('button', { name: /Quote authority Locked/ }));
  expect(screen.getByText(/cannot be turned off, edited or removed/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Save|Turn on|Turn off/ })).not.toBeInTheDocument();
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
    expect(screen.getByText('Off', { selector: '.risk-status strong' }).closest('p')).toHaveTextContent('Off — has no effect on bets');
    fireEvent.change(screen.getByLabelText('Limit (Stanbucks)'), { target: { value: '5' } });
    fireEvent.click(button('Save and turn on'));
    expect(await screen.findByText('Minimum stake is on: 5 Stanbucks · All bets. Applies to new bets. Revision 2 saved.')).toBeInTheDocument();
    expect(axios.request.mock.calls[0][0].data.rule).toMatchObject({ enabled: true, parameters: { limit: 500 } });
    expect(screen.getByText('On', { selector: '.risk-status strong' }).closest('p')).toHaveTextContent('On — checked on new bets · All bets');
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
