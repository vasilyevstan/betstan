import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import App from '../../App';
import MyBets from './MyBets';
import useMyBets from '../../hook/useMyBets';
import { cashBackReason, CASH_BACK_POLL_MS, storageKey } from '../../cashBackUtils';
import { accepted, bet, financial, quoted, rejected } from '../../../tests/fixtures/cashBack';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
jest.mock('../../Header', () => () => null);
jest.mock('../event/EventList', () => () => null);
jest.mock('../Slip', () => () => null);
jest.mock('./Statistics', () => () => null);

const currentUser = { id: 'cash-back-owner' };
const originalCrypto = window.crypto;
const copy = (value) => JSON.parse(JSON.stringify(value));
const response = (data, status = 200) => ({ data: copy(data), status });
const httpError = (status, code) => ({ response: { status, data: { errors: [{ code, message: code }] } } });
const mount = (props = {}) => render(<MyBets currentUser={currentUser} {...props} />);
const mountAccountApp = () => render(<MemoryRouter initialEntries={['/bets']}><App /></MemoryRouter>);
const card = (slipId = 'slip-one') => document.querySelector(`[data-slip-id="${slipId}"]`);
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const advance = async (ms) => act(async () => { jest.advanceTimersByTime(ms); });

const installApi = (options = {}) => {
  const state = {
    bets: options.bets ?? [bet()], operations: {}, history: { items: [], nextCursor: null },
    nextHistory: null, confirm: options.confirm, quote: options.quote,
  };
  axios.get.mockImplementation(async (url) => {
    if (url === '/api/bet') return response(state.bets);
    if (url.includes('/history')) return response(url.includes('?') ? state.nextHistory : state.history);
    const operation = Object.values(state.operations).find((item) => url.endsWith(item.operationId));
    if (operation) return response(operation, ['QUOTE_PENDING', 'CONFIRM_PENDING'].includes(operation.state) ? 202 : 200);
    throw new Error(`Unexpected test GET: ${url}`);
  });
  axios.post.mockImplementation(async (url, body) => {
    const slipId = decodeURIComponent(url.split('/')[3]);
    if (url.endsWith('/quote')) {
      const existing = state.operations[body.clientOperationId];
      if (existing) return response(existing, ['QUOTE_PENDING', 'CONFIRM_PENDING'].includes(existing.state) ? 202 : 200);
      const offer = quoted(body, { slipId, financial: state.bets.find((entry) => entry.slipId === slipId)?.cashBackFinancial });
      const operation = state.quote ? state.quote(offer) : offer;
      state.operations[body.clientOperationId] = operation;
      return response(operation);
    }
    const original = state.operations[body.clientOperationId];
    if (!original) throw httpError(404, 'OPERATION_NOT_FOUND');
    if (body.quoteId !== original.quote?.quoteId) throw httpError(409, 'QUOTE_CHANGED');
    const operation = state.confirm ? state.confirm(original) : { ...original, state: 'CONFIRM_PENDING' };
    state.operations[body.clientOperationId] = operation;
    if (operation.state === 'ACCEPTED') {
      state.bets = state.bets.map((entry) => entry.slipId === operation.slipId
        ? { ...entry, status: operation.receipt.financial.status, cashBackFinancial: operation.receipt.financial } : entry);
      state.history.items.unshift(operation.receipt);
    }
    return response(operation, operation.state === 'CONFIRM_PENDING' ? 202 : 200);
  });
  return state;
};

const getOffer = async ({ partial } = {}) => {
  await screen.findByText('Northern Falcons - Southern Owls');
  if (partial !== undefined) {
    fireEvent.click(within(card()).getByRole('button', { name: 'Partial stake' }));
    fireEvent.change(within(card()).getByLabelText('Stake to close (Stanbucks)'), { target: { value: partial } });
  }
  fireEvent.click(within(card()).getByRole('button', { name: /Get (cash-back|new) offer/ }));
  return within(card()).findByRole('button', { name: partial === undefined ? 'Confirm full cash back' : 'Confirm partial cash back' });
};

// A server quote/receipt is not a readiness signal for the local restoration effect.
const findRestoredPartialInput = async (amount) => {
  const input = await screen.findByLabelText('Stake to close (Stanbucks)');
  await waitFor(() => {
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue(amount);
    expect(screen.getByRole('button', { name: 'Partial stake' })).toHaveAttribute('aria-pressed', 'true');
  });
  return input;
};

