const { test, expect } = require('@playwright/test');
const { createLiveBettingMockState, installAppApiMocks } = require('./support/mockAppApi');

// Cross-route design guard: a change to shared styles (header, slip, tokens) must not
// break pages it was not aimed at. Every route renders in both themes at desktop and phone width.
const routes = ['/', '/login', '/bets', '/backoffice', '/telemetry'];
const viewports = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

for (const [name, viewport] of Object.entries(viewports)) {
  for (const theme of ['dark', 'light']) {
    test(`design sweep ${name} ${theme}`, async ({ page }) => {
      test.setTimeout(120 * 1000);
      await page.setViewportSize(viewport);
      await installAppApiMocks(page, createLiveBettingMockState());
      for (const route of routes) {
        await page.goto(`${route}?theme=${theme}`);
        await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
        if (route === '/telemetry') {
          await page.locator('.telemetry-metric__date-button').last().click();
          await expect(page.locator('.telemetry-metric__values--hourly data')).toHaveCount(24);
        }
        const evidence = await page.evaluate(() => {
          const navigation = document.querySelector('nav[aria-label="Primary navigation"]');
          const visible = (element) => element.getClientRects().length > 0;
          const controls = [...navigation.querySelectorAll('a, button')].filter(visible)
            .map((element) => element.getBoundingClientRect());
          const brand = navigation.querySelector('.navbar-brand');
          const badges = [...document.querySelectorAll('.slip-board__heading .bet-kind-badge')].filter(visible);
          const hourly = [...document.querySelectorAll('.telemetry-metric__values--hourly .telemetry-metric__pair')];
          return {
            overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            headerCollisions: controls.flatMap((a, i) => controls.slice(i + 1).filter((b) => (
              a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5
            ))).length,
            brandUnderline: getComputedStyle(brand, '::after').content !== 'none',
            stretchedBadges: badges.filter((badge) => (
              badge.getBoundingClientRect().width > badge.parentElement.getBoundingClientRect().width * 0.8
            )).length,
            hourlyArrangements: [...new Set(hourly.map((pair) => (
              pair.querySelector('data').getBoundingClientRect().top
                >= pair.querySelector('time').getBoundingClientRect().bottom - 1 ? 'stacked' : 'inline'
            )))],
          };
        });
        const where = `${name} ${theme} ${route}`;
        expect(evidence.overflow, `${where} horizontal overflow`).toBeLessThanOrEqual(1);
        expect(evidence.headerCollisions, `${where} header collisions`).toBe(0);
        expect(evidence.brandUnderline, `${where} wordmark underline`).toBe(false);
        expect(evidence.stretchedBadges, `${where} stretched slip badges`).toBe(0);
        expect(evidence.hourlyArrangements.length, `${where} uniform hourly chips`).toBeLessThanOrEqual(1);
      }
    });
  }
}
