import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import EventMarkets from './event/EventMarkets';
import BackofficeMarkets from './account/BackofficeMarkets';
import { acceptedOddsForBet, possibleReturn, settlementOddsForBet } from '../cashBackUtils';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), put: jest.fn() }));

const manualDefinition = {
  schemaVersion: 1, name: 'Match award', terms: 'Operator announces the winning nominee.',
  settlementMode: 'MANUAL', outcomeMode: 'EXCLUSIVE', coverage: 'COMPLETE', parameters: [],
  outcomes: [{ key: 'a', label: 'Nominee A' }, { key: 'b', label: 'Nominee B' }],
};
const event = { eventId: 'event-a', name: 'Home - Away', time: '2099-01-01T12:00:00.000Z', status: 'NO_RESULT', visibility: 'ONLINE' };
const template = { id: 'template-a', version: 1, publishedAt: '2025-01-01T00:00:00.000Z', definition: manualDefinition };
const configuration = {
  schemaVersion: 1, eventId: 'event-a', marketId: 'market-a', revision: 2, rulesRevision: 1, template,
  parameters: {}, availability: 'OPEN', pricing: { method: 'OPERATOR', odds: { a: 2, b: 2 } },
};
const selection = (marketId, label = 'Home win') => ({
  origin: 'STANDARD', marketId, outcomeKey: 'home', quoteRevision: 1, rulesRevision: 1,
  templateId: marketId, templateVersion: 1, marketName: '1X2', label, terms: 'Full-time score',
  settlementMode: 'FINAL_SCORE', pricingMethod: 'SCORE_MODEL',
  rule: { kind: 'COMPARE', metric: 'GOAL_DIFFERENCE', comparison: 'GT', value: 0 }, odds: 2,
});
const quote = () => ({
  schemaVersion: 1, eventId: 'event-a', kind: 'BUILDER', quoteId: 'quote-a', modelId: 'model-a',
  issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 30000).toISOString(),
  odds: 3.75, selections: [selection('standard-a'), selection('standard-b', 'Away win')],
});
const renderRoute = (component, route) => render(<MemoryRouter initialEntries={[route]}>
  <Routes><Route path="/events/:eventId/markets" element={component} />
    <Route path="/backoffice/events/:eventId/markets" element={component} /></Routes>
</MemoryRouter>);
let market;
let catalog;
let boards;
const originalCrypto = window.crypto;
let nextId = 0;
beforeEach(() => {
  jest.resetAllMocks();
  Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => `market-request-${++nextId}` } });
  market = { ...configuration, status: 'PUBLISHED', publishedConfiguration: configuration };
  catalog = { enabled: true, event, hasRetainedModel: true,
    standardSelections: [selection('standard-a'), selection('standard-b', 'Away win')],
    markets: [{ configuration, preview: { odds: { a: 2, b: 2 } }, builderEligible: false }] };
  boards = { PRE_MATCH: null, LIVE: null };
  axios.get.mockImplementation(async (url) => {
    if (url === '/api/backoffice/market-templates') return { data: {
      enabled: true, templates: [{ templateId: 'template-a', revision: 1, archived: false, versions: [template] }], starters: [],
    } };
    if (url.startsWith('/api/backoffice/events/')) return { data: { enabled: true, event, markets: [market] } };
    if (url === '/api/slip/boards') return { data: boards };
    if (url === '/api/event/events/event-a/markets') return { data: catalog };
    throw new Error(`Unexpected GET ${url}`);
  });
});
afterEach(() => Object.defineProperty(window, 'crypto', { configurable: true, value: originalCrypto }));

