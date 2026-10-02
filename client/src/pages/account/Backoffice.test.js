import React, { useState } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axios from 'axios';
import Backoffice from './Backoffice';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const event = {
  eventId: 'event-1',
  name: 'Home - Away',
  home: 'Home',
  away: 'Away',
  status: 'NO_RESULT',
  visibility: 'ONLINE',
  time: '2030-01-01T12:00:00.000Z',
};

const offlineEvent = {
  ...event,
  eventId: 'event-2',
  name: 'Harbor - Valley',
  home: 'Harbor',
  away: 'Valley',
  visibility: 'OFFLINE',
};
const recordedEvent = {
  ...event,
  eventId: 'event-3',
  name: 'Summit - Harbor',
  home: 'Summit',
  away: 'Harbor',
  status: 'RESULTED',
  homeResult: 2,
  awayResult: 0,
};
const catalog = [
  offlineEvent,
  event,
  recordedEvent,
  { eventId: 'hidden-id-only', name: 'Mystery fixture', status: 'FUTURE_STATUS', visibility: 'FUTURE_VISIBILITY', time: 'invalid' },
  { eventId: 'missing-details' },
];

const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

const RefreshingBackoffice = () => {
  const [refreshToken, setRefreshToken] = useState(0);
  return <Backoffice refreshToken={refreshToken}
    onChanged={() => setRefreshToken((current) => current + 1)} />;
};

const scoreInput = (side, fixture = event) => screen.getByRole('spinbutton', {
  name: `${side === 'home' ? 'Home' : 'Away'} score for ${fixture[side]} in ${fixture.name}`,
});

const enterScores = (home, away, fixture = event) => {
  fireEvent.change(scoreInput('home', fixture), { target: { value: home } });
  fireEvent.change(scoreInput('away', fixture), { target: { value: away } });
};

const renderBackoffice = (props = {}) => render(
  <Backoffice
    onChanged={jest.fn()}
    refreshToken={0}
    {...props}
  />
);

