import React from 'react';
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

describe('LogIn page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('submits login form using UseRequest', () => {
    const doRequest = jest.fn();
    UseRequest.mockReturnValue({
      doRequest,
      errors: null,
    });

    const { container } = render(
      <MemoryRouter>
        <LogIn callback={jest.fn()} />
      </MemoryRouter>
    );

    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'qa@betstan.xyz' } });
    fireEvent.change(inputs[1], { target: { value: 'Password123!Password123!' } });

    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
    expect(doRequest).toHaveBeenCalledTimes(1);
  });

  it('navigates home and triggers callback on successful login', () => {
    const callback = jest.fn();
    let hookConfig;
    UseRequest.mockImplementation((config) => {
      hookConfig = config;
      return { doRequest: jest.fn(), errors: null };
    });

    render(
      <MemoryRouter>
        <LogIn callback={callback} />
      </MemoryRouter>
    );

    hookConfig.onSuccess();

    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
