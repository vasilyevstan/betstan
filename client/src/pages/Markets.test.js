import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import axios from 'axios';
import ProductCustomMarkets from './event/product/ProductCustomMarkets';
import BackofficeMarkets from './account/BackofficeMarkets';
import { acceptedOddsForBet, possibleReturn, settlementOddsForBet } from '../cashBackUtils';
import { extractSelectionKeysFromBoards } from '../liveBettingUtils';
import { gridLayout } from '../marketLayout';

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
  <Routes><Route path="/backoffice/events/:eventId/markets" element={component} /></Routes>
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

const renderCard = (props = {}) => render(<ProductCustomMarkets eventId="event-a" eventName="Home - Away"
  resulted={false} selectedSelectionKeys={new Set()} {...props} />);
const acceptQuotes = () => axios.post.mockImplementation(async (url) => {
  if (url === '/api/event/events/event-a/market-quotes') return { data: { ...quote(), kind: 'SINGLE' } };
  if (url === '/api/slip/market-selection') return { data: { accepted: true } };
  throw new Error(`Unexpected POST ${url}`);
});
const outcome = (label) => `Select Match award ${label} in Home - Away at 2.00`;

it('shows published markets on the match card and adds an outcome to the slip in one click', async () => {
  acceptQuotes();
  const placed = jest.fn();
  const selectedSelectionKeys = extractSelectionKeysFromBoards({ PRE_MATCH: { rows: [{ eventId: 'event-a',
    marketBet: { kind: 'SINGLE', selections: [{ origin: 'TEMPLATE', marketId: 'market-a', outcomeKey: 'b' }] } }] } });
  renderCard({ onSelectionPlaced: placed, selectedSelectionKeys });
  expect(await screen.findByRole('heading', { name: 'Match award' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: outcome('Nominee B') })).toHaveAttribute('aria-pressed', 'true');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: outcome('Nominee A') })); });
  await waitFor(() => expect(placed).toHaveBeenCalledTimes(1));
  expect(axios.post.mock.calls).toEqual([
    ['/api/event/events/event-a/market-quotes', { requestId: expect.any(String), kind: 'SINGLE',
      selections: [{ origin: 'TEMPLATE', marketId: 'market-a', outcomeKey: 'a', quoteRevision: 2 }] }],
    ['/api/slip/market-selection', { quoteId: 'quote-a', expectedBoardRevision: null, expectedBoardFingerprint: null,
      replaceEventSelections: false }],
  ]);
});

it('asks before replacing another selection from the same match and refreshes its own selection silently', async () => {
  acceptQuotes();
  boards.PRE_MATCH = { status: 'DRAFT', boardRevision: 4, boardFingerprint: 'reviewed-board',
    rows: [{ eventId: 'event-a', productName: '1X2', oddsName: 'Home', oddsValue: 2 }] };
  renderCard();
  fireEvent.click(await screen.findByRole('button', { name: outcome('Nominee A') }));
  const replace = await screen.findByRole('button', { name: 'Replace with Nominee A' });
  expect(replace).toHaveFocus();
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Keep current' }));
  expect(screen.queryByRole('button', { name: 'Replace with Nominee A' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: outcome('Nominee A') }));
  const confirm = await screen.findByRole('button', { name: 'Replace with Nominee A' });
  await act(async () => { fireEvent.click(confirm); });
  await waitFor(() => expect(axios.post).toHaveBeenLastCalledWith('/api/slip/market-selection', {
    quoteId: 'quote-a', expectedBoardRevision: 4, expectedBoardFingerprint: 'reviewed-board', replaceEventSelections: true,
  }));
  axios.post.mockClear();
  boards.PRE_MATCH.rows = [{ eventId: 'event-a', marketBet: { kind: 'SINGLE',
    selections: [{ origin: 'TEMPLATE', marketId: 'market-a', outcomeKey: 'a' }] } }];
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: outcome('Nominee A') })); });
  await waitFor(() => expect(axios.post).toHaveBeenLastCalledWith('/api/slip/market-selection', expect.objectContaining({
    replaceEventSelections: true,
  })));
  expect(screen.queryByRole('button', { name: 'Replace with Nominee A' })).not.toBeInTheDocument();
});

