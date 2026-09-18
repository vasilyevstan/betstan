const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, createTelemetryHourly, installAppApiMocks } = require('./support/mockAppApi');

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

  const refresh = document.querySelector('.telemetry-page :focus-visible') || document.querySelector('.telemetry-refresh');
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
    tooltipText: ratiosFor('.telemetry-metric__tooltip time, .telemetry-metric__tooltip data', 'color'),
    detailText: ratiosFor('.telemetry-metric__day, .telemetry-metric__generated, .telemetry-metric__action', 'color'),
    pairText: ratiosFor('.telemetry-metric__values .telemetry-metric__date, .telemetry-metric__values .telemetry-metric__value', 'color'),
  };
});

const expectTooltipContents = async (tooltip, bucket, count) => {
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('time')).toHaveCount(1);
  await expect(tooltip.locator('data')).toHaveCount(1);
  await expect(tooltip.locator('time')).toHaveText(bucket.length === 10
    ? `${bucket} UTC` : `${bucket.slice(0, 10)} ${bucket.slice(11, 16)} UTC`);
  await expect(tooltip.locator('time')).toHaveAttribute('datetime', bucket);
  await expect(tooltip.locator('data')).toHaveText(String(count));
  await expect(tooltip.locator('data')).toHaveAttribute('value', String(count));
};

const expectTooltipGeometry = async (page, card, trigger, bucket, count, interaction = 'pointer') => {
  if (interaction !== 'already-focused') await trigger.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  if (interaction === 'focus') {
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
  }
  // Playwright may scroll a trigger clear of the sticky navbar on hover.
  // Measure document coordinates so scrolling is not misreported as layout shift.
  const documentBox = (element) => {
    const box = element.getBoundingClientRect();
    return { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height, scrollX, scrollY };
  };
  const before = await card.evaluate(documentBox);
  if (interaction === 'pointer') {
    // Locator.hover may scroll before delivering the pointer. Measure app-induced
    // scrolling from native entry, before React's mouse handler, not that setup.
    await trigger.evaluate((element) => {
      element.telemetryScrollAtPointerEntry = null;
      element.addEventListener('pointerover', () => {
        element.telemetryScrollAtPointerEntry = { scrollX, scrollY };
      }, { once: true });
    });
    await trigger.hover();
  }
  else if (interaction === 'focus') await trigger.focus();
  const tooltip = card.getByRole('tooltip');
  await expectTooltipContents(tooltip, bucket, count);
  const evidence = await tooltip.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const cardBox = element.closest('.telemetry-metric').getBoundingClientRect();
    const headerBottom = document.querySelector('.app-navbar').getBoundingClientRect().bottom;
    const controls = [...element.closest('.telemetry-metric').querySelectorAll('button:focus, .telemetry-metric__action')];
    const lines = [...element.querySelectorAll('time, data')].map((line) => {
      const lineBox = line.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(line);
      const text = range.getBoundingClientRect();
      return {
        tag: line.tagName,
        left: lineBox.left, right: lineBox.right, top: lineBox.top, bottom: lineBox.bottom,
        textLeft: text.left, textRight: text.right, textTop: text.top, textBottom: text.bottom,
        scrollWidth: line.scrollWidth, clientWidth: line.clientWidth,
      };
    });
    return {
      left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      minLeft: Math.max(0, cardBox.left), maxRight: Math.min(innerWidth, cardBox.right),
      minTop: Math.max(headerBottom, cardBox.top), maxBottom: Math.min(innerHeight, cardBox.bottom),
      pointerEvents: getComputedStyle(element).pointerEvents,
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, lines,
      controlOverlaps: controls.filter((control) => {
        const other = control.getBoundingClientRect();
        return box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top;
      }).length,
    };
  });
  expect(evidence.left).toBeGreaterThanOrEqual(evidence.minLeft - 0.75);
  expect(evidence.right).toBeLessThanOrEqual(evidence.maxRight + 0.75);
  expect(evidence.top).toBeGreaterThanOrEqual(evidence.minTop - 0.75);
  expect(evidence.bottom).toBeLessThanOrEqual(evidence.maxBottom + 0.75);
  expect(evidence.controlOverlaps).toBe(0);
  expect(evidence.pointerEvents).toBe('none');
  expect(evidence.scrollWidth).toBeLessThanOrEqual(evidence.clientWidth);
  expect(evidence.lines.map((line) => line.tag)).toEqual(['TIME', 'DATA']);
  for (const line of evidence.lines) {
    expect(line.left).toBeGreaterThanOrEqual(evidence.left - 0.75);
    expect(line.right).toBeLessThanOrEqual(evidence.right + 0.75);
    expect(line.top).toBeGreaterThanOrEqual(evidence.top - 0.75);
    expect(line.bottom).toBeLessThanOrEqual(evidence.bottom + 0.75);
    expect(line.textLeft).toBeGreaterThanOrEqual(line.left - 0.75);
    expect(line.textRight).toBeLessThanOrEqual(line.right + 0.75);
    expect(line.textTop).toBeGreaterThanOrEqual(line.top - 0.75);
    expect(line.textBottom).toBeLessThanOrEqual(line.bottom + 0.75);
    expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
    expect(Math.abs((line.textLeft + line.textRight) / 2 - (evidence.left + evidence.right) / 2)).toBeLessThanOrEqual(0.75);
  }
  expect(evidence.lines[0].bottom).toBeLessThanOrEqual(evidence.lines[1].top);
  const after = await card.evaluate(documentBox);
  for (const dimension of ['x', 'y', 'width', 'height']) {
    expect(Math.abs(before[dimension] - after[dimension])).toBeLessThanOrEqual(0.75);
  }
  const contrast = await getContrastEvidence(page);
  expect(contrast.tooltipText.length).toBeGreaterThanOrEqual(2);
  expect(Math.min(...contrast.tooltipText)).toBeGreaterThanOrEqual(4.5);
  const scrollAtEntry = interaction === 'pointer'
    ? await trigger.evaluate((element) => element.telemetryScrollAtPointerEntry)
    : before;
  expect(scrollAtEntry).not.toBeNull();
  return {
    evidence, contrast: Math.min(...contrast.tooltipText),
    layoutDelta: Math.max(...['x', 'y', 'width', 'height'].map((dimension) => Math.abs(before[dimension] - after[dimension]))),
    scrollDelta: Math.max(Math.abs(scrollAtEntry.scrollX - after.scrollX), Math.abs(scrollAtEntry.scrollY - after.scrollY)),
  };
};

