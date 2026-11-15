const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

const API = '/api/backoffice/risk-centre';
const createPolicy = () => {
  const catalogue = [
    ['MAX_STAKE', 'Maximum stake', 'admission', 10000, 'minor units', false],
    ['DELAY_MS', 'Acceptance delay', 'admission', 0, 'milliseconds', true],
    ['MAX_OPERATOR_EXPOSURE', 'Operator exposure', 'accounting', 10000, 'minor units', false],
  ].map(([type, label, category, limit, unit, defaultEnabled]) => ({
    type, label, category, description: 'Every matching enabled restriction applies to the whole ticket.',
    defaultParameters: { limit }, defaultEnabled, defaultScope: {}, locked: false,
    parameterDefinitions: [{ name: 'limit', label: 'Limit', type: 'number', required: true, min: 0, max: 1000000, unit }],
  }));
  return {
    revision: 1, defaultsVersion: 1,
    rules: catalogue.map(item => ({
      id: `default:${item.type}`, type: item.type, enabled: item.defaultEnabled,
      scope: {}, parameters: { ...item.defaultParameters },
    })),
    catalogue: [...catalogue, {
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
      await page.getByRole('button', { name: /Maximum stake Disabled/ }).click();
      await expect(page.getByRole('heading', { name: 'Maximum stake', exact: true })).toBeFocused();
      await expect(page.getByLabel('Event IDs', { exact: true })).toBeHidden();
      await page.getByLabel('Limit (Stanbucks)', { exact: true }).fill('24');
      await page.getByRole('combobox', { name: 'Structure', exact: true }).selectOption('SINGLE');
      const previous = mutations.length;
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
      expect(mutations).toHaveLength(previous);
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(/Revision \d+ saved/)).toBeVisible();
      expect(mutations.at(-1).body.rule.parameters.limit).toBe(2400);
      await page.screenshot({ path: testInfo.outputPath(`risk-stake-${theme}-${viewport.width}.png`), fullPage: true });
      await page.getByLabel('Add a rule').selectOption('DELAY_MS');
      await expect(page.getByRole('heading', { name: 'Acceptance delay', exact: true })).toBeFocused();
      await expect(page.getByLabel('Enabled', { exact: true })).not.toBeChecked();
      await page.getByLabel('Limit (seconds)', { exact: true }).fill('0.5');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByText(/Revision \d+ saved/)).toBeVisible();
      expect(mutations.at(-1).body.rule.parameters.limit).toBe(500);
      await page.getByRole('button', { name: 'Remove', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm remove' }).click();
      await expect(page.getByText(/Revision \d+ saved/)).toBeVisible();
      await page.getByRole('button', { name: 'Restore all defaults' }).click();
      await expect(page.getByText('Factory policy preview')).toBeVisible();
      await page.getByRole('button', { name: 'Confirm restore' }).click();
      await expect(page.getByText(/Revision \d+ saved/)).toBeVisible();
      await page.getByRole('button', { name: /Operator exposure limit Disabled/ }).click();
      await expect(page.getByLabel('Enabled', { exact: true })).toBeDisabled();
      await expect(page.getByText(/Exact hedge credit is not spendable/)).toBeVisible();
      const geometry = await page.locator('.risk-centre').evaluate(root => {
        const targets = [...root.querySelectorAll('button, input:not([type="checkbox"]), select, summary')]
          .filter(node => node.getBoundingClientRect().height > 0);
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          narrow: targets.filter(node => !node.disabled && node.getBoundingClientRect().height < 43.5).map(node => node.textContent),
          fieldOverflow: targets.filter(node => node.getBoundingClientRect().right > innerWidth + 1).length,
        };
      });
      expect(geometry).toEqual({ overflow: false, narrow: [], fieldOverflow: 0 });
      await page.screenshot({ path: testInfo.outputPath(`risk-${theme}-${viewport.width}.png`), fullPage: true });
    }
  });
}

test('uncertain Save reuses its operation identity and updates only once', async ({ page }) => {
  const { mutations } = await installRiskApi(page, { uncertain: true });
  await page.goto('/backoffice/risk-centre');
  await page.getByRole('button', { name: /Maximum stake Disabled/ }).click();
  await page.getByLabel('Limit (Stanbucks)', { exact: true }).fill('32');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('uncertain');
  await expect(page.getByLabel('Limit (Stanbucks)', { exact: true })).toHaveValue('32');
  await page.getByRole('button', { name: 'Retry same save' }).click();
  await expect(page.getByText(/Revision 2 saved/)).toBeVisible();
  expect(mutations[1]).toEqual(mutations[0]);
});
