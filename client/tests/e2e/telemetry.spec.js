const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

const columnCount = (locator) => locator.evaluate((element) => (
  getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
));

test('Telemetry keeps its public navigation, exact lifecycle, and responsive full-width layout', async ({ page }) => {
  await installFakeEventSource(page);
  const state = createShellMockState();
  await installAppApiMocks(page, state);

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/telemetry?ui=v1&theme=dark', { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('heading', {
    name: 'Telemetry and service health',
    level: 1,
  })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Service health', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Daily activity', level: 2 })).toBeVisible();
  await expect(page.locator('.telemetry-metric')).toHaveCount(8);
  await expect(page.locator('.telemetry-health__item')).toHaveCount(10);
  await expect(page.locator('.telemetry-metric__pair')).toHaveCount(112);
  await expect(page.locator('.scoreboard')).toHaveCount(0);
  await expect(page.locator('.slip-boards')).toHaveCount(0);
  expect(state.requestCount('GET /api/telemetry/summary')).toBe(1);
  expect(state.requestCount('POST /api/telemetry/page-view')).toBe(0);

  const telemetryLink = page.getByRole('link', { name: 'Telemetry', exact: true });
  const backofficeLink = page.getByRole('link', { name: 'Backoffice', exact: true });
  await expect(telemetryLink).toHaveAttribute('aria-current', 'page');
  await expect(telemetryLink).toHaveAttribute(
    'href',
    '/telemetry?ui=v1&theme=dark'
  );
  expect(await telemetryLink.locator('xpath=ancestor::li').evaluate(
    (item) => item.previousElementSibling?.textContent.trim()
  )).toBe(await backofficeLink.textContent());

  expect(await columnCount(page.locator('.telemetry-metrics'))).toBe(2);
  expect(await columnCount(page.locator('.telemetry-health'))).toBe(5);

  const refresh = page.getByRole('button', { name: 'Refresh' });
  const refreshBox = await refresh.boundingBox();
  expect(refreshBox.width).toBeGreaterThanOrEqual(44);
  expect(refreshBox.height).toBeGreaterThanOrEqual(44);
  await refresh.click();
  await expect(page.getByRole('status')).toHaveText('Telemetry refreshed.');
  await expect(refresh).toBeFocused();
  expect(state.requestCount('GET /api/telemetry/summary')).toBe(2);

  await page.locator('a[title="light mode"]').click();
  await expect(page).toHaveURL(/\/telemetry\?ui=v1&theme=light$/);
  expect(state.requestCount('GET /api/telemetry/summary')).toBe(2);
  expect(state.requestCount('POST /api/telemetry/page-view')).toBe(0);

  for (const viewport of [
    { width: 1000, height: 1000, metricColumns: 1, healthColumns: 2 },
    { width: 768, height: 1000, metricColumns: 1, healthColumns: 2 },
    { width: 390, height: 844, metricColumns: 1, healthColumns: 1 },
  ]) {
    await page.setViewportSize(viewport);
    expect(await columnCount(page.locator('.telemetry-metrics')))
      .toBe(viewport.metricColumns);
    expect(await columnCount(page.locator('.telemetry-health')))
      .toBe(viewport.healthColumns);
    expect(await page.evaluate(() => (
      document.documentElement.scrollWidth <= window.innerWidth
    ))).toBe(true);
  }
});
