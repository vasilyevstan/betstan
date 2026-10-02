import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, useLocation } from 'react-router-dom';
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

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const LocationSearch = () => {
  const location = useLocation();
  return <output data-testid="location-search">{location.search}</output>;
};

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

  it('does not resubmit on presentation changes and uses the latest query after an explicit retry', async () => {
    const callback = jest.fn();
    const initialRequest = createDeferred();
    const retryRequest = createDeferred();
    axios.post
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(retryRequest.promise);

    render(
      <MemoryRouter initialEntries={['/logout?ui=v1&theme=dark&review=retained']}>
        <nav aria-label="Test presentation changes">
          <Link to="/logout?ui=v1&theme=light&review=retained">Use Light</Link>
          <Link to="/logout?ui=v3&theme=light&review=retained&filter=open">
            Use Spacious
          </Link>
          <Link to="/logout?ui=v3&theme=dark&review=retained&filter=open">
            Use Dark
          </Link>
        </nav>
        <LocationSearch />
        <LogOut callback={callback} />
      </MemoryRouter>
    );

    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('link', { name: 'Use Light' }));
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent(
      '?ui=v1&theme=light&review=retained'
    ));
    expect(axios.post).toHaveBeenCalledTimes(1);

    await act(async () => {
      initialRequest.reject(new Error('ECONNRESET from auth.internal'));
    });
    expect(await screen.findByRole('heading', {
      level: 1,
      name: 'We couldn’t log you out',
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('link', { name: 'Use Spacious' }));
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent(
      '?ui=v3&theme=light&review=retained&filter=open'
    ));
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Return to Events' })).toHaveAttribute(
      'href',
      '/?ui=v3&theme=light&review=retained&filter=open'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry log out' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('link', { name: 'Use Dark' }));
    await waitFor(() => expect(screen.getByTestId('location-search')).toHaveTextContent(
      '?ui=v3&theme=dark&review=retained&filter=open'
    ));
    expect(axios.post).toHaveBeenCalledTimes(2);

    await act(async () => {
      retryRequest.resolve({});
    });
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith({
      pathname: '/',
      search: '?ui=v3&theme=dark&review=retained&filter=open',
    }));
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
