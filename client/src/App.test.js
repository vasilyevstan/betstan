import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import axios from 'axios';
import App from './App';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
  patch: jest.fn(),
}));

jest.mock('./Header', () => () => <div data-testid="header">Header</div>);
jest.mock('./pages/event/EventList', () => ({ onSelectionPlaced }) => (
  <section data-testid="events">
    <h1>Events</h1>
    <button type="button" onClick={() => onSelectionPlaced('LIVE')}>Place live pick</button>
    <button type="button" onClick={() => onSelectionPlaced('PRE_MATCH')}>Place pre-match pick</button>
    <button type="button" onClick={() => onSelectionPlaced()}>Place pick without a kind</button>
    <button type="button" onClick={onSelectionPlaced}>Place pick with a click event</button>
  </section>
));
jest.mock('./pages/Slip', () => (props) => (
  <div
    data-testid="slip"
    data-refresh-signal={props.refreshSignal}
    data-resolved={String(props.isCurrentUserResolved)}
    data-tab-kind={props.tabRequest?.betKind ?? ''}
    data-tab-nonce={props.tabRequest?.nonce ?? ''}
  >
    Slip sidebar
  </div>
));
jest.mock('./pages/account/Statistics', () => () => (
  <div data-testid="leaderboard">Leaderboard sidebar</div>
));
jest.mock('./pages/account/Backoffice', () => () => <div>Backoffice page</div>);
jest.mock('./pages/account/BackofficeMarkets', () => ({
  __esModule: true,
  default: () => <div>Event markets</div>,
  BackofficeMarketDesigner: () => <div>Market designer</div>,
}));
jest.mock('./pages/account/MyBets', () => () => <div>My bets page</div>);
jest.mock('./pages/auth/AuthPage', () => ({ tab, callback }) => (
  <div>
    <p>{`Auth page, ${tab} tab`}</p>
    <button type="button" onClick={callback}>Complete auth</button>
  </div>
));
jest.mock('./pages/auth/ForgotPassword', () => () => <div>Forgot password page</div>);
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
    <button type="button" onClick={() => navigate('/BACKOFFICE')}>Backoffice case alias</button>
    <button type="button" onClick={() => navigate('/backoffice/')}>Backoffice slash alias</button>
    <button type="button" onClick={() => navigate('/profile')}>Profile route</button>
    <button type="button" onClick={() => navigate('/backoffice/markets')}>Templates route</button>
    <button type="button" onClick={() => navigate('/BACKOFFICE/MARKETS/?theme=light')}>Templates alias</button>
    <button type="button" onClick={() => navigate('/backoffice/events/example/markets')}>Event markets route</button>
    <button type="button" onClick={() => navigate('/backoffice/risk-centre')}>Risk route</button>
    <button type="button" onClick={() => navigate('/BACKOFFICE/RISK-CENTRE/?theme=light')}>Risk alias</button>
  </div>;
};

const renderApp = (path, withControls = false) => render(
  <MemoryRouter initialEntries={[path]}>
    {withControls ? <NavigationControls /> : null}
    <App />
  </MemoryRouter>
);