beforeEach(() => {
  let nextId = 0;
  Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => `test-operation-${++nextId}` } });
  localStorage.clear();
  axios.get.mockReset();
  axios.post.mockReset();
});
afterEach(() => {
  jest.useRealTimers();
  localStorage.clear();
  Object.defineProperty(window, 'crypto', { configurable: true, value: originalCrypto });
});

it('shows the exact partial offer and all original identities before a separate confirmation, without repricing', async () => {
  const state = installApi({ confirm: accepted });
  mount();
  const confirm = await getOffer({ partial: '40.00' });
  const offer = card().querySelector('.cash-back-offer');
  expect(offer).toHaveTextContent('Stake to close40.00 Stanbucks');
  expect(offer).toHaveTextContent('Quoted nominal return20.00 Stanbucks');
  expect(offer).toHaveTextContent('Original wager100.00 Stanbucks');
  expect(offer).toHaveTextContent('Accepted total odds3');
  expect(offer).toHaveTextContent('Remaining stake after cash back60.00 Stanbucks');
  expect(offer).toHaveTextContent('Possible return on remaining stake180.00 Stanbucks');
  expect(within(offer).getByRole('list', { name: 'All original selections for this offer' })).toHaveTextContent('Northern Falcons - Southern Owls · 1X2 · Northern Falcons');
  expect(axios.post).toHaveBeenCalledTimes(1);
  const request = axios.post.mock.calls[0][1];
  expect(request).toEqual({ action: 'QUOTE', clientOperationId: expect.any(String), portion: { mode: 'PARTIAL', stakeMinor: 4000 } });
  expect(state.bets[0].wager).toBe(100);
  fireEvent.click(confirm);
  await screen.findByText('Cash back recorded. The receipt below is authoritative.');
  expect(axios.post.mock.calls[1][1]).toEqual({ action: 'CONFIRM', clientOperationId: request.clientOperationId,
    quoteId: state.operations[request.clientOperationId].quote.quoteId });
  expect(card()).toHaveTextContent('PARTIAL CASH BACK');
  expect(card()).toHaveTextContent('Cumulative closed principal: 40.00');
  expect(card()).toHaveTextContent('Cumulative recorded nominal return: 20.00');
  expect(card()).toHaveTextContent('Possible return on remaining stake: 180.00');
  expect(screen.getByLabelText('Stake to close (Stanbucks)')).toHaveValue(40);
  expect(document.body).not.toHaveTextContent(/paid|credited|funds transferred/i);
});

it.each(['0', '-1', '40.001', '100', '100.01'])('strictly rejects partial %s without changing the amount or switching to full', async (amount) => {
  installApi();
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  fireEvent.click(screen.getByRole('button', { name: 'Partial stake' }));
  const input = screen.getByLabelText('Stake to close (Stanbucks)');
  fireEvent.change(input, { target: { value: amount } });
  fireEvent.click(screen.getByRole('button', { name: 'Get cash-back offer' }));
  expect(screen.getByRole('alert')).toHaveTextContent('A partial must leave at least 0.01');
  expect(input).toHaveValue(Number(amount));
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(document.getElementById(input.getAttribute('aria-describedby').split(' ').at(-1))).toHaveAttribute('role', 'alert');
  expect(screen.getByRole('button', { name: 'Partial stake' })).toHaveAttribute('aria-pressed', 'true');
  expect(axios.post).not.toHaveBeenCalled();
});

it('invalidates edits/expiry, preserves the input, and requires a new identity plus explicit confirmation for a changed offer', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  installApi();
  mount();
  const confirm = await getOffer({ partial: '40.00' });
  const firstBody = axios.post.mock.calls[0][1];
  fireEvent.change(screen.getByLabelText('Stake to close (Stanbucks)'), { target: { value: '30.00' } });
  expect(confirm).toBeDisabled();
  expect(screen.getByText(/This offer is no longer current/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Get new offer' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm partial cash back' })).toBeEnabled());
  expect(axios.post.mock.calls[1][1].clientOperationId).not.toBe(firstBody.clientOperationId);
  await advance(7001);
  expect(screen.getByRole('button', { name: 'Confirm partial cash back' })).toBeDisabled();
  expect(screen.getByText(cashBackReason('QUOTE_EXPIRED'))).toBeInTheDocument();
  expect(screen.getByLabelText('Stake to close (Stanbucks)')).toHaveValue(30);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm partial cash back' }));
  expect(axios.post.mock.calls.every(([url]) => url.endsWith('/quote'))).toBe(true);
});

