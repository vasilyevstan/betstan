import React from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

      const homeLink = screen.getByRole('link', { name: 'BetStan home' });
      const backofficeLink = screen.getByRole('link', { name: 'Backoffice' });
      const telemetryLink = screen.getByRole('link', { name: 'Telemetry' });
      expect(homeLink).toHaveAttribute(
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
      expect(homeLink).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByRole('link', { name: 'Events' })).not.toBeInTheDocument();
      expect(screen.getByText('Backoffice')).toBeVisible();
      expect(screen.getByText('Telemetry')).toBeVisible();
      expect(backofficeLink).toHaveAccessibleName('Backoffice');
      expect(telemetryLink).toHaveAccessibleName('Telemetry');
      expect(telemetryLink.closest('li').previousElementSibling)
        .toBe(backofficeLink.closest('li'));
      for (const [label, pathname] of currentUser
        ? [['My bets', '/bets'], ['Log out', '/logout']]
        : [['Create account', '/signup'], ['Log in', '/login']]) {
        expect(screen.getByRole('link', { name: label })).toHaveAttribute(
          'href', `${pathname}?ui=${uiVariant}&theme=light`
        );
      }
      for (const label of currentUser ? ['Create account', 'Log in'] : ['My bets', 'Log out']) {
        expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
      }

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

it.each(['v1', 'v2', 'v3'])('keeps compact icons and labelled public routes without layout controls in %s', (uiVariant) => {
  renderHeader(undefined, uiVariant);

  expect(screen.queryByRole('group', { name: 'Layout' })).not.toBeInTheDocument();
  expect(screen.queryByText('Layout')).not.toBeInTheDocument();
  for (const label of ['Standard', 'Compact', 'Spacious']) {
    expect(screen.queryByRole('link', { name: label })).not.toBeInTheDocument();
  }
  expect(screen.getByRole('img', { name: 'BetStan home' }))
    .toHaveAttribute('src', '/brand/betstan-wordmark-light.svg');
  expect(screen.queryByRole('link', { name: 'Events' })).not.toBeInTheDocument();
  for (const [label, icon] of [
    ['Backoffice', 'backoffice'], ['Telemetry', 'telemetry'],
    ['Create account', 'signup'], ['Log in', 'login'], ['Dark', 'theme-dark'], ['Light', 'theme-light'],
  ]) {
    const link = screen.getByRole('link', { name: label, exact: true });
    expect(link).toHaveAccessibleName(label);
    expect(link).toHaveAttribute('title', label);
    expect(link.querySelector('img')).toHaveAttribute('src', `/icons/${icon}.svg`);
    expect(link.querySelector('img')).toHaveAttribute('alt', '');
    if (['Backoffice', 'Telemetry'].includes(label)) {
      expect(link.querySelector('.app-nav-link__label')).not.toHaveClass('visually-hidden');
      expect(link).toHaveTextContent(label);
    } else {
      expect(link.querySelector('span')).toHaveClass('visually-hidden');
    }
  }
  expect(screen.queryByText('Theme')).not.toBeInTheDocument();
  const activeTheme = screen.getByRole('link', { name: 'Light' });
  expect(activeTheme).toHaveAttribute('aria-current', 'true');
  expect(activeTheme).toHaveClass('presentation-option--active');
  expect(screen.getByRole('link', { name: 'Dark' })).not.toHaveAttribute('aria-current');
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
  for (const [name, pathname] of [
    ['BetStan home', '/'], ['Backoffice', '/backoffice'], ['Telemetry', '/telemetry'],
    ['Create account', '/signup'], ['Log in', '/login'],
  ]) {
    expect(screen.getByRole('link', { name })).toHaveAttribute(
      'href', `${pathname}?ui=v2&theme=light&acceptanceEventIds=event-1%2Cevent-2&review=retained`
    );
  }
  expect(dark).toHaveAttribute(
    'href',
    '/?ui=v2&theme=dark&acceptanceEventIds=event-1%2Cevent-2&review=retained'
  );
});

