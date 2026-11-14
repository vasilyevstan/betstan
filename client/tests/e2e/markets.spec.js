const { test, expect } = require('@playwright/test');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createBackofficeEvents, createShellMockState, installAppApiMocks } = require('./support/mockAppApi');

// Synthetic event and authority responses; this test never contacts a live backend.
const prepare = async (page, { hasRetainedModel = true } = {}) => {
  const state = createShellMockState();
  state.currentUser = { id: 'market-player', email: 'player@example.com', role: 'USER' };
  state.backofficeEvents = createBackofficeEvents();
  const event = state.backofficeEvents[0];
  state.events = [{ ...event, products: [{ id: 'northport-1x2', type: '1X2', name: '1X2', odds: [
    { id: 'home', name: 'Northport', value: 2.2 }, { id: 'draw', name: 'Draw', value: 3.4 }, { id: 'away', name: 'Lakewood', value: 3.1 },
  ] }] }, { ...event, eventId: 'neighbour-event', name: 'North Christopherborough United - Eastwick', products: [
    { id: 'neighbour-1x2', type: '1X2', name: '1X2', odds: [
      { id: 'home', name: 'North Christopherborough United', value: 1.9 }, { id: 'draw', name: 'Draw', value: 3.5 },
      { id: 'away', name: 'Eastwick', value: 4.1 },
    ] }] }];
  const definition = {
    schemaVersion: 1, name: 'Total goals', settlementMode: 'FINAL_SCORE', outcomeMode: 'EXCLUSIVE', coverage: 'COMPLETE',
    terms: 'Settled on the full-time score.', parameters: [{ key: 'line', label: 'Goals line', minimum: 0.5, maximum: 10.5, defaultValue: 2.5 }],
    outcomes: [
      { key: 'over', label: 'Over', rule: { kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'GT', value: { parameter: 'line' } } },
      { key: 'under', label: 'Under', rule: { kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'LT', value: { parameter: 'line' } } },
    ],
  };
  const template = { id: 'totals', version: 1, definition, publishedAt: '2025-01-01T00:00:00Z' };
  const resultDefinition = {
    ...definition, name: '1X2', parameters: [],
    outcomes: [['home', '1', 'GT'], ['draw', 'X', 'EQ'], ['away', '2', 'LT']].map(([key, label, comparison]) => ({
      key, label, rule: { kind: 'COMPARE', metric: 'GOAL_DIFFERENCE', comparison, value: 0 },
    })),
  };
  const scoreDefinition = {
    ...resultDefinition, name: 'Correct Score', coverage: 'PARTIAL',
    outcomes: [[0, 0], [0, 1], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [3, 0], [3, 1]].map(([home, away]) => ({
      key: `score-${home}-${away}`, label: `${home} - ${away}`, rule: { kind: 'ALL', rules: [
        { kind: 'COMPARE', metric: 'HOME_GOALS', comparison: 'EQ', value: home },
        { kind: 'COMPARE', metric: 'AWAY_GOALS', comparison: 'EQ', value: away },
      ] },
    })),
  };
  const starters = [{ id: '1x2', definition: resultDefinition }, { id: 'correct-score', definition: scoreDefinition },
    { id: 'totals', definition }].map((starter) => {
    const columns = starter.id === '1x2' ? 3 : 2;
    return { ...starter, layout: { version: 1, columns, tileShape: 'rounded',
      tiles: starter.definition.outcomes.map((outcome, index) => ({
        outcomeKey: outcome.key, row: Math.floor(index / columns) + 1, column: index % columns + 1, width: 1, height: 1,
      })) } };
  });
  const templates = [{ templateId: 'totals', revision: 1, archived: false, versions: [template] }];
  let market = { schemaVersion: 1, eventId: event.eventId, marketId: 'totals-a', revision: 1, rulesRevision: 1,
    template, parameters: { line: 2.5 }, pricing: { method: 'SCORE_MODEL' }, availability: 'OPEN', status: 'DRAFT' };
  const total = { origin: 'TEMPLATE', marketId: 'totals-a', outcomeKey: 'over', quoteRevision: 2, rulesRevision: 1,
    templateId: 'totals', templateVersion: 1, marketName: 'Total goals', label: 'Over', terms: 'Settled on the full-time score.',
    settlementMode: 'FINAL_SCORE', pricingMethod: 'SCORE_MODEL', odds: 2.14,
    rule: { kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'GT', value: 2.5 } };
  const quotes = [];
  const quoteRequests = [];
  const writes = [];
  await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const send = (body) => route.fulfill({ json: body });
    if (url.pathname === '/api/backoffice/market-templates') {
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        writes.push({ path: url.pathname, body });
        const id = `template-${templates.length}`;
        const saved = { templateId: id, revision: 1, archived: false,
          versions: [{ id, version: 1, definition: body.definition, layout: body.layout, publishedAt: '2025-01-01T00:00:00Z' }] };
        templates.push(saved);
        return send(saved);
      }
      return send({ enabled: true, templates, starters });
    }
    if (url.pathname === `/api/backoffice/events/${event.eventId}/markets`) {
      if (method === 'POST') {
        const body = route.request().postDataJSON();
        writes.push({ path: url.pathname, body });
        const designed = templates.find((item) => item.templateId === body.templateId).versions
          .find((version) => version.version === body.templateVersion);
        const { layout, ...frozenTemplate } = designed;
        market = { schemaVersion: 1, eventId: event.eventId, marketId: 'designed-market', revision: 1, rulesRevision: 1,
          template: frozenTemplate, layout, parameters: body.parameters, availability: 'OPEN', status: 'DRAFT' };
        return send(market);
      }
      return send({ enabled: true, event, markets: [market] });
    }
    const odds = () => market.marketId === 'totals-a' ? { over: 2.14, under: 1.66 }
      : Object.fromEntries(market.template.definition.outcomes.map((outcome) => [outcome.key, 1.87]));
    if (url.pathname === `/api/event/events/${event.eventId}/markets/preview`) {
      writes.push({ path: url.pathname, body: route.request().postDataJSON() });
      return send({ method: market.marketId === 'totals-a' ? 'SCORE_MODEL' : 'EQUAL_CHANCE', odds: odds() });
    }
    if (url.pathname === `/api/backoffice/events/${event.eventId}/markets/${market.marketId}` && method === 'PUT') {
      const body = route.request().postDataJSON();
      writes.push({ path: url.pathname, body });
      market = { ...market, ...body, revision: market.revision + 1, status: 'PUBLISHED' };
      market.configuration = { ...market };
      market.publishedConfiguration = { ...market.configuration };
      return send(market);
    }
    if (url.pathname === '/api/event/events/neighbour-event/markets') return send({ enabled: true, event: state.events[1], markets: [] });
    if (url.pathname === `/api/event/events/${event.eventId}/markets`) return send({
      enabled: true, event, hasRetainedModel,
      markets: market.status === 'PUBLISHED' ? [{ configuration: market, preview: { odds: odds() } }] : [],
    });
    if (url.pathname === `/api/event/events/${event.eventId}/market-quotes`) {
      const now = Date.now();
      quoteRequests.push(route.request().postDataJSON());
      const selected = market.template.definition.outcomes.find((item) => item.key === quoteRequests[quoteRequests.length - 1].selections[0].outcomeKey);
      const frozen = market.marketId === 'totals-a' ? total : {
        origin: 'TEMPLATE', marketId: market.marketId, outcomeKey: selected.key, quoteRevision: market.revision, rulesRevision: 1,
        templateId: market.template.id, templateVersion: market.template.version, marketName: market.template.definition.name,
        label: selected.label, terms: market.template.definition.terms, settlementMode: 'MANUAL', pricingMethod: 'OPERATOR', odds: 1.87,
      };
      quotes.push({ schemaVersion: 1, quoteId: 'reviewed-quote',
        kind: 'SINGLE', eventId: event.eventId, modelId: 'retained-model', selections: [frozen], odds: frozen.odds,
        issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString() });
      return send(quotes[quotes.length - 1]);
    }
    if (url.pathname === '/api/slip/market-selection') {
      writes.push({ path: url.pathname, body: route.request().postDataJSON() });
      state.boards.PRE_MATCH = { id: 'draft', betKind: 'PRE_MATCH', status: 'DRAFT', wager: 10,
        boardRevision: 1, boardFingerprint: 'draft-fingerprint', rows: [{
          id: 'custom-row', eventId: event.eventId, eventName: event.name, productName: 'Custom market', productId: market.marketId,
          oddsName: quotes[0].selections[0].label, oddsValue: quotes[0].odds, betKind: 'PRE_MATCH', marketBet: quotes[0],
        }] };
      return send(state.boards.PRE_MATCH);
    }
    return route.fallback();
  });
  return { state, event, writes, definition, quotes, quoteRequests, templates };
};