const expectTooltipTransitAndEscape = async (page, card, bar, bucket, count) => {
  const tooltip = card.getByRole('tooltip');
  const tipBox = await tooltip.boundingBox();
  const barBox = await bar.boundingBox();
  const x = Math.max(tipBox.x + 1, Math.min(tipBox.x + tipBox.width - 1, barBox.x + barBox.width / 2));
  const above = tipBox.y + tipBox.height <= barBox.y;
  const startY = above ? barBox.y + 1 : barBox.y + barBox.height - 1;
  const endY = above ? tipBox.y + tipBox.height - 1 : tipBox.y + 1;
  await page.mouse.move(barBox.x + barBox.width / 2, startY);
  await tooltip.evaluate((element) => { window.telemetryObservedTooltip = element; });
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(x, startY + (endY - startY) * step / 12);
    await expect(tooltip).toBeVisible();
    expect(await tooltip.evaluate((element) => element === window.telemetryObservedTooltip)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(x, endY);
  await expect(tooltip).toHaveCount(0);
  await page.mouse.move(0, 0);
  await bar.hover();
  await expectTooltipContents(tooltip, bucket, count);
};

const expectMixedState = async (page) => {
  const cards = page.locator('.telemetry-metric');
  const first = cards.nth(0);
  const lastDate = first.locator('.telemetry-metric__date-button').last();
  const name = await lastDate.getAttribute('aria-label');
  await lastDate.focus();
  await page.keyboard.press('Space');
  const back = first.getByRole('button', { name: 'Back to 14 days' });
  await expect(back).toBeFocused();
  await expect(first.locator('rect')).toHaveCount(24);
  await expect(first.getByText(/In progress/)).toBeVisible();
  await expect(cards.nth(1).locator('rect')).toHaveCount(14);
  await expect(first.locator('ol button')).toHaveCount(0);
  await expect(page.locator('.telemetry-metric__values .telemetry-metric__pair')).toHaveCount(122);
  await expectMetricContentsInsideCards(cards);
  await expectSiblingBoxesDoNotIntersect(cards, 'mixed metric cards');
  await expectRequiredLabelsNotClipped(page);
  await expectNoScrollOverflow(page.locator('html'), 'mixed document');
  const targets = await page.locator('.telemetry-metric button').evaluateAll((elements) => (
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    })
  ));
  expect(Math.min(...targets.map((box) => box.width))).toBeGreaterThanOrEqual(44);
  expect(Math.min(...targets.map((box) => box.height))).toBeGreaterThanOrEqual(44);
  const contrast = await getContrastEvidence(page);
  expect(Math.min(...contrast.detailText)).toBeGreaterThanOrEqual(4.5);
  expect(Math.min(...contrast.pairText)).toBeGreaterThanOrEqual(4.5);
  expect(contrast.focus.ratio).toBeGreaterThanOrEqual(3);
  expect(contrast.focus.width).toBe('3px');
  await expectTooltipGeometry(page, first, first.locator('rect').first(), '2026-09-10T00:00:00.000Z', 1);
  await expectTooltipGeometry(page, first, first.locator('rect').last(), '2026-09-10T23:00:00.000Z', 0);
  await back.press('Enter');
  await expect(first.getByRole('button', { name, exact: true })).toBeFocused();
  await expect(first.locator('rect')).toHaveCount(14);
};