it('retains authenticated display name and accessible bet/logout icon names', () => {
  renderHeader({ email: 'long-display-name@example.com' });
  expect(screen.getByText('long-display-nam')).toBeVisible();
  for (const [name, icon] of [['My bets', 'bets'], ['Log out', 'logout']]) {
    const link = screen.getByRole('link', { name });
    expect(link).toHaveAccessibleName(name);
    expect(link).toHaveAttribute('title', name);
    expect(link.querySelector('.app-nav-link__label')).toHaveClass('visually-hidden');
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
  expect(screen.getByRole('link', { name: 'BetStan home' }))
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
  expect(screen.getByRole('link', { name: 'BetStan home' }))
    .toHaveAttribute('aria-current', 'page');
});

it('marks a trailing-slash Backoffice alias current without marking Telemetry', () => {
  renderHeader(undefined, 'v1', '/backoffice/');

  expect(screen.getByRole('link', { name: 'Backoffice' }))
    .toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'Telemetry' }))
    .not.toHaveAttribute('aria-current');
});

it.each([
  ['/SIGNUP/', undefined, 'Create account'],
  ['/Login///', undefined, 'Log in'],
  ['/BETS/', { email: 'user@example.com' }, 'My bets'],
  ['/Logout/', { email: 'user@example.com' }, 'Log out'],
])('retains canonical current-page identity for %s', (pathname, currentUser, name) => {
  renderHeader(currentUser, 'v1', pathname);
  expect(screen.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByRole('link', { name: 'BetStan home' })).not.toHaveAttribute('aria-current');
  expect(screen.getByRole('link', { name: 'Dark' }))
    .toHaveAttribute('href', `${pathname}?ui=v1&theme=dark`);
});

it('owns the disclosure without a second Bootstrap controller and closes on Escape with focus restored', () => {
  renderHeader();
  const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
  const menu = document.getElementById(toggle.getAttribute('aria-controls'));
  expect(toggle).toHaveAttribute('type', 'button');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(toggle).not.toHaveAttribute('data-bs-toggle');
  expect(toggle).not.toHaveAttribute('data-bs-target');
  expect(menu).toHaveClass('collapse', 'navbar-collapse');
  expect(menu).not.toHaveClass('show');

  act(() => userEvent.click(toggle));
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(menu).toHaveClass('show');
  const telemetry = screen.getByRole('link', { name: 'Telemetry' });
  telemetry.focus();
  fireEvent.keyDown(telemetry, { key: 'Escape' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(menu).not.toHaveClass('show');
  expect(toggle).toHaveFocus();

  act(() => userEvent.click(toggle));
  act(() => userEvent.click(toggle));
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(menu).not.toHaveClass('show');
});

it.each([
  ['BetStan home', undefined], ['Backoffice', undefined], ['Telemetry', undefined],
  ['Create account', undefined], ['Log in', undefined],
  ['My bets', { email: 'user@example.com' }], ['Log out', { email: 'user@example.com' }],
])('closes the disclosure on %s activation, including the current route', (name, currentUser) => {
  renderHeader(currentUser);
  const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
  act(() => userEvent.click(toggle));
  act(() => userEvent.click(screen.getByRole('link', { name })));
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(document.getElementById('betstan-navbar')).not.toHaveClass('show');
  expect(toggle).toHaveFocus();
});

it('keeps the disclosure and focus on a theme change without changing the route or query identities', () => {
  renderHeader(undefined, 'v3', '/Telemetry/');
  const toggle = screen.getByRole('button', { name: 'Toggle navigation' });
  act(() => userEvent.click(toggle));
  const dark = screen.getByRole('link', { name: 'Dark' });
  act(() => userEvent.click(dark));
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(dark).toHaveFocus();
  expect(screen.getByRole('link', { name: 'Light' }))
    .toHaveAttribute('href', '/Telemetry/?ui=v3&theme=light');
  expect(screen.getByRole('link', { name: 'Backoffice' }))
    .toHaveAttribute('href', '/backoffice?ui=v3&theme=dark');
});

it('retains the dark wordmark', () => {
  render(
    <MemoryRouter>
      <Header uiVariant="v1" theme="dark" />
    </MemoryRouter>
  );
  expect(screen.getByRole('img', { name: 'BetStan home' }))
    .toHaveAttribute('src', '/brand/betstan-wordmark-dark.svg');
});
