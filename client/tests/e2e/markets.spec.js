const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createBackofficeEvents, createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

// Synthetic event and authority responses; this test never contacts a live backend.
const prepare = async (page) => {
  const state = createShellMockState();
  state.currentUser = { id: 'market-player', email: 'player@example.com', role: 'USER' };
  state.backofficeEvents = createBackofficeEvents();
  const event = state.backofficeEvents[0];
  const definition = {
    schemaVersion: 1, name: 'Total goals', settlementMode: 'FINAL_SCORE', outcomeMode: 'EXCLUSIVE', coverage: 'COMPLETE',
    terms: 'Settled on the full-time score.', parameters: [{ key: 'line', label: 'Goals line', minimum: 0.5, maximum: 10.5, defaultValue: 2.5 }],
    outcomes: [
      { key: 'over', label: 'Over', rule: { kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'GT', value: { parameter: 'line' } } },
      { key: 'under', label: 'Under', rule: { kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'LT', value: { parameter: 'line' } } },
    ],
  };
  const template = { id: 'totals', version: 1, definition, publishedAt: '2025-01-01T00:00:00Z' };
  let market = { schemaVersion: 1, eventId: event.eventId, marketId: 'totals-a', revision: 1, rulesRevision: 1,
    template, parameters: { line: 2.5 }, pricing: { method: 'SCORE_MODEL' }, availability: 'OPEN', status: 'DRAFT' };
  const home = { origin: 'STANDARD', marketId: 'standard-1x2', outcomeKey: 'home', quoteRevision: 1,
    rulesRevision: 1, templateId: 'standard-1x2', templateVersion: 1, marketName: 'Match result', label: 'Northport win',
    terms: 'Full-time score', settlementMode: 'FINAL_SCORE', pricingMethod: 'SCORE_MODEL', odds: 2.2,
    rule: { kind: 'COMPARE', metric: 'GOAL_DIFFERENCE', comparison: 'GT', value: 0 } };
  const total = { ...home, origin: 'TEMPLATE', marketId: 'totals-a', templateId: 'totals', outcomeKey: 'over',
    marketName: 'Total goals', label: 'Over', rule: { kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'GT', value: 2.5 } };
  const quotes = [];
  const writes = [];
  await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const send = (body) => route.fulfill({ json: body });
    if (url.pathname === '/api/backoffice/market-templates') return send({
      enabled: true, templates: [{ templateId: 'totals', revision: 1, archived: false, versions: [template] }],
      starters: [{ id: 'totals', definition }],
    });
    if (url.pathname === `/api/backoffice/events/${event.eventId}/markets`) return send({ enabled: true, event, markets: [market] });
    if (url.pathname === `/api/event/events/${event.eventId}/markets/preview`) {
      writes.push({ path: url.pathname, body: route.request().postDataJSON() });
      return send({ method: 'SCORE_MODEL', odds: { over: 2.14, under: 1.66 } });
    }
    if (url.pathname === `/api/backoffice/events/${event.eventId}/markets/totals-a` && method === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push({ path: url.pathname, body });
      market = { ...market, ...body, revision: market.revision + 1, status: 'PUBLISHED' };
      market.configuration = { ...market };
      market.publishedConfiguration = { ...market.configuration };
      return send(market);
    }
    if (url.pathname === `/api/event/events/${event.eventId}/markets`) return send({
      enabled: true, event, hasRetainedModel: true,
      standardSelections: [home, ...Array.from({ length: 49 }, (_, index) => ({
        ...home, marketId: 'correct-score', marketName: 'Correct score', outcomeKey: `score-${index}`,
        label: `${Math.floor(index / 7)}:${index % 7}`, odds: 10 + index,
      }))],
      markets: [{ configuration: market, preview: { odds: { over: 2.14, under: 1.66 } }, builderEligible: true }],
    });
    if (url.pathname === `/api/event/events/${event.eventId}/market-quotes`) {
      const now = Date.now();
      quotes.push({ ...route.request().postDataJSON(), schemaVersion: 1, quoteId: 'reviewed-quote',
        eventId: event.eventId, modelId: 'retained-model', selections: [home, total], odds: 3.25,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString() });
      return send(quotes[quotes.length - 1]);
    }
    if (url.pathname === '/api/slip/market-selection') {
      writes.push({ path: url.pathname, body: route.request().postDataJSON() });
      state.boards.PRE_MATCH = { id: 'draft', betKind: 'PRE_MATCH', status: 'DRAFT', wager: 10,
        boardRevision: 1, boardFingerprint: 'draft-fingerprint', rows: [{
          id: 'builder-row', eventId: event.eventId, eventName: event.name, productName: 'Bet Builder',
          oddsName: 'Northport win + Over', oddsValue: 3.25, betKind: 'PRE_MATCH', marketBet: quotes[0],
        }] };
      return send(state.boards.PRE_MATCH);
    }
    return route.fallback();
  });
  return { state, event, writes, definition, quotes };
};

