import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Header from './Header';

const renderHeader = (currentUser) => render(
  <MemoryRouter initialEntries={['/?ui=v2&theme=light']}>
    <Header currentUser={currentUser} uiVariant="v2" theme="light" />
  </MemoryRouter>
);

it('shows Backoffice only to administrators', () => {
  const { unmount } = renderHeader({
    email: 'admin@example.com',
    role: 'ADMIN',
  });

  expect(screen.getByRole('link', { name: 'Backoffice' })).toHaveAttribute(
    'href',
    '/backoffice?ui=v2&theme=light'
  );

  unmount();
  renderHeader({ email: 'user@example.com', role: 'USER' });
  expect(
    screen.queryByRole('link', { name: 'Backoffice' })
  ).not.toBeInTheDocument();
});

it('keeps Backoffice hidden for legacy users without a role', () => {
  renderHeader({ email: 'legacy@example.com' });

  expect(
    screen.queryByRole('link', { name: 'Backoffice' })
  ).not.toBeInTheDocument();
});