// A single immediate read after native activation: no polling or test-side scroll
// may turn an offscreen focus destination into a passing visibility assertion.
const expectImmediateFocusVisible = async (page, name, transition) => {
  const evidence = await page.evaluate(() => {
    const element = document.activeElement;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const ring = parseFloat(style.outlineWidth) + Math.max(0, parseFloat(style.outlineOffset));
    return {
      name: element.getAttribute('aria-label') || element.textContent.trim(),
      focusVisible: element.matches(':focus-visible'),
      outlineStyle: style.outlineStyle,
      outlineWidth: parseFloat(style.outlineWidth),
      left: box.left - ring, right: box.right + ring,
      top: box.top - ring, bottom: box.bottom + ring,
      headerBottom: document.querySelector('.app-navbar').getBoundingClientRect().bottom,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
    };
  });
  console.log(`Immediate ${transition} focus: ${JSON.stringify(evidence)}`);
  expect(evidence.name).toBe(name);
  expect(evidence.focusVisible).toBe(true);
  expect(evidence.outlineStyle).toBe('solid');
  expect(evidence.outlineWidth).toBe(3);
  expect(evidence.top).toBeGreaterThanOrEqual(evidence.headerBottom - 0.75);
  expect(evidence.bottom).toBeLessThanOrEqual(evidence.viewportHeight + 0.75);
  expect(evidence.left).toBeGreaterThanOrEqual(-0.75);
  expect(evidence.right).toBeLessThanOrEqual(evidence.viewportWidth + 0.75);
};

