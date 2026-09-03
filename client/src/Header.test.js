import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Header from './Header';

const renderHeader = (currentUser, uiVariant = 'v2') => render(
  <MemoryRouter initialEntries={[`/?ui=${uiVariant}&theme=light`]}>
    <Header currentUser={currentUser} uiVariant={uiVariant} theme="light" />
  </MemoryRouter>
);

const userStates = [
  undefined,
  { email: 'user@example.com', role: 'USER' },
  { email: 'legacy@example.com' },
  { email: 'admin@example.com', role: 'ADMIN' },
];

it.each(['v1', 'v2', 'v3'])(
  'shows a visible public Backoffice entry in %s',
  (uiVariant) => {
    for (const currentUser of userStates) {
      const { unmount } = renderHeader(currentUser, uiVariant);

      const link = screen.getByRole('link', { name: 'Backoffice' });
      expect(link).toHaveAttribute(
        'href',
        `/backoffice?ui=${uiVariant}&theme=light`
      );
      expect(link).toHaveTextContent('Backoffice');
      expect(screen.getByText('Backoffice')).toBeVisible();
      expect(link).toHaveAccessibleName('Backoffice');

      unmount();
      expect(
        screen.queryByRole('link', { name: 'Backoffice' })
      ).not.toBeInTheDocument();
    }
  },
);
