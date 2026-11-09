import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import Profile from './Profile';

jest.mock('axios', () => ({ get: jest.fn(), patch: jest.fn() }));
const player = { id: 'owner', email: 'player@example.com', displayName: 'Player' };
const stats = (overrides = {}) => ({
  range: { from: null, toExclusive: null },
  acceptedBets: 3, wins: 1, losses: 1, openBets: 1, voidedBets: 0, cashBackBets: 0,
  pendingSubmissions: 2, declinedSubmissions: 1, totalStaked: '0.301',
  preMatchBets: 4, liveBets: 2, singleBets: 5, accumulatorBets: 1,
  favouriteMarket: { name: '1X2', selections: 7 }, ...overrides,
});
const zeroStats = (overrides = {}) => stats({
  acceptedBets: 0, wins: 0, losses: 0, openBets: 0, pendingSubmissions: 0, declinedSubmissions: 0,
  totalStaked: '0', preMatchBets: 0, liveBets: 0, singleBets: 0, accumulatorBets: 0, favouriteMarket: null,
  ...overrides,
});
const profile = (props = {}) => <MemoryRouter initialEntries={['/profile?ui=v2&theme=light']}>
  <Profile currentUser={player} isCurrentUserResolved {...props} />
</MemoryRouter>;
const showTotals = () => screen.findByText('Total staked');
const figure = (label) => screen.getByText(label, { selector: 'dt' }).nextElementSibling.querySelector('.profile-figure');
const editName = () => fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
const changeName = (value) => fireEvent.change(screen.getByLabelText('Display name'), { target: { value } });
const splitItems = () => Array.from(document.querySelectorAll('.profile-splits > li'));
const rangeCaption = () => screen.getAllByRole('status').find((node) => node.classList.contains('profile-range'));
const openCustomDates = () => fireEvent.click(screen.getByRole('button', { name: 'Custom dates' }));
const echoRange = (_url, config) => Promise.resolve({
  data: stats({ range: { from: config.params.from ?? null, toExclusive: config.params.toExclusive ?? null } }),
});

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockReset();
  axios.patch.mockReset();
  axios.get.mockImplementation(echoRange);
  axios.patch.mockImplementation((_url, body) => Promise.resolve({ data: body }));
});

afterEach(() => jest.useRealTimers());

it("shows only the current player's activity sheet and keeps the login read-only", async () => {
  render(profile());
  await showTotals();
  expect(screen.getByRole('heading', { name: 'My profile', level: 1 })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Player', level: 2 })).toBeVisible();
  expect(screen.getByText(player.email)).toBeVisible();
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  expect(figure('Bets')).toHaveTextContent('6');
  expect(figure('Win rate')).toHaveTextContent('50%');
  expect(screen.getByText('1 of 2 settled bets won')).toBeVisible();
  expect(figure('Total staked').textContent).toBe('0.301');
  expect(screen.getByText('Awaiting moderation').nextElementSibling).toHaveTextContent('2');
  expect(screen.getByText('Declined').nextElementSibling).toHaveTextContent('1');
  const splits = splitItems().map((item) => item.textContent.replace(/\s+/g, ' ').trim());
  expect(splits).toEqual(['1 Won, Lost 1', '4 Pre-match, Live 2', '5 Singles, Accumulators 1']);
  expect(screen.getByText('Favourite market').nextElementSibling).toHaveTextContent('1X27 selections');
  expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('link', { name: 'View my bets' })).toHaveAttribute('href', '/bets?ui=v2&theme=light');
  expect(axios.get).toHaveBeenCalledWith('/api/bet/me/stats', expect.objectContaining({ params: {} }));
});