it('explains sign-in and board conflicts inline and refreshes the slip after a conflict', async () => {
  const placed = jest.fn();
  axios.post.mockRejectedValueOnce({ response: { status: 401, data: { message: 'Sign in to generate a betting quote' } } })
    .mockResolvedValueOnce({ data: { ...quote(), kind: 'SINGLE' } })
    .mockRejectedValueOnce({ response: { status: 409, data: { message: 'Your board changed.' } } });
  renderCard({ onSelectionPlaced: placed });
  const select = await screen.findByRole('button', { name: outcome('Nominee A') });
  await act(async () => { fireEvent.click(select); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Log in to add this selection to your slip.');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: outcome('Nominee A') })); });
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Your board changed.'));
  expect(placed).toHaveBeenCalledTimes(1);
});

it('shows nothing for resulted events or when custom markets are not open', async () => {
  const { container, rerender } = renderCard({ resulted: true });
  expect(axios.get).not.toHaveBeenCalled();
  catalog = { ...catalog, enabled: false };
  rerender(<ProductCustomMarkets eventId="event-a" resulted={false} selectedSelectionKeys={new Set()} />);
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/event/events/event-a/markets'));
  expect(container).toBeEmptyDOMElement();
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
  expect(await screen.findByText(/Publishing\. The market goes live/)).toBeInTheDocument();
  market = { ...market, status: 'PUBLISHED', publishedConfiguration: configuration };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('Published. It now shows on the match card.')).toBeInTheDocument();
  expect(screen.queryByText(/Publishing\. The market goes live/)).not.toBeInTheDocument();
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
  fireEvent.click(await screen.findByRole('tab', { name: 'Template library' }));
  fireEvent.click(screen.getByRole('button', { name: 'New template' }));
  const form = screen.getByRole('group', { name: 'New template' });
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
    name: 'New award', settlementMode: 'MANUAL', outcomes: [{ key: 'first-nominee', label: 'First nominee' }, { key: 'second-nominee', label: 'Second nominee' }],
  });
  await screen.findByText(/Template saved/);
});