for (const theme of ['dark', 'light']) {
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`market authoring and match-card selection at ${viewport.width}px${theme === 'light' ? ' light' : ''}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const { state, event, writes, quotes, quoteRequests } = await prepare(page);
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
    await page.getByRole('button', { name: 'Add market' }).click();
    await expect(page.getByRole('radio', { name: /Total goals.*Template v1/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: /^1X2 .*Built-in/ })).toBeEnabled();
    await expect(page.getByRole('radio', { name: /Total goals.*Built-in/ })).toHaveCount(0);
    await expect(page.locator('.market-choice .market-preview').filter({ hasText: 'Total goals 2.5' })).toContainText('Over');
    await expect(page.locator('.market-add .market-player-preview')).toContainText('Player preview');
    await expect(page.getByLabel('Template name')).toHaveCount(0);
    await capture('backoffice-add-market');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.goto(`/backoffice?theme=${theme}`);
    await page.getByRole('link', { name: 'Market designer', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Market designer' })).toBeVisible();
    await page.getByRole('button', { name: 'New template' }).click();
    await page.getByLabel('Start from').selectOption('totals');
    await expect(page.getByRole('group', { name: 'New template' })).toBeVisible();
    await expect(page.getByLabel('Template name')).toHaveValue('Total goals copy');
    await expect(page.locator('.market-definition-editor .market-player-preview')).toContainText('Total goals copy 2.5');
    await capture('template-rules');
    await page.goto(`/?theme=${theme}`);
    const card = page.getByRole('article', { name: event.name });
    await expect(card.getByRole('heading', { name: 'Total goals 2.5' })).toBeVisible();
    await expect(card.getByRole('link', { name: /Markets/ })).toHaveCount(0);
    const over = card.getByRole('button', { name: `Select Total goals 2.5 Over in ${event.name} at 2.14` });
    await over.click();
    await expect(over).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('complementary').getByText(/Quote expires/)).toBeVisible();
    expect(quoteRequests).toEqual([{ requestId: expect.any(String), kind: 'SINGLE',
      selections: [{ origin: 'TEMPLATE', marketId: 'totals-a', outcomeKey: 'over', quoteRevision: 2 }] }]);
    expect(writes[2].body).toEqual({ quoteId: 'reviewed-quote', expectedBoardRevision: null,
      expectedBoardFingerprint: null, replaceEventSelections: false });
    await capture('match-card-market');
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

for (const theme of ['dark', 'light']) {
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`market designer persists a custom shape at ${viewport.width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const { state, event, templates, quoteRequests } = await prepare(page);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/backoffice/events/${event.eventId}/markets?theme=${theme}`);
    const toolbar = page.locator('.market-toolbar');
    const detail = page.locator('.market-detail');
    await expect(toolbar.getByRole('button', { name: 'Add market' })).toBeVisible();
    const toolbarBox = await toolbar.boundingBox();
    const detailBox = await detail.boundingBox();
    expect(detailBox.y).toBeGreaterThan(toolbarBox.y + toolbarBox.height);
    expect(Math.abs(detailBox.width - toolbarBox.width)).toBeLessThan(2);
    await page.getByRole('button', { name: 'Add market' }).click();
    await page.getByRole('radio', { name: /^1X2 / }).check();
    await expect(page.getByRole('button', { name: 'Add to event' })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Add to event' })).toBeInViewport();
    await expect(page.getByRole('radio', { name: /^Correct Score / })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('event-market-picker.png'), fullPage: true });
    await page.goto(`/backoffice/markets?theme=${theme}`);
    await page.getByRole('button', { name: 'New template' }).click();
    await page.getByLabel('Template name').fill('Player of the match');
    await page.getByLabel('Settlement terms').fill('Operator declares the official award winner.');
    await page.getByLabel('Outcome label', { exact: true }).nth(0).fill('Captain');
    await page.getByLabel('Outcome label', { exact: true }).nth(1).fill('Keeper');
    const keeper = page.getByRole('button', { name: 'Design Keeper', exact: true });
    await keeper.click();
    const destination = page.getByRole('button', { name: 'Place Keeper at row 2, column 1', exact: true });
    if (viewport.width > 1000) await keeper.dragTo(destination);
    else {
      await destination.focus();
      await page.keyboard.press('Enter');
    }
    await expect(keeper).toHaveCSS('grid-row', '2 / span 1');
    await page.getByRole('combobox', { name: 'Tile width', exact: true }).selectOption('2');
    await page.getByRole('combobox', { name: 'Tile height', exact: true }).selectOption('2');
    await page.getByRole('combobox', { name: 'Tile shape', exact: true }).selectOption('pill');
    await expect(keeper).toHaveCSS('grid-column', '1 / span 2');
    await expect(keeper).toHaveCSS('grid-row', '2 / span 2');
    await page.getByLabel('Selected outcome', { exact: true }).fill('Goalkeeper');
    await expect(page.getByLabel('Selected outcome', { exact: true })).toHaveValue('Goalkeeper');
    await page.getByRole('button', { name: 'Up', exact: true }).click();
    await expect(page.getByText('Moved Captain to make room.', { exact: false })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Design Goalkeeper', exact: true })).toHaveCSS('grid-row', '1 / span 2');
    await expect(page.getByRole('button', { name: 'Design Captain', exact: true })).toHaveCSS('grid-row', '3 / span 1');
    await expect(page.getByRole('button', { name: 'Up', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.locator('.market-designer').screenshot({ path: testInfo.outputPath('visual-designer.png') });
    await page.getByRole('button', { name: 'Save template', exact: true }).click();
    await expect(page.getByText('Template saved.', { exact: false })).toBeVisible();
    const saved = templates[1].versions[0];
    expect(saved.layout.tiles).toEqual([
      { outcomeKey: 'captain', row: 3, column: 1, width: 1, height: 1 },
      { outcomeKey: 'goalkeeper', row: 1, column: 1, width: 2, height: 2 },
    ]);
    await page.reload();
    await page.getByRole('button', { name: 'New version of Player of the match' }).click();
    await expect(page.getByRole('button', { name: 'Design Goalkeeper' })).toHaveCSS('grid-column', '1 / span 2');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.goto(`/backoffice/events/${event.eventId}/markets?theme=${theme}`);
    await page.getByRole('button', { name: 'Add market' }).click();
    await page.getByRole('radio', { name: /^Player of the match/ }).check();
    await page.getByRole('button', { name: 'Add to event' }).click();
    await expect(page.getByText('Draft created.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Generate odds' }).click();
    await expect(page.getByText('Price preview.', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Publish market' }).click();
    await expect(page.getByRole('button', { name: /Player of the match.*Published/ })).toBeVisible();
    await page.goto(`/?theme=${theme}`);
    const card = page.getByRole('article', { name: event.name });
    const selection = card.getByRole('button', { name: /Select Player of the match Goalkeeper/ });
    await expect(selection.locator('..')).toHaveCSS('grid-column', '1 / span 2');
    await expect(selection.locator('..')).toHaveCSS('grid-row', '1 / span 2');
    if (viewport.width > 1000) {
      // The neighbour has a longer name and no custom market; its 1X2 must stay level and directly under its header.
      const neighbour = page.getByRole('article', { name: 'North Christopherborough United - Eastwick' });
      const deckGap = async (article) => article.evaluate((node) => node.querySelector('.event-card__product-deck').getBoundingClientRect().top
        - node.querySelector('.event-card__prematch-header').getBoundingClientRect().bottom);
      const oneXTwoTop = (article) => article.locator('.product-block--1x2 .product-block__title').evaluate((node) => node.getBoundingClientRect().top);
      expect((await card.boundingBox()).y).toBeCloseTo((await neighbour.boundingBox()).y, 0);
      expect(Math.abs(await oneXTwoTop(card) - await oneXTwoTop(neighbour))).toBeLessThan(2);
      expect(Math.abs(await deckGap(neighbour) - await deckGap(card))).toBeLessThan(2);
    }
    await selection.click();
    await expect.poll(() => quoteRequests.length).toBe(1);
    await expect(selection).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('complementary').getByText(/Quote expires/)).toBeVisible();
    expect(quoteRequests[0].selections).toEqual([
      { origin: 'TEMPLATE', marketId: 'designed-market', outcomeKey: 'goalkeeper', quoteRevision: 2 },
    ]);
    await card.screenshot({ path: testInfo.outputPath('custom-player-card.png') });
    expect(errors).toEqual([]);
    expect(state.unhandledRequests).toEqual([]);
  });
}
}

for (const scenario of [
  { name: '1X2', width: 390, theme: 'light', outcome: '1' },
  { name: 'Correct Score', width: 1440, theme: 'dark', outcome: '0 - 0' },
]) {
  test(`copies and publishes ${scenario.name} on an event without a model`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: scenario.width, height: 900 });
    const { state, event, templates, writes, quoteRequests } = await prepare(page, { hasRetainedModel: false });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`/backoffice/markets?theme=${scenario.theme}`);
    await page.getByRole('button', { name: `Use ${scenario.name} template` }).click();
    await expect(page.getByLabel('Template name')).toHaveValue(`${scenario.name} copy`);
    await page.getByLabel('Template name').fill('My match product');
    await page.getByRole('combobox', { name: 'Result', exact: true }).selectOption('MANUAL');
    await page.getByRole('combobox', { name: 'Tile shape', exact: true }).selectOption('pill');
    await page.getByRole('button', { name: 'Save template', exact: true }).click();
    await expect(page.getByText('Template saved.', { exact: false })).toBeVisible();
    const copy = templates[1].versions[0];
    expect(copy.definition).toMatchObject({ name: 'My match product', settlementMode: 'MANUAL' });
    expect(copy.definition.outcomes.every((outcome) => !outcome.rule)).toBe(true);
    expect(copy.layout.tileShape).toBe('pill');
    await expect(page.getByRole('button', { name: 'Use Free draw template' })).toBeVisible();
    const gallery = await page.locator('.market-standard-designs .market-choices').boundingBox();
    const library = await page.locator('.market-library').boundingBox();
    expect(gallery.width).toBeGreaterThan(library.width - 40);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: testInfo.outputPath('copyable-template-library.png'), fullPage: true });
    await page.getByRole('button', { name: `Use ${scenario.name} template` }).click();
    await expect(page.getByLabel('Template name')).toHaveValue(`${scenario.name} copy`);
    await expect(page.getByRole('combobox', { name: 'Result', exact: true })).toHaveValue('FINAL_SCORE');
    await expect(page.getByRole('combobox', { name: 'Tile shape', exact: true })).toHaveValue('rounded');
    await page.goto(`/backoffice/events/${event.eventId}/markets?theme=${scenario.theme}`);
    await expect(page.getByText(/only manual-result templates can be added/)).toBeVisible();
    await page.getByRole('button', { name: 'Add market' }).click();
    await expect(page.getByRole('radio', { name: new RegExp(`^${scenario.name} `) })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /^My match product/ })).toBeChecked();
    await page.getByRole('button', { name: 'Add to event' }).click();
    await expect(page.getByText('Draft created.', { exact: false })).toBeVisible();
    expect(writes.filter((write) => write.path === '/api/backoffice/market-templates')).toHaveLength(1);
    await page.getByRole('button', { name: 'Generate odds' }).click();
    await expect(page.getByText('Price preview.', { exact: false })).toBeVisible();
    expect(writes.find((write) => write.path.endsWith('/preview')).body.generation.method).toBe('EQUAL_CHANCE');
    await page.getByRole('button', { name: 'Publish market' }).click();
    await expect(page.getByRole('button', { name: /My match product.*Published/ })).toBeVisible();
    await page.goto(`/?theme=${scenario.theme}`);
    const card = page.getByRole('article', { name: event.name });
    const pick = card.getByRole('button', { name: `Select My match product ${scenario.outcome} in ${event.name} at 1.87` });
    await pick.click();
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('complementary').getByText(/Quote expires/)).toBeVisible();
    expect(quoteRequests[0].selections[0]).toMatchObject({ origin: 'TEMPLATE', marketId: 'designed-market' });
    await card.screenshot({ path: testInfo.outputPath('copied-template-player-card.png') });
    expect(errors).toEqual([]);
    expect(state.unhandledRequests).toEqual([]);
  });
}