it.each([
  { pendingSubmissions: 2, declinedSubmissions: 0, expectedBets: '2' },
  { pendingSubmissions: 0, declinedSubmissions: 3, expectedBets: '3' },
])('counts unaccepted submissions as Bets: %p', async ({ pendingSubmissions, declinedSubmissions, expectedBets }) => {
  const total = pendingSubmissions + declinedSubmissions;
  axios.get.mockResolvedValueOnce({ data: zeroStats({
    pendingSubmissions, declinedSubmissions, preMatchBets: total, singleBets: total,
  }) });
  render(profile());
  await showTotals();
  expect(figure('Bets').textContent).toBe(expectedBets);
  expect(figure('Win rate').textContent).toBe('—');
  expect(screen.getByText('No settled bets yet')).toBeVisible();
  expect(figure('Total staked').textContent).toBe('0');
  expect(screen.queryByText('Favourite market')).not.toBeInTheDocument();
  expect(screen.queryByText('No betting activity yet.')).not.toBeInTheDocument();
});

it('groups an exact decimal stake without converting it to a number', async () => {
  const { group, decimal } = Object.fromEntries(new Intl.NumberFormat().formatToParts(1234.5)
    .map(({ type, value }) => [type, value]));
  axios.get.mockResolvedValueOnce({ data: stats({ totalStaked: '1234567890123456789.123' }) });
  render(profile());
  await showTotals();
  expect(figure('Total staked').textContent)
    .toBe(['1', '234', '567', '890', '123', '456', '789'].join(group) + `${decimal}123`);
  expect(figure('Total staked').querySelectorAll('wbr')).toHaveLength(6);
});

it('labels enum-like live market names and still renders legacy responses without style fields', async () => {
  axios.get.mockResolvedValueOnce({ data: stats({ favouriteMarket: { name: 'NEXT_CORNER', selections: 1 } }) });
  const { unmount } = render(profile());
  await showTotals();
  expect(screen.getByText('Favourite market').nextElementSibling).toHaveTextContent('Next Corner Kick1 selection');
  unmount();
  const legacy = stats();
  ['preMatchBets', 'liveBets', 'singleBets', 'accumulatorBets', 'favouriteMarket'].forEach((key) => delete legacy[key]);
  axios.get.mockResolvedValueOnce({ data: legacy });
  render(profile());
  await showTotals();
  expect(splitItems()).toHaveLength(1);
  expect(screen.queryByText('Favourite market')).not.toBeInTheDocument();
});

it.each([
  { preMatchBets: 1 }, { accumulatorBets: -1 }, { favouriteMarket: { name: ' ', selections: 1 } },
  { favouriteMarket: { name: '1X2', selections: 0 } },
])('treats inconsistent style figures as unavailable: %p', async (overrides) => {
  axios.get.mockResolvedValueOnce({ data: stats(overrides) });
  render(profile());
  expect(await screen.findByRole('alert')).toHaveTextContent('statistics are unavailable');
  expect(screen.queryByText('Total staked')).not.toBeInTheDocument();
});

it('saves a trimmed Unicode name, closes the editor and returns focus', async () => {
  const saved = jest.fn();
  render(profile({ onProfileSaved: saved }));
  editName();
  expect(screen.getByLabelText('Display name')).toHaveFocus();
  changeName('  Zoë Player  ');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByText('Name saved.')).toBeVisible();
  expect(axios.patch).toHaveBeenCalledWith('/api/auth/profile', { displayName: 'Zoë Player' },
    expect.objectContaining({ signal: expect.any(Object) }));
  expect(saved).toHaveBeenCalledWith('owner', 'Zoë Player');
  expect(screen.getByRole('heading', { name: 'Zoë Player', level: 2 })).toBeVisible();
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Edit name' })).toHaveFocus();
  expect(screen.getByText(player.email)).toBeVisible();
});

it('cancels an edit with Cancel or Escape, restoring the saved name', async () => {
  render(profile());
  editName();
  changeName('Discarded');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Edit name' })).toHaveFocus();
  editName();
  expect(screen.getByLabelText('Display name')).toHaveValue('Player');
  changeName('Discarded again');
  fireEvent.keyDown(screen.getByLabelText('Display name'), { key: 'Escape' });
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  expect(axios.patch).not.toHaveBeenCalled();
});

