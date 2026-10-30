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

      const eventsLink = screen.getByRole('link', { name: 'Events' });
      const backofficeLink = screen.getByRole('link', { name: 'Backoffice' });
      const telemetryLink = screen.getByRole('link', { name: 'Telemetry' });
      expect(eventsLink).toHaveAttribute(
        'href',
        `/?ui=${uiVariant}&theme=light`
      );
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
      expect(eventsLink).toBeVisible();
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

it.each(['v1', 'v2', 'v3'])('keeps one labelled, icon-supported header without layout controls in %s', (uiVariant) => {
  renderHeader(undefined, uiVariant);

  expect(screen.queryByRole('group', { name: 'Layout' })).not.toBeInTheDocument();
  expect(screen.queryByText('Layout')).not.toBeInTheDocument();
  for (const label of ['Standard', 'Compact', 'Spacious']) {
    expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
  }
  expect(screen.getByRole('img', { name: 'BetStan home' }))
    .toHaveAttribute('src', '/brand/betstan-wordmark-light.svg');
  expect(screen.getByRole('link', { name: 'Events' }).querySelector('img')).toBeNull();
  for (const [label, icon] of [
    ['Backoffice', 'backoffice'], ['Telemetry', 'telemetry'],
    ['Create account', 'signup'], ['Log in', 'login'], ['Dark', 'theme-dark'], ['Light', 'theme-light'],
  ]) {
    const link = screen.getByRole('link', { name: label, exact: true });
    expect(link).toHaveTextContent(label);
    expect(link.querySelector('img')).toHaveAttribute('src', `/icons/${icon}.svg`);
    expect(link.querySelector('img')).toHaveAttribute('alt', '');
  }
  expect(screen.getByText('Theme')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Dark' })).toBeVisible();
  const activeTheme = screen.getByRole('link', { name: 'Light' });
  const themeMark = activeTheme.querySelector('.state-mark');
  expect(activeTheme).toHaveAttribute('aria-current', 'true');
  expect(themeMark).toHaveAttribute('aria-hidden', 'true');
  expect(themeMark).toBeEmptyDOMElement();
  expect(screen.getByRole('link', { name: 'Dark' }).querySelector('.state-mark')).toBeNull();
});

it('preserves density and unrelated query keys on home, navigation and theme changes', () => {
  render(
    <MemoryRouter initialEntries={[
      '/?ui=v2&theme=light&acceptanceEventIds=event-1%2Cevent-2&review=retained',
    ]}>
      <Header currentUser={undefined} uiVariant="v2" theme="light" />
    </MemoryRouter>
  );

  const dark = screen.getByRole('link', { name: 'Dark' });
  for (const [name, pathname] of [['BetStan home', '/'], ['Events', '/'], ['Backoffice', '/backoffice'], ['Telemetry', '/telemetry']]) {
    expect(screen.getByRole('link', { name })).toHaveAttribute(
      'href', `${pathname}?ui=v2&theme=light&acceptanceEventIds=event-1%2Cevent-2&review=retained`
    );
  }
  expect(dark).toHaveAttribute(
    'href',
    '/?ui=v2&theme=dark&acceptanceEventIds=event-1%2Cevent-2&review=retained'
  );
});

it('retains authenticated display name and labelled bet/logout icons', () => {
  renderHeader({ email: 'long-display-name@example.com' });
  expect(screen.getByText('long-display-nam')).toBeVisible();
  for (const [name, icon] of [['My bets', 'bets'], ['Log out', 'logout']]) {
    const link = screen.getByRole('link', { name });
    expect(link).toHaveTextContent(name);
    expect(link.querySelector('img')).toHaveAttribute('src', `/icons/${icon}.svg`);
    expect(link.querySelector('img')).toHaveAttribute('alt', '');
  }
  expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
});

it('marks Telemetry as the current page without losing valid navigation query parameters', () => {
  renderHeader(undefined, 'v3', '/telemetry');

  const telemetryLink = screen.getByRole('link', { name: 'Telemetry' });
  expect(telemetryLink).toHaveAttribute('aria-current', 'page');
  expect(telemetryLink).toHaveAttribute('href', '/telemetry?ui=v3&theme=light');
  expect(screen.getByRole('link', { name: 'Backoffice' }))
    .not.toHaveAttribute('aria-current');
});

it.each(['/telemetry/', '/Telemetry', '/TELEMETRY///'])(
  'marks the Telemetry route alias %s as current',
  (pathname) => {
    renderHeader(undefined, 'v2', pathname);

    expect(screen.getByRole('link', { name: 'Telemetry' }))
      .toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Backoffice' }))
      .not.toHaveAttribute('aria-current');
  },
);

it('does not mark Telemetry current for an unknown deeper path', () => {
  renderHeader(undefined, 'v2', '/telemetry/details');

  expect(screen.getByRole('link', { name: 'Telemetry' }))
    .not.toHaveAttribute('aria-current');
});

it('marks a trailing-slash Backoffice alias current without marking Telemetry', () => {
  renderHeader(undefined, 'v1', '/backoffice/');

  expect(screen.getByRole('link', { name: 'Backoffice' }))
    .toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'Telemetry' }))
    .not.toHaveAttribute('aria-current');
});
