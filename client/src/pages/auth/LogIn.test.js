import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LogIn from './LogIn';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hook/UseRequest', () => jest.fn());
const UseRequest = require('../../hook/UseRequest');

describe('LogIn form', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders and submits an accessible login form', () => {
    const doRequest = jest.fn();
    UseRequest.mockReturnValue({
      doRequest,
      errors: null,
    });

    render(
      <MemoryRouter initialEntries={['/login?ui=v2&theme=light']}>
        <LogIn callback={jest.fn()} />
      </MemoryRouter>
    );

    // The heading, tabs and cross-links belong to the single auth page (AuthPage.test.js).
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    const identifier = screen.getByLabelText('Username or email');
    const password = screen.getByLabelText('Password');
    expect(identifier).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('autocomplete', 'current-password');

    fireEvent.change(identifier, { target: { value: 'stan_1' } });
    fireEvent.change(password, { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    expect(doRequest).toHaveBeenCalledTimes(1);
    expect(UseRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      body: {
        email: 'stan_1',
        password: 'Password123!',
      },
    }));
  });

  it('preserves the selected UI and triggers callback on successful login', () => {
    const callback = jest.fn();
    let hookConfig;
    UseRequest.mockImplementation((config) => {
      hookConfig = config;
      return { doRequest: jest.fn(), errors: null };
    });

    render(
      <MemoryRouter initialEntries={['/login?ui=v3&theme=dark']}>
        <LogIn callback={callback} />
      </MemoryRouter>
    );

    hookConfig.onSuccess();

    expect(mockNavigate).toHaveBeenCalledWith({
      pathname: '/',
      search: '?ui=v3&theme=dark',
    });
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