describe('App telemetry routing and page-view reporting', () => {
  it.each([
    ['/BACKOFFICE/MARKETS/', ['admin', 'market-template']],
    ['/BACKOFFICE/RISK-CENTRE/', ['admin', 'risk-centre']],
    ['/backoffice/events/example/markets', ['admin']],
    ['/backoffice/events/analysis', ['admin']],
    ['/BACKOFFICE/EVENTS/example/ANALYSIS/', ['admin']],
    ['/backoffice/markets/preview', []],
  ])('classifies the raw direct route %s without counting event editors or previews as templates', async (path, expected) => {
    await act(async () => { renderApp(path); });
    expect(axios.post.mock.calls.map(([, { page }]) => page)).toEqual(expected);
  });

  it.each([
    '/backoffice/events/analysis?theme=light',
    '/backoffice/events/example/analysis?ui=v3',
  ])('renders Backoffice analysis at %s rather than the player event board', async path => {
    await act(async () => { renderApp(path); });
    expect(screen.getByRole('heading', { level: 1, name: 'Black swan analysis' })).toBeVisible();
    expect(screen.queryByTestId('events')).not.toBeInTheDocument();
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith('/api/telemetry/page-view', { page: 'admin' });
  });

  it('deduplicates specific page aliases independently of the broad admin stream', async () => {
    await act(async () => { renderApp('/backoffice/markets', true); });
    const pages = () => axios.post.mock.calls.map(([, { page }]) => page);
    expect(pages()).toEqual(['admin', 'market-template']);
    for (const name of ['Templates alias', 'Event markets route', 'Templates route', 'Risk route', 'Risk alias']) {
      await act(async () => { fireEvent.click(screen.getByText(name)); });
    }
    expect(pages()).toEqual(['admin', 'market-template', 'market-template', 'risk-centre']);
    await act(async () => { fireEvent.click(screen.getByText('Other route')); });
    await act(async () => { fireEvent.click(screen.getByText('Risk route')); });
    expect(pages()).toEqual(['admin', 'market-template', 'market-template', 'risk-centre', 'admin', 'risk-centre']);
  });

  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
    axios.patch.mockReset();
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
    expect(screen.getByRole('main').parentElement).toHaveClass('app-desk__main');
    expect(screen.getByRole('main').parentElement.parentElement).toHaveClass('app-desk--full');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('uses main-first semantic order and lets the skip link focus the stable main target', async () => {
    await act(async () => {
      renderApp('/');
    });

    const main = screen.getByRole('main');
    const statistics = screen.getByRole('complementary', { name: 'Statistics' });
    const slips = screen.getByRole('complementary', { name: 'Slip' });

    expect(main).toHaveAttribute('id', 'main-content');
    expect(main).toHaveAttribute('tabindex', '-1');
    expect(main.compareDocumentPosition(statistics) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(statistics.compareDocumentPosition(slips) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();

    fireEvent.click(screen.getByRole('link', { name: 'Skip to main content' }));
    expect(main).toHaveFocus();
  });

  it.each(['/telemetry/', '/Telemetry'])(
    'renders direct Telemetry alias %s full width',
    async (pathname) => {
      await act(async () => {
        renderApp(pathname);
      });

      expect(screen.getByRole('heading', {
        name: 'Telemetry and service health',
        level: 1,
      })).toBeInTheDocument();
      expect(screen.queryByTestId('leaderboard')).not.toBeInTheDocument();
      expect(screen.queryByTestId('slip')).not.toBeInTheDocument();
      expect(screen.getByRole('main').parentElement).not.toHaveClass('col-xl-8');
      expect(axios.post).not.toHaveBeenCalled();
    },
  );

  it.each(['/backoffice/', '/BACKOFFICE'])(
    'renders direct Backoffice alias %s and reports one admin page view',
    async (pathname) => {
      await act(async () => {
        renderApp(pathname);
      });

      expect(screen.getByText('Backoffice page')).toBeInTheDocument();
      expect(screen.getByTestId('leaderboard')).toBeInTheDocument();
      expect(screen.getByTestId('slip')).toBeInTheDocument();
      await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
      expect(axios.post).toHaveBeenCalledWith(
        '/api/telemetry/page-view',
        { page: 'admin' }
      );
    },
  );

  it('keeps an unknown deeper Telemetry path on the wildcard layout', async () => {
    await act(async () => {
      renderApp('/telemetry/details');
    });

    expect(screen.getByTestId('events')).toBeInTheDocument();
    expect(screen.getByTestId('leaderboard')).toBeInTheDocument();
    expect(screen.getByTestId('slip')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Telemetry and service health' }))
      .not.toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('renders the wildcard as Events with exactly one route heading', async () => {
    await act(async () => {
      renderApp('/retained-unknown-route');
    });

    expect(screen.getByTestId('events')).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Events' }))
      .toBeInTheDocument();
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

  it('does not double-count transitions between Backoffice route aliases', async () => {
    await act(async () => {
      renderApp('/backoffice/', true);
    });
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Backoffice case alias' }));
    fireEvent.click(screen.getByRole('button', { name: 'Backoffice slash alias' }));
    await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
    expect(screen.getByText('Backoffice page')).toBeInTheDocument();
  });

  it('routes a private profile and retains a saved display name without changing the login', async () => {
    axios.get.mockImplementation(async (url) => ({
      data: url === '/api/auth/currentuser'
        ? { currentUser: { id: 'owner', email: 'login@example.com', displayName: 'Old name' } }
        : {
          range: { from: null, toExclusive: null },
          acceptedBets: 0, wins: 0, losses: 0, openBets: 0, voidedBets: 0, cashBackBets: 0,
          pendingSubmissions: 0, declinedSubmissions: 0, totalStaked: '0',
        },
    }));
    axios.patch.mockResolvedValue({ data: { displayName: 'Saved name' } });
    await act(async () => renderApp('/profile?ui=v2&theme=light', true));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit name' }));
    expect(screen.getByLabelText('Display name')).toHaveValue('Old name');
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Saved name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(await screen.findByText('Name saved.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Other route' }));
    fireEvent.click(screen.getByRole('button', { name: 'Profile route' }));
    expect(await screen.findByRole('heading', { name: 'Saved name', level: 2 })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Edit name' }));
    expect(screen.getByLabelText('Display name')).toHaveValue('Saved name');
    expect(screen.getByText('login@example.com')).toBeVisible();
    expect(screen.getByTestId('leaderboard')).toBeInTheDocument();
    expect(screen.getByTestId('slip')).toBeInTheDocument();
    expect(axios.get.mock.calls.filter(([url]) => url === '/api/auth/currentuser')).toHaveLength(1);
  });
});

describe('App slip window requests', () => {
  const slip = () => screen.getByTestId('slip');
  const refreshSignal = () => Number(slip().getAttribute('data-refresh-signal'));

  const LoginLink = () => {
    const navigate = useNavigate();
    return <button type="button" onClick={() => navigate('/login')}>Go to login</button>;
  };

  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
    axios.patch.mockReset();
    axios.get.mockResolvedValue({ data: { currentUser: null } });
    axios.post.mockResolvedValue({});
  });

  it('names the region Slip and keeps the heading id the release gate selects', async () => {
    await act(async () => { renderApp('/'); });

    expect(screen.getByRole('complementary', { name: 'Slip' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Slips' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Slip' })).toHaveAttribute('id', 'slips-region-heading');
  });

  it('tells the slip when auth has resolved so a guest slip can load', async () => {
    await act(async () => { renderApp('/'); });

    expect(slip()).toHaveAttribute('data-resolved', 'true');
    expect(slip()).toHaveAttribute('data-tab-nonce', '');
  });

  it.each([
    ['LIVE', 'Place live pick'],
    ['PRE_MATCH', 'Place pre-match pick'],
  ])('asks the slip to open the %s tab and reload when a pick is placed', async (betKind, buttonName) => {
    await act(async () => { renderApp('/'); });
    const signalBefore = refreshSignal();

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    expect(slip()).toHaveAttribute('data-tab-kind', betKind);
    expect(slip()).toHaveAttribute('data-tab-nonce', '1');
    expect(refreshSignal()).toBe(signalBefore + 1);
  });

  it('issues a new request every time, including the same kind twice in a row', async () => {
    await act(async () => { renderApp('/'); });

    fireEvent.click(screen.getByRole('button', { name: 'Place live pick' }));
    expect([slip().dataset.tabKind, slip().dataset.tabNonce]).toEqual(['LIVE', '1']);
    fireEvent.click(screen.getByRole('button', { name: 'Place live pick' }));
    expect([slip().dataset.tabKind, slip().dataset.tabNonce]).toEqual(['LIVE', '2']);
    fireEvent.click(screen.getByRole('button', { name: 'Place pre-match pick' }));
    expect([slip().dataset.tabKind, slip().dataset.tabNonce]).toEqual(['PRE_MATCH', '3']);
  });

  it.each([
    'Place pick without a kind',
    'Place pick with a click event',
  ])('reloads the slip but never requests a tab for "%s"', async (buttonName) => {
    await act(async () => { renderApp('/'); });
    const signalBefore = refreshSignal();

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    expect(refreshSignal()).toBe(signalBefore + 1);
    expect(slip()).toHaveAttribute('data-tab-kind', '');
    expect(slip()).toHaveAttribute('data-tab-nonce', '');
  });

  it('reloads the slip after login or signup without a tab request and keeps the last one', async () => {
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/']}>
          <LoginLink />
          <App />
        </MemoryRouter>
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Place live pick' }));
    const signalBefore = refreshSignal();

    fireEvent.click(screen.getByRole('button', { name: 'Go to login' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Complete auth' }));
    });

    expect(refreshSignal()).toBe(signalBefore + 1);
    expect([slip().dataset.tabKind, slip().dataset.tabNonce]).toEqual(['LIVE', '1']);
  });

  it('reloads the slip after a login without any tab request when none was placed', async () => {
    await act(async () => { renderApp('/login?ui=v2&theme=dark'); });
    const signalBefore = refreshSignal();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Complete auth' }));
    });

    expect(refreshSignal()).toBe(signalBefore + 1);
    expect(slip()).toHaveAttribute('data-tab-kind', '');
    expect(slip()).toHaveAttribute('data-tab-nonce', '');
  });
});

describe('App auth routes', () => {
  const currentUserRequests = () => axios.get.mock.calls
    .filter(([url]) => url === '/api/auth/currentuser');

  beforeEach(() => {
    axios.get.mockReset();
    axios.post.mockReset();
    axios.patch.mockReset();
    axios.get.mockResolvedValue({ data: { currentUser: null } });
    axios.post.mockResolvedValue({});
  });

  it.each([
    ['/login?ui=v2&theme=dark', 'login'],
    ['/LOGIN/', 'login'],
    ['/signup?ui=v3&theme=light', 'signup'],
    ['/Signup/', 'signup'],
  ])('renders the one auth page at %s on its %s tab', async (path, tab) => {
    await act(async () => { renderApp(path); });

    expect(screen.getByText(`Auth page, ${tab} tab`)).toBeInTheDocument();
    expect(screen.getAllByText(/^Auth page, /)).toHaveLength(1);
    expect(screen.queryByTestId('events')).not.toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it.each(['/login?ui=v2&theme=dark', '/signup?ui=v2&theme=dark'])(
    'hands %s the shared auth callback so a successful login or signup refreshes the session',
    async (path) => {
      await act(async () => { renderApp(path); });
      expect(currentUserRequests()).toHaveLength(1);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Complete auth' }));
      });

      expect(currentUserRequests()).toHaveLength(2);
    },
  );

  it.each(['/forgot-password?ui=v2&theme=light', '/Forgot-Password/'])(
    'renders the public forgot-password page at %s without an auth page or a page view',
    async (path) => {
      await act(async () => { renderApp(path); });

      expect(screen.getByText('Forgot password page')).toBeInTheDocument();
      expect(screen.queryByText(/^Auth page, /)).not.toBeInTheDocument();
      expect(screen.queryByTestId('events')).not.toBeInTheDocument();
      expect(axios.post).not.toHaveBeenCalled();
    },
  );

  it('keeps a deeper forgot-password path on the wildcard Events layout', async () => {
    await act(async () => { renderApp('/forgot-password/details'); });

    expect(screen.getByTestId('events')).toBeInTheDocument();
    expect(screen.queryByText('Forgot password page')).not.toBeInTheDocument();
  });
});
