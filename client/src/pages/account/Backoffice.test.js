import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const renderBackoffice = (props = {}) => render(
  <Backoffice
    onChanged={jest.fn()}
    refreshToken={0}
    {...props}
  />
);

describe('public Backoffice access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
      name: 'Set results for Home - Away',
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
      name: 'Set results for Home - Away',
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
      name: 'Set results for Home - Away',
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
    expect(screen.getByRole('button', {
      name: 'Set results for Home - Away',
    })).toBeDisabled();
  });

  it('sends an idempotent target visibility', async () => {
    renderBackoffice();
    await screen.findByText('Home - Away');

    fireEvent.click(screen.getByRole('button', {
      name: 'Change visibility for Home - Away',
    }));

    await waitFor(() => expect(axios.post).toHaveBeenCalledWith(
      '/api/backoffice/event_visibility',
      { eventId: 'event-1', visibility: 'OFFLINE' }
    ));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Visibility changed for Home - Away.'
    );
  });
});