it('preserves unsaved inputs after a concurrent revision until the operator explicitly reloads', async () => {
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: /Match award.*Published/ }));
  fireEvent.change(screen.getByLabelText('Nominee A: decimal odds'), { target: { value: '2.25' } });
  market = { ...market, revision: 3, pricing: { method: 'OPERATOR', odds: { a: 3.5, b: 2 } } };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your unsaved inputs are still shown.');
  expect(screen.getByLabelText('Nominee A: decimal odds')).toHaveValue(2.25);
  expect(screen.getByRole('button', { name: 'Publish market' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Discard edits and reload market' }));
  expect(screen.getByLabelText('Nominee A: decimal odds')).toHaveValue(3.5);
  expect(screen.getByRole('button', { name: 'Publish market' })).toBeEnabled();
});

const totalGoals = {
  schemaVersion: 1, name: 'Total goals', settlementMode: 'FINAL_SCORE', outcomeMode: 'EXCLUSIVE', coverage: 'COMPLETE', terms: '',
  parameters: [{ key: 'line', label: 'Goals line', minimum: 0.5, maximum: 20.5, defaultValue: 2.5 }],
  outcomes: [
    { key: 'over', label: 'Over', rule: { kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'GT', value: { parameter: 'line' } } },
    { key: 'under', label: 'Under', rule: { kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'LT', value: { parameter: 'line' } } },
  ],
};
const overrideGet = (routes) => {
  const base = axios.get.getMockImplementation();
  axios.get.mockImplementation(async (url) => (routes[url] ? { data: routes[url]() } : base(url)));
};

it('creates a manual market in one step and reuses its saved template when the draft request is retried', async () => {
  market = undefined;
  overrideGet({ '/api/backoffice/events/event-a/markets': () => ({ enabled: true, event, markets: market ? [market] : [] }) });
  let marketAttempts = 0;
  axios.post.mockImplementation(async (url, body) => {
    if (url === '/api/backoffice/market-templates') {
      return { data: { templateId: 'quick-template', revision: 1, archived: false,
        versions: [{ id: 'quick-template', version: 1, definition: body.definition }] } };
    }
    marketAttempts += 1;
    if (marketAttempts === 1) throw new Error('Connection interrupted');
    market = { ...configuration, marketId: 'market-new', revision: 1, status: 'DRAFT', pricing: undefined,
      template: { id: 'quick-template', version: 1, definition: { ...manualDefinition, name: 'Player of the match' } } };
    return { data: { marketId: 'market-new' } };
  });
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  expect(await screen.findByText('Add a market to start.')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add market' }));
  expect(screen.getByRole('radio', { name: /Manual market/ })).toBeChecked();
  fireEvent.change(screen.getByLabelText('Market name'), { target: { value: 'Player of the match' } });
  fireEvent.change(screen.getByLabelText('Outcome 1'), { target: { value: 'Home captain' } });
  fireEvent.change(screen.getByLabelText('Outcome 2'), { target: { value: 'Away captain' } });
  fireEvent.change(screen.getByLabelText('How the result is decided'), { target: { value: 'Official award.' } });
  expect(document.querySelector('.market-add .market-player-preview'))
    .toHaveTextContent(/Player preview.*Player of the match.*Home captain.*Away captain/);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create draft' })); });
  expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create draft' })); });
  expect(await screen.findByText(/Draft created\. Set the odds, then publish\./)).toBeInTheDocument();
  const templateCalls = axios.post.mock.calls.filter(([url]) => url === '/api/backoffice/market-templates');
  const marketCalls = axios.post.mock.calls.filter(([url]) => url === '/api/backoffice/events/event-a/markets');
  expect(templateCalls).toHaveLength(1);
  expect(templateCalls[0][1].definition).toMatchObject({ name: 'Player of the match', settlementMode: 'MANUAL', terms: 'Official award.',
    outcomes: [{ key: 'home-captain', label: 'Home captain' }, { key: 'away-captain', label: 'Away captain' }] });
  expect(templateCalls[0][1].layout.tiles.map((tile) => tile.outcomeKey)).toEqual(['home-captain', 'away-captain']);
  expect(marketCalls).toHaveLength(2);
  expect(marketCalls[1][1]).toEqual(marketCalls[0][1]);
  expect(marketCalls[0][1]).toMatchObject({ templateId: 'quick-template', templateVersion: 1, parameters: {} });
  expect(await screen.findByRole('heading', { name: 'Player of the match' })).toHaveFocus();
});

it('explains why automatic markets are unavailable for an event without a pricing model', async () => {
  catalog = { ...catalog, hasRetainedModel: false };
  overrideGet({ '/api/backoffice/market-templates': () => ({
    enabled: true, templates: [], starters: [{ id: 'total-goals', definition: totalGoals }],
  }) });
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  expect(await screen.findByText(/no pricing model, so automatic markets are unavailable/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Add market' }));
  expect(screen.getByRole('radio', { name: /Total goals.*Needs a pricing model/ })).toBeDisabled();
  expect(screen.getByRole('radio', { name: /Total goals/ }).closest('label')).toHaveTextContent(/Total goals 2\.5.*Over.*Under/);
  expect(screen.getByRole('radio', { name: /Manual market/ })).toBeEnabled();
});

it('saves a draft without incomplete odds and states why it cannot be published yet', async () => {
  market = { ...market, revision: 1, status: 'DRAFT', pricing: undefined, publishedConfiguration: undefined };
  axios.put.mockImplementation(async (_url, body) => ({ data: (market = { ...market, revision: 2 }) }));
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: /Match award.*Draft/ }));
  const publish = screen.getByRole('button', { name: 'Publish market' });
  expect(publish).toBeDisabled();
  expect(publish).toHaveAccessibleDescription('Enter odds from 1.01 to 1000 for every outcome.');
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save draft' })); });
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith('/api/backoffice/events/event-a/markets/market-a', {
    revision: 1, parameters: {}, availability: 'OPEN', publish: false,
  }));
  expect(await screen.findByText(/Draft saved without odds/)).toBeInTheDocument();
});

