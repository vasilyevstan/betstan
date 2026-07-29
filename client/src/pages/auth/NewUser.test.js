import React from 'react';
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

  it('submits signup form using UseRequest', () => {
    const doRequest = jest.fn();
    UseRequest.mockReturnValue({
      doRequest,
      errors: null,
    });

    const { container } = render(
      <MemoryRouter>
        <NewUser callback={jest.fn()} />
      </MemoryRouter>
    );

    const inputs = container.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: 'new@betstan.xyz' } });
    fireEvent.change(inputs[1], { target: { value: 'Password123!Password123!' } });

    fireEvent.click(screen.getByRole('button', { name: 'Sign Up' }));
    expect(doRequest).toHaveBeenCalledTimes(1);
  });

  it('navigates home and triggers callback on successful signup', () => {
    const callback = jest.fn();
    let hookConfig;
    UseRequest.mockImplementation((config) => {
      hookConfig = config;
      return { doRequest: jest.fn(), errors: null };
    });

    render(
      <MemoryRouter>
        <NewUser callback={callback} />
      </MemoryRouter>
    );

    hookConfig.onSuccess();

    expect(mockNavigate).toHaveBeenCalledWith('/');
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