const expectOwnPairGeometry = async (card, viewport, mode, expectedCounts) => {
  const evidence = await card.evaluate((element) => {
    const epsilon = 0.75;
    const pairs = [...element.querySelectorAll('.telemetry-metric__values .telemetry-metric__pair')];
    const rows = [];
    const containmentFailures = [];
    const intersections = [];
    const counts = [];
    const controls = pairs.map((pair, index) => {
      const control = pair.querySelector('button') || pair;
      const box = control.getBoundingClientRect();
      const pairBox = pair.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(control.querySelector('data'));
      const valueBaseline = range.getClientRects()[0].bottom;
      counts.push(control.querySelector('data').textContent);
      const inside = (child, parent) => (
        child.left >= parent.left - epsilon && child.right <= parent.right + epsilon
        && child.top >= parent.top - epsilon && child.bottom <= parent.bottom + epsilon
      );
      if (!inside(box, pairBox)) containmentFailures.push({ index, kind: 'control-in-pair' });
      for (const child of control.querySelectorAll('time, data')) {
        range.selectNodeContents(child);
        if (!inside(child.getBoundingClientRect(), box)
          || [...range.getClientRects()].some((textBox) => !inside(textBox, box))) {
          containmentFailures.push({ index, kind: child.tagName });
        }
      }
      let row = rows.find((entry) => Math.abs(entry.top - pairBox.top) <= epsilon);
      if (!row) {
        row = { top: pairBox.top, controls: [] };
        rows.push(row);
      }
      row.controls.push({ top: box.top, bottom: box.bottom, width: box.width, valueBaseline });
      return { box, pairBox };
    });
    for (let a = 0; a < controls.length; a += 1) {
      for (let b = a + 1; b < controls.length; b += 1) {
        for (const kind of ['box', 'pairBox']) {
          const first = controls[a][kind];
          const second = controls[b][kind];
          if (first.left < second.right - epsilon && first.right > second.left + epsilon
            && first.top < second.bottom - epsilon && first.bottom > second.top + epsilon) {
            intersections.push({ a, b, kind });
          }
        }
      }
    }
    const spread = (key) => Math.max(...rows.map((row) => {
      const values = row.controls.map((control) => control[key]);
      return Math.max(...values) - Math.min(...values);
    }));
    const body = element.querySelector('.card-body');
    const bodyBox = body.getBoundingClientRect();
    const bodyStyle = getComputedStyle(body);
    const contentLeft = bodyBox.left + parseFloat(bodyStyle.paddingLeft);
    const contentWidth = bodyBox.width - parseFloat(bodyStyle.paddingLeft) - parseFloat(bodyStyle.paddingRight);
    const plot = element.querySelector('svg').getBoundingClientRect();
    const containers = [
      document.documentElement, element, body,
      ...element.querySelectorAll('.telemetry-metric__figure, .telemetry-metric__values, .telemetry-metric__pair, button'),
    ];
    return {
      count: pairs.length, counts, containmentFailures, intersections,
      rowTopSpread: spread('top'), rowBottomSpread: spread('bottom'),
      rowWidthSpread: spread('width'), valueBaselineSpread: spread('valueBaseline'),
      plotWidth: plot.width, contentWidth, plotOffset: plot.left - contentLeft,
      overflow: containers.filter((container) => container.scrollWidth > container.clientWidth)
        .map((container) => ({ className: container.className, scrollWidth: container.scrollWidth, clientWidth: container.clientWidth })),
    };
  });
  console.log(`Own-pair geometry ${viewport}/${mode}: ${JSON.stringify(evidence)}`);
  expect(evidence.counts).toEqual(expectedCounts.map(String));
  expect(evidence.containmentFailures).toEqual([]);
  expect(evidence.intersections).toEqual([]);
  expect(evidence.overflow).toEqual([]);
  for (const key of ['rowTopSpread', 'rowBottomSpread', 'rowWidthSpread', 'valueBaselineSpread']) {
    expect(evidence[key], key).toBeLessThanOrEqual(0.75);
  }
  expect(Math.abs(evidence.plotWidth - evidence.contentWidth)).toBeLessThanOrEqual(0.75);
  expect(Math.abs(evidence.plotOffset)).toBeLessThanOrEqual(0.75);
};

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
  expect(Math.min(...evidence.pairText)).toBeGreaterThanOrEqual(4.5);
};