it('uses authoritative Builder quotes and requires explicit same-event replacement', async () => {
  boards.PRE_MATCH = { status: 'DRAFT', boardRevision: 4, boardFingerprint: 'reviewed-board',
    rows: [{ id: 'old-row', eventId: 'event-a', productName: '1X2', oddsName: 'Home', oddsValue: 2 }] };
  axios.post.mockImplementation(async (url) => {
    if (url.endsWith('market-quotes')) return { data: quote() };
    if (url === '/api/slip/market-selection') return { data: {} };
    throw new Error(`Unexpected POST ${url}`);
  });
  const refresh = jest.fn();
  renderRoute(<EventMarkets currentUser={{ id: 'player' }} onSelectionPlaced={refresh} />, '/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: 'Bet Builder', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Home win 2.00' }));
  fireEvent.click(screen.getByRole('button', { name: 'Away win 2.00' }));
  expect(screen.getByRole('button', { name: 'Nominee A 2.00' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Get combined odds' }));
  const add = await screen.findByRole('button', { name: 'Add quoted selection to slip' });
  expect(add).toBeDisabled();
  expect(axios.post.mock.calls[0][1].selections[0]).toEqual({
    origin: 'STANDARD', marketId: 'standard-a', outcomeKey: 'home', quoteRevision: 1,
  });
  fireEvent.click(screen.getByLabelText('Replace these same-match selections with this quote'));
  fireEvent.click(add);
  await waitFor(() => expect(axios.post).toHaveBeenLastCalledWith('/api/slip/market-selection', {
    quoteId: 'quote-a', expectedBoardRevision: 4, expectedBoardFingerprint: 'reviewed-board', replaceEventSelections: true,
  }));
  expect(await screen.findByText(/Added to your pre-match slip/)).toBeInTheDocument();
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('enforces ten Builder picks and does not add an expired quote', async () => {
  catalog.standardSelections = Array.from({ length: 11 }, (_, index) => selection(`market-${index}`, `Selection ${index + 1}`));
  axios.post.mockResolvedValue({ data: { ...quote(), expiresAt: new Date(Date.now() - 1).toISOString() } });
  renderRoute(<EventMarkets currentUser={{ id: 'player' }} />, '/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: 'Bet Builder', exact: true }));
  for (let index = 1; index <= 10; index += 1) fireEvent.click(screen.getByRole('button', { name: `Selection ${index} 2.00` }));
  expect(screen.getByRole('button', { name: 'Selection 11 2.00' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Get combined odds' }));
  expect(await screen.findByRole('button', { name: 'Add quoted selection to slip' })).toBeDisabled();
  expect(screen.getByText(/Quote expired/)).toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledTimes(1);
});

it('clears stale quote review after a board conflict instead of silently adopting new selections', async () => {
  axios.post.mockImplementation(async (url) => {
    if (url.endsWith('market-quotes')) return { data: { ...quote(), kind: 'SINGLE' } };
    throw { response: { status: 409, data: { message: 'Your board changed.' } } };
  });
  renderRoute(<EventMarkets currentUser={{ id: 'player' }} />, '/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: 'Nominee A 2.00' }));
  fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add quoted selection to slip' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your board changed.');
  expect(screen.queryByRole('button', { name: 'Add quoted selection to slip' })).not.toBeInTheDocument();
});

it('previews generated manual odds without publication and publishes only the reviewed revision', async () => {
  market = { ...market, revision: 1, status: 'DRAFT', publishedConfiguration: undefined };
  axios.post.mockResolvedValue({ data: { method: 'EQUAL_CHANCE', odds: { a: 1.87, b: 1.87 } } });
  axios.put.mockImplementation(async (_url, body) => {
    market = { ...market, ...body, revision: 2, status: 'PUBLISHING' };
    return { data: market };
  });
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: /Match award.*Draft/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Generate odds' }));
  await screen.findByText(/Price preview/);
  expect(axios.put).not.toHaveBeenCalled();
  expect(axios.post).toHaveBeenCalledWith('/api/event/events/event-a/markets/preview', {
    definition: manualDefinition, parameters: {}, generation: { method: 'EQUAL_CHANCE' },
  });
  fireEvent.change(screen.getByLabelText('Nominee A: decimal odds'), { target: { value: '1.9' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Publish market' })); });
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith('/api/backoffice/events/event-a/markets/market-a', {
    revision: 1, parameters: {}, availability: 'OPEN', publish: true,
    pricing: { method: 'OPERATOR', odds: { a: 1.9, b: 1.87 } },
  }));
  expect(await screen.findByText(/Configuration saved/)).toBeInTheDocument();
});

it('requires a separate immutable manual-result review and keeps the decision locked', async () => {
  axios.post.mockImplementation(async (_url, body) => {
    market = { ...market, decision: body, resultPublicationPending: true };
    return { data: { decision: body, publication: 'PENDING' } };
  });
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: /Match award.*Published/ }));
  fireEvent.click(screen.getByLabelText('Nominee A'));
  fireEvent.click(screen.getByRole('button', { name: 'Review final decision' }));
  expect(axios.post).not.toHaveBeenCalled();
  expect(screen.getByText(/This decision cannot be changed/)).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm final decision' })); });
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/backoffice/events/event-a/markets/market-a/result', {
    requestId: expect.any(String), revision: 2, result: 'SETTLED', winningOutcomeKeys: ['a'],
  }));
  expect(await screen.findByText(/Locked result: Nominee A/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Confirm final decision' })).not.toBeInTheDocument();
});

it('saves reusable custom definitions with a stable request id after an uncertain response', async () => {
  axios.post.mockRejectedValueOnce(new Error('Connection interrupted'))
    .mockResolvedValueOnce({ data: { templateId: 'new-template', versions: [{ ...template, version: 1 }] } });
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  fireEvent.click(await screen.findByText('Reusable template library'));
  fireEvent.click(screen.getByRole('button', { name: 'Create custom template' }));
  const form = screen.getByRole('group', { name: 'Create reusable template' });
  fireEvent.change(within(form).getByLabelText('Template name'), { target: { value: 'New award' } });
  fireEvent.change(within(form).getByLabelText('Settlement terms'), { target: { value: 'Operator declares the winner.' } });
  const outcomes = within(form).getAllByLabelText('Outcome label');
  fireEvent.change(outcomes[0], { target: { value: 'First nominee' } });
  fireEvent.change(outcomes[1], { target: { value: 'Second nominee' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted');
  fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
  expect(axios.post.mock.calls[1][1]).toEqual(axios.post.mock.calls[0][1]);
  expect(axios.post.mock.calls[0][1].definition).toMatchObject({
    name: 'New award', settlementMode: 'MANUAL', outcomes: [{ key: 'first', label: 'First nominee' }, { key: 'second', label: 'Second nominee' }],
  });
  await screen.findByText(/Template saved/);
});

it('preserves unsaved inputs after a concurrent revision until the operator explicitly reloads', async () => {
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: /Match award.*Published/ }));
  fireEvent.change(screen.getByLabelText('Nominee A: decimal odds'), { target: { value: '2.25' } });
  market = { ...market, revision: 3, pricing: { method: 'OPERATOR', odds: { a: 3.5, b: 2 } } };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your unsaved inputs are still shown.');
  expect(screen.getByLabelText('Nominee A: decimal odds')).toHaveValue(2.25);
  expect(screen.getByRole('button', { name: 'Publish market' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits and reload market' }));
  expect(screen.getByLabelText('Nominee A: decimal odds')).toHaveValue(3.5);
  expect(screen.getByRole('button', { name: 'Publish market' })).toBeEnabled();
});

it('does not expose a late quote to a different authenticated owner', async () => {
  let resolveQuote;
  axios.post.mockImplementation(() => new Promise((resolve) => { resolveQuote = resolve; }));
  const page = (owner) => <MemoryRouter initialEntries={['/events/event-a/markets']}>
    <Routes><Route path="/events/:eventId/markets" element={<EventMarkets currentUser={{ id: owner }} />} /></Routes>
  </MemoryRouter>;
  const rendered = render(page('first-owner'));
  fireEvent.click(await screen.findByRole('button', { name: 'Nominee A 2.00' }));
  fireEvent.click(screen.getByRole('button', { name: 'Get quote' }));
  await waitFor(() => expect(resolveQuote).toEqual(expect.any(Function)));
  rendered.rerender(page('second-owner'));
  await screen.findByRole('button', { name: 'Nominee A 2.00' });
  await act(async () => { resolveQuote({ data: quote() }); });
  expect(screen.queryByRole('button', { name: 'Add quoted selection to slip' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Get quote' })).toBeDisabled();
});

it('preserves accepted odds while treating retained void exposures as one for returns', () => {
  const bet = { rows: [{ status: 'VOID', oddsValue: 5 }, { status: 'WIN', oddsValue: 3 }] };
  expect(Number(acceptedOddsForBet(bet))).toBe(15);
  expect(possibleReturn(1000, settlementOddsForBet(bet))).toBe('30.00');
});
