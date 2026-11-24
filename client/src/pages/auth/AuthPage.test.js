import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import AuthPage from './AuthPage';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');

const LocationProbe = () => {
  const location = useLocation();
  return (
    <p data-testid="location" data-key={location.key}>{`${location.pathname}${location.search}`}</p>
  );
};

// Stands in for the browser back and forward buttons.
const HistoryButtons = () => {
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate(-1)}>history back</button>
      <button type="button" onClick={() => navigate(1)}>history forward</button>
    </>
  );
};

// Mirrors the way App registers the two routes.
const renderAuth = (path = '/login?ui=v2&theme=dark', callback = jest.fn()) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<AuthPage tab="login" callback={callback} />} />
        <Route path="/signup" element={<AuthPage tab="signup" callback={callback} />} />
        <Route path="/forgot-password" element={<p>Forgot password page</p>} />
        <Route path="/" element={<p>Home page</p>} />
      </Routes>
      <LocationProbe />
      <HistoryButtons />
    </MemoryRouter>
  );
};

const currentLocation = () => screen.getByTestId('location').textContent;
const tab = (name) => screen.getByRole('tab', { name });
const tabStates = () => screen.getAllByRole('tab')
  .map((element) => [element.textContent, element.getAttribute('aria-selected')]);

const fillLogin = (identifier, password) => {
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: identifier } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
};

const fillSignup = (identifier, password) => {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: identifier } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
};