const expectTelemetryLayout = async (page, viewport) => {
  await expect(page.getByRole('heading', {
    name: 'Telemetry and service health',
    level: 1,
  })).toBeVisible();
  await expect(page.locator('.telemetry-metric')).toHaveCount(8);
  await expect(page.locator('.telemetry-health__item')).toHaveCount(10);
  await expect(page.locator('.telemetry-metric__values .telemetry-metric__pair')).toHaveCount(112);
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
        // Reuse this layout matrix, not a second screenshot matrix.
        await expectMixedState(page);
        const card = page.locator('.telemetry-metric').first();
        const measured = await expectTooltipGeometry(
          page, card, card.locator('rect').last(), state.telemetrySummary.dates[13], state.telemetrySummary.metrics[0].values[13]
        );
        if (viewport.width === 768) {
          const bar = card.locator('rect').last();
          const barBox = await bar.boundingBox();
          const { evidence } = measured;
          const height = evidence.bottom - evidence.top;
          // Preserve the original constrained Back → tallest-bar state: both
          // natural positions fail, so only the new bounded fallback can pass.
          expect(barBox.y - height - 6).toBeLessThan(evidence.minTop + 8);
          expect(barBox.y + barBox.height + 6 + height).toBeGreaterThan(evidence.maxBottom - 8);
          expect(Math.abs(evidence.top - (evidence.minTop + 8))).toBeLessThanOrEqual(0.75);
          expect(measured.scrollDelta).toBeLessThanOrEqual(0.75);
          const scrollBeforeTransit = await page.evaluate(() => scrollY);
          await expectTooltipTransitAndEscape(page, card, bar,
            state.telemetrySummary.dates[13], state.telemetrySummary.metrics[0].values[13]);
          expect(Math.abs(await page.evaluate(() => scrollY) - scrollBeforeTransit)).toBeLessThanOrEqual(0.75);
          // Click the actual SVG bar where the pointer-transparent fallback
          // overlaps it, not the overlay or an artificially forwarded event.
          const point = {
            x: barBox.x + barBox.width / 2,
            y: (Math.max(barBox.y, evidence.top) + Math.min(barBox.y + barBox.height, evidence.bottom)) / 2,
          };
          expect(evidence.bottom).toBeGreaterThan(barBox.y);
          expect(await bar.evaluate((element, point) => document.elementFromPoint(point.x, point.y) === element, point)).toBe(true);
          const key = `GET /api/telemetry/metrics/MAIN_PAGE_VISIT/days/${state.telemetrySummary.dates[13]}`;
          const requestsBeforeClick = state.requestCount(key);
          await page.mouse.click(point.x, point.y);
          await expect(card.locator('rect')).toHaveCount(24);
          expect(state.requestCount(key)).toBe(requestsBeforeClick + 1);
          console.log(`Fallback ${uiVariant}/${theme}/768: bar ${barBox.y.toFixed(2)}–${(barBox.y + barBox.height).toFixed(2)}; tooltip ${evidence.top.toFixed(2)}–${evidence.bottom.toFixed(2)}; contrast ${measured.contrast.toFixed(2)}; layout delta ${measured.layoutDelta}; scroll delta ${measured.scrollDelta}; 12-step transit/Escape/reentry and actual overlapping-bar click passed.`);
        }
        console.log(`Telemetry ${uiVariant}/${theme}/${viewport.width}: tooltip contrast ${measured.contrast.toFixed(2)}, layout delta <=0.75px; mixed controls >=44px`);
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

test('static route aliases share layout, navigation, and page-view identity', async ({ page }) => {
  await installFakeEventSource(page);
  const state = createShellMockState();
  await installAppApiMocks(page, state);
  await page.setViewportSize({ width: 1600, height: 1000 });

  await page.goto('/telemetry/?ui=v1&theme=dark', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', {
    name: 'Telemetry and service health',
    level: 1,
  })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Telemetry', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.scoreboard')).toHaveCount(0);
  await expect(page.locator('.slip-boards')).toHaveCount(0);
  expect(state.requestCount('GET /api/telemetry/summary')).toBe(1);
  expect(state.requestCount('POST /api/telemetry/page-view')).toBe(0);

  await page.getByRole('link', { name: 'Telemetry', exact: true }).click();
  await expect(page).toHaveURL(/\/telemetry\?ui=v1&theme=dark$/);
  expect(state.requestCount('GET /api/telemetry/summary')).toBe(1);

  await page.goto('/Telemetry?ui=v1&theme=dark', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', {
    name: 'Telemetry and service health',
    level: 1,
  })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Telemetry', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.scoreboard')).toHaveCount(0);
  await expect(page.locator('.slip-boards')).toHaveCount(0);
  expect(state.requestCount('POST /api/telemetry/page-view')).toBe(0);

  await page.goto('/backoffice/?ui=v1&theme=dark', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Backoffice', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Backoffice', exact: true }))
    .toHaveAttribute('aria-current', 'page');
  expect(state.requestCount('POST /api/telemetry/page-view')).toBe(1);
  expect(state.requests.filter(({ key }) => key === 'POST /api/telemetry/page-view'))
    .toEqual([{
      key: 'POST /api/telemetry/page-view',
      body: { page: 'admin' },
    }]);

  await page.getByRole('link', { name: 'Backoffice', exact: true }).click();
  await expect(page).toHaveURL(/\/backoffice\?ui=v1&theme=dark$/);
  expect(state.requestCount('POST /api/telemetry/page-view')).toBe(1);

  await page.goto('/telemetry/details?ui=v1&theme=dark', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Telemetry and service health' }))
    .toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Telemetry', exact: true }))
    .not.toHaveAttribute('aria-current');
  await expect(page.locator('.scoreboard')).toHaveCount(1);
  await expect(page.locator('.slip-boards')).toHaveCount(1);
  expect(state.requestCount('POST /api/telemetry/page-view')).toBe(1);
});

