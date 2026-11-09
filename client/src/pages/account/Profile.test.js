import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import Profile from './Profile';

jest.mock('axios', () => ({ get: jest.fn(), patch: jest.fn() }));
const player = { id: 'owner', email: 'player@example.com', displayName: 'Player' };
const stats = (overrides = {}) => ({
  range: { from: null, toExclusive: null },
  acceptedBets: 3, wins: 1, losses: 1, openBets: 1, voidedBets: 0, cashBackBets: 0,
  pendingSubmissions: 2, declinedSubmissions: 1, totalStaked: '0.301', ...overrides,
});
const profile = (props = {}) => <MemoryRouter initialEntries={['/profile?ui=v2&theme=light']}>
  <Profile currentUser={player} isCurrentUserResolved {...props} />
</MemoryRouter>;
const showTotals = () => screen.findByText('Total staked');
const changeName = (value) => fireEvent.change(screen.getByLabelText('Display name'), { target: { value } });

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockReset();
  axios.patch.mockReset();
  axios.get.mockImplementation((_url, config) => Promise.resolve({
    data: stats({ range: { from: config.params.from ?? null, toExclusive: config.params.toExclusive ?? null } }),
  }));
  axios.patch.mockImplementation((_url, body) => Promise.resolve({ data: body }));
});

it("shows only the current player's totals and keeps the login read-only", async () => {
  render(profile());
  await showTotals();
  expect(screen.getByRole('heading', { name: 'My profile', level: 1 })).toBeVisible();
  expect(screen.getByText(player.email)).toBeVisible();
  expect(screen.getByLabelText('Display name')).toHaveValue('Player');
  expect(screen.getByText('Bets').nextElementSibling).toHaveTextContent('6');
  expect(screen.getByText('Total staked').nextElementSibling).toHaveTextContent('0.301 Stanbucks');
  expect(screen.getByText('Awaiting moderation').nextElementSibling).toHaveTextContent('2');
  expect(screen.getByText('Declined').nextElementSibling).toHaveTextContent('1');
  expect(axios.get).toHaveBeenCalledWith('/api/bet/me/stats', expect.objectContaining({ params: {} }));
  expect(screen.queryByLabelText('Login')).not.toBeInTheDocument();
});

it.each([
  { pendingSubmissions: 2, declinedSubmissions: 0, expectedBets: '2' },
  { pendingSubmissions: 0, declinedSubmissions: 3, expectedBets: '3' },
])('counts unaccepted submissions as Bets: %p', async ({ pendingSubmissions, declinedSubmissions, expectedBets }) => {
  axios.get.mockResolvedValueOnce({ data: stats({
    acceptedBets: 0, wins: 0, losses: 0, openBets: 0,
    pendingSubmissions, declinedSubmissions, totalStaked: '0',
  }) });
  render(profile());
  await showTotals();
  expect(screen.getByText('Bets').nextElementSibling.textContent).toBe(expectedBets);
  expect(screen.getByText('Wins').nextElementSibling).toHaveTextContent('0');
  expect(screen.getByText('Losses').nextElementSibling).toHaveTextContent('0');
  expect(screen.getByText('Total staked').nextElementSibling).toHaveTextContent('0 Stanbucks');
  expect(screen.queryByText('No betting activity yet.')).not.toBeInTheDocument();
});

it('saves a trimmed Unicode name and updates the same-owner app state', async () => {
  const saved = jest.fn();
  render(profile({ onProfileSaved: saved }));
  changeName('  Zoë Player  ');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByText('Name saved.')).toBeVisible();
  expect(axios.patch).toHaveBeenCalledWith('/api/auth/profile', { displayName: 'Zoë Player' },
    expect.objectContaining({ signal: expect.any(Object) }));
  expect(saved).toHaveBeenCalledWith('owner', 'Zoë Player');
  expect(screen.getByLabelText('Display name')).toHaveValue('Zoë Player');
  expect(screen.getByText(player.email)).toBeVisible();
});

it('surfaces save errors while preserving the name for retry', async () => {
  axios.patch.mockRejectedValueOnce({ response: { status: 400, data: { errors: [{ msg: 'Use a single-line name.' }] } } });
  render(profile());
  changeName('Draft name');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Use a single-line name.');
  expect(screen.getByLabelText('Display name')).toHaveValue('Draft name');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  expect(await screen.findByText('Name saved.')).toBeVisible();
});

it.each(['   ', 'N'.repeat(255), 'Name\u0000'])('rejects invalid name input without sending it', async (value) => {
  render(profile());
  changeName(value);
  fireEvent.submit(screen.getByLabelText('Display name').closest('form'));
  expect(await screen.findByRole('alert')).toHaveTextContent('1 to 254 characters');
  expect(axios.patch).not.toHaveBeenCalled();
});

