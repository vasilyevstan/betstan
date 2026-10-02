const { test, expect } = require('@playwright/test');
const authCopy = require('../../src/pages/auth/authCopy.json');
const { installFakeEventSource } = require('./support/fakeEventSource');
const {
  createBackofficeEvents,
  createLiveBettingMockState,
  createShellMockState,
  installAppApiMocks,
} = require('./support/mockAppApi');

const prepareShell = async (page, overrides = {}) => {
  await installFakeEventSource(page);
  const state = createShellMockState(overrides);
  await installAppApiMocks(page, state);
  return state;
};

test('home page responds and renders shell', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await prepareShell(page);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('Create account');
  await expect(page.locator('body')).toContainText('Log in');
  expect(pageErrors).toEqual([]);
});

test('variant query param keeps app functional', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await prepareShell(page);

  await page.goto('/?ui=v3', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toContainText('Create account');
  expect(pageErrors).toEqual([]);
});

test('signup submit does not crash UI', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await prepareShell(page, { signupError: 'Signup smoke request rejected' });

  await page.goto('/signup', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: authCopy.signup.title })).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('qa-smoke');
  await page.getByLabel('Password', { exact: true }).fill('Password123!');
  await page.getByRole('button', { name: authCopy.signup.submit, exact: true }).click();

  await expect(page.getByText('Signup smoke request rejected')).toBeVisible();
  await expect(page.locator('body')).not.toContainText("Cannot read properties of undefined (reading 'map')");
  expect(pageErrors).toEqual([]);
});

test('login submit does not crash UI', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await prepareShell(page, { loginError: 'Login smoke request rejected' });

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: authCopy.login.title })).toBeVisible();
  await page.getByLabel('Username or email').fill('qa-invalid');
  await page.getByLabel('Password', { exact: true }).fill('invalid-password');
  await page.getByRole('button', { name: authCopy.login.submit, exact: true }).click();

  await expect(page.getByText('Login smoke request rejected')).toBeVisible();
  await expect(page.locator('body')).not.toContainText("Cannot read properties of undefined (reading 'map')");
  expect(pageErrors).toEqual([]);
});

test('auth pages fit a mobile viewport', async ({ page }) => {
  await prepareShell(page);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const { path, title } of [
    { path: '/login', title: authCopy.login.title },
    { path: '/signup', title: authCopy.signup.title },
  ]) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
});

