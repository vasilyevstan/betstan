const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

const API = '/api/backoffice/risk-centre';
const TEMPLATE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const createPolicy = () => {
  const catalogue = [
    ['MAX_STAKE', 'Maximum stake', 'admission', 10000, 'minor units', false],
    ['DELAY_MS', 'Acceptance delay', 'admission', 0, 'milliseconds', true],
    ['MAX_OPERATOR_EXPOSURE', 'Operator exposure', 'accounting', 10000, 'minor units', false],
  ].map(([type, label, category, limit, unit, defaultEnabled]) => ({
    type, label, category, description: 'Every matching rule that is on applies to the whole ticket.',
    defaultParameters: { limit }, defaultEnabled, defaultScope: {}, locked: false,
    parameterDefinitions: [{ name: 'limit', label: 'Limit', type: 'number', required: true, min: 0, max: 1000000, unit }],
  }));
  catalogue.push({
    type: 'MAX_SUBMISSIONS', label: 'Bet frequency', category: 'activity', description: 'Limit bets in a named time window.',
    defaultParameters: { limit: 10, window: 'UTC_DAY', perCustomer: false }, defaultEnabled: false, defaultScope: {}, locked: false,
    parameterDefinitions: [
      { name: 'limit', label: 'Limit', type: 'number', required: true, min: 1, max: 1000, unit: 'count' },
      { name: 'window', label: 'Window', type: 'select', required: true, options: ['UTC_DAY', 'ROLLING_24H'] },
      { name: 'perCustomer', label: 'Per customer', type: 'boolean', required: true },
    ],
  });
  return {
    revision: 1, defaultsVersion: 1,
    builtinMarkets: [
      { id: 'PRE_MATCH:1X2', name: '1X2', betKind: 'PRE_MATCH' },
      { id: 'PRE_MATCH:CS', name: 'Correct Score', betKind: 'PRE_MATCH' },
      { id: 'LIVE:NEXT_CORNER', name: 'Next corner (live)', betKind: 'LIVE' },
      { id: 'LIVE:SECOND_HALF_TIME_RESULT', name: 'Second half time result (live)', betKind: 'LIVE' },
    ],
    rules: catalogue.map(item => ({
      id: `default:${item.type}`, type: item.type, enabled: item.defaultEnabled,
      scope: {}, parameters: { ...item.defaultParameters },
    })),
    catalogue: [...catalogue, {
      type: 'DENY', label: 'Block bets', category: 'admission', description: 'Decline every matching bet.',
      defaultEnabled: false, defaultScope: {}, defaultParameters: {}, parameterDefinitions: [], locked: false,
    }, {
      type: 'QUOTE_AUTHORITY', label: 'Quote authority', category: 'integrity', description: 'Original quote consent remains mandatory.',
      defaultEnabled: true, defaultScope: {}, defaultParameters: {}, parameterDefinitions: [], locked: true,
    }],
    readiness: { transactions: 'READY', accounting: { ready: false, code: 'HISTORICAL_RECONCILIATION_REQUIRED' },
      capabilities: { extensibleMarkets: false, selectionBlocking: true } },
  };
};
async function installRiskApi(page, { uncertain = false, eventRisk = false } = {}) {
  const state = createShellMockState();
  await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  let policy = createPolicy();
  if (eventRisk) {
    policy.readiness.accounting = { ready: false, openPositionsReady: true, readyLossWindows: [] };
    const ceiling = policy.rules.find(rule => rule.type === 'MAX_OPERATOR_EXPOSURE');
    ceiling.enabled = true;
    ceiling.parameters = { limit: 1200, perCustomer: false };
    policy.rules.push({ ...ceiling, id: 'award-budget', scope: { marketIds: ['award'] }, parameters: { limit: 50, perCustomer: false } });
  }
  const operations = new Map();
  const mutations = [];
  const eventReads = [];
  const events = [
    { eventId: 'event-a', name: 'Northport - Lakewood', time: '2099-01-01T12:00:00.000Z', phase: 'PRE_MATCH' },
    { eventId: 'event-b', name: 'Eastwick - North Christopherborough United', time: '2099-01-02T12:00:00.000Z', phase: 'PRE_MATCH' },
    { eventId: 'event-c', name: 'Westhaven - Southport', time: '2099-01-03T12:00:00.000Z', phase: 'PRE_MATCH' },
  ];
  if (eventRisk) state.backofficeEvents = events.map(event => ({
    ...event, home: event.name.split(' - ')[0], away: event.name.split(' - ')[1],
    status: 'NO_RESULT', visibility: 'ONLINE',
  }));
  const metrics = { exposureMinor: '100', openTickets: 1, pendingTickets: 0 };
  const report = () => ({ asOf: '2026-11-14T21:00:00.000Z', policyRevision: policy.revision, analysis: { ready: true, code: 'READY' } });
  const offers = [
    { id: 'a'.repeat(64), origin: 'STANDARD', marketId: 'result', marketName: '1X2', label: 'Home', odds: 3, sourceOpen: true, headroomMinor: '250' },
    { id: 'b'.repeat(64), origin: 'STANDARD', marketId: 'result', marketName: '1X2', label: 'Away', odds: 1.8, sourceOpen: true, headroomMinor: '250' },
    { id: 'c'.repeat(64), origin: 'TEMPLATE', marketId: 'award', marketName: 'Match award', label: 'Nominee A', odds: 4, sourceOpen: false, headroomMinor: '50' },
  ];
  const reply = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/backoffice/risk-centre**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (path === API) return reply(route, policy);
      if (eventRisk && path.startsWith(`${API}/events`)) {
        eventReads.push(request.url());
        const query = new URL(request.url()).searchParams;
        if (path === `${API}/events`) return reply(route, {
          ...report(), events: (query.has('after') ? events.slice(2) : events.slice(0, 2)).map(event => ({
            ...event, metrics: { ...metrics, exposureMinor: event.eventId === 'event-b' ? '850' : '100' },
          })), nextAfter: query.has('after') ? null : 'event-b',
        });
        const stakeMinor = Number(query.get('stakeMinor') || 100);
        return reply(route, { ...report(), event: events[0], metrics, stakeMinor, choices: offers.map(offer => {
          const off = policy.rules.some(rule => rule.id === `choice:${offer.id}` && rule.enabled);
          const ceiling = Math.floor(Number(offer.headroomMinor) * 100 / stakeMinor) / 100;
          const payout = Math.floor(stakeMinor * offer.odds);
          const advice = off ? 'OFF' : payout <= Number(offer.headroomMinor) ? 'WITHIN_CEILING'
            : ceiling < 1.01 ? 'TURN_OFF' : 'LOWER_ODDS';
          return { ...offer, betKind: 'PRE_MATCH', off, advice, switchConflict: false, singleBlockedByOtherRule: false,
            stressReturnMinor: String(payout), suggestedOdds: advice === 'LOWER_ODDS' ? ceiling : null };
        }) });
      }
      if (path === `${API}/history`) return reply(route, { items: [...operations.values()].reverse() });
      const id = path.slice(`${API}/operations/`.length);
      return operations.has(id) ? reply(route, operations.get(id)) : reply(route, { message: 'Operation not found', code: 'NOT_FOUND' }, 404);
    }
    const body = request.postDataJSON();
    mutations.push({ method: request.method(), path, body });
    if (operations.has(body.requestId)) return reply(route, operations.get(body.requestId));
    if (body.expectedRevision !== policy.revision) return reply(route, { code: 'REVISION_CONFLICT', message: 'Policy changed' }, 409);
    if (path === `${API}/rules`) policy.rules.push(body.rule);
    else if (request.method() === 'PUT') policy.rules = policy.rules.map(rule => rule.id === body.rule.id ? body.rule : rule);
    else if (request.method() === 'DELETE') policy.rules = policy.rules.filter(rule => rule.id !== path.split('/').pop());
    else if (body.ruleId) policy.rules = policy.rules.map(rule => rule.id === body.ruleId
      ? createPolicy().rules.find(factory => factory.id === rule.id) : rule);
    else policy.rules = createPolicy().rules;
    policy.revision += 1;
    const result = { requestId: body.requestId, revision: policy.revision, defaultsVersion: 1,
      rules: JSON.parse(JSON.stringify(policy.rules)), occurredAt: '2026-11-14T21:00:00.000Z' };
    operations.set(body.requestId, result);
    if (uncertain) { uncertain = false; return route.abort(); }
    return reply(route, result);
  });
  let cashBack = { enabled: true, revision: 0 };
  await page.route('**/api/backoffice/cash-back-setting**', async route => {
    if (route.request().method() === 'GET') return reply(route, cashBack);
    const body = route.request().postDataJSON();
    if (body.expectedEnabled !== cashBack.enabled) return reply(route, { message: 'Cash back changed' }, 409);
    cashBack = { enabled: body.enabled, revision: cashBack.revision + 1, updatedAt: '2026-11-14T21:00:00.000Z' };
    return reply(route, cashBack);
  });
  let access = { registrationEnabled: true, loginEnabled: true, revision: 0 };
  await page.route('**/api/backoffice/access-controls**', async route => {
    if (route.request().method() === 'GET') return reply(route, access);
    const field = route.request().url().endsWith('/login') ? 'loginEnabled' : 'registrationEnabled';
    const body = route.request().postDataJSON();
    if (body.expectedEnabled !== access[field]) return reply(route, { code: 'CONFLICT', message: 'Changed' }, 409);
    access = { ...access, [field]: body.enabled, revision: access.revision + 1 };
    return reply(route, access);
  });
  await page.route('**/api/backoffice/market-templates**', route => reply(route, { enabled: true, starters: [], templates: [
    { templateId: TEMPLATE_ID, archived: false, versions: [{ version: 1, definition: { name: 'Total goals' } }] },
    { templateId: 'b'.repeat(32), archived: true, versions: [{ version: 1, definition: { name: 'Archived template' } }] },
  ] }));
  return { state, mutations, eventReads };
}

