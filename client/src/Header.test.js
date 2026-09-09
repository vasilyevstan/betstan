import React from 'react';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Header from './Header';

const renderHeader = (currentUser, uiVariant = 'v2', pathname = '/') => render(
  <MemoryRouter initialEntries={[`${pathname}?ui=${uiVariant}&theme=light`]}>
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
  'shows public Backoffice and Telemetry entries in order in %s',
  (uiVariant) => {
    for (const currentUser of userStates) {
      const { unmount } = renderHeader(currentUser, uiVariant);

      const backofficeLink = screen.getByRole('link', { name: 'Backoffice' });
      const telemetryLink = screen.getByRole('link', { name: 'Telemetry' });
      expect(backofficeLink).toHaveAttribute(
        'href',
        `/backoffice?ui=${uiVariant}&theme=light`
      );
      expect(telemetryLink).toHaveAttribute(
        'href',
        `/telemetry?ui=${uiVariant}&theme=light`
      );
      expect(backofficeLink).toHaveTextContent('Backoffice');
      expect(telemetryLink).toHaveTextContent('Telemetry');
      expect(screen.getByText('Backoffice')).toBeVisible();
      expect(screen.getByText('Telemetry')).toBeVisible();
      expect(backofficeLink).toHaveAccessibleName('Backoffice');
      expect(telemetryLink).toHaveAccessibleName('Telemetry');
      expect(telemetryLink.closest('li').previousElementSibling)
        .toBe(backofficeLink.closest('li'));

      unmount();
      expect(
        screen.queryByRole('link', { name: 'Backoffice' })
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('link', { name: 'Telemetry' })
      ).not.toBeInTheDocument();
    }
  },
);

it('marks Telemetry as the current page without losing valid navigation query parameters', () => {
  renderHeader(undefined, 'v3', '/telemetry');

  const telemetryLink = screen.getByRole('link', { name: 'Telemetry' });
  expect(telemetryLink).toHaveAttribute('aria-current', 'page');
  expect(telemetryLink).toHaveAttribute('href', '/telemetry?ui=v3&theme=light');
  expect(screen.getByRole('link', { name: 'Backoffice' }))
    .not.toHaveAttribute('aria-current');
});