it('surfaces save errors while preserving the name for retry', async () => {
  axios.patch.mockRejectedValueOnce({ response: { status: 400, data: { errors: [{ msg: 'Use a single-line name.' }] } } });
  render(profile());
  editName();
  changeName('Draft name');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Use a single-line name.');
  expect(screen.getByLabelText('Display name')).toHaveValue('Draft name');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByText('Name saved.')).toBeVisible();
});

it.each(['   ', 'N'.repeat(255), 'Name\u0000'])('rejects invalid name input without sending it', async (value) => {
  render(profile());
  editName();
  changeName(value);
  fireEvent.submit(screen.getByLabelText('Display name').closest('form'));
  expect(await screen.findByRole('alert')).toHaveTextContent('1 to 254 characters');
  expect(axios.patch).not.toHaveBeenCalled();
});

it('applies presets immediately with the same windows as My bets', async () => {
  jest.useFakeTimers('modern');
  jest.setSystemTime(new Date(2026, 2, 29, 15, 30));
  render(profile());
  await showTotals();
  const nextMidnight = new Date(2026, 2, 30).toISOString();
  for (const [label, days] of [['Today', 0], ['Last 7 days', 7], ['Last 30 days', 30]]) {
    const from = days ? new Date(Date.now() - days * 86400000).toISOString() : new Date(2026, 2, 29).toISOString();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(axios.get).toHaveBeenLastCalledWith('/api/bet/me/stats',
      expect.objectContaining({ params: { from, toExclusive: nextMidnight } })));
    expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'false');
  }
  const calls = axios.get.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));
  expect(axios.get).toHaveBeenCalledTimes(calls);
});

it('keeps the previous figures visible and busy while a new period loads', async () => {
  render(profile());
  await showTotals();
  let resolveToday;
  axios.get.mockImplementationOnce((url, config) => new Promise((resolve) => {
    resolveToday = () => resolve(echoRange(url, config));
  }));
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(figure('Bets')).toHaveTextContent('6');
  expect(screen.getByText('Total staked').closest('.profile-sheet')).toHaveAttribute('aria-busy', 'true');
  expect(rangeCaption()).toHaveTextContent('Updating');
  await act(async () => resolveToday());
  expect(screen.getByText('Total staked').closest('.profile-sheet')).toHaveAttribute('aria-busy', 'false');
});

it('applies inclusive local custom dates and returns to all time without losing a name draft', async () => {
  render(profile());
  await showTotals();
  editName();
  changeName('Unsaved name');
  openCustomDates();
  expect(screen.getByLabelText('From')).toHaveFocus();
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-29' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-29' } });
  const start = new Date(2026, 2, 29);
  const end = new Date(2026, 2, 30);
  axios.get.mockResolvedValueOnce({ data: stats({
    range: { from: start.toISOString(), toExclusive: end.toISOString() },
    acceptedBets: 1, wins: 0, losses: 0, openBets: 1,
    pendingSubmissions: 1, declinedSubmissions: 2, totalStaked: '5',
    preMatchBets: 4, liveBets: 0, singleBets: 4, accumulatorBets: 0,
  }) });
  fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));
  await waitFor(() => expect(axios.get).toHaveBeenLastCalledWith('/api/bet/me/stats',
    expect.objectContaining({ params: { from: start.toISOString(), toExclusive: end.toISOString() } })));
  await waitFor(() => expect(figure('Bets')).toHaveTextContent('4'));
  expect(figure('Total staked').textContent).toBe('5');
  expect(rangeCaption()).toHaveTextContent(new Intl.DateTimeFormat(undefined,
    { day: 'numeric', month: 'short', year: 'numeric' }).format(start));
  expect(screen.getByLabelText('Display name')).toHaveValue('Unsaved name');
  fireEvent.click(screen.getByRole('button', { name: 'All time' }));
  await waitFor(() => expect(axios.get).toHaveBeenLastCalledWith('/api/bet/me/stats',
    expect.objectContaining({ params: {} })));
  await waitFor(() => expect(figure('Bets')).toHaveTextContent('6'));
  expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
});