describe('AuthPage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Log in tab', () => {
    it('opens on /login with the login heading, the shared panel and the Log in tab selected', () => {
      renderAuth('/login?ui=v2&theme=dark');

      expect(screen.getByRole('heading', { level: 1, name: 'Log in to your account' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Log in to your account' })).toHaveClass('auth-card');
      expect(screen.getByText('Enter your username or email and password to continue.'))
        .toBeInTheDocument();
      expect(tabStates()).toEqual([['Log in', 'true'], ['Create account', 'false']]);

      const panel = screen.getByRole('tabpanel', { name: 'Log in' });
      expect(within(panel).getByLabelText('Username or email')).toHaveAttribute('autocomplete', 'username');
      expect(within(panel).getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
      expect(within(panel).getByRole('button', { name: 'Log in' })).toHaveAttribute('type', 'submit');
    });

    it('defaults to the Log in tab when no tab is given', () => {
      render(
        <MemoryRouter initialEntries={['/login']}>
          <AuthPage callback={jest.fn()} />
        </MemoryRouter>
      );

      expect(tab('Log in')).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('heading', { level: 1, name: 'Log in to your account' })).toBeInTheDocument();
    });

    it('keeps the release-gate selectors for /login unambiguous', () => {
      renderAuth('/login?ui=v2&theme=dark');

      // The browser specs call getByLabel, which is strict and also matches aria-label and
      // aria-labelledby, so every labelled element is counted, not only inputs.
      expect(screen.getAllByLabelText(/username or email/i)).toHaveLength(1);
      expect(screen.getAllByLabelText(/password/i)).toHaveLength(1);
      expect(screen.getAllByLabelText('Password')).toHaveLength(1);
      expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
      // The Log in tab is a tab, so getByRole('button', { name: 'Log in' }) is the submit button.
      expect(screen.getAllByRole('button', { name: 'Log in' })).toEqual([
        within(screen.getByRole('tabpanel')).getByRole('button', { name: 'Log in' }),
      ]);
      expect(screen.getAllByRole('button', { name: /log in/i })).toHaveLength(1);
      expect(tab('Log in').tagName).toBe('BUTTON');
      expect(tab('Log in')).toHaveAttribute('role', 'tab');
      // getByTitle('Log in') belongs to the header icon, so nothing on this page has a title.
      expect(document.querySelectorAll('[title]')).toHaveLength(0);
    });

    it('offers Forgot password? as a plain link outside every label and keeps the query', () => {
      renderAuth('/login?ui=v2&theme=light');

      const link = screen.getByRole('link', { name: 'Forgot password?' });
      expect(link).toHaveAttribute('href', '/forgot-password?ui=v2&theme=light');
      expect(link).toHaveClass('auth-card__link', 'inline-control-target');
      expect(link).not.toHaveAttribute('title');
      expect(link.closest('label')).toBeNull();
      expect(screen.queryAllByLabelText(/forgot/i)).toHaveLength(0);
      expect(screen.getByLabelText('Password')).toHaveAccessibleName('Password');

      fireEvent.click(link);

      expect(currentLocation()).toBe('/forgot-password?ui=v2&theme=light');
      expect(screen.getByText('Forgot password page')).toBeInTheDocument();
    });

    it('logs in through /api/auth/login, routes home keeping the query and calls the auth callback once', async () => {
      axios.post.mockResolvedValueOnce({ data: { id: 'user-1' } });
      const callback = jest.fn();
      renderAuth('/login?ui=v3&theme=dark', callback);

      fillLogin('stan_1', 'Password123!');
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

      await waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith('/api/auth/login', {
        email: 'stan_1',
        password: 'Password123!',
      });
      expect(currentLocation()).toBe('/?ui=v3&theme=dark');
      expect(screen.getByText('Home page')).toBeInTheDocument();
    });

    it('shows the server message and neither navigates nor calls the callback when login fails', async () => {
      axios.post.mockRejectedValueOnce({
        response: { status: 400, data: { errors: [{ message: 'Invalid login credentials' }] } },
      });
      const callback = jest.fn();
      renderAuth('/login?ui=v3&theme=dark', callback);

      fillLogin('stan_1', 'wrong-password');
      fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Please check your details');
      expect(alert).toHaveTextContent('Invalid login credentials');
      expect(within(screen.getByRole('tabpanel')).getByRole('alert')).toBe(alert);
      expect(callback).not.toHaveBeenCalled();
      expect(currentLocation()).toBe('/login?ui=v3&theme=dark');
    });

    it('replaces the old cross-link with the Create account tab', () => {
      renderAuth('/login?ui=v2&theme=light');

      expect(screen.queryByRole('link', { name: 'Create an account' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('link').map((link) => link.textContent)).toEqual(['Forgot password?']);
    });
  });

  describe('Create account tab', () => {
    it('opens on the /signup alias with the signup heading, form and Create account tab selected', () => {
      renderAuth('/signup?ui=v3&theme=light');

      expect(screen.getByRole('heading', { level: 1, name: 'Create an account' })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Create an account' })).toHaveClass('auth-card');
      expect(screen.getByText('Choose a username and password to get started.')).toBeInTheDocument();
      expect(tabStates()).toEqual([['Log in', 'false'], ['Create account', 'true']]);

      const panel = screen.getByRole('tabpanel', { name: 'Create account' });
      expect(within(panel).getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
      expect(within(panel).getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password');
      expect(within(panel).getByRole('button', { name: 'Create account' })).toHaveAttribute('type', 'submit');
      expect(screen.getAllByLabelText(/password/i)).toHaveLength(1);
      expect(screen.queryByLabelText(/username or email/i)).not.toBeInTheDocument();
    });

    it('creates an account through /api/auth/new, routes home keeping the query and calls the auth callback once', async () => {
      axios.post.mockResolvedValueOnce({ data: {} });
      const callback = jest.fn();
      renderAuth('/signup?ui=v3&theme=dark', callback);

      fillSignup('new-user', 'Password123!');
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

      await waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith('/api/auth/new', {
        email: 'new-user',
        password: 'Password123!',
      });
      expect(currentLocation()).toBe('/?ui=v3&theme=dark');
      expect(screen.getByText('Home page')).toBeInTheDocument();
    });

    it('shows the server message and neither navigates nor calls the callback when signup fails', async () => {
      axios.post.mockRejectedValueOnce({
        response: { status: 400, data: { errors: [{ message: 'Username already in use' }] } },
      });
      const callback = jest.fn();
      renderAuth('/signup?ui=v3&theme=dark', callback);

      fillSignup('taken-user', 'Password123!');
      fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Username already in use');
      expect(callback).not.toHaveBeenCalled();
      expect(currentLocation()).toBe('/signup?ui=v3&theme=dark');
    });

    it('has no Forgot password? link and no Log in cross-link', () => {
      renderAuth('/signup?ui=v2&theme=light');

      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(document.querySelectorAll('[title]')).toHaveLength(0);
    });
  });

  describe('single page behaviour', () => {
    it.each([
      ['/login?ui=v2', 'login-identifier', 'signup-identifier'],
      ['/signup?ui=v2', 'signup-identifier', 'login-identifier'],
    ])('mounts only the active form on %s', (path, activeFieldId, inactiveFieldId) => {
      renderAuth(path);

      expect(document.querySelectorAll('form')).toHaveLength(1);
      expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
      expect(document.getElementById(activeFieldId)).toBeInTheDocument();
      expect(document.getElementById(inactiveFieldId)).toBeNull();
      expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    });

    it('exposes a labelled tablist of untitled tabs wired to the one mounted tabpanel', () => {
      renderAuth('/login?ui=v2&theme=dark');

      expect(screen.getByRole('tablist', { name: 'Account access' })).toBeInTheDocument();
      screen.getAllByRole('tab').forEach((element) => {
        expect(element).toHaveAttribute('type', 'button');
        expect(element).not.toHaveAttribute('title');
      });
      expect(tab('Log in')).toHaveAttribute('id', 'auth-tab-login');
      expect(tab('Log in')).toHaveAttribute('aria-controls', 'auth-panel-login');
      expect(tab('Create account')).toHaveAttribute('id', 'auth-tab-signup');
      expect(tab('Create account')).toHaveAttribute('aria-controls', 'auth-panel-signup');

      const loginPanel = screen.getByRole('tabpanel', { name: 'Log in' });
      expect(loginPanel).toHaveAttribute('id', 'auth-panel-login');
      expect(loginPanel).toHaveAttribute('aria-labelledby', 'auth-tab-login');
      expect(document.getElementById('auth-panel-signup')).toBeNull();

      fireEvent.click(tab('Create account'));

      const signupPanel = screen.getByRole('tabpanel', { name: 'Create account' });
      expect(signupPanel).toHaveAttribute('id', 'auth-panel-signup');
      expect(signupPanel).toHaveAttribute('aria-labelledby', 'auth-tab-signup');
      expect(document.getElementById('auth-panel-login')).toBeNull();
    });

    it('switches tabs by navigating between /login and /signup and keeps the ui and theme query', () => {
      renderAuth('/login?ui=v2&theme=dark');

      fireEvent.click(tab('Create account'));
      expect(currentLocation()).toBe('/signup?ui=v2&theme=dark');
      expect(screen.getByRole('heading', { level: 1, name: 'Create an account' })).toBeInTheDocument();
      expect(tabStates()).toEqual([['Log in', 'false'], ['Create account', 'true']]);

      fireEvent.click(tab('Log in'));
      expect(currentLocation()).toBe('/login?ui=v2&theme=dark');
      expect(screen.getByRole('heading', { level: 1, name: 'Log in to your account' })).toBeInTheDocument();
      expect(tabStates()).toEqual([['Log in', 'true'], ['Create account', 'false']]);
    });

    it('does not add a history entry when the active tab is clicked again', () => {
      renderAuth('/login?ui=v2&theme=dark');
      const locationKey = screen.getByTestId('location').dataset.key;

      fireEvent.click(tab('Log in'));

      expect(screen.getByTestId('location').dataset.key).toBe(locationKey);
    });

    it('follows browser back and forward between the tabs', () => {
      renderAuth('/login?ui=v2&theme=dark');

      fireEvent.click(tab('Create account'));
      expect(screen.getByRole('heading', { level: 1, name: 'Create an account' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'history back' }));
      expect(currentLocation()).toBe('/login?ui=v2&theme=dark');
      expect(tabStates()).toEqual([['Log in', 'true'], ['Create account', 'false']]);
      expect(screen.getByLabelText('Username or email')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'history forward' }));
      expect(currentLocation()).toBe('/signup?ui=v2&theme=dark');
      expect(tabStates()).toEqual([['Log in', 'false'], ['Create account', 'true']]);
      expect(screen.getByLabelText('Username')).toBeInTheDocument();
    });

    it('moves between the tabs with the arrow, Home and End keys and keeps focus on the active tab', () => {
      renderAuth('/login?ui=v2&theme=dark');
      const loginTab = tab('Log in');
      const signupTab = tab('Create account');
      loginTab.focus();

      fireEvent.keyDown(loginTab, { key: 'ArrowRight' });
      expect(currentLocation()).toBe('/signup?ui=v2&theme=dark');
      // The same elements survive the route change, so keyboard focus is not lost.
      expect(tab('Create account')).toBe(signupTab);
      expect(tab('Log in')).toBe(loginTab);
      expect(signupTab).toHaveFocus();
      expect(signupTab).toHaveAttribute('aria-selected', 'true');
      expect(signupTab).toHaveAttribute('tabindex', '0');
      expect(loginTab).toHaveAttribute('tabindex', '-1');

      fireEvent.keyDown(signupTab, { key: 'Home' });
      expect(currentLocation()).toBe('/login?ui=v2&theme=dark');
      expect(loginTab).toHaveFocus();

      fireEvent.keyDown(loginTab, { key: 'End' });
      expect(currentLocation()).toBe('/signup?ui=v2&theme=dark');
      expect(signupTab).toHaveFocus();

      fireEvent.keyDown(signupTab, { key: 'ArrowRight' });
      expect(currentLocation()).toBe('/login?ui=v2&theme=dark');
      expect(loginTab).toHaveFocus();

      fireEvent.keyDown(loginTab, { key: 'ArrowLeft' });
      expect(currentLocation()).toBe('/signup?ui=v2&theme=dark');
      expect(signupTab).toHaveFocus();
    });

    it('tabs from the active tab through the Log in form to the Forgot password? link', () => {
      renderAuth('/login?ui=v2&theme=dark');
      tab('Log in').focus();

      const order = [];
      for (let step = 0; step < 4; step += 1) {
        userEvent.tab();
        order.push(document.activeElement);
      }

      expect(order).toEqual([
        screen.getByLabelText('Username or email'),
        screen.getByLabelText('Password'),
        screen.getByRole('button', { name: 'Log in' }),
        screen.getByRole('link', { name: 'Forgot password?' }),
      ]);
    });

    it('tabs from the active tab through the Create account form', () => {
      renderAuth('/signup?ui=v2&theme=dark');
      tab('Create account').focus();

      const order = [];
      for (let step = 0; step < 3; step += 1) {
        userEvent.tab();
        order.push(document.activeElement);
      }

      expect(order).toEqual([
        screen.getByLabelText('Username'),
        screen.getByLabelText('Password'),
        screen.getByRole('button', { name: 'Create account' }),
      ]);
    });

    it('does not carry typed credentials from one tab to the other', () => {
      renderAuth('/login?ui=v2&theme=dark');
      fillLogin('stan_1', 'Password123!');

      fireEvent.click(tab('Create account'));
      expect(screen.getByLabelText('Username')).toHaveValue('');
      expect(screen.getByLabelText('Password')).toHaveValue('');

      fillSignup('new-user', 'Password456!');
      fireEvent.click(tab('Log in'));
      expect(screen.getByLabelText('Username or email')).toHaveValue('');
      expect(screen.getByLabelText('Password')).toHaveValue('');
    });

    it('sends nothing until a form is submitted', () => {
      renderAuth('/login?ui=v2&theme=dark');

      fireEvent.click(tab('Create account'));
      fireEvent.click(tab('Log in'));

      expect(axios.post).not.toHaveBeenCalled();
    });
  });
});
