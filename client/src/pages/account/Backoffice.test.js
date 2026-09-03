import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import axios from 'axios';
import Backoffice from './Backoffice';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const renderBackoffice = ({
  currentUser,
  isCurrentUserResolved = true,
} = {}) => render(
  <MemoryRouter initialEntries={['/backoffice?ui=v3&theme=dark']}>
    <Backoffice
      currentUser={currentUser}
      isCurrentUserResolved={isCurrentUserResolved}
      onChanged={jest.fn()}
      refreshToken={0}
    />
  </MemoryRouter>
);

describe('Backoffice access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: [] });
  });

  it('waits for current-user resolution without requesting protected data', () => {
    renderBackoffice({ isCurrentUserResolved: false });

    expect(screen.getByRole('heading', { name: 'Backoffice' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Checking administrator access'
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('keeps the route available to anonymous visitors with a login path', () => {
    renderBackoffice();

    expect(screen.getByRole('heading', { name: 'Backoffice' })).toBeVisible();
    expect(screen.getByText(
      'Log in with an administrator account to use Backoffice.'
    )).toBeVisible();
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute(
      'href',
      '/login?ui=v3&theme=dark'
    );
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('explains the authorization boundary to signed-in ordinary users', () => {
    renderBackoffice({
      currentUser: { email: 'user@example.com', role: 'USER' },
    });

    expect(screen.getByText(
      'Administrator access is required to use Backoffice.'
    )).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('loads the protected panel only for administrators', async () => {
    axios.get.mockResolvedValue({
      data: [{
        eventId: 'event-1',
        name: 'Admin fixture',
        home: 'Home',
        away: 'Away',
        status: 'OPEN',
        visibility: 'ONLINE',
      }],
    });
    renderBackoffice({
      currentUser: { email: 'admin@example.com', role: 'ADMIN' },
    });

    expect(await screen.findByText('Admin fixture')).toBeVisible();
    expect(axios.get).toHaveBeenCalledWith('/api/backoffice');
    expect(screen.getByText('Create new event')).toBeVisible();
  });

  it('surfaces protected event loading failures', async () => {
    axios.get.mockRejectedValue(new Error('request failed'));
    renderBackoffice({
      currentUser: { email: 'admin@example.com', role: 'ADMIN' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Unable to load Backoffice events.'
    );
  });
});