test('exact tooltip hover transit, Escape, edge counts and native SVG actions are stable', async ({ page }) => {
  await installFakeEventSource(page);
  const state = createShellMockState();
  state.telemetrySummary.metrics[0].values[0] = 0;
  state.telemetrySummary.metrics[0].values[7] = Number.MAX_SAFE_INTEGER;
  state.telemetrySummary.metrics[0].values[13] = 123456789;
  const hourly = {
    ...createTelemetryHourly('MAIN_PAGE_VISIT', '2026-08-28'),
    values: Array.from({ length: 24 }, (_, hour) => (
      hour === 7 ? Number.MAX_SAFE_INTEGER : hour === 23 ? 0 : hour * 3
    )),
  };
  state.telemetryHourlyResponses['MAIN_PAGE_VISIT/2026-08-28'] = { body: hourly };
  await installAppApiMocks(page, state);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/telemetry?ui=v3&theme=dark');
  const cards = page.locator('.telemetry-metric');
  await expect(cards).toHaveCount(8);
  for (let index = 0; index < 8; index += 1) {
    await expectTooltipGeometry(page, cards.nth(index), cards.nth(index).locator('rect').first(),
      state.telemetrySummary.dates[0], state.telemetrySummary.metrics[index].values[0]);
  }
  const first = cards.first();
  for (let index = 0; index < 14; index += 1) {
    await expectTooltipGeometry(page, first, first.locator('rect').nth(index),
      state.telemetrySummary.dates[index], state.telemetrySummary.metrics[0].values[index]);
  }
  for (let index = 0; index < 14; index += 1) {
    const button = first.locator('.telemetry-metric__values button').nth(index);
    await expectTooltipGeometry(page, first, button,
      state.telemetrySummary.dates[index], state.telemetrySummary.metrics[0].values[index], 'focus');
    await expect(button).toBeFocused();
    await expect(first.locator('.telemetry-metric__values data')).toHaveCount(14);
    await expect(first.locator('.telemetry-metric__values data')).toHaveText(state.telemetrySummary.metrics[0].values.map(String));
  }
  for (const index of [0, 7, 13]) {
    const bar = first.locator('rect').nth(index);
    await expectTooltipGeometry(page, first, bar, state.telemetrySummary.dates[index], state.telemetrySummary.metrics[0].values[index]);
    await expectTooltipTransitAndEscape(page, first, bar, state.telemetrySummary.dates[index], state.telemetrySummary.metrics[0].values[index]);
  }
  const bar = first.locator('rect').first();
  const focused = cards.nth(1).locator('button').first();
  await focused.focus();
  await bar.click();
  await expect(first.locator('rect')).toHaveCount(24);
  await expect(focused).toBeFocused();
  await expect(first.getByRole('tooltip')).toHaveCount(0);
  for (let hour = 0; hour < 24; hour += 1) {
    await expectTooltipGeometry(page, first, first.locator('rect').nth(hour), hourly.hours[hour], hourly.values[hour]);
    await expect(first.locator('.telemetry-metric__values data')).toHaveCount(24);
    await expect(first.locator('.telemetry-metric__values data')).toHaveText(hourly.values.map(String));
  }
  const detailKey = 'GET /api/telemetry/metrics/MAIN_PAGE_VISIT/days/2026-08-28';
  await first.locator('rect').last().click();
  expect(state.requestCount(detailKey)).toBe(1);
  await page.mouse.wheel(0, 70);
  await expect(first.getByRole('tooltip')).toHaveCount(0);
  await expectTooltipGeometry(page, first, first.locator('rect').last(), hourly.hours[23], 0);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await expect(first.getByRole('tooltip')).toHaveCount(0);
  expect(state.requestCount('POST /api/telemetry/page-view')).toBe(0);
  console.log('Tooltip evidence: all 8 cards; 14 daily UTC buckets by pointer and native focus; 24 hourly bucket starts with later generatedAt; both date/count lines and exact attributes; zero/MAX_SAFE_INTEGER/edges; transit/Escape/reentry/scroll/resize/native SVG focus retained.');
});

