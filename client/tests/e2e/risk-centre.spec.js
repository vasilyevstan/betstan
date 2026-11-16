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
      capabilities: { extensibleMarkets: false } },
  };
};
async function installRiskApi(page, { uncertain = false } = {}) {
  const state = createShellMockState();
  await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  let policy = createPolicy();
  const operations = new Map();
  const mutations = [];
  const reply = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
  await page.route('**/api/backoffice/risk-centre**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      if (path === API) return reply(route, policy);
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
  await page.route('**/api/backoffice/market-templates**', route => reply(route, { enabled: true, starters: [], templates: [
    { templateId: TEMPLATE_ID, archived: false, versions: [{ version: 1, definition: { name: 'Total goals' } }] },
  ] }));
  return { state, mutations };
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
      const cashBack = page.getByRole('region', { name: 'Cash back', exact: true });
      await cashBack.getByRole('button', { name: 'Turn off cash back for all events' }).click();
      await expect(page.getByText(/Cash back is off for all events/)).toBeVisible();
      await expect(cashBack.locator('.market-pill--danger')).toHaveText('OFF');
      await cashBack.getByRole('button', { name: 'Turn on cash back for all events' }).click();
      await expect(cashBack.locator('.market-pill--positive')).toHaveText('ON');
      const markets = page.getByRole('region', { name: 'Markets', exact: true });
      await markets.getByRole('button', { name: 'Turn off Total goals for all events' }).click();
      await expect(page.getByText(/Total goals is off for all events\. New bets on it are declined\. Revision \d+ saved/)).toBeVisible();
      expect(mutations.at(-1).body.rule).toMatchObject({
        id: `market:${TEMPLATE_ID}`, type: 'DENY', enabled: true, scope: { templateIds: [TEMPLATE_ID] },
      });
      await expect(page.getByRole('button', { name: /Block bets ON Market: Total goals/ })).toBeVisible();
      await markets.getByRole('button', { name: 'Turn on Total goals for all events' }).click();
      await expect(page.getByText(/Total goals is on for all events\. Revision \d+ saved/)).toBeVisible();
      expect(mutations.at(-1)).toMatchObject({ method: 'DELETE', path: `${API}/rules/market:${TEMPLATE_ID}` });
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