it.each([
  'BET_NOT_CONFIRMED', 'SELECTION_RESOLVED', 'PRE_MATCH_CUTOFF', 'MARKET_UNAVAILABLE',
  'QUOTE_EXPIRED', 'QUOTE_CHANGED', 'STALE_REVISION', 'INVALID_AMOUNT',
  'LEGACY_PRECISION_UNSUPPORTED', 'AUTHORITY_UNAVAILABLE', 'OPERATION_CONFLICT', 'RESERVATION_DENIED',
])('explains server unavailability %s without treating local CONFIRMED as eligibility', async (reason) => {
  installApi({ quote: (offer) => ({ ...offer.quote.operation, state: 'UNAVAILABLE', reason }) });
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  fireEvent.click(screen.getByRole('button', { name: 'Get cash-back offer' }));
  await screen.findByText(`Cash back unavailable. ${cashBackReason(reason)}`);
  expect(screen.queryByRole('button', { name: 'Confirm full cash back' })).not.toBeInTheDocument();
});

it.each([
  [404, 'BET_NOT_FOUND'], [409, 'OPERATION_CONFLICT'], [400, 'INVALID_REQUEST'], [503, 'CASH_BACK_UNAVAILABLE'],
])('shows actionable facade failure %s/%s', async (status, code) => {
  installApi();
  axios.post.mockRejectedValue(httpError(status, code));
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  fireEvent.click(screen.getByRole('button', { name: 'Get cash-back offer' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(cashBackReason(code));
  expect(screen.queryByText('Cash back recorded. The receipt below is authoritative.')).not.toBeInTheDocument();
});

it('separates durable rejection from transport failure and requires a fresh offer', async () => {
  installApi({ confirm: (offer) => rejected(offer, 'STALE_REVISION') });
  mount();
  fireEvent.click(await getOffer());
  await within(card()).findByText(`Cash back rejected. ${cashBackReason('STALE_REVISION')}`);
  expect(screen.getByRole('button', { name: 'Confirm full cash back' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Get new offer' })).toBeEnabled();
  expect(card()).toHaveTextContent('Original wager: 100.00');
  expect(screen.queryByText('Cash back recorded. The receipt below is authoritative.')).not.toBeInTheDocument();
});

it('recovers a lost initial quote response on reload by retrying the identical POST, never an invented lookup', async () => {
  installApi();
  axios.post.mockRejectedValueOnce(new Error('response lost'));
  const first = mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  fireEvent.click(screen.getByRole('button', { name: 'Partial stake' }));
  fireEvent.change(screen.getByLabelText('Stake to close (Stanbucks)'), { target: { value: '40.00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Get cash-back offer' }));
  await screen.findByText(/Network failure/);
  const original = copy(axios.post.mock.calls[0][1]);
  first.unmount();
  mount();
  await screen.findByRole('button', { name: 'Confirm partial cash back' });
  expect(axios.post.mock.calls[1][1]).toEqual(original);
  expect(axios.get.mock.calls.some(([url]) => url.includes('/operations/'))).toBe(false);
  await findRestoredPartialInput(40);
});

it('keeps uncertain consent locked past browser expiry and recovers its accepted receipt after reload', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  const state = installApi();
  const first = mount();
  const confirm = await getOffer({ partial: '40.00' });
  const post = axios.post.getMockImplementation();
  axios.post.mockImplementation(async (url, body, config) => {
    const result = await post(url, body, config);
    if (url.endsWith('/accept')) throw new Error('lost after durable registration');
    return result;
  });
  fireEvent.click(confirm);
  await screen.findByText(/Network failure/);
  await advance(9000);
  expect(screen.getByText(/Confirmation pending/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Get new offer' })).toBeDisabled();
  expect(confirm).toBeDisabled();
  expect(screen.queryByText(cashBackReason('QUOTE_EXPIRED'))).not.toBeInTheDocument();
  const id = Object.keys(state.operations)[0];
  state.operations[id] = accepted(state.operations[id]);
  first.unmount();
  mount();
  await screen.findByText('Cash back recorded. The receipt below is authoritative.');
  await findRestoredPartialInput(40);
  expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/accept'))).toHaveLength(1);
  expect(card()).toHaveTextContent('Remaining stake: 60.00');
  expect(localStorage.length).toBe(0);
});

it('replays the saved confirmation after reload of an ambiguous unsubmitted POST, even if its quote has now expired', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  installApi();
  const first = mount();
  const confirm = await getOffer();
  axios.post.mockRejectedValueOnce(new Error('lost before registration'));
  fireEvent.click(confirm);
  await screen.findByText(/Network failure/);
  const consent = copy(axios.post.mock.calls[1][1]);
  await advance(8000);
  first.unmount();
  mount();
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(3));
  expect(axios.post.mock.calls[2][1]).toEqual(consent);
  expect(await screen.findByText(/Confirmation pending/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Full remainder' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.queryByText('Cash back recorded. The receipt below is authoritative.')).not.toBeInTheDocument();
});

it('never creates a quote or confirmation from consent planted before the real App resolves the owner login', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  const state = installApi({ confirm: accepted });
  const quoteRequest = { action: 'QUOTE', clientOperationId: 'planted', portion: { mode: 'FULL' } };
  const record = { slipId: 'slip-one', clientOperationId: 'planted', createdAt: Date.now(), quoteRequest,
    confirmRequest: { action: 'CONFIRM', clientOperationId: 'planted', quoteId: 'quote-planted' } };
  const key = storageKey(currentUser.id, record);
  localStorage.setItem(key, JSON.stringify(record));
  const login = deferred();
  const get = axios.get.getMockImplementation();
  axios.get.mockImplementation((url, config) => url === '/api/auth/currentuser' ? login.promise : get(url, config));
  mountAccountApp();
  expect(screen.getByText('Loading your account…')).toBeInTheDocument();
  expect(axios.post).not.toHaveBeenCalled();
  await act(async () => { login.resolve(response({ currentUser })); });
  await advance(CASH_BACK_POLL_MS * 3);
  fireEvent.focus(window);
  await advance(CASH_BACK_POLL_MS);
  expect(axios.post).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toHaveTextContent('Saved cash-back recovery data');
  expect(screen.getByRole('button', { name: 'Get cash-back offer' })).toBeDisabled();
  expect(state.operations).toEqual({});
  expect(card()).toHaveTextContent('Remaining stake: 100.00');
  expect(card()).not.toHaveTextContent(/Cash back recorded|Cash back rejected/);
  expect(localStorage.getItem(key)).toBe(JSON.stringify(record));
});

it('uses the real App auth refresh to isolate changed accounts and revoke failed recovery without sending consent', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  const state = installApi();
  const nextOwner = { id: 'next-owner' };
  const save = (owner, slipId, id) => {
    const quoteRequest = { action: 'QUOTE', clientOperationId: id, portion: { mode: 'PARTIAL', stakeMinor: 2000 } };
    const offer = quoted(quoteRequest, { slipId });
    const record = { slipId, clientOperationId: id, createdAt: Date.now(), operationId: offer.operationId, quoteRequest,
      confirmRequest: { action: 'CONFIRM', clientOperationId: id, quoteId: offer.quote.quoteId } };
    localStorage.setItem(storageKey(owner.id, record), JSON.stringify(record));
    state.operations[id] = { ...offer, state: 'CONFIRM_PENDING' };
    return offer;
  };
  const previous = save(currentUser, 'slip-one', 'previous-account');
  const next = save(nextOwner, 'next-slip', 'next-account');
  const late = deferred();
  const get = axios.get.getMockImplementation();
  let authenticated = currentUser;
  let denyRecovery = false;
  let previousSignal;
  axios.get.mockImplementation((url, config) => {
    if (url === '/api/auth/currentuser') return denyRecovery
      ? Promise.reject(new Error('auth unavailable')) : Promise.resolve(response({ currentUser: authenticated }));
    if (url.endsWith(previous.operationId)) { previousSignal = config.signal; return late.promise; }
    if (denyRecovery && url.endsWith(next.operationId)) return Promise.reject(httpError(401, 'AUTHENTICATION_REQUIRED'));
    return get(url, config);
  });
  mountAccountApp();
  await screen.findByText('Northern Falcons - Southern Owls');
  await waitFor(() => expect(previousSignal).toBeDefined());
  expect(axios.get.mock.calls.some(([url]) => url.endsWith(next.operationId))).toBe(false);
  authenticated = nextOwner;
  state.bets = [bet({ _id: 'next-bet', slipId: 'next-slip',
    rows: [{ ...bet().rows[0], eventName: 'Next account match' }] })];
  fireEvent.focus(window);
  await screen.findByText('Next account match');
  expect(previousSignal.aborted).toBe(true);
  await act(async () => { late.resolve(response(accepted(previous))); });
  expect(card()).toBeNull();
  expect(card('next-slip')).toHaveTextContent('Remaining stake: 100.00');
  expect(screen.queryByText(/Cash back recorded/)).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check confirmation status' })).toBeEnabled());
  denyRecovery = true;
  fireEvent.click(screen.getByRole('button', { name: 'Check confirmation status' }));
  await screen.findByText(/Log in to view your bets/);
  const lookups = axios.get.mock.calls.filter(([url]) => url.includes('/operations/')).length;
  await advance(CASH_BACK_POLL_MS * 3);
  expect(card('next-slip')).toBeNull();
  expect(axios.get.mock.calls.filter(([url]) => url.includes('/operations/'))).toHaveLength(lookups);
  expect(axios.post).not.toHaveBeenCalled();
});

it('never treats a 202 with an accepted-shaped body as acceptance', async () => {
  installApi();
  mount();
  const confirm = await getOffer();
  axios.post.mockImplementationOnce(async (url, body) => {
    const request = axios.post.mock.calls[0][1];
    return response(accepted(quoted(request)), 202);
  });
  fireEvent.click(confirm);
  expect(await screen.findByRole('alert')).toHaveTextContent('server response could not be verified');
  expect(screen.getByRole('button', { name: 'Get new offer' })).toBeDisabled();
  expect(card()).toHaveTextContent('Remaining stake: 100.00');
});

it('keeps completion feedback and moves focus only when the current filter removes its focused completed card', async () => {
  installApi({ confirm: accepted });
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  fireEvent.click(screen.getByRole('button', { name: 'CONFIRMED', exact: true }));
  const confirm = await getOffer();
  confirm.focus();
  fireEvent.click(confirm);
  await screen.findByText(/Full cash back recorded: 100.00/);
  expect(card()).toBeNull();
  expect(screen.getByRole('button', { name: 'CONFIRMED', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(document.activeElement).toBe(document.querySelector('.my-bets-feedback'));
  fireEvent.click(screen.getByRole('button', { name: 'CASH BACK', exact: true }));
  expect(card()).toHaveTextContent('CASH BACK');
  expect(card()).toHaveTextContent('Exposure closed by cash back');
  expect(card()).not.toHaveTextContent('Pending result');
  expect(card()).not.toHaveTextContent('Won');
});

it('preserves keyed input, focus, filters, sibling forms and expansion across refresh and another tab revision', async () => {
  const original = bet();
  const state = installApi({ bets: [
    bet({ rows: Array.from({ length: 5 }, (_, index) => ({ ...original.rows[0], _id: `row-${index}`, eventName: index ? `Selection event ${index}` : original.rows[0].eventName, oddsValue: index ? 1 : 3 })) }),
    bet({ _id: 'other-bet', slipId: 'other-slip', rows: [{ ...original.rows[0], _id: 'other-row', eventName: 'Other match' }] }),
  ] });
  mount();
  const confirm = await getOffer({ partial: '40.00' });
  fireEvent.click(screen.getByRole('button', { name: 'Show all selections (5)' }));
  const input = within(card()).getByLabelText('Stake to close (Stanbucks)');
  input.focus();
  const otherCard = card('other-slip');
  fireEvent.click(within(otherCard).getByRole('button', { name: 'Partial stake' }));
  fireEvent.change(within(otherCard).getByLabelText('Stake to close (Stanbucks)'), { target: { value: '12.34' } });
  input.focus();
  state.bets[0] = { ...state.bets[0], cashBackFinancial: financial({
    revision: 2, remainingStakeMinor: 6000, cumulativeClosedStakeMinor: 4000, cumulativeReturnMinor: 2000,
  }) };
  fireEvent(window, new StorageEvent('storage', { key: storageKey(currentUser.id, { clientOperationId: 'other-tab' }) }));
  await screen.findByText(/This offer is no longer current/);
  expect(confirm).toBeDisabled();
  expect(within(card()).getByLabelText('Stake to close (Stanbucks)')).toBe(input);
  expect(input).toHaveValue(40);
  expect(input).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Show less selections' })).toHaveAttribute('aria-expanded', 'true');
  expect(within(otherCard).getByLabelText('Stake to close (Stanbucks)')).toHaveValue(12.34);
  expect(within(otherCard).getByRole('button', { name: 'Get cash-back offer' })).toBeEnabled();
});

it('pins a restored offer instead of adopting another tab offer, and keeps the focused amount read-only during its pending consent', async () => {
  const state = installApi();
  const request = { action: 'QUOTE', clientOperationId: 'restored', portion: { mode: 'PARTIAL', stakeMinor: 4000 } };
  const original = quoted(request);
  const record = { slipId: 'slip-one', clientOperationId: 'restored', operationId: original.operationId, createdAt: Date.now(), quoteRequest: request };
  state.operations.restored = original;
  localStorage.setItem(storageKey(currentUser.id, record), JSON.stringify(record));
  mount();
  await screen.findByRole('button', { name: 'Confirm partial cash back' });
  const input = await findRestoredPartialInput(40);
  input.focus();
  const otherRequest = { action: 'QUOTE', clientOperationId: 'other-tab', portion: { mode: 'PARTIAL', stakeMinor: 2000 } };
  const other = quoted(otherRequest);
  state.operations['other-tab'] = { ...other, state: 'CONFIRM_PENDING' };
  const otherRecord = {
    slipId: 'slip-one', clientOperationId: 'other-tab', operationId: other.operationId, createdAt: Date.now() + 1,
    quoteRequest: otherRequest, confirmRequest: { action: 'CONFIRM', clientOperationId: 'other-tab', quoteId: other.quote.quoteId },
  };
  const key = storageKey(currentUser.id, otherRecord);
  localStorage.setItem(key, JSON.stringify(otherRecord));
  fireEvent(window, new StorageEvent('storage', { key }));
  await screen.findByText(/Confirmation pending/);
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute('readonly');
  expect(input).toHaveValue(40);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check confirmation status' })).toBeEnabled());
  axios.get.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Check confirmation status' }));
  await waitFor(() => expect(axios.get).toHaveBeenCalledWith(`/api/bet/slip-one/cash-back/operations/${other.operationId}`, expect.any(Object)));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check confirmation status' })).toBeEnabled());
  state.operations['other-tab'] = accepted(other);
  fireEvent(window, new StorageEvent('storage', { key }));
  await within(card()).findByText(/This offer is no longer current/);
  expect(card().querySelector('.cash-back-offer')).toHaveTextContent('Stake to close40.00');
  expect(input).toHaveFocus();
  expect(input).not.toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: 'Confirm partial cash back' })).toBeDisabled();
});

it('canonicalizes saved metadata once and does not echo unchanged lookup results between tabs', async () => {
  installApi();
  mount();
  await getOffer();
  const id = axios.post.mock.calls[0][1].clientOperationId;
  const key = storageKey(currentUser.id, { clientOperationId: id });
  const canonical = localStorage.getItem(key);
  const saved = JSON.parse(canonical);
  localStorage.setItem(key, JSON.stringify({
    operationId: saved.operationId, quoteRequest: saved.quoteRequest,
    createdAt: saved.createdAt, clientOperationId: saved.clientOperationId, slipId: saved.slipId,
  }));
  const writes = jest.spyOn(Storage.prototype, 'setItem');
  try {
    fireEvent(window, new StorageEvent('storage', { key }));
    await waitFor(() => expect(localStorage.getItem(key)).toBe(canonical));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm full cash back' })).toBeEnabled());
    expect(writes).toHaveBeenCalledTimes(1);
    const reads = axios.get.mock.calls.length;
    fireEvent.focus(window);
    await waitFor(() => expect(axios.get.mock.calls.length).toBeGreaterThan(reads));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm full cash back' })).toBeEnabled());
    expect(writes).toHaveBeenCalledTimes(1);
  } finally {
    writes.mockRestore();
  }
});

it('retains explicit consent racing an in-flight lookup and sends its exact body once, not a new operation', async () => {
  const state = installApi({ confirm: accepted });
  const { result } = renderHook(() => useMyBets({ ownerId: currentUser.id }));
  await waitFor(() => expect(result.current.bets).toHaveLength(1));
  let id;
  act(() => { id = result.current.requestQuote('slip-one', { mode: 'PARTIAL', stakeMinor: 4000 }); });
  await waitFor(() => expect(result.current.operations[id]?.state).toBe('QUOTED'));
  const lookup = deferred();
  const previousGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url) => url.includes('/operations/') ? lookup.promise : previousGet(url));
  fireEvent.focus(window);
  await waitFor(() => expect(result.current.network[id]?.busy).toBe(true));
  act(() => result.current.confirm(id));
  const consent = { action: 'CONFIRM', clientOperationId: id, quoteId: state.operations[id].quote.quoteId };
  expect(JSON.parse(localStorage.getItem(storageKey(currentUser.id, { clientOperationId: id }))).confirmRequest).toEqual(consent);
  await act(async () => { lookup.resolve(response(state.operations[id])); });
  await waitFor(() => expect(result.current.operations[id]?.state).toBe('ACCEPTED'));
  const confirmations = axios.post.mock.calls.filter(([url]) => url.endsWith('/accept'));
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0][1]).toEqual(consent);
  expect(result.current.actionErrors['slip-one']).toBeFalsy();
});

it('retains repeated partial histories and cumulative totals after remainder settlement, with no active exposure', async () => {
  const one = accepted(quoted({ action: 'QUOTE', clientOperationId: 'one', portion: { mode: 'PARTIAL', stakeMinor: 2000 } }));
  const two = accepted(quoted({ action: 'QUOTE', clientOperationId: 'two', portion: { mode: 'PARTIAL', stakeMinor: 2000 } },
    { financial: one.receipt.financial, now: Date.now() + 1000 }));
  const state = installApi({ bets: [bet({ status: 'WIN', cashBackFinancial: { ...two.receipt.financial, revision: 4, status: 'WIN' } })] });
  state.history = { items: [two.receipt, one.receipt], nextCursor: null };
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  expect(card()).toHaveTextContent('PARTIAL CASH BACK');
  expect(card()).toHaveTextContent('Remainder stake that settled: 60.00');
  expect(card()).toHaveTextContent('Active exposure: 0.00');
  expect(card()).toHaveTextContent('Cumulative closed principal: 40.00');
  expect(card()).not.toHaveTextContent('Possible return on remaining stake:');
  fireEvent.click(screen.getByRole('button', { name: 'Cash-back history' }));
  await screen.findByText('2 receipts loaded. End of available history.');
  expect(screen.getAllByText('Partial cash back', { exact: true })).toHaveLength(2);
  expect(document.body).not.toHaveTextContent('decision-one');
});

it('paginates immutable history on demand and does not call the first page complete', async () => {
  let remaining = financial();
  const entries = Array.from({ length: 21 }, (_, index) => {
    const receipt = accepted(quoted({
      action: 'QUOTE', clientOperationId: `history-${index}`, portion: { mode: 'PARTIAL', stakeMinor: 100 },
    }, { financial: remaining, now: Date.now() + index })).receipt;
    remaining = receipt.financial;
    return receipt;
  }).reverse();
  const state = installApi({ bets: [bet({ cashBackFinancial: remaining })] });
  state.history = { items: entries.slice(0, 20), nextCursor: 'opaque/page+2' };
  state.nextHistory = { items: [entries[20]], nextCursor: null };
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  expect(axios.get.mock.calls.filter(([url]) => url.includes('/history'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Cash-back history' }));
  await screen.findByText('20 receipts loaded. Earlier receipts are available.');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier receipts' }));
  await screen.findByText('21 receipts loaded. End of available history.');
  expect(axios.get).toHaveBeenCalledWith('/api/bet/slip-one/cash-back/history?cursor=opaque%2Fpage%2B2', expect.any(Object));
});

it('preserves the historical keyed-object listing without guessing a different cash-back DTO', async () => {
  installApi();
  axios.get.mockResolvedValueOnce(response({ 'bet-one': bet() }));
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  expect(screen.getByText('1 bets found')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Get cash-back offer' })).toBeEnabled();
});

it.each([401, 403])('revokes cached records on permission failure %s, aborts stale account work and never recovers another owner metadata', async (status) => {
  const state = installApi();
  const onAuthRefresh = jest.fn().mockResolvedValue(undefined);
  const view = mount({ onAuthRefresh });
  await screen.findByText('Northern Falcons - Southern Owls');
  axios.post.mockRejectedValueOnce(httpError(status, 'AUTHENTICATION_REQUIRED'));
  fireEvent.click(screen.getByRole('button', { name: 'Get cash-back offer' }));
  await screen.findByText(/Your session could not be verified/);
  expect(card()).toBeNull();
  expect(onAuthRefresh).toHaveBeenCalledTimes(1);
  state.bets = [];
  const priorRequests = axios.post.mock.calls.length;
  view.rerender(<MyBets currentUser={{ id: 'other-owner' }} />);
  await screen.findByText('No bets match the active filters.');
  expect(axios.post).toHaveBeenCalledTimes(priorRequests);
  const slow = deferred();
  axios.get.mockImplementationOnce(() => slow.promise);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh bets' }));
  view.rerender(<MyBets currentUser={null} />);
  await act(async () => { slow.resolve(response([bet()])); });
  expect(card()).toBeNull();
  expect(screen.getByText(/Log in to view your bets/)).toBeInTheDocument();
});

it('keeps lookup failures pending rather than inventing rejection or another operation', async () => {
  installApi();
  mount();
  fireEvent.click(await getOffer());
  await screen.findByText(/Confirmation pending/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Check confirmation status' })).toBeEnabled());
  const previousGet = axios.get.getMockImplementation();
  axios.get.mockImplementation((url) => url.includes('/operations/')
    ? Promise.reject(httpError(404, 'OPERATION_NOT_FOUND')) : previousGet(url));
  fireEvent.click(screen.getByRole('button', { name: 'Check confirmation status' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(cashBackReason('OPERATION_NOT_FOUND'));
  expect(screen.getByRole('button', { name: 'Get new offer' })).toBeDisabled();
  expect(axios.post.mock.calls.filter(([url]) => url.endsWith('/accept'))).toHaveLength(1);
  expect(screen.queryByText(/Cash back rejected/)).not.toBeInTheDocument();
});

it('shows a confirm facade conflict, then reconciles the same operation before enabling a fresh offer', async () => {
  const state = installApi();
  mount();
  const confirm = await getOffer();
  const id = axios.post.mock.calls[0][1].clientOperationId;
  state.operations[id] = { ...state.operations[id], state: 'UNAVAILABLE', reason: 'MARKET_UNAVAILABLE' };
  axios.post.mockRejectedValueOnce(httpError(409, 'QUOTE_UNAVAILABLE'));
  fireEvent.click(confirm);
  expect(await screen.findByRole('alert')).toHaveTextContent(cashBackReason('QUOTE_UNAVAILABLE'));
  expect(screen.getByRole('button', { name: 'Get new offer' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Check confirmation status' }));
  await screen.findByText(`Cash back unavailable. ${cashBackReason('MARKET_UNAVAILABLE')}`);
  expect(screen.getByRole('button', { name: 'Get new offer' })).toBeEnabled();
});

it('makes history failures actionable and restarts an invalid cursor at the first page on reopen', async () => {
  const receipt = accepted(quoted({ action: 'QUOTE', clientOperationId: 'history', portion: { mode: 'PARTIAL', stakeMinor: 100 } })).receipt;
  const state = installApi({ bets: [bet({ cashBackFinancial: receipt.financial })] });
  state.history = { items: [receipt], nextCursor: 'cursor-to-retry' };
  const previousGet = axios.get.getMockImplementation();
  let firstHistory = true;
  axios.get.mockImplementation((url) => {
    if (url.includes('?cursor=')) return Promise.reject(httpError(400, 'INVALID_CURSOR'));
    if (url.endsWith('/history') && firstHistory) {
      firstHistory = false;
      return Promise.reject(new Error('offline'));
    }
    return previousGet(url);
  });
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  fireEvent.click(screen.getByRole('button', { name: 'Cash-back history' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Cash-back history could not be loaded');
  fireEvent.click(screen.getByRole('button', { name: 'Retry history page' }));
  await screen.findByText('1 receipt loaded. Earlier receipts are available.');
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier receipts' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(cashBackReason('INVALID_CURSOR'));
  state.history.nextCursor = null;
  fireEvent.click(screen.getByRole('button', { name: 'Hide cash-back history' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cash-back history' }));
  await screen.findByText('1 receipt loaded. End of available history.');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('keeps previous cards and input on refresh failure and displays initial loading/empty/permission states', async () => {
  installApi();
  const view = mount();
  expect(screen.getByText('Loading My Bets…')).toBeInTheDocument();
  await screen.findByText('Northern Falcons - Southern Owls');
  fireEvent.click(screen.getByRole('button', { name: 'Partial stake' }));
  const input = screen.getByLabelText('Stake to close (Stanbucks)');
  fireEvent.change(input, { target: { value: '5.25' } });
  axios.get.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh bets' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('My Bets could not be refreshed');
  expect(input).toHaveValue(5.25);
  expect(card()).not.toBeNull();
  view.unmount();
  mount({ currentUser: null });
  expect(screen.getByText(/Log in to view your bets/)).toBeInTheDocument();
});

it('polls only owned pending operations and stops once an offer or final decision is known', async () => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-24T12:00:00Z'));
  const state = installApi({ quote: (offer) => ({ ...offer.quote.operation, state: 'QUOTE_PENDING' }) });
  mount();
  await screen.findByText('Northern Falcons - Southern Owls');
  fireEvent.click(screen.getByRole('button', { name: 'Get cash-back offer' }));
  await screen.findByText(/Getting an offer/);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry same offer request' })).toBeEnabled());
  await advance(CASH_BACK_POLL_MS * 2);
  const lookups = () => axios.get.mock.calls.filter(([url]) => url.includes('/operations/')).length;
  expect(lookups()).toBe(1);
  const body = axios.post.mock.calls[0][1];
  state.operations[body.clientOperationId] = quoted(body);
  await advance(CASH_BACK_POLL_MS * 2);
  await screen.findByRole('button', { name: 'Confirm full cash back' });
  const completedLookups = lookups();
  await advance(12000);
  expect(lookups()).toBe(completedLookups);
});
