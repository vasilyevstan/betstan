import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Header from './Header';

const renderHeader = (currentUser, uiVariant = 'v2') => render(
  <MemoryRouter initialEntries={['/?ui=v2&theme=light']}>
    <Header currentUser={currentUser} uiVariant={uiVariant} theme="light" />
  </MemoryRouter>
);

it.each(['v1', 'v2', 'v3'])(
  'shows a visible Backoffice label to administrators in %s',
  (uiVariant) => {
    const { unmount } = renderHeader({
      email: 'admin@example.com',
      role: 'ADMIN',
    }, uiVariant);

    const link = screen.getByRole('link', { name: 'Backoffice' });
    expect(link).toHaveAttribute('href', '/backoffice?ui=v2&theme=light');
    expect(link).toHaveTextContent('Backoffice');
    expect(screen.getByText('Backoffice')).toBeVisible();

    unmount();
  },
);

it('keeps Backoffice hidden for ordinary users', () => {
  renderHeader({ email: 'user@example.com', role: 'USER' });
  expect(screen.queryByRole('link', { name: 'Backoffice' })).not.toBeInTheDocument();
});

it('keeps Backoffice hidden for legacy users without a role', () => {
  renderHeader({ email: 'legacy@example.com' });

  expect(
    screen.queryByRole('link', { name: 'Backoffice' })
  ).not.toBeInTheDocument();
});
