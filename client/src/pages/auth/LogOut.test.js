import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LogOut from './LogOut';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');

describe('LogOut page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('logs out, navigates to home, and triggers callback', async () => {
    const callback = jest.fn();
    axios.post.mockResolvedValueOnce({});

    render(
      <MemoryRouter initialEntries={['/logout?ui=v3&theme=light&review=retained']}>
        <LogOut callback={callback} />
      </MemoryRouter>
    );

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Logging you out' }))
      .toBeInTheDocument();
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/logout'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({
      pathname: '/',
      search: '?ui=v3&theme=light&review=retained',
    }));
    expect(await screen.findByRole('heading', { level: 1, name: 'You’re logged out' }))
      .toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('shows a sanitized failure, preserves query navigation, and retries safely', async () => {
    const callback = jest.fn();
    axios.post
      .mockRejectedValueOnce(new Error('ECONNRESET from auth.internal'))
      .mockResolvedValueOnce({});

    render(
      <MemoryRouter initialEntries={['/logout?ui=v1&theme=dark&review=retained']}>
        <LogOut callback={callback} />
      </MemoryRouter>
    );

    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'We couldn’t log you out',
    })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.queryByText(/ECONNRESET|auth\.internal/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Return to Events' })).toHaveAttribute(
      'href',
      '/?ui=v1&theme=dark&review=retained'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry log out' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({
      pathname: '/',
      search: '?ui=v1&theme=dark&review=retained',
    }));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