test('expanded mobile navigation scrolls away without hiding labelled controls or route content', async ({ page }) => {
  const state = createLiveBettingMockState();
  state.currentUser = null;
  state.backofficeEvents = createBackofficeEvents();
  const liveEvent = state.events.find(({ eventId }) => eventId === 'live-1');
  liveEvent.home = 'Raptors Athletic Club with an Exceptionally Long Home Name';
  liveEvent.away = 'Sharks Borough United with an Exceptionally Long Away Name';
  liveEvent.name = `${liveEvent.home} - ${liveEvent.away}`;
  await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  await page.setViewportSize({ width: 390, height: 844 });

  const expectedNavigationLabels = [
    'BetStan home',
    'Standard',
    'Compact',
    'Spacious',
    'Dark',
    'Light',
    'Events',
    'Backoffice',
    'Telemetry',
    'Create account',
    'Log in',
  ];

  for (const { path, heading } of [
    { path: '/', heading: 'Events' },
    { path: '/backoffice', heading: 'Backoffice' },
    { path: '/login', heading: authCopy.login.title },
  ]) {
    await page.goto(`${path}?ui=v2&theme=dark`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    const header = page.locator('.app-navbar');
    await expect(header).toBeVisible();

    const initial = await header.evaluate((navigation) => {
      const bounds = (element) => {
        const rect = element.getBoundingClientRect();
        return {
          bottom: rect.bottom,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          width: rect.width,
        };
      };
      const controlName = (element) => {
        const clone = element.cloneNode(true);
        clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
        return element.getAttribute('aria-label')
          || clone.textContent.trim()
          || element.querySelector('img')?.alt
          || '';
      };
      const controls = Array.from(navigation.querySelectorAll('a')).map((element) => ({
        ...bounds(element),
        name: controlName(element),
      }));
      const containers = [
        navigation,
        navigation.querySelector('.container-fluid'),
        navigation.querySelector('.app-navbar__content'),
        navigation.querySelector('.app-navbar__workspace'),
        ...navigation.querySelectorAll('.presentation-control, .presentation-control__options, .app-navbar__links'),
      ].filter(Boolean);

      return {
        bounds: bounds(navigation),
        controls,
        overflowingContainers: containers
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.className),
        position: getComputedStyle(navigation).position,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });

    expect(initial.position).toBe('static');
    expect(initial.documentOverflow).toBeLessThanOrEqual(1);
    expect(initial.overflowingContainers).toEqual([]);
    expect(initial.controls.map(({ name }) => name)).toEqual(expectedNavigationLabels);
    expect(initial.controls.every(({ height, width }) => height >= 44 && width >= 44)).toBe(true);
    expect(initial.controls.every(({ left, right }) => left >= -1 && right <= 391)).toBe(true);

    await page.evaluate((headerHeight) => {
      window.scrollTo(0, Math.ceil(headerHeight + 16));
    }, initial.bounds.height);
    await expect.poll(() => page.evaluate(() => window.scrollY))
      .toBeGreaterThan(initial.bounds.height);

    const scrolled = await page.locator('main').evaluate((main) => {
      const navigation = document.querySelector('.app-navbar');
      const headerBounds = navigation.getBoundingClientRect();
      const mainBounds = main.getBoundingClientRect();
      return {
        headerBottom: headerBounds.bottom,
        headerPosition: getComputedStyle(navigation).position,
        mainTop: mainBounds.top,
        mainVisibleHeight: Math.max(
          0,
          Math.min(window.innerHeight, mainBounds.bottom) - Math.max(0, mainBounds.top),
        ),
        navigationAtViewportTop: Boolean(
          document.elementFromPoint(window.innerWidth / 2, 1)?.closest('.app-navbar')
        ),
      };
    });

    expect(scrolled.headerPosition).toBe('static');
    expect(scrolled.headerBottom).toBeLessThanOrEqual(0);
    expect(scrolled.navigationAtViewportTop).toBe(false);
    expect(scrolled.mainTop).toBeLessThan(32);
    expect(scrolled.mainVisibleHeight).toBeGreaterThan(300);

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(header).toBeVisible();
    for (const label of expectedNavigationLabels) {
      await expect(header.getByRole('link', { name: label, exact: true })).toBeVisible();
    }
  }
});

test('Match Desk shell keeps semantic order and switches exactly at 1400px', async ({ page }) => {
  await prepareShell(page);

  const inspectShell = () => page.locator('.app-desk').evaluate((desk) => {
    const box = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        width: bounds.width,
      };
    };
    const main = desk.querySelector('.app-desk__main');
    const statistics = desk.querySelector('.app-desk__statistics');
    const slips = desk.querySelector('.app-desk__slips');
    const statisticsPanel = statistics.querySelector('.app-shell__sidebar');
    const slipsPanel = slips.querySelector('.app-shell__sidebar');
    return {
      desk: box(desk),
      main: box(main),
      statistics: box(statistics),
      slips: box(slips),
      mainPosition: getComputedStyle(main).position,
      statisticsPosition: getComputedStyle(statisticsPanel).position,
      slipsPosition: getComputedStyle(slipsPanel).position,
      mainBeforeStatistics: Boolean(
        main.compareDocumentPosition(statistics) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      statisticsBeforeSlips: Boolean(
        statistics.compareDocumentPosition(slips) & Node.DOCUMENT_POSITION_FOLLOWING
      ),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  await page.setViewportSize({ width: 1399, height: 1000 });
  await page.goto(
    '/?ui=v2&theme=dark&acceptanceEventIds=event-1%2Cevent-2&review=retained',
    { waitUntil: 'domcontentloaded' }
  );
  await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Events' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Backoffice' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Telemetry' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Standard' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Compact' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByRole('link', { name: 'Spacious' })).toHaveAttribute(
    'href',
    '/?ui=v3&theme=dark&acceptanceEventIds=event-1%2Cevent-2&review=retained'
  );
  const navigationTargets = page.locator(
    '.app-nav-link, .presentation-option, .app-navbar__auth-link'
  );
  for (const target of await navigationTargets.all()) {
    const bounds = await target.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }

  const below = await inspectShell();
  expect(below.mainBeforeStatistics).toBe(true);
  expect(below.statisticsBeforeSlips).toBe(true);
  expect(below.main.top).toBeLessThan(below.statistics.top);
  expect(Math.abs(below.main.width - below.desk.width)).toBeLessThanOrEqual(1);
  expect(below.statisticsPosition).not.toBe('sticky');
  expect(below.slipsPosition).not.toBe('sticky');
  expect(below.mainPosition).not.toBe('sticky');
  expect(below.overflow).toBeLessThanOrEqual(1);

  await page.getByRole('link', { name: 'Skip to main content' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  await page.setViewportSize({ width: 1400, height: 1000 });
  const at = await inspectShell();
  expect(at.mainBeforeStatistics).toBe(true);
  expect(at.statisticsBeforeSlips).toBe(true);
  expect(at.statistics.left).toBeLessThan(at.main.left);
  expect(at.main.right).toBeLessThan(at.slips.left);
  expect(Math.abs(at.statistics.top - at.main.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(at.slips.top - at.main.top)).toBeLessThanOrEqual(1);
  expect(at.statisticsPosition).toBe('sticky');
  expect(at.slipsPosition).toBe('sticky');
  expect(at.mainPosition).not.toBe('sticky');
  expect(at.overflow).toBeLessThanOrEqual(1);
});

test('Events and wildcard routes expose one logical route heading', async ({ page }) => {
  await prepareShell(page);

  for (const path of ['/', '/retained-wildcard']) {
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  }
});

test('reduced motion removes effective motion while focus and state cues remain', async ({ page }) => {
  const state = createLiveBettingMockState();
  state.backofficeEvents = createBackofficeEvents();
  state.backofficeActions = {};
  await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 1000 });

  const expectMotionlessFocus = async (locator) => {
    await expect(locator).toBeVisible();
    await locator.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(locator).toBeFocused();
    const metrics = await locator.evaluate((element) => {
      const style = getComputedStyle(element);
      const durationsAreZero = (value) => value
        .split(',')
        .every((part) => Number.parseFloat(part) === 0);
      return {
        animationDurationIsZero: durationsAreZero(style.animationDuration),
        animationName: style.animationName,
        outlineStyle: style.outlineStyle,
        outlineWidth: Number.parseFloat(style.outlineWidth),
        scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
        transitionDelayIsZero: durationsAreZero(style.transitionDelay),
        transitionDurationIsZero: durationsAreZero(style.transitionDuration),
      };
    });
    expect(metrics.animationDurationIsZero).toBe(true);
    expect(metrics.animationName).toBe('none');
    expect(metrics.transitionDelayIsZero).toBe(true);
    expect(metrics.transitionDurationIsZero).toBe(true);
    expect(metrics.scrollBehavior).toBe('auto');
    expect(metrics.outlineStyle).toBe('solid');
    expect(metrics.outlineWidth).toBeGreaterThanOrEqual(3);
  };

  await page.goto('/?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
  await expectMotionlessFocus(page.getByRole('link', { name: 'Events' }));
  const selectedBettingControl = page.getByRole('button', {
    name: state.fixtures.preMatchSelectionLabel,
  });
  await selectedBettingControl.click();
  await expect(selectedBettingControl).toHaveAttribute('aria-pressed', 'true');
  await expect(selectedBettingControl.locator('.product-button__selected-cue')).toHaveText('✓');
  await expectMotionlessFocus(selectedBettingControl);

  await page.goto('/login?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
  await expectMotionlessFocus(page.getByRole('button', {
    name: authCopy.login.submit,
    exact: true,
  }));

  await page.goto('/backoffice?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Target: OFFLINE', { exact: false }).first()).toBeVisible();
  await expectMotionlessFocus(page.getByRole('button', {
    name: 'Take offline for Northport - Lakewood',
  }));

  await page.goto('/telemetry?ui=v2&theme=dark', { waitUntil: 'domcontentloaded' });
  await expect(page.getByText('Healthy', { exact: true }).first()).toBeVisible();
  await expectMotionlessFocus(page.getByRole('button', { name: 'Refresh', exact: true }));
});