for (const theme of ['light', 'dark']) {
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
    test(`Backoffice event stress, choice switches and pagination in ${theme} at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const { state, mutations, eventReads } = await installRiskApi(page, { eventRisk: true });
      await page.goto(`/backoffice?theme=${theme}`);
      const direct = page.getByRole('link', { name: 'Black swan analysis for Northport - Lakewood', exact: true });
      await expect(direct).toBeVisible();
      expect(eventReads).toHaveLength(0);
      await page.screenshot({ path: testInfo.outputPath(`backoffice-analysis-entry-${theme}-${viewport.width}.png`), fullPage: true });
      await direct.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { level: 1, name: 'Black swan analysis' })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: 'Northport - Lakewood' })).toBeVisible();
      expect(eventReads.some(url => new URL(url).pathname === `${API}/events`)).toBe(false);
      await expect(page.getByText('Lower odds to 2.50 or less')).toBeVisible();
      await expect(page.getByText('Consider turning off')).toBeVisible();
      await expect(page.getByText('Paused or unavailable at source')).toBeVisible();
      const choice = page.getByRole('switch', { name: 'Allow Home in 1X2 for Northport - Lakewood', exact: true });
      await choice.focus();
      await page.keyboard.press('Space');
      await expect(choice).toHaveAttribute('aria-checked', 'false');
      await expect(choice).toBeEnabled();
      await expect(choice).toBeFocused();
      expect(mutations.at(-1).body.rule.scope).toEqual({ betKind: 'PRE_MATCH', eventIds: ['event-a'], selectionIds: ['a'.repeat(64)] });
      await choice.click();
      await expect(choice).toHaveAttribute('aria-checked', 'true');
      await expect(choice).toBeEnabled();
      expect(mutations.at(-1)).toMatchObject({ method: 'DELETE', path: `${API}/rules/choice:${'a'.repeat(64)}` });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
      const short = await page.locator('.risk-events a, .risk-events button, .risk-events input, .risk-events summary').evaluateAll(nodes =>
        nodes.filter(node => node.getClientRects().length && !node.disabled && node.getBoundingClientRect().height < 43.5).map(node => node.textContent));
      expect(short).toEqual([]);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`backoffice-event-analysis-${theme}-${viewport.width}.png`), fullPage: true });
      await page.getByLabel('Test stake (Stanbucks)').fill('2');
      await page.getByRole('button', { name: 'Recalculate', exact: true }).click();
      await expect(page.getByText('Tested stake: 2.00 Stanbucks')).toBeVisible();
      expect(eventReads.at(-1)).toContain('stakeMinor=200');
      await page.getByRole('link', { name: 'Black swan analysis', exact: true }).click();
      await page.getByRole('button', { name: 'Review risk for Northport - Lakewood' }).click();
      const summary = await page.locator('.risk-event-summary').first().evaluate(node => {
        const [identity, exposure, action] = node.children;
        const text = document.createRange();
        text.selectNodeContents(action);
        return { identityBottom: identity.getBoundingClientRect().bottom, exposureTop: exposure.getBoundingClientRect().top,
          actionLines: text.getClientRects().length };
      });
      expect(summary.actionLines).toBe(1);
      if (viewport.width < 760) expect(summary.exposureTop).toBeGreaterThanOrEqual(summary.identityBottom);
      await page.getByRole('button', { name: 'Next events', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Review risk for Westhaven - Southport' })).toBeVisible();
      expect(eventReads.at(-1)).toContain('after=event-b');
      await page.getByRole('button', { name: 'Previous events', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Review risk for Northport - Lakewood' })).toBeVisible();
      expect(errors).toEqual([]);
      expect(state.unhandledRequests).toEqual([]);
    });
  }
}

for (const theme of ['light', 'dark']) {
  test(`public Risk Centre CRUD, restore and geometry in ${theme}`, async ({ page }, testInfo) => {
    const { mutations } = await installRiskApi(page);
    for (const viewport of [{ width: 1600, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(`/backoffice?theme=${theme}`);
      await expect(page.getByRole('link', { name: 'Market designer', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Risk Centre', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Risk Centre', exact: true })).toBeVisible();
      const activity = page.getByRole('region', { name: 'Betting activity' });
      await expect(activity).toContainText('10 bets · Calendar day (UTC) · Across all customers');
      await expect(activity).not.toContainText(/UTC_DAY|false/);
      await expect(page.locator('.risk-rule-list .market-pill--positive').first()).toHaveText('ON');
      await expect(page.locator('.risk-rule-list .market-pill--danger').first()).toHaveText('OFF');
      await page.getByRole('button', { name: /Maximum stake OFF/ }).click();
      await expect(page.getByRole('heading', { name: 'Maximum stake', exact: true })).toBeFocused();
      await expect(page.getByLabel('Event IDs', { exact: true })).toBeHidden();
      await page.getByLabel('Limit (Stanbucks)', { exact: true }).fill('24');
      await page.getByRole('combobox', { name: 'Structure', exact: true }).selectOption('SINGLE');
      const previous = mutations.length;
      await expect(page.locator('.risk-centre')).not.toContainText(/Enabled|Disabled/);
      await expect(page.getByRole('button', { name: 'Save and turn on', exact: true })).toBeEnabled();
      expect(mutations).toHaveLength(previous);
      await page.getByRole('button', { name: 'Save and turn on', exact: true }).click();
      await expect(page.getByText(/Maximum stake is on: 24 Stanbucks/)).toBeVisible();
      expect(mutations.at(-1).body.rule).toMatchObject({ enabled: true, parameters: { limit: 2400 } });
      await expect(page.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`risk-stake-${theme}-${viewport.width}.png`), fullPage: true });
      await page.getByLabel('Add live rule', { exact: true }).selectOption('DELAY_MS');
      await expect(page.getByRole('heading', { name: 'Acceptance delay', exact: true })).toBeFocused();
      await expect(page.locator('.risk-status')).toContainText('Not saved — no effect yet');
      await page.getByLabel('Limit (seconds)', { exact: true }).fill('0.5');
      await page.getByRole('button', { name: 'Save as off', exact: true }).click();
      await expect(page.getByText(/Acceptance delay saved as off/)).toBeVisible();
      expect(mutations.at(-1).body.rule).toMatchObject({ enabled: false, scope: { betKind: 'LIVE' }, parameters: { limit: 500 } });
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm remove' }).click();
      await expect(page.getByText(/Revision \d+ saved/)).toBeVisible();
      await page.getByRole('button', { name: 'Restore all defaults' }).click();
      await expect(page.getByText('Factory policy preview')).toBeVisible();
      await page.getByRole('button', { name: 'Confirm restore' }).click();
      await expect(page.getByText(/Revision \d+ saved/)).toBeVisible();
      await page.getByRole('tab', { name: 'Accounts & cash back' }).click();
      const cashBack = page.getByRole('region', { name: 'Cash back', exact: true });
      await cashBack.getByRole('button', { name: 'Turn off cash back for all events' }).click();
      await expect(page.getByText(/Cash back is off for all events/)).toBeVisible();
      await expect(cashBack.locator('.market-pill--danger')).toHaveText('OFF');
      await cashBack.getByRole('button', { name: 'Turn on cash back for all events' }).click();
      await expect(cashBack.locator('.market-pill--positive')).toHaveText('ON');
      await page.getByRole('tab', { name: 'Markets', exact: true }).click();
      const betting = page.getByRole('region', { name: 'Betting', exact: true });
      await betting.getByRole('button', { name: 'Close betting for all events' }).click();
      await expect(page.getByText(/Betting is closed for all events\. New pre-match and live bets are declined\. Revision \d+ saved/)).toBeVisible();
      expect(mutations.at(-1).body.rule).toMatchObject({ id: 'betting:all', type: 'DENY', enabled: true, scope: {} });
      await expect(betting.locator('.market-pill--danger')).toHaveText('OFF');
      await betting.getByRole('button', { name: 'Open betting for all events' }).click();
      await expect(betting.locator('.market-pill--positive')).toHaveText('ON');
      await page.getByRole('tab', { name: 'Accounts & cash back' }).click();
      const accounts = page.getByRole('region', { name: 'Accounts', exact: true });
      await accounts.getByRole('button', { name: 'Stop customer sign-in' }).click();
      await expect(page.getByText(/Customer sign-in is stopped\./)).toBeVisible();
      await expect(accounts).toContainText('Paused while sign-in is stopped');
      await accounts.getByRole('button', { name: 'Allow customer sign-in' }).click();
      await expect(page.getByText('Customer sign-in is allowed.')).toBeVisible();
      await page.getByRole('tab', { name: 'Markets', exact: true }).click();
      const markets = page.getByRole('region', { name: 'Markets', exact: true });
      const pre = markets.getByRole('region', { name: 'Pre-match', exact: true });
      const live = markets.getByRole('region', { name: 'Live', exact: true });
      const groupBox = await pre.boundingBox();
      const liveBox = await live.boundingBox();
      const gap = viewport.width < 760 ? liveBox.y - (groupBox.y + groupBox.height)
        : liveBox.x - (groupBox.x + groupBox.width);
      expect(gap).toBeGreaterThanOrEqual(0);
      const bounds = await markets.locator('button').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        return box.width >= 43.5 && box.height >= 43.5 && box.right <= window.innerWidth + 1;
      }));
      expect(bounds.every(Boolean)).toBe(true);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: testInfo.outputPath(`risk-markets-${theme}-${viewport.width}.png`), fullPage: true });
      await expect(markets.getByRole('button', { name: 'Turn off Correct Score for all events' })).toBeVisible();
      await expect(markets.getByRole('button', { name: 'Turn off Second half time result (live) for all events' })).toBeVisible();
      await expect(markets.getByRole('button', { name: 'Turn off Archived template for all events' }).locator('..')).toContainText('Template / Archived');
      await markets.getByRole('button', { name: 'Turn off 1X2 for all events' }).click();
      await expect(page.getByText(/1X2 is off for all events\. New bets on it are declined\. Revision \d+ saved/)).toBeVisible();
      expect(mutations.at(-1).body.rule).toMatchObject({
        id: 'market:PRE_MATCH:1X2', type: 'DENY', enabled: true, scope: { marketTypes: ['PRE_MATCH:1X2'] },
      });
      await expect(markets.getByRole('button', { name: 'Turn on 1X2 for all events' }).locator('..').locator('.market-pill')).toHaveText('OFF');
      await markets.getByRole('button', { name: 'Turn on 1X2 for all events' }).click();
      await expect(markets.getByRole('button', { name: 'Turn off 1X2 for all events' }).locator('..').locator('.market-pill')).toHaveText('ON');
      expect(mutations.at(-1)).toMatchObject({ method: 'DELETE', path: `${API}/rules/market:PRE_MATCH:1X2` });
      await markets.getByRole('button', { name: 'Turn off Total goals for all events' }).click();
      await expect(page.getByText(/Total goals is off for all events\. New bets on it are declined\. Revision \d+ saved/)).toBeVisible();
      expect(mutations.at(-1).body.rule).toMatchObject({
        id: `market:${TEMPLATE_ID}`, type: 'DENY', enabled: true, scope: { templateIds: [TEMPLATE_ID] },
      });
      await page.getByRole('tab', { name: 'Rules', exact: true }).click();
      await expect(page.getByRole('button', { name: /Block bets ON Market: Total goals/ })).toBeVisible();
      await page.getByRole('tab', { name: 'Markets', exact: true }).click();
      await markets.getByRole('button', { name: 'Turn on Total goals for all events' }).click();
      await expect(page.getByText(/Total goals market block removed\. Other restrictions still apply\. Revision \d+ saved/)).toBeVisible();
      expect(mutations.at(-1)).toMatchObject({ method: 'DELETE', path: `${API}/rules/market:${TEMPLATE_ID}` });
      await page.getByRole('tab', { name: 'Rules', exact: true }).click();
      await page.getByRole('button', { name: /Operator exposure limit OFF/ }).click();
      await expect(page.getByRole('button', { name: 'Turn on', exact: true })).toBeDisabled();
      await expect(page.getByText(/Can't turn on yet/)).toBeVisible();
      await expect(page.getByText(/Exact hedge credit is not spendable/)).toBeVisible();
      const geometry = await page.locator('.risk-centre').evaluate(root => {
        const targets = [...root.querySelectorAll('button, input:not([type="checkbox"]), select, summary')]
          .filter(node => node.getBoundingClientRect().height > 0);
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          titleLeftSpread: (() => {
            const positions = [...root.querySelectorAll('.risk-rule-title strong')].map(node => node.getBoundingClientRect().left);
            return Math.max(...positions) - Math.min(...positions);
          })(),
          narrow: targets.filter(node => !node.disabled && node.getBoundingClientRect().height < 43.5).map(node => node.textContent),
          fieldOverflow: targets.filter(node => node.getBoundingClientRect().right > innerWidth + 1).length,
        };
      });
      expect(geometry).toEqual({ overflow: false, narrow: [], fieldOverflow: 0, titleLeftSpread: 0 });
      await page.screenshot({ path: testInfo.outputPath(`risk-${theme}-${viewport.width}.png`), fullPage: true });
    }
  });
}

test('uncertain Save reuses its operation identity and updates only once', async ({ page }) => {
  const { mutations } = await installRiskApi(page, { uncertain: true });
  await page.goto('/backoffice/risk-centre');
  await page.getByRole('button', { name: /Maximum stake OFF/ }).click();
  await page.getByLabel('Limit (Stanbucks)', { exact: true }).fill('32');
  await page.getByRole('button', { name: 'Save and turn on', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('uncertain');
  await expect(page.getByLabel('Limit (Stanbucks)', { exact: true })).toHaveValue('32');
  await page.getByRole('button', { name: 'Retry same save' }).click();
  await expect(page.getByText(/Revision 2 saved/)).toBeVisible();
  expect(mutations[1]).toEqual(mutations[0]);
});