describe('public Backoffice access', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    axios.get.mockResolvedValue({ data: [event] });
    axios.post.mockResolvedValue({ data: {} });
  });

  it.each([
    ['anonymous visitors', undefined],
    ['ordinary users', { email: 'user@example.com', role: 'USER' }],
    ['legacy roleless users', { email: 'legacy@example.com' }],
    ['administrators', { email: 'admin@example.com', role: 'ADMIN' }],
  ])('loads the complete panel for %s', async (_label, currentUser) => {
    renderBackoffice({ currentUser });

    expect(screen.getByRole('heading', { name: 'Backoffice' })).toBeVisible();
    expect(await screen.findByText('Home - Away')).toBeVisible();
    expect(screen.getByText('Kickoff:', { exact: false })).toBeVisible();
    expect(screen.getByText('Kickoff:', { exact: false }).querySelector('time'))
      .toHaveAttribute('datetime', event.time);
    expect(screen.getByText('Create new event')).toBeVisible();
    expect(axios.get).toHaveBeenCalledWith('/api/backoffice');
    expect(screen.queryByText(/administrator access/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
  });

  it('surfaces event loading failures without hiding the public controls', async () => {
    axios.get.mockRejectedValue(new Error('request failed'));
    renderBackoffice();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load Backoffice events.'
    );
    expect(screen.getByText('Create new event')).toBeVisible();
    expect(screen.getByRole('searchbox', { name: 'Search events' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Final result' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Visibility' })).toBeVisible();
    expect(screen.queryByText(/Showing \d+ of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No events/)).not.toBeInTheDocument();
  });

  it('creates an event with trimmed team names', async () => {
    const onChanged = jest.fn();
    renderBackoffice({ onChanged });
    await screen.findByText('Home - Away');

    fireEvent.change(screen.getByLabelText('Home team'), {
      target: { value: '  Team A ' },
    });
    fireEvent.change(screen.getByLabelText('Away team'), {
      target: { value: ' Team B  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/backoffice/new_event',
      {
        home: 'Team A',
        away: 'Team B',
        kickoffDelaySeconds: 15 * 60,
        requestId: expect.any(String),
      }
    ));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent(
      'Team A - Team B was created.'
    );
    expect(screen.getByText('Kickoff is scheduled 15 minutes after creation.')).toBeVisible();
  });

  it('reuses the creation request id after an ambiguous network failure', async () => {
    axios.post
      .mockRejectedValueOnce(new Error('connection dropped'))
      .mockResolvedValueOnce({ data: {} });
    renderBackoffice();
    await screen.findByText('Home - Away');

    fireEvent.change(screen.getByLabelText('Home team'), {
      target: { value: 'Team A' },
    });
    fireEvent.change(screen.getByLabelText('Away team'), {
      target: { value: 'Team B' },
    });
    const createButton = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(createButton);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to complete the Backoffice action.'
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } });
    fireEvent.change(screen.getByLabelText('Final result'), { target: { value: 'RESULTED' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'OFFLINE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to complete the Backoffice action.');
    expect(screen.getByLabelText('Home team')).toHaveValue('Team A');
    expect(screen.getByLabelText('Away team')).toHaveValue('Team B');
    fireEvent.click(createButton);

    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
    const firstRequestId = axios.post.mock.calls[0][1].requestId;
    const secondRequestId = axios.post.mock.calls[1][1].requestId;
    expect(secondRequestId).toBe(firstRequestId);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Team A - Team B was created.'
    );
  });

  it('reports a persisted action that is still retrying publication', async () => {
    axios.post.mockResolvedValueOnce({
      status: 202,
      data: { message: 'Event saved; publication is retrying' },
    });
    renderBackoffice();
    await screen.findByText('Home - Away');

    fireEvent.change(screen.getByLabelText('Home team'), {
      target: { value: 'Team A' },
    });
    fireEvent.change(screen.getByLabelText('Away team'), {
      target: { value: 'Team B' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    const pendingNotice = await screen.findByRole('status');
    expect(pendingNotice).toHaveTextContent(
      'Event saved; publication is retrying'
    );
    expect(pendingNotice).toHaveClass('alert-warning');
  });

  it('submits numeric results through labelled controls', async () => {
    renderBackoffice();
    await screen.findByText('Home - Away');

    fireEvent.change(screen.getByLabelText('Home score'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Away score'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', {
      name: 'Save final result for Home - Away',
    }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/backoffice/result',
      { eventId: 'event-1', homeResult: 3, awayResult: 1 }
    ));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Result saved for Home - Away.'
    );
  });

  it('does not silently settle an event when either score is blank', async () => {
    renderBackoffice();
    await screen.findByText('Home - Away');

    const resultButton = screen.getByRole('button', {
      name: 'Save final result for Home - Away',
    });
    fireEvent.submit(resultButton.closest('form'));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter both scores before setting the result.'
    );
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('surfaces a conflicting result instead of reporting false success', async () => {
    axios.post.mockRejectedValueOnce({
      response: {
        data: { message: 'Event already has a different result' },
      },
    });
    renderBackoffice();
    await screen.findByText('Home - Away');

    fireEvent.change(screen.getByLabelText('Home score'), {
      target: { value: '3' },
    });
    fireEvent.change(screen.getByLabelText('Away score'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', {
      name: 'Save final result for Home - Away',
    }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Event already has a different result'
    );
    expect(screen.queryByText('Result saved for Home - Away.')).not.toBeInTheDocument();
  });

  it('disables result controls for completed events', async () => {
    axios.get.mockResolvedValue({
      data: [{ ...event, status: 'RESULTED', homeResult: 2, awayResult: 0 }],
    });
    renderBackoffice();

    expect(await screen.findByLabelText('Home score')).toBeDisabled();
    expect(scoreInput('home')).toHaveValue(2);
    expect(scoreInput('away')).toHaveValue(0);
    expect(scoreInput('away')).toBeVisible();
    expect(scoreInput('away')).toBeDisabled();
    expect(screen.getByRole('button', {
      name: 'Save final result for Home - Away',
    })).toBeDisabled();
    const visibilityButton = screen.getByRole('button', { name: 'Take offline for Home - Away' });
    expect(visibilityButton).toBeEnabled();
    fireEvent.click(visibilityButton);
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/backoffice/event_visibility', { eventId: 'event-1', visibility: 'OFFLINE' }
    ));
    expect(await screen.findByRole('status')).toHaveTextContent('Visibility changed for Home - Away.');
  });

  it('sends an idempotent target visibility', async () => {
    renderBackoffice();
    await screen.findByText('Home - Away');

    fireEvent.click(screen.getByRole('button', {
      name: 'Take offline for Home - Away',
    }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/backoffice/event_visibility',
      { eventId: 'event-1', visibility: 'OFFLINE' }
    ));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Visibility changed for Home - Away.'
    );
  });

  it.each([
    ['array', catalog],
    ['object', Object.fromEntries(catalog.map((entry) => [entry.eventId, entry]))],
  ])('starts with All/All and preserves the complete %s collection order', async (_label, data) => {
    axios.get.mockResolvedValue({ data });
    renderBackoffice();
    await screen.findByText('Showing 5 of 5 events');

    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByLabelText('Final result')).toHaveValue('ALL');
    expect(screen.getByLabelText('Visibility')).toHaveValue('ALL');
    expect(screen.getAllByRole('article').map((card) => within(card).getByRole('heading', { level: 3 }).textContent))
      .toEqual([
        'Harbor - Valley', 'Home - Away', 'Summit - Harbor', 'Mystery fixture',
        'Home team unavailable - Away team unavailable',
      ]);
    expect(screen.getAllByRole('spinbutton')).toHaveLength(10);
    const unknown = screen.getByRole('article', { name: 'Mystery fixture' });
    expect(within(unknown).getByText('Final result:', { exact: false })).toHaveTextContent('Final result: Unknown');
    expect(within(unknown).getByText('Visibility:', { exact: false })).toHaveTextContent('Visibility: Unknown');
    expect(within(unknown).getByText('Kickoff time unavailable')).toBeVisible();
    const missing = screen.getByRole('article', { name: 'Home team unavailable - Away team unavailable' });
    expect(within(missing).getByText('Final result:', { exact: false })).toHaveTextContent('Final result: Unavailable');
    expect(within(missing).getByText('Visibility:', { exact: false })).toHaveTextContent('Visibility: Unavailable');
  });

  it('searches trimmed case-insensitive names and teams only, without requests', async () => {
    axios.get.mockResolvedValue({ data: catalog });
    renderBackoffice();
    await screen.findByText('Showing 5 of 5 events');
    const search = screen.getByRole('searchbox');

    for (const [query, expectedNames] of [
      ['  hArBoR  ', ['Harbor - Valley', 'Summit - Harbor']],
      ['valley', ['Harbor - Valley']],
      ['summit', ['Summit - Harbor']],
      ['HOME - away', ['Home - Away']],
      ['mystery', ['Mystery fixture']],
      ['hidden-id-only', []],
      ['   ', ['Harbor - Valley', 'Home - Away', 'Summit - Harbor', 'Mystery fixture', 'Home team unavailable - Away team unavailable']],
    ]) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.queryAllByRole('article').map((card) => within(card).getByRole('heading', { level: 3 }).textContent))
        .toEqual(expectedNames);
      expect(screen.getByText(`Showing ${expectedNames.length} of 5 events`)).toBeVisible();
    }
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('combines independent result, visibility and search predicates and clears only discovery', async () => {
    axios.get.mockResolvedValue({ data: catalog });
    renderBackoffice();
    await screen.findByText('Showing 5 of 5 events');

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'harbor' } });
    fireEvent.change(screen.getByLabelText('Final result'), { target: { value: 'NO_RESULT' } });
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'OFFLINE' } });
    expect(screen.getByRole('article')).toHaveAccessibleName('Harbor - Valley');
    expect(screen.getByText('Showing 1 of 5 events')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Final result'), { target: { value: 'RESULTED' } });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByText(/No events match these filters/)).toBeVisible();
    expect(screen.queryByText('No events are available yet.')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'ONLINE' } });
    expect(screen.getByRole('article')).toHaveAccessibleName('Summit - Harbor');

    const clear = screen.getByRole('button', { name: 'Clear filters' });
    clear.focus();
    fireEvent.click(clear);
    expect(clear).toHaveFocus();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByLabelText('Final result')).toHaveValue('ALL');
    expect(screen.getByLabelText('Visibility')).toHaveValue('ALL');
    expect(screen.getByText('Showing 5 of 5 events')).toBeVisible();
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('distinguishes loading and a truly empty catalog from no matches', async () => {
    const request = deferred();
    axios.get.mockReturnValueOnce(request.promise);
    renderBackoffice();
    expect(screen.getByRole('status')).toHaveTextContent('Loading Backoffice events...');
    expect(screen.queryByText(/Showing \d+ of/)).not.toBeInTheDocument();
    expect(screen.queryByText(/No events/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'harbor' } });

    await act(async () => { request.resolve({ data: [] }); });
    expect(screen.getByText('Showing 0 of 0 events')).toBeVisible();
    expect(screen.getByText('No events are available yet.')).toBeVisible();
    expect(screen.queryByText(/No events match/)).not.toBeInTheDocument();
  });

  it('preserves hidden score drafts, creation inputs and surviving controls through local discovery', async () => {
    axios.get.mockResolvedValue({ data: catalog });
    renderBackoffice();
    await screen.findByText('Showing 5 of 5 events');
    const homeInput = scoreInput('home');
    const article = screen.getByRole('article', { name: event.name });
    enterScores('7', '0');
    enterScores('4', '2', offlineEvent);
    fireEvent.change(screen.getByLabelText('Home team'), { target: { value: 'New Home' } });
    fireEvent.change(screen.getByLabelText('Away team'), { target: { value: 'New Away' } });

    const search = screen.getByRole('searchbox');
    search.focus();
    fireEvent.change(search, { target: { value: 'home' } });
    expect(scoreInput('home')).toBe(homeInput);
    expect(screen.getByRole('article', { name: event.name })).toBe(article);
    expect(search).toHaveFocus();
    fireEvent.change(search, { target: { value: 'harbor' } });
    expect(screen.queryByRole('article', { name: event.name })).not.toBeInTheDocument();
    expect(scoreInput('home', offlineEvent)).toHaveValue(4);
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'ONLINE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(scoreInput('home')).toHaveValue(7);
    expect(scoreInput('away')).toHaveValue(0);
    expect(scoreInput('home', offlineEvent)).toHaveValue(4);
    expect(scoreInput('away', offlineEvent)).toHaveValue(2);
    expect(screen.getByLabelText('Home team')).toHaveValue('New Home');
    expect(screen.getByLabelText('Away team')).toHaveValue('New Away');
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('keeps full event/team identities in compact score labels and exact IDs in submission', async () => {
    const fixture = { ...event, eventId: 'exact-event-id', home: 'Northport United', away: 'Lakewood Rovers', name: 'Northport United - Lakewood Rovers' };
    axios.get.mockResolvedValue({ data: [fixture] });
    renderBackoffice();
    const card = await screen.findByRole('article', { name: fixture.name });
    expect(within(card).getByText('Home score')).toBeVisible();
    expect(within(card).getByText('Away score')).toBeVisible();
    expect(scoreInput('home', fixture)).toHaveAttribute('id', 'backoffice-home-result-exact-event-id');
    expect(scoreInput('away', fixture)).toHaveAttribute('id', 'backoffice-away-result-exact-event-id');
    enterScores('0', '99', fixture);
    fireEvent.click(within(card).getByRole('button', { name: `Save final result for ${fixture.name}` }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/backoffice/result', { eventId: 'exact-event-id', homeResult: 0, awayResult: 99 }
    ));
    expect(await screen.findByRole('status')).toHaveTextContent(`Result saved for ${fixture.name}.`);
  });

  it.each(['-1', '100', '1.5'])('rejects invalid score %s even on direct form submission', async (score) => {
    renderBackoffice();
    await screen.findByText(event.name);
    enterScores(score, '0');
    fireEvent.submit(screen.getByRole('form', { name: `Final result for ${event.name}` }));
    expect(screen.getByRole('alert')).toHaveTextContent('Scores must be whole numbers between 0 and 99.');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('resets creation identity after name changes and accepted creation while retaining name bounds', async () => {
    axios.post.mockRejectedValueOnce(new Error('connection dropped'))
      .mockRejectedValueOnce(new Error('connection dropped'));
    renderBackoffice();
    await screen.findByText(event.name);
    const home = screen.getByLabelText('Home team');
    const away = screen.getByLabelText('Away team');
    expect(home).toHaveAttribute('maxlength', '80');
    expect(away).toHaveAttribute('maxlength', '80');
    fireEvent.change(home, { target: { value: 'Team A' } });
    fireEvent.change(away, { target: { value: 'Team B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByRole('alert');
    const firstId = axios.post.mock.calls[0][1].requestId;
    fireEvent.change(home, { target: { value: 'Team C' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByRole('alert');
    const secondId = axios.post.mock.calls[1][1].requestId;
    expect(secondId).not.toBe(firstId);
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await screen.findByText('Team C - Team B was created.');
    expect(axios.post.mock.calls[2][1].requestId).toBe(secondId);
    expect(home).toHaveValue('');
    expect(away).toHaveValue('');
    fireEvent.change(home, { target: { value: 'Team C' } });
    fireEvent.change(away, { target: { value: 'Team B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(4));
    expect(axios.post.mock.calls[3][1].requestId).not.toBe(secondId);
    await screen.findByText('Team C - Team B was created.');
  });

  it('disables every mutation during a pending action but leaves local discovery available', async () => {
    const action = deferred();
    axios.get.mockResolvedValue({ data: [event, offlineEvent, recordedEvent] });
    axios.post.mockReturnValueOnce(action.promise);
    renderBackoffice();
    await screen.findByText(event.name);
    enterScores('1', '0');
    fireEvent.click(screen.getByRole('button', { name: `Save final result for ${event.name}` }));
    expect(screen.getByRole('button', { name: `Save final result for ${event.name}` })).toHaveTextContent('Saving...');
    screen.getAllByRole('spinbutton').forEach((input) => expect(input).toBeDisabled());
    screen.getAllByRole('button').filter((button) => button.textContent !== 'Clear filters')
      .forEach((button) => expect(button).toBeDisabled());
    expect(screen.getByLabelText('Home team')).toBeDisabled();
    expect(screen.getByLabelText('Away team')).toBeDisabled();
    expect(screen.getByRole('searchbox')).toBeEnabled();
    expect(screen.getByLabelText('Final result')).toBeEnabled();
    expect(screen.getByLabelText('Visibility')).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clear filters' })).toBeEnabled();
    await act(async () => { action.resolve({ data: { event: { ...event, status: 'RESULTED' } } }); });
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it.each([400, 404, 409])('retains the full %s error outside the filtered list', async (status) => {
    const message = `Visibility could not be changed (${status}). Reload the catalog and check this event before retrying.`;
    const onChanged = jest.fn();
    axios.post.mockRejectedValueOnce({ response: { status, data: { message } } });
    renderBackoffice({ onChanged });
    await screen.findByText(event.name);
    fireEvent.click(screen.getByRole('button', { name: `Take offline for ${event.name}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('alert').closest('.backoffice-events')).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onChanged).not.toHaveBeenCalled();
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('keeps filters and feedback after accepted refresh, with the existing GET draft reset', async () => {
    axios.get.mockResolvedValueOnce({ data: [event, offlineEvent] })
      .mockResolvedValueOnce({ data: [{ ...event, visibility: 'OFFLINE' }, offlineEvent] });
    render(<RefreshingBackoffice />);
    await screen.findByText(event.name);
    enterScores('6', '4', offlineEvent);
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'ONLINE' } });
    fireEvent.click(screen.getByRole('button', { name: `Take offline for ${event.name}` }));
    await screen.findByText('Showing 0 of 2 events');
    expect(screen.getByLabelText('Visibility')).toHaveValue('ONLINE');
    expect(screen.getByRole('status')).toHaveTextContent(`Visibility changed for ${event.name}.`);
    expect(axios.get).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(scoreInput('home', offlineEvent)).toHaveValue(null);
    expect(scoreInput('away', offlineEvent)).toHaveValue(null);
    expect(screen.getByRole('button', { name: `Make online for ${event.name}` })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: `Make online for ${event.name}` }));
    await waitFor(() => expect(axios.post).toHaveBeenLastCalledWith(
      '/api/backoffice/event_visibility', { eventId: 'event-1', visibility: 'ONLINE' }
    ));
    await waitFor(() => expect(axios.get).toHaveBeenCalledTimes(3));
    await screen.findByText('Showing 1 of 1 events');
  });

  it('recovers lost card focus once after a result refresh, keeping a 202 warning outside the list', async () => {
    const action = deferred();
    const updated = { ...event, status: 'RESULTED', homeResult: 2, awayResult: 0 };
    axios.get.mockResolvedValueOnce({ data: [event] }).mockResolvedValueOnce({ data: [updated] });
    axios.post.mockReturnValueOnce(action.promise);
    render(<RefreshingBackoffice />);
    await screen.findByText(event.name);
    fireEvent.change(screen.getByLabelText('Final result'), { target: { value: 'NO_RESULT' } });
    enterScores('2', '0');
    const save = screen.getByRole('button', { name: `Save final result for ${event.name}` });
    save.focus();
    fireEvent.click(save);
    await act(async () => {
      action.resolve({ status: 202, data: { event: updated, message: 'Result saved; publication is retrying. Check again before assuming downstream completion.' } });
    });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Events Showing 0 of 1 events/ })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveClass('alert-warning');
    expect(screen.getByRole('status')).toHaveTextContent('Result saved; publication is retrying. Check again before assuming downstream completion.');
    expect(screen.getByRole('status').closest('.backoffice-events')).toBeNull();
    expect(axios.get).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(scoreInput('home')).toHaveValue(2);
    expect(scoreInput('home')).toBeDisabled();
    expect(scoreInput('away')).toHaveValue(0);
  });

  it.each([false, true])('does not recover focus after intervening user movement (then blurred: %s)', async (blurAfterFocus) => {
    const action = deferred();
    axios.get.mockResolvedValueOnce({ data: [event] })
      .mockResolvedValueOnce({ data: [{ ...event, visibility: 'OFFLINE' }] });
    axios.post.mockReturnValueOnce(action.promise);
    render(<RefreshingBackoffice />);
    await screen.findByText(event.name);
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'ONLINE' } });
    const button = screen.getByRole('button', { name: `Take offline for ${event.name}` });
    button.focus();
    fireEvent.click(button);
    const search = screen.getByRole('searchbox');
    search.focus();
    if (blurAfterFocus) search.blur();
    await act(async () => { action.resolve({ data: { eventId: event.eventId, visibility: 'OFFLINE' } }); });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Events Showing 0 of 1 events/ })).not.toHaveFocus();
    expect(blurAfterFocus ? document.body : search).toHaveFocus();
  });

  it('does not move focus or replace surviving card controls on a normal refresh', async () => {
    axios.get.mockResolvedValueOnce({ data: [event] })
      .mockResolvedValueOnce({ data: [{ ...event, visibility: 'OFFLINE' }] });
    render(<RefreshingBackoffice />);
    const card = await screen.findByRole('article', { name: event.name });
    const input = scoreInput('home');
    const button = screen.getByRole('button', { name: `Take offline for ${event.name}` });
    button.focus();
    fireEvent.click(button);
    await screen.findByRole('button', { name: `Make online for ${event.name}` });
    expect(screen.getByRole('article', { name: event.name })).toBe(card);
    expect(scoreInput('home')).toBe(input);
    expect(screen.getByRole('heading', { name: /Events Showing/ })).not.toHaveFocus();
  });

  it('cancels pending refresh focus recovery when local filtering hides a card', async () => {
    const refresh = deferred();
    axios.get.mockResolvedValueOnce({ data: [event] }).mockReturnValueOnce(refresh.promise);
    const view = renderBackoffice();
    await screen.findByText(event.name);
    scoreInput('home').focus();
    view.rerender(<Backoffice refreshToken={1} />);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await act(async () => { refresh.resolve({ data: [] }); });
    expect(screen.getByRole('heading', { name: /Events Showing 0 of 0 events/ })).not.toHaveFocus();
  });
});
