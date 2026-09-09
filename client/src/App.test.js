import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import axios from 'axios';
import App from './App';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

jest.mock('./Header', () => () => <div data-testid="header">Header</div>);
jest.mock('./pages/event/EventList', () => () => <div data-testid="events">Events</div>);
jest.mock('./pages/Slip', () => () => <div data-testid="slip">Slip sidebar</div>);
jest.mock('./pages/account/Statistics', () => () => (
  <div data-testid="leaderboard">Leaderboard sidebar</div>
));
jest.mock('./pages/account/Backoffice', () => () => <div>Backoffice page</div>);
jest.mock('./pages/account/MyBets', () => () => <div>My bets page</div>);
jest.mock('./pages/auth/NewUser', () => () => <div>Signup page</div>);
jest.mock('./pages/auth/LogIn', () => () => <div>Login page</div>);
jest.mock('./pages/auth/LogOut', () => () => <div>Logout page</div>);
jest.mock('./pages/Telemetry', () => () => (
  <section>
    <h1>Telemetry and service health</h1>
  </section>
));

const NavigationControls = () => {
  const navigate = useNavigate();
  return <div>
    <button type="button" onClick={() => navigate('/?ui=v3&theme=light')}>Main query</button>
    <button type="button" onClick={() => navigate('/other')}>Other route</button>
    <button type="button" onClick={() => navigate('/telemetry')}>Telemetry route</button>
    <button type="button" onClick={() => navigate('/backoffice')}>Backoffice route</button>
  </div>;
};

const renderApp = (path, withControls = false) => render(
  <MemoryRouter initialEntries={[path]}>
    {withControls ? <NavigationControls /> : null}
    <App />
  </MemoryRouter>
);

describe('App telemetry routing and page-view reporting', () => {
  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
    axios.get.mockResolvedValue({ data: { currentUser: null } });
    axios.post.mockResolvedValue({});
  });

  it('renders Telemetry full width without mounting either existing sidebar', async () => {
    await act(async () => {
      renderApp('/telemetry?ui=v2&theme=light');
    });

    expect(screen.getByRole('heading', { name: 'Telemetry and service health', level: 1 }))
      .toBeInTheDocument();
    expect(screen.queryByTestId('leaderboard')).not.toBeInTheDocument();
    expect(screen.queryByTestId('slip')).not.toBeInTheDocument();
    expect(screen.getByRole('main').parentElement).toHaveClass('col-12', 'order-1');
    expect(screen.getByRole('main').parentElement).not.toHaveClass('col-xl-8');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('reports only main and Backoffice pathname entries with exact request bodies', async () => {
    await act(async () => {
      renderApp('/', true);
    });

    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    expect(axios.post).toHaveBeenLastCalledWith(
      '/api/telemetry/page-view',
      { page: 'main' }
    );

    fireEvent.click(screen.getByRole('button', { name: 'Main query' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Other route' }));
    fireEvent.click(screen.getByRole('button', { name: 'Telemetry route' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Backoffice route' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(2));
    expect(axios.post).toHaveBeenLastCalledWith(
      '/api/telemetry/page-view',
      { page: 'admin' }
    );
  });

  it('swallows page-view reporting failure without blocking rendering', async () => {
    axios.post.mockRejectedValueOnce(new Error('reporting offline'));
    await act(async () => {
      renderApp('/');
    });

    expect(screen.getByTestId('events')).toBeInTheDocument();
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('main')).toBeInTheDocument();
  });
});
