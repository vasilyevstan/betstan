const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

const UI_VARIANTS = ['v1', 'v2', 'v3'];
const THEMES = ['dark', 'light'];
const VIEWPORTS = [
  { width: 1600, height: 1000, metricColumns: 2, healthColumns: 5 },
  { width: 768, height: 1000, metricColumns: 1, healthColumns: 2 },
  { width: 390, height: 844, metricColumns: 1, healthColumns: 1 },
];

const columnCount = (locator) => locator.evaluate((element) => (
  getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length
));

const expectNoScrollOverflow = async (locator, label) => {
  const failures = await locator.evaluateAll((elements) => elements
    .map((element) => ({
      className: element.className?.baseVal || element.className || element.tagName,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))
    .filter(({ clientWidth, scrollWidth }) => scrollWidth > clientWidth));

  expect(failures, `${label} must not overflow horizontally`).toEqual([]);
};

const expectSiblingBoxesDoNotIntersect = async (locator, label) => {
  const intersections = await locator.evaluateAll((elements) => {
    const boxes = elements.map((element, index) => {
      const rect = element.getBoundingClientRect();
      return {
        index,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const overlaps = [];

    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        const a = boxes[first];
        const b = boxes[second];
        if (
          a.left < b.right
          && a.right > b.left
          && a.top < b.bottom
          && a.bottom > b.top
        ) {
          overlaps.push([a.index, b.index]);
        }
      }
    }
    return overlaps;
  });

  expect(intersections, `${label} boxes must not intersect`).toEqual([]);
};

const expectMetricContentsInsideCards = async (cards) => {
  const failures = await cards.evaluateAll((elements) => {
    const epsilon = 0.75;
    const selector = [
      '.telemetry-metric__heading',
      '.telemetry-metric__graph',
      '.telemetry-metric__date',
      '.telemetry-metric__value',
    ].join(',');

    return elements.flatMap((card, cardIndex) => {
      const cardRect = card.getBoundingClientRect();
      return [...card.querySelectorAll(selector)].flatMap((child, childIndex) => {
        const childRect = child.getBoundingClientRect();
        const isInside = (
          childRect.left >= cardRect.left - epsilon
          && childRect.right <= cardRect.right + epsilon
          && childRect.top >= cardRect.top - epsilon
          && childRect.bottom <= cardRect.bottom + epsilon
        );
        return isInside ? [] : [{
          cardIndex,
          childIndex,
          className: child.className?.baseVal || child.className || child.tagName,
        }];
      });
    });
  });

  expect(failures, 'graph, headings, dates, and values must remain inside their card').toEqual([]);
};

const expectRequiredLabelsNotClipped = async (page) => {
  const failures = await page.locator([
    '#telemetry-page-heading',
    '#telemetry-health-heading',
    '#telemetry-activity-heading',
    '.telemetry-page__generated',
    '.telemetry-health__service',
    '.telemetry-health__status > span:last-child',
    '.telemetry-metric__heading',
    '.telemetry-metric__date',
    '.telemetry-metric__value',
    '.navbar-collapse.show .nav-icon-link__label',
    '.navbar-collapse.show .nav-picture-button__label',
    '.navbar-expand-lg .nav-icon-link__label',
    '.navbar-expand-lg .nav-picture-button__label',
  ].join(',')).evaluateAll((elements) => {
    const epsilon = 0.75;
    return elements.flatMap((element, index) => {
      const elementRect = element.getBoundingClientRect();
      if (elementRect.width === 0 || elementRect.height === 0) {
        return [];
      }

      const range = document.createRange();
      range.selectNodeContents(element);
      const textRect = range.getBoundingClientRect();
      const container = element.closest(
        '.telemetry-metric, .telemetry-health__item, .telemetry-page, .app-navbar'
      );
      const containerRect = container?.getBoundingClientRect();
      const style = getComputedStyle(element);
      const hasOwnOverflow = (
        (element.clientWidth > 0 && element.scrollWidth > element.clientWidth)
        || (element.clientHeight > 0 && element.scrollHeight > element.clientHeight)
      );
      const textEscapesContainer = containerRect && (
        textRect.left < containerRect.left - epsilon
        || textRect.right > containerRect.right + epsilon
        || textRect.top < containerRect.top - epsilon
        || textRect.bottom > containerRect.bottom + epsilon
      );
      const clipsByStyle = (
        ['hidden', 'clip'].includes(style.overflow)
        || ['hidden', 'clip'].includes(style.overflowX)
        || ['hidden', 'clip'].includes(style.overflowY)
      ) && hasOwnOverflow;

      return hasOwnOverflow || textEscapesContainer || clipsByStyle
        ? [{
            index,
            className: element.className || element.id || element.tagName,
            hasOwnOverflow,
            textEscapesContainer,
          }]
        : [];
    });
  });

  expect(failures, 'required Telemetry and navigation labels must not be clipped').toEqual([]);
};

const expectNavigationFits = async (page, checkAllLinks = false) => {
  const navbar = page.locator('.app-navbar');
  const backoffice = page.getByRole('link', { name: 'Backoffice', exact: true });
  const telemetry = page.getByRole('link', { name: 'Telemetry', exact: true });
  await expect(backoffice).toBeVisible();
  await expect(telemetry).toBeVisible();

  const failures = await page.locator(
    checkAllLinks
      ? '.navbar-nav .nav-item > a'
      : '.navbar-nav .nav-item > a[title="Backoffice"], .navbar-nav .nav-item > a[title="Telemetry"]'
  ).evaluateAll((links) => {
    const navbarRect = links[0]?.closest('.app-navbar')?.getBoundingClientRect();
    const boxes = links.map((link, index) => {
      const rect = link.getBoundingClientRect();
      return {
        index,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const issues = [];
    const epsilon = 0.75;

    boxes.forEach((box) => {
      if (
        !navbarRect
        || box.left < navbarRect.left - epsilon
        || box.right > navbarRect.right + epsilon
        || box.top < navbarRect.top - epsilon
        || box.bottom > navbarRect.bottom + epsilon
      ) {
        issues.push({ type: 'outside-navbar', index: box.index });
      }
    });

    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        const a = boxes[first];
        const b = boxes[second];
        if (
          a.left < b.right
          && a.right > b.left
          && a.top < b.bottom
          && a.bottom > b.top
        ) {
          issues.push({ type: 'intersection', indexes: [a.index, b.index] });
        }
      }
    }

    return issues;
  });

  expect(failures, 'navigation links must remain separate and inside the navbar').toEqual([]);
  await expectNoScrollOverflow(navbar, 'navbar');
};

const getContrastEvidence = (page) => page.evaluate(() => {
  const parseColor = (value) => {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'transparent') {
      return [0, 0, 0, 0];
    }

    if (normalized.startsWith('color(srgb')) {
      const values = normalized.match(/[-+]?(?:\d*\.)?\d+/g)?.map(Number) || [];
      return [
        (values[0] || 0) * 255,
        (values[1] || 0) * 255,
        (values[2] || 0) * 255,
        values[3] ?? 1,
      ];
    }

    const values = normalized.match(/[-+]?(?:\d*\.)?\d+/g)?.map(Number) || [];
    return [
      values[0] || 0,
      values[1] || 0,
      values[2] || 0,
      values[3] ?? 1,
    ];
  };
  const composite = (foreground, background) => {
    const alpha = foreground[3] + (background[3] * (1 - foreground[3]));
    if (alpha === 0) {
      return [0, 0, 0, 0];
    }
    return [
      ((foreground[0] * foreground[3])
        + (background[0] * background[3] * (1 - foreground[3]))) / alpha,
      ((foreground[1] * foreground[3])
        + (background[1] * background[3] * (1 - foreground[3]))) / alpha,
      ((foreground[2] * foreground[3])
        + (background[2] * background[3] * (1 - foreground[3]))) / alpha,
      alpha,
    ];
  };
  const effectiveBackground = (element) => {
    let current = element;
    let result = [0, 0, 0, 0];
    while (current) {
      result = composite(result, parseColor(getComputedStyle(current).backgroundColor));
      if (result[3] >= 0.999) {
        break;
      }
      current = current.parentElement;
    }
    return result[3] < 1 ? composite(result, [255, 255, 255, 1]) : result;
  };
  const luminance = (color) => {
    const channels = color.slice(0, 3).map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return (0.2126 * channels[0]) + (0.7152 * channels[1]) + (0.0722 * channels[2]);
  };
  const contrast = (foreground, background) => {
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
      / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  };
  const ratiosFor = (selector, property, backgroundSelector) => (
    [...document.querySelectorAll(selector)].map((element) => {
      const foreground = parseColor(getComputedStyle(element)[property]);
      const backgroundElement = backgroundSelector
        ? element.closest(backgroundSelector)
        : element;
      const background = effectiveBackground(backgroundElement);
      return contrast(
        foreground[3] < 1 ? composite(foreground, background) : foreground,
        background
      );
    })
  );

  const refresh = document.querySelector('.telemetry-refresh');
  const refreshStyle = getComputedStyle(refresh);
  const focusBackground = effectiveBackground(refresh.parentElement);
  const outline = parseColor(refreshStyle.outlineColor);

  return {
    focus: {
      ratio: contrast(outline, focusBackground),
      style: refreshStyle.outlineStyle,
      width: refreshStyle.outlineWidth,
    },
    graphs: ratiosFor('.telemetry-metric__bar', 'fill'),
    indicators: ratiosFor(
      '.telemetry-health__indicator',
      'backgroundColor',
      '.telemetry-health__status'
    ),
    statusText: ratiosFor('.telemetry-health__status > span:last-child', 'color'),
  };
});

const openCollapsedNavigation = async (page) => {
  const toggler = page.getByRole('button', { name: 'Toggle navigation' });
  if (await toggler.isVisible()) {
    await toggler.click();
    await expect(page.locator('#betstan-navbar')).toHaveClass(/show/);
  }
};

const expectContrast = async (page) => {
  const refresh = page.getByRole('button', { name: 'Refresh' });
  await page.keyboard.press('Tab');
  await refresh.focus();
  await expect(refresh).toBeFocused();

  const evidence = await getContrastEvidence(page);
  expect(evidence.statusText).toHaveLength(10);
  expect(Math.min(...evidence.statusText)).toBeGreaterThanOrEqual(4.5);
  expect(evidence.indicators).toHaveLength(10);
  expect(Math.min(...evidence.indicators)).toBeGreaterThanOrEqual(3);
  expect(evidence.graphs).toHaveLength(112);
  expect(Math.min(...evidence.graphs)).toBeGreaterThanOrEqual(3);
  expect(evidence.focus.width).toBe('3px');
  expect(evidence.focus.style).toBe('solid');
  expect(evidence.focus.ratio).toBeGreaterThanOrEqual(3);
};

const expectTelemetryLayout = async (page, viewport) => {
  await expect(page.getByRole('heading', {
    name: 'Telemetry and service health',
    level: 1,
  })).toBeVisible();
  await expect(page.locator('.telemetry-metric')).toHaveCount(8);
  await expect(page.locator('.telemetry-health__item')).toHaveCount(10);
  await expect(page.locator('.telemetry-metric__pair')).toHaveCount(112);
  await expect(page.locator('.scoreboard')).toHaveCount(0);
  await expect(page.locator('.slip-boards')).toHaveCount(0);

  expect(await columnCount(page.locator('.telemetry-metrics'))).toBe(viewport.metricColumns);
  expect(await columnCount(page.locator('.telemetry-health'))).toBe(viewport.healthColumns);

  await expectNoScrollOverflow(page.locator('html'), 'document');
  await expectNoScrollOverflow(page.locator([
    '.telemetry-page',
    '.telemetry-section',
    '.telemetry-health',
    '.telemetry-metrics',
    '.telemetry-metric',
    '.telemetry-metric__figure',
    '.telemetry-metric__values',
  ].join(',')), 'Telemetry containers');
  await expectSiblingBoxesDoNotIntersect(page.locator('.telemetry-health__item'), 'health card');
  await expectSiblingBoxesDoNotIntersect(page.locator('.telemetry-metric'), 'metric card');
  await expectMetricContentsInsideCards(page.locator('.telemetry-metric'));
  await expectRequiredLabelsNotClipped(page);
  await expectContrast(page);
};

const expectRefreshFocusAfterSuccessAndFailure = async (page, state) => {
  const refresh = page.getByRole('button', { name: 'Refresh' });
  const validSummary = state.telemetrySummary;

  await refresh.click();
  await expect(page.getByRole('status')).toHaveText('Telemetry refreshed.');
  await expect(refresh).toBeFocused();

  state.telemetrySummary = {};
  await refresh.click();
  await expect(page.getByRole('alert')).toHaveText(
    `Refresh failed. Showing data generated at ${validSummary.generatedAt}.`
  );
  await expect(refresh).toBeFocused();
  state.telemetrySummary = validSummary;
};

for (const uiVariant of UI_VARIANTS) {
  for (const theme of THEMES) {
    test(`Telemetry fits ${uiVariant} ${theme} across desktop, tablet, and mobile`, async ({ page }) => {
      await installFakeEventSource(page);
      const state = createShellMockState();
      await installAppApiMocks(page, state);

      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await page.goto(
          `/telemetry?ui=${uiVariant}&theme=${theme}`,
          { waitUntil: 'domcontentloaded' }
        );

        await expect(page.getByRole('heading', { name: 'Service health', level: 2 }))
          .toBeVisible();
        expect(state.requestCount('POST /api/telemetry/page-view')).toBe(0);
        await openCollapsedNavigation(page);

        const telemetryLink = page.getByRole('link', { name: 'Telemetry', exact: true });
        const backofficeLink = page.getByRole('link', { name: 'Backoffice', exact: true });
        await expect(telemetryLink).toHaveAttribute('aria-current', 'page');
        await expect(telemetryLink).toHaveAttribute(
          'href',
          `/telemetry?ui=${uiVariant}&theme=${theme}`
        );
        expect(await telemetryLink.locator('xpath=ancestor::li').evaluate(
          (item) => item.previousElementSibling?.textContent.trim()
        )).toBe(await backofficeLink.textContent());

        await expectNavigationFits(page);
        await expectTelemetryLayout(page, viewport);

        if (viewport.width === 1600) {
          await expectRefreshFocusAfterSuccessAndFailure(page, state);
        }
      }
    });
  }
}

test('authenticated expanded navbar fits at 1000px', async ({ page }) => {
  await installFakeEventSource(page);
  const state = createShellMockState();
  state.currentUser = {
    id: 'telemetry-user',
    email: 'telemetry-user@example.com',
    role: 'USER',
  };
  await installAppApiMocks(page, state);

  await page.setViewportSize({ width: 1000, height: 1000 });
  await page.goto('/telemetry?ui=v2&theme=light', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Service health', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Toggle navigation' })).toBeHidden();
  await expect(page.locator('#betstan-navbar')).toBeVisible();
  await expect(page.getByText('telemetry-user', { exact: true })).toBeVisible();
  await expectNavigationFits(page, true);
  await expectRequiredLabelsNotClipped(page);
  await expectNoScrollOverflow(page.locator('html'), 'authenticated 1000px document');
});
