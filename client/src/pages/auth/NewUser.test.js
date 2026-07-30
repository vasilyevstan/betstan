import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NewUser from './NewUser';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hook/UseRequest', () => jest.fn());
const UseRequest = require('../../hook/UseRequest');

describe('NewUser page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders and submits an accessible account creation form', () => {
    const doRequest = jest.fn();
    UseRequest.mockReturnValue({
      doRequest,
      errors: null,
    });

    render(
      <MemoryRouter initialEntries={['/signup?ui=v2&theme=light']}>
        <NewUser callback={jest.fn()} />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Create an account' })).toBeInTheDocument();

    const identifier = screen.getByLabelText('Username');
    const password = screen.getByLabelText('Password');
    expect(identifier).toHaveAttribute('autocomplete', 'username');
    expect(identifier).toHaveAttribute('minlength', '3');
    expect(identifier).toHaveAttribute('maxlength', '40');
    expect(password).toHaveAttribute('autocomplete', 'new-password');

    fireEvent.change(identifier, { target: { value: 'new-user' } });
    fireEvent.change(password, { target: { value: 'Password123!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(doRequest).toHaveBeenCalledTimes(1);
    expect(UseRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      body: {
        email: 'new-user',
        password: 'Password123!',
      },
    }));
    expect(screen.getByRole('link', { name: 'Log in' }))
      .toHaveAttribute('href', '/login?ui=v2&theme=light');
  });

  it('preserves the selected UI and triggers callback on successful signup', () => {
    const callback = jest.fn();
    let hookConfig;
    UseRequest.mockImplementation((config) => {
      hookConfig = config;
      return { doRequest: jest.fn(), errors: null };
    });

    render(
      <MemoryRouter initialEntries={['/signup?ui=v3&theme=dark']}>
        <NewUser callback={callback} />
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