for (const theme of ['dark', 'light']) {
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`market authoring and Builder review at ${viewport.width}px${theme === 'light' ? ' light' : ''}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { state, event, writes, quotes } = await prepare(page);
    const capture = async (name) => {
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      const shortControls = await page.locator('.markets-page button, .markets-page select, .markets-page input:not([type=checkbox]):not([type=radio]), .markets-page summary')
        .evaluateAll((controls) => controls.filter((control) => control.getClientRects().length > 0
          && control.getBoundingClientRect().height < 43.5).map((control) => control.textContent));
      expect(shortControls).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true });
    };
    await page.goto(`/backoffice?theme=${theme}`);
    await page.getByRole('link', { name: 'Markets for Northport - Lakewood', exact: true }).click();
    await page.getByRole('button', { name: /Total goals.*Draft/ }).click();
    await page.getByRole('button', { name: 'Generate odds' }).click();
    await expect(page.getByText('Price preview.', { exact: false })).toBeVisible();
    expect(writes).toHaveLength(1);
    await capture('backoffice-pricing');
    await page.getByRole('button', { name: 'Publish market' }).click();
    await expect(page.getByRole('button', { name: /Total goals.*Published/ })).toBeVisible();
    expect(writes[1].body).toMatchObject({ revision: 1, publish: true, parameters: { line: 2.5 }, pricing: { method: 'SCORE_MODEL' } });
    await page.getByText('Reusable template library', { exact: true }).click();
    await page.getByLabel('Starter definition').selectOption('totals');
    await page.getByRole('button', { name: 'Customize starter' }).click();
    await expect(page.getByRole('group', { name: 'Create reusable template' })).toBeVisible();
    await capture('template-rules');
    await page.goto(`/events/${event.eventId}/markets?theme=${theme}`);
    await page.getByRole('button', { name: 'Bet Builder', exact: true }).click();
    await page.getByRole('button', { name: 'Northport win 2.20' }).click();
    await page.getByRole('button', { name: 'Over 2.14', exact: true }).click();
    await expect(page.getByText('49 outcomes (0 selected)', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '0:0 10.00' })).toBeHidden();
    await expect(page.getByText('Goals line: 2.5', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Get combined odds' }).click();
    await expect(page.getByRole('button', { name: 'Add quoted selection to slip' })).toBeEnabled();
    await capture('builder-review');
    await page.getByRole('button', { name: 'Add quoted selection to slip' }).click();
    await expect(page.getByText(/Added to your pre-match slip/)).toBeVisible();
    await expect(page.getByRole('complementary').getByText(/Quote expires/)).toBeVisible();
    expect(writes[2].body).toEqual({ quoteId: 'reviewed-quote', expectedBoardRevision: null,
      expectedBoardFingerprint: null, replaceEventSelections: false });
    state.boards.PRE_MATCH = null;
    state.bets = [{ id: 'retained-history', slipId: 'retained-history', userId: 'market-player',
      status: 'WIN', betKind: 'PRE_MATCH', wager: 10, timestamp: new Date().toISOString(), rows: [
        { id: 'void-row', eventId: event.eventId, eventName: event.name, productName: 'Bet Builder',
          oddsName: 'Frozen selections', oddsValue: 5, status: 'VOID', marketBet: { ...quotes[0], odds: 5 } },
        { id: 'winner-row', eventId: 'another-event', eventName: 'Bayside - Hillcrest', productName: '1X2', oddsName: 'Home', oddsValue: 3, status: 'WIN' },
      ] }];
    await page.goto(`/bets?theme=${theme}`);
    await page.getByRole('button', { name: /Bet details/ }).click();
    await expect(page.getByText('Accepted total odds: 15.00')).toBeVisible();
    await expect(page.getByText('Settled return (nominal): 30.00 Stanbucks')).toBeVisible();
    await expect(page.getByText(/Cash back is not available for custom markets/)).toBeVisible();
    await capture('frozen-history');
    expect(errors).toEqual([]);
    expect(state.unhandledRequests).toEqual([]);
  });
}
}