test('mobile focus fallback, loading/error Back, partial Refresh and later-open focus retention', async ({ page }) => {
  await installFakeEventSource(page);
  const state = createShellMockState();
  await installAppApiMocks(page, state);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/telemetry?ui=v2&theme=light');
  const first = page.locator('.telemetry-metric').first();
  const origin = first.locator('.telemetry-metric__date-button').last();
  await origin.evaluate((element) => {
    const top = element.getBoundingClientRect().top + window.scrollY;
    // The shell inherits Bootstrap smooth scrolling. Establish settled geometry
    // before testing a fresh focus, rather than racing an in-progress scroll.
    window.scrollTo({ top: top - 220, behavior: 'instant' });
  });
  // Even an instant scroll dispatches its scroll event on a subsequent frame.
  await page.evaluate(() => new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  }));
  await expect.poll(() => first.locator('svg').evaluate((element) => element.getBoundingClientRect().bottom)).toBeLessThan(200);
  await origin.focus();
  await expectTooltipGeometry(page, first, origin, '2026-09-10', 14, 'already-focused');
  const fallback = await first.getByRole('tooltip').boundingBox();
  const buttonBox = await origin.boundingBox();
  expect(fallback.y + fallback.height).toBeLessThanOrEqual(buttonBox.y - 5);
  expect(fallback.y).toBeGreaterThan(0);
  const contrast = await getContrastEvidence(page);
  expect(contrast.focus.ratio).toBeGreaterThanOrEqual(3);
  expect(Math.min(...contrast.tooltipText)).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press('Escape');
  await expect(first.getByRole('tooltip')).toHaveCount(0);
  await origin.blur();
  await origin.focus();
  await expectTooltipContents(first.getByRole('tooltip'), '2026-09-10', 14);

  let release;
  const key = 'MAIN_PAGE_VISIT/2026-09-10';
  state.telemetryHourlyResponses[key] = {
    wait: new Promise((resolve) => { release = resolve; }),
    status: 503, body: { error: 'Telemetry temporarily unavailable' },
  };
  await origin.press('Enter');
  await expectImmediateFocusVisible(page, 'Back to 14 days', 'daily activation');
  const back = first.getByRole('button', { name: 'Back to 14 days' });
  await expect(back).toBeFocused();
  await expect(first.getByRole('status')).toHaveText('Loading hourly data...');
  release();
  await expect(first.getByRole('alert')).toContainText('Hourly data is unavailable');
  await expect(back).toBeFocused();
  state.telemetryHourlyResponses[key] = {
    wait: new Promise((resolve) => { release = resolve; }),
    body: createTelemetryHourly('MAIN_PAGE_VISIT', '2026-09-10'),
  };
  await first.getByRole('button', { name: 'Retry' }).press('Enter');
  await expectImmediateFocusVisible(page, 'Back to 14 days', 'Retry');
  await expect(back).toBeFocused();
  const second = page.locator('.telemetry-metric').nth(1);
  const other = second.locator('.telemetry-metric__date-button').first();
  await other.focus();
  release();
  await expect(first.locator('rect')).toHaveCount(24);
  await expect(other).toBeFocused();

  let releaseOverview;
  let releaseDetail;
  state.telemetrySummaryResponse = { wait: new Promise((resolve) => { releaseOverview = resolve; }) };
  state.telemetryHourlyResponses[key] = {
    wait: new Promise((resolve) => { releaseDetail = resolve; }),
    status: 429, body: { error: 'Too many requests' },
  };
  const refresh = page.getByRole('button', { name: 'Refresh' });
  await refresh.click();
  await expect(refresh).toBeDisabled();
  const otherKey = 'ADMIN_PAGE_VISIT/2026-08-28';
  let releaseLater;
  state.telemetryHourlyResponses[otherKey] = {
    wait: new Promise((resolve) => { releaseLater = resolve; }),
    body: createTelemetryHourly('ADMIN_PAGE_VISIT', '2026-08-28'),
  };
  await other.press('Space');
  const otherBack = second.getByRole('button', { name: 'Back to 14 days' });
  await expect(otherBack).toBeFocused();
  releaseOverview();
  await expect(refresh).toBeDisabled();
  releaseDetail();
  await expect(refresh).toBeEnabled();
  await expect(page.getByText(/Refresh failed for some telemetry data/)).toBeVisible();
  await expect(first.locator('rect')).toHaveCount(24);
  await expect(second.getByRole('status')).toContainText('Loading hourly');
  await expect(otherBack).toBeFocused();
  releaseLater();
  await expect(second.locator('rect')).toHaveCount(24);
  await expect(otherBack).toBeFocused();
  await expectMetricContentsInsideCards(page.locator('.telemetry-metric'));
  await expectNoScrollOverflow(page.locator('html'), 'mobile mixed failure');
  await back.press('Enter');
  await expectImmediateFocusVisible(page, 'Main page visits, 2026-09-10 UTC, 14', 'Back');
  console.log(`Mobile focus fallback measured; text contrast ${Math.min(...contrast.tooltipText).toFixed(2)}, focus ${contrast.focus.ratio.toFixed(2)}; network/batch completion retained sibling focus.`);
});