it('keeps manual results available but explains that authoring is off', async () => {
  overrideGet({ '/api/backoffice/events/event-a/markets': () => ({ enabled: false, event, markets: [market] }) });
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  expect(await screen.findByText(/Market authoring is off/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add market' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: /Match award.*Published/ }));
  expect(screen.getByRole('button', { name: 'Review final decision' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('Nominee A'));
  expect(screen.getByRole('button', { name: 'Review final decision' })).toBeEnabled();
});

it('preserves accepted odds while treating retained void exposures as one for returns', () => {
  const bet = { rows: [{ status: 'VOID', oddsValue: 5 }, { status: 'WIN', oddsValue: 3 }] };
  expect(Number(acceptedOddsForBet(bet))).toBe(15);
  expect(possibleReturn(1000, settlementOddsForBet(bet))).toBe('30.00');
});

it('offers locked standard designs without permitting duplicate markets or editing them', async () => {
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  fireEvent.click(await screen.findByRole('button', { name: 'Add market' }));
  for (const name of ['1X2', 'Correct Score']) {
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(`^${name} Locked`) }));
    expect(screen.getByText(/Its layout, outcomes and rules cannot be changed here/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Customize design and outcomes' })).not.toBeInTheDocument();
  }
  expect(axios.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: /Match award.*Template v1/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Customize design and outcomes' }));
  expect(screen.getByRole('group', { name: 'Market layout canvas' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save design and create draft' })).toBeEnabled();
});

it('keeps dragged and resized tile positions while outcome labels and keys change', async () => {
  axios.post.mockResolvedValue({ data: { templateId: 'designed', versions: [{ ...template, version: 1 }] } });
  renderRoute(<BackofficeMarkets />, '/backoffice/events/event-a/markets');
  fireEvent.click(await screen.findByRole('tab', { name: 'Template library' }));
  fireEvent.click(screen.getByRole('button', { name: 'New template' }));
  fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Award layout' } });
  fireEvent.change(screen.getByLabelText('Settlement terms'), { target: { value: 'Declared by the operator.' } });
  const inputs = screen.getAllByLabelText('Outcome label');
  fireEvent.change(inputs[0], { target: { value: 'Captain' } });
  fireEvent.change(inputs[1], { target: { value: 'Keeper' } });
  fireEvent.click(screen.getByRole('button', { name: 'Design Keeper' }));
  fireEvent.click(screen.getByRole('button', { name: 'Place Keeper at row 2, column 1' }));
  fireEvent.change(screen.getByLabelText('Tile width'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Tile height'), { target: { value: '2' } });
  fireEvent.change(screen.getByLabelText('Selected outcome'), { target: { value: 'Goalkeeper' } });
  expect(screen.getByLabelText('Selected outcome')).toHaveValue('Goalkeeper');
  expect(screen.getByRole('button', { name: 'Design Goalkeeper' })).toHaveStyle({ gridColumn: '1 / span 2', gridRow: '2 / span 2' });
  fireEvent.click(screen.getByRole('button', { name: 'Up', exact: true }));
  expect(screen.getByRole('alert')).toHaveTextContent('That space is occupied');
  expect(screen.getByRole('button', { name: 'Design Goalkeeper' })).toHaveStyle({ gridRow: '2 / span 2' });
  fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/backoffice/market-templates', expect.objectContaining({
    definition: expect.objectContaining({ outcomes: [{ key: 'captain', label: 'Captain' }, { key: 'goalkeeper', label: 'Goalkeeper' }] }),
    layout: { version: 1, columns: 2, tileShape: 'rounded', tiles: [
      { outcomeKey: 'captain', row: 1, column: 1, width: 1, height: 1 },
      { outcomeKey: 'goalkeeper', row: 2, column: 1, width: 2, height: 2 },
    ] },
  })));
});

it('renders the event snapshot design without changing outcome identity or quoted odds', async () => {
  market.layout = { ...gridLayout(manualDefinition.outcomes), tileShape: 'pill',
    tiles: [{ outcomeKey: 'b', row: 1, column: 1, width: 2, height: 1 },
      { outcomeKey: 'a', row: 2, column: 2, width: 1, height: 2 }] };
  acceptQuotes();
  renderCard();
  const nominee = await screen.findByRole('button', { name: outcome('Nominee A') });
  await waitFor(() => expect(nominee.parentElement).toHaveStyle({ gridColumn: '2 / span 1', gridRow: '2 / span 2' }));
  expect(nominee.parentElement.parentElement).toHaveClass('market-layout--pill');
  fireEvent.click(nominee);
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/event/events/event-a/market-quotes', expect.objectContaining({
    selections: [{ origin: 'TEMPLATE', marketId: 'market-a', outcomeKey: 'a', quoteRevision: 2 }],
  })));
});

it('keeps betting available with a clear standard-layout notice if presentation cannot be loaded', async () => {
  const base = axios.get.getMockImplementation();
  axios.get.mockImplementation((url) => url.startsWith('/api/backoffice/events/')
    ? Promise.reject(new Error('Presentation unavailable')) : base(url));
  renderCard();
  expect(await screen.findByRole('status')).toHaveTextContent('Markets use the standard layout.');
  expect(screen.getByRole('button', { name: outcome('Nominee A') })).toBeEnabled();
});

it.each(['market', 'template', 'version'])('never attaches a design from a different %s identity', async (mismatch) => {
  market.layout = gridLayout(manualDefinition.outcomes, 1);
  market = { ...market, template: { ...market.template } };
  if (mismatch === 'market') market.marketId = 'another-market';
  if (mismatch === 'template') market.template.id = 'another-template';
  if (mismatch === 'version') market.template.version = 2;
  renderCard();
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith('/api/backoffice/events/event-a/markets'));
  expect(screen.getByRole('button', { name: outcome('Nominee A') }).parentElement).toHaveClass('product-custom-grid');
});
