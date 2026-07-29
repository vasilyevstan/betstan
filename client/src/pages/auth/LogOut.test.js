import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
      <MemoryRouter>
        <LogOut callback={callback} />
      </MemoryRouter>
    );

    expect(screen.getByText('Logging you out...')).toBeTruthy();
    await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/auth/logout'));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/'));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