it('applies inclusive local placement dates and resets to all time without losing a name draft', async () => {
  render(profile());
  await showTotals();
  changeName('Unsaved name');
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-29' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-29' } });
  const start = new Date(2026, 2, 29);
  const end = new Date(2026, 2, 30);
  axios.get.mockResolvedValueOnce({ data: stats({
    range: { from: start.toISOString(), toExclusive: end.toISOString() },
    acceptedBets: 1, wins: 0, losses: 0, openBets: 1,
    pendingSubmissions: 1, declinedSubmissions: 2, totalStaked: '5',
  }) });
  fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));
  await waitFor(() => expect(axios.get).toHaveBeenLastCalledWith('/api/bet/me/stats',
    expect.objectContaining({ params: { from: start.toISOString(), toExclusive: end.toISOString() } })));
  await showTotals();
  expect(screen.getByText('Bets').nextElementSibling).toHaveTextContent('4');
  expect(screen.getByText('Total staked').nextElementSibling).toHaveTextContent('5 Stanbucks');
  expect(screen.getByLabelText('Display name')).toHaveValue('Unsaved name');
  fireEvent.click(screen.getByRole('button', { name: 'All time' }));
  await waitFor(() => expect(axios.get).toHaveBeenLastCalledWith('/api/bet/me/stats',
    expect.objectContaining({ params: {} })));
  await showTotals();
  expect(screen.getByText('Bets').nextElementSibling).toHaveTextContent('6');
  expect(screen.getByLabelText('From')).toHaveValue('');
  expect(screen.getByLabelText('To')).toHaveValue('');
});

it('rejects incomplete and reversed date ranges before requesting new totals', async () => {
  render(profile());
  await showTotals();
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
  changeName('Still editing');
  axios.get.mockResolvedValueOnce({ data: stats({
    acceptedBets: 0, wins: 0, losses: 0, openBets: 0, pendingSubmissions: 0,
    declinedSubmissions: 0, totalStaked: '0',
  }) });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh statistics' }));
  expect(await screen.findByText('No betting activity yet.')).toBeVisible();
  expect(screen.getByLabelText('Display name')).toHaveValue('Still editing');
});

it('does not turn a malformed successful response into zero statistics', async () => {
  axios.get.mockResolvedValueOnce({ data: {} });
  render(profile());
  expect(await screen.findByRole('alert')).toHaveTextContent('statistics are unavailable');
  expect(screen.queryByText('No betting activity yet.')).not.toBeInTheDocument();
});

it('ignores a superseded date-range response', async () => {
  let resolveOld;
  axios.get.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
  render(profile());
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-29' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-29' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply dates' }));
  await showTotals();
  await act(async () => resolveOld({ data: stats({ totalStaked: '999999' }) }));
  expect(screen.getByText('Total staked').nextElementSibling).toHaveTextContent('0.301 Stanbucks');
});

it('clears drafts and ignores old statistics and save responses on an account switch', async () => {
  let resolveStats;
  let resolveSave;
  axios.get.mockImplementationOnce(() => new Promise((resolve) => { resolveStats = resolve; }));
  axios.patch.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
  const saved = jest.fn();
  const { rerender } = render(profile({ onProfileSaved: saved }));
  changeName('Old account draft');
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  rerender(profile({ currentUser: { id: 'other', email: 'other-login', displayName: 'Other player' }, onProfileSaved: saved }));
  await showTotals();
  await act(async () => {
    resolveStats({ data: stats({ totalStaked: '999999' }) });
    resolveSave({ data: { displayName: 'Old account draft' } });
  });
  expect(screen.getByLabelText('Display name')).toHaveValue('Other player');
  expect(screen.queryByText(player.email)).not.toBeInTheDocument();
  expect(screen.getByText('Total staked').nextElementSibling).not.toHaveTextContent('999999');
  expect(saved).not.toHaveBeenCalled();
});

it.each([401, 403])('clears private data and refreshes authentication on statistics status %s', async (status) => {
  axios.get.mockRejectedValueOnce({ response: { status } });
  const refresh = jest.fn();
  render(profile({ onAuthRefresh: refresh }));
  expect(await screen.findByText('Sign in to view your profile and betting activity.')).toBeVisible();
  expect(screen.queryByLabelText('Display name')).not.toBeInTheDocument();
  expect(screen.queryByText(player.email)).not.toBeInTheDocument();
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('handles an expired session during a name save without reporting success', async () => {
  axios.patch.mockRejectedValueOnce({ response: { status: 401 } });
  render(profile());
  await showTotals();
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
  expect(screen.getByRole('link', { name: 'Log in' }))
    .toHaveAttribute('href', '/login?ui=v2&theme=light');
  expect(axios.get).not.toHaveBeenCalled();
});
