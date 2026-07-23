import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import UseRequest from './UseRequest';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');

const Harness = ({ onSuccess }) => {
  const { doRequest, errors } = UseRequest({
    url: '/api/auth/new',
    method: 'post',
    body: { email: 'qa@betstan.xyz', password: 'Password123!' },
    onSuccess,
  });

  return (
    <div>
      <button onClick={() => doRequest()} type="button">
        submit
      </button>
      {errors}
    </div>
  );
};

describe('UseRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders message when backend returns data.message without errors array', async () => {
    axios.post.mockRejectedValueOnce({
      response: {
        data: {
          message: 'Invalid credentials',
        },
      },
    });

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));

    await screen.findByText('Invalid credentials');
  });

  it('renders each backend validation error item', async () => {
    axios.post.mockRejectedValueOnce({
      response: {
        data: {
          errors: [{ msg: 'Email is required' }, { message: 'Password is too short' }],
        },
      },
    });

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));

    await screen.findByText('Email is required');
    await screen.findByText('Password is too short');
  });

  it('calls onSuccess and clears previous errors on successful request', async () => {
    const onSuccess = jest.fn();
    axios.post
      .mockRejectedValueOnce({
        response: {
          data: {
            message: 'Temporary failure',
          },
        },
      })
      .mockResolvedValueOnce({
        data: { ok: true },
      });

    render(<Harness onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await screen.findByText('Temporary failure');

    fireEvent.click(screen.getByRole('button', { name: 'submit' }));
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ ok: true }));
    await waitFor(() => expect(screen.queryByText('Temporary failure')).toBeNull());
  });

  it('falls back to err.message when response payload has no message/errors array', async () => {
    axios.post.mockRejectedValueOnce({
      message: 'Network timeout',
    });

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));

    await screen.findByText('Network timeout');
  });

  it('falls back to generic message when no structured error details exist', async () => {
    axios.post.mockRejectedValueOnce({});

    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'submit' }));

    await screen.findByText('Request failed');
  });
});