test('mixed-count pair geometry stays contained and aligned at three widths', async ({ page }) => {
  await installFakeEventSource(page);
  const state = createShellMockState();
  const counts = [0, 7, Number.MAX_SAFE_INTEGER];
  const dailyCounts = Array.from({ length: 14 }, (_, index) => counts[index % counts.length]);
  const hourlyCounts = Array.from({ length: 24 }, (_, index) => counts[index % counts.length]);
  state.telemetrySummary.metrics[0].values = dailyCounts;
  state.telemetryHourlyResponses['MAIN_PAGE_VISIT/2026-08-28'] = {
    body: {
      ...createTelemetryHourly('MAIN_PAGE_VISIT', '2026-08-28'),
      values: hourlyCounts,
    },
  };
  await installAppApiMocks(page, state);
  for (const width of [390, 768, 1600]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/telemetry?ui=v2&theme=light');
    const card = page.locator('.telemetry-metric').first();
    await expect(card.locator('.telemetry-metric__values data')).toHaveCount(14);
    await expectOwnPairGeometry(card, width, 'daily', dailyCounts);
    await card.locator('.telemetry-metric__date-button').first().press('Enter');
    await expect(card.locator('.telemetry-metric__values data')).toHaveCount(24);
    await expectOwnPairGeometry(card, width, 'hourly', hourlyCounts);
    await expectTooltipGeometry(page, card, card.locator('rect').first(), '2026-08-28T00:00:00.000Z', 0);
    await expectTooltipGeometry(page, card, card.locator('rect').last(), '2026-08-28T23:00:00.000Z', Number.MAX_SAFE_INTEGER);
  }
});

test.describe('Telemetry native touch', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('44px date targets open hourly and Back restores daily', async ({ page }) => {
    await installFakeEventSource(page);
    const state = createShellMockState();
    await installAppApiMocks(page, state);
    await page.goto('/telemetry?ui=v1&theme=light');
    const card = page.locator('.telemetry-metric').first();
    const date = card.locator('.telemetry-metric__date-button').first();
    const box = await date.boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    await date.tap();
    await expect(card.locator('rect')).toHaveCount(24);
    const back = card.getByRole('button', { name: 'Back to 14 days' });
    const backBox = await back.boundingBox();
    expect(backBox.width).toBeGreaterThanOrEqual(44);
    expect(backBox.height).toBeGreaterThanOrEqual(44);
    await back.tap();
    await expect(card.locator('rect')).toHaveCount(14);
    expect(state.requestCount('GET /api/telemetry/summary')).toBe(1);
  });
});
