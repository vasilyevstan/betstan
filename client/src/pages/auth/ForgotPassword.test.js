import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import ForgotPassword from './ForgotPassword';

jest.mock('axios', () => ({
  post: jest.fn(),
}));

const axios = require('axios');

const CONFIRMATION = 'If that account exists, its password is now abcdef. Log in with it.';

const renderPage = (path = '/forgot-password?ui=v2&theme=light') => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/login" element={<div>Login page</div>} />
    </Routes>
  </MemoryRouter>
);

const submit = (value) => {
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
};

describe('ForgotPassword page', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders one labelled field with login validation rules and one Reset password button', () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Reset your password' })).toBeInTheDocument();
    const field = screen.getByLabelText('Username or email');
    expect(screen.getAllByRole('textbox')).toEqual([field]);
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveAttribute('autocomplete', 'username');
    expect(field).toHaveAttribute('minlength', '3');
    expect(field).toHaveAttribute('maxlength', '254');
    expect(field).toBeRequired();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(screen.getAllByRole('button')).toEqual([
      screen.getByRole('button', { name: 'Reset password' }),
    ]);
    expect(screen.getByRole('button', { name: 'Reset password' })).toHaveAttribute('type', 'submit');
    // Nothing is promised before a reset, and nothing is said about sending messages.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(screen.queryByText(/inbox|sent|e-mail/i)).not.toBeInTheDocument();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('leaves the browser to block an empty submission through the required field', () => {
    renderPage();
    const field = screen.getByLabelText('Username or email');

    // jsdom does not run constraint validation on click, so the form validity the
    // browser consults before it fires submit is asserted instead.
    expect(field).toBeInvalid();
    expect(field.form.checkValidity()).toBe(false);

    fireEvent.change(field, { target: { value: 'stan_1' } });
    expect(field).toBeValid();
    expect(field.form.checkValidity()).toBe(true);
  });

  it('posts the field as the email property and confirms with exactly the specified message', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: { anything: 'ignored' } });
    renderPage();

    submit('stan_1');

    const status = screen.getByRole('status');
    await waitFor(() => expect(status.textContent).toBe(CONFIRMATION));
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith('/api/auth/forgot-password', { email: 'stan_1' });
    expect(screen.getByText(CONFIRMATION)).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to log in' }))
      .toHaveAttribute('href', '/login?ui=v2&theme=light');
  });

  it('confirms the same way whatever the success body says', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: undefined });
    renderPage();

    submit('someone-unknown');

    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(CONFIRMATION));
  });

  it('shows the backend validation message like the login form and no confirmation on 400', async () => {
    axios.post.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { errors: [{ message: 'Enter a valid username or email', field: 'email' }] },
      },
    });
    renderPage();

    submit('not valid!');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Please check your details');
    expect(alert).toHaveTextContent('Enter a valid username or email');
    expect(alert.closest('.auth-errors')).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText(CONFIRMATION)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('shows a normal error and no confirmation when the network fails', async () => {
    axios.post.mockRejectedValueOnce(new Error('Network Error'));
    renderPage();

    submit('stan_1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed. Please try again.');
    expect(screen.queryByText('Network Error')).not.toBeInTheDocument();
    expect(screen.queryByText(CONFIRMATION)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it.each([
    ['a structured server error', { errors: [{ message: 'Something went wrong' }] }, 'Something went wrong'],
    ['an unstructured server error', '<html>Bad gateway</html>', 'Request failed. Please try again.'],
  ])('shows an error and no confirmation on a 5xx with %s', async (_name, data, expected) => {
    axios.post.mockRejectedValueOnce({ response: { status: 503, data } });
    renderPage();

    submit('stan_1');

    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(screen.queryByText(CONFIRMATION)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('removes an earlier confirmation when a later request fails', async () => {
    axios.post
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(new Error('Network Error'));
    renderPage();

    submit('stan_1');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(CONFIRMATION));

    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed. Please try again.');
    expect(screen.queryByText(CONFIRMATION)).not.toBeInTheDocument();
  });

  it('retires the confirmation once the field changes and clears an earlier error on success', async () => {
    axios.post
      .mockRejectedValueOnce(new Error('Network Error'))
      .mockResolvedValueOnce({ status: 200, data: {} });
    renderPage();

    submit('stan_1');
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(CONFIRMATION));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'other_1' } });
    expect(screen.queryByText(CONFIRMATION)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('keeps the field, button and way back in reading and keyboard order', () => {
    renderPage();

    userEvent.tab();
    expect(screen.getByLabelText('Username or email')).toHaveFocus();
    userEvent.tab();
    expect(screen.getByRole('button', { name: 'Reset password' })).toHaveFocus();
    userEvent.tab();
    expect(screen.getByRole('link', { name: 'Back to log in' })).toHaveFocus();
  });

  it('links back to login keeping the selected UI and theme, from every state', async () => {
    axios.post.mockResolvedValueOnce({ status: 200, data: {} });
    renderPage('/forgot-password?ui=v3&theme=dark');

    const link = screen.getByRole('link', { name: 'Back to log in' });
    expect(link).toHaveAttribute('href', '/login?ui=v3&theme=dark');
    expect(link).not.toHaveAttribute('title');

    submit('stan_1');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(CONFIRMATION));
    expect(screen.getByRole('link', { name: 'Back to log in' }))
      .toHaveAttribute('href', '/login?ui=v3&theme=dark');

    fireEvent.click(screen.getByRole('link', { name: 'Back to log in' }));
    expect(screen.getByText('Login page')).toBeInTheDocument();
  });
});