it('rejects incomplete and reversed date ranges before requesting new totals', async () => {
  render(profile());
  await showTotals();
  openCustomDates();
  fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Choose both dates');
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-04-02' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-04-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));
  expect(screen.getByRole('alert')).toHaveTextContent('From on or before To');
  expect(axios.get).toHaveBeenCalledTimes(1);
});

it('distinguishes statistics failure from zero activity and keeps editing independent', async () => {
  axios.get.mockRejectedValueOnce(new Error('offline'));
  render(profile());
  expect(await screen.findByRole('alert')).toHaveTextContent('statistics are unavailable');
  expect(screen.queryByText('Total staked')).not.toBeInTheDocument();
  editName();
  changeName('Still editing');
  axios.get.mockResolvedValueOnce({ data: zeroStats() });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh statistics' }));
  expect(await screen.findByText('No betting activity yet.')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Browse events' })).toHaveAttribute('href', '/?ui=v2&theme=light');
  expect(screen.getByLabelText('Display name')).toHaveValue('Still editing');
});

it('does not turn a malformed successful response into zero statistics', async () => {
  axios.get.mockResolvedValueOnce({ data: {} });
  render(profile());
  expect(await screen.findByRole('alert')).toHaveTextContent('statistics are unavailable');
  expect(screen.queryByText('No betting activity yet.')).not.toBeInTheDocument();
});

it('ignores a superseded period response', async () => {
  let resolveOld;
  axios.get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  render(profile());
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  await showTotals();
  await act(async () => resolveOld({ data: stats({ totalStaked: '999999' }) }));
  expect(figure('Total staked').textContent).toBe('0.301');
});

it('clears drafts and ignores old statistics and save responses on an account switch', async () => {
  let resolveStats;
  let resolveSave;
  axios.get.mockImplementationOnce(() => new Promise((resolve) => { resolveStats = resolve; }));
  axios.patch.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
  const saved = jest.fn();
  const { rerender } = render(profile({ onProfileSaved: saved }));
  editName();
  changeName('Old account draft');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  rerender(profile({ currentUser: { id: 'other', email: 'other-login', displayName: 'Other player' }, onProfileSaved: saved }));
  await showTotals();
  await act(async () => {
    resolveStats({ data: stats({ totalStaked: '999999' }) });
    resolveSave({ data: { displayName: 'Old account draft' } });
  });
  expect(screen.getByRole('heading', { name: 'Other player', level: 2 })).toBeVisible();
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  expect(screen.queryByText(player.email)).not.toBeInTheDocument();
  expect(figure('Total staked')).not.toHaveTextContent('999');
  expect(saved).not.toHaveBeenCalled();
});

it.each([401, 403])('clears private data and refreshes authentication on statistics status %s', async (status) => {
  axios.get.mockRejectedValueOnce({ response: { status } });
  const refresh = jest.fn();
  render(profile({ onAuthRefresh: refresh }));
  expect(await screen.findByText('Sign in to view your profile and betting activity.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Edit name' })).not.toBeInTheDocument();
  expect(screen.queryByText(player.email)).not.toBeInTheDocument();
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('handles an expired session during a name save without reporting success', async () => {
  axios.patch.mockRejectedValueOnce({ response: { status: 401 } });
  render(profile());
  await showTotals();
  editName();
  changeName('New name');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('link', { name: 'Log in' })).toBeVisible();
  expect(screen.queryByText('Name saved.')).not.toBeInTheDocument();
});

it('does not request private statistics before authentication resolves or for an anonymous visitor', () => {
  const { rerender } = render(profile({ isCurrentUserResolved: false }));
  expect(screen.getByRole('status')).toHaveTextContent('Checking your session');
  expect(axios.get).not.toHaveBeenCalled();
  rerender(profile({ currentUser: null }));
  expect(within(screen.getByRole('link', { name: 'Log in' }).parentElement).getByText(/Sign in/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Log in' }))
    .toHaveAttribute('href', '/login?ui=v2&theme=light');
  expect(axios.get).not.toHaveBeenCalled();
});
