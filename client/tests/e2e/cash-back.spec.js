const { test, expect } = require('@playwright/test');
const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const { execFileSync } = require('child_process');
const path = require('path');
const { runInNewContext } = require('vm');
const { installFakeEventSource } = require('./support/fakeEventSource');
const { createLiveBettingMockState, createShellMockState, installAppApiMocks } = require('./support/mockAppApi');
const { bet, quoted, accepted, rejected } = require('../fixtures/cashBack');

const longName = 'Northern Mountain Falcons United Sporting Association - Southern Coastal Owls Athletic Club';
const makeLongBet = () => bet({
  rows: Array.from({ length: 5 }, (_, index) => ({
    ...bet().rows[0], _id: `long-row-${index}`, eventId: `long-event-${index}`,
    productId: `long-product-${index}`, oddsId: `exact-odds-${index}`,
    selectionId: `exact-selection-${index}`,
    eventName: index === 0 ? longName : `International Championship ${index}: ${longName}`,
    oddsName: 'Northern Mountain Falcons United Sporting Association',
    productName: 'Match result — original full-time selection',
    oddsValue: index === 0 ? 3 : 1,
  })),
});
const getCard = (page, id = 'slip-one') => page.locator(`[data-slip-id="${id}"]`);
const sourceBinding = () => {
  const root = path.resolve(__dirname, '../../..');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const paths = [...new Set([
    ...git(['diff', '--name-only', '--', 'client']),
    ...git(['ls-files', '--others', '--exclude-standard', '--', 'client']),
  ])].sort();
  const digest = createHash('sha256');
  const files = paths.map((file) => {
    const bytes = readFileSync(path.join(root, file));
    digest.update(`${file}\0`).update(bytes);
    return { path: file, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const [baseHead, baseTree] = git(['rev-parse', 'HEAD', 'HEAD^{tree}']);
  return { baseHead, baseTree, workingClientSha256: digest.digest('hex'), files,
    scope: 'Uncommitted local implementation; parent alone assembles the immutable candidate.' };
};

const createState = () => {
  const state = createShellMockState();
  state.currentUser = { id: 'cash-back-browser-owner', email: 'cashback-ui@example.com' };
  state.bets = [makeLongBet(), bet({
    _id: 'other-bet', slipId: 'other-slip', rows: [{ ...bet().rows[0], eventName: 'Independent sibling slip' }],
  })];
  state.cashRequests = [];
  state.operations = new Map();
  state.quoteBodies = new Map();
  state.receipts = [];
  state.pendingDecisions = new Map();
  state.publish = (operation) => {
    state.operations.set(operation.clientOperationId, operation);
    if (operation.receipt) {
      state.bets = state.bets.map((entry) => entry.slipId === operation.slipId
        && entry.cashBackFinancial.revision <= operation.receipt.financial.revision
        ? { ...entry, status: operation.receipt.financial.status, cashBackFinancial: operation.receipt.financial } : entry);
    }
    if (operation.state === 'ACCEPTED' && !state.receipts.some((item) => item.decisionId === operation.receipt.decisionId)) {
      state.receipts.unshift(operation.receipt);
    }
  };
  return state;
};

// UI-only HTTP evidence, not a substitute for the separately exercised backend.
// Exact bodies/IDs replay immutable offers; 202 is pending, never acceptance.
const prepare = async (page, state) => {
  await installFakeEventSource(page);
  await installAppApiMocks(page, state);
  await page.route('**/api/bet/*/cash-back/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const body = method === 'POST' ? route.request().postDataJSON() : null;
    const slipId = decodeURIComponent(url.pathname.split('/')[3]);
    state.cashRequests.push({ method, path: url.pathname, body });
    const send = (data, status = 200) => route.fulfill({
      status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(data),
    });
    const conflict = (code) => send({ errors: [{ code, message: code }] }, 409);
    if (url.pathname.endsWith('/quote')) {
      const previous = state.quoteBodies.get(body.clientOperationId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(body)) return conflict('OPERATION_CONFLICT');
      if (!previous) {
        expect(Object.keys(body).sort()).toEqual(['action', 'clientOperationId', 'portion']);
        state.quoteBodies.set(body.clientOperationId, body);
        state.operations.set(body.clientOperationId, quoted(body, {
          slipId, financial: state.bets.find((entry) => entry.slipId === slipId).cashBackFinancial,
        }));
      }
      if (state.loseQuoteOnce) {
        state.loseQuoteOnce = false;
        return route.abort('failed');
      }
      return send(state.operations.get(body.clientOperationId));
    }
    if (url.pathname.endsWith('/accept')) {
      expect(Object.keys(body).sort()).toEqual(['action', 'clientOperationId', 'quoteId']);
      const operation = state.operations.get(body.clientOperationId);
      if (!operation || operation.quote.quoteId !== body.quoteId) return conflict('QUOTE_CHANGED');
      if (['ACCEPTED', 'REJECTED'].includes(operation.state)) return send(operation);
      if (operation.state === 'CONFIRM_PENDING') return send(operation, 202);
      const before = state.bets.find((entry) => entry.slipId === slipId).cashBackFinancial;
      if (before.revision !== operation.quote.financial.revision || Date.now() >= Date.parse(operation.quote.expiresAt)) {
        const decision = rejected(operation, before.revision !== operation.quote.financial.revision ? 'STALE_REVISION' : 'QUOTE_EXPIRED',
          { ...before, revision: before.revision + 1 });
        state.publish(decision);
        return send(decision);
      }
      if (state.rejectNextConfirmation) {
        const decision = rejected(operation, state.rejectNextConfirmation);
        state.rejectNextConfirmation = null;
        state.publish(decision);
        return send(decision);
      }
      const decision = accepted(operation);
      if (state.holdNextConfirmation) {
        state.holdNextConfirmation = false;
        state.pendingDecisions.set(body.clientOperationId, decision);
        state.operations.set(body.clientOperationId, { ...operation, state: 'CONFIRM_PENDING' });
        return route.abort('failed');
      }
      state.publish(decision);
      return send(decision);
    }
    if (url.pathname.endsWith('/history')) {
      const offset = url.searchParams.get('cursor') ? 20 : 0;
      const entries = state.receipts.filter((receipt) => receipt.quote.operation.slipId === slipId);
      return send({ items: entries.slice(offset, offset + 20), nextCursor: entries.length > offset + 20 ? 'next-page' : null });
    }
    const operation = [...state.operations.values()].find((item) => url.pathname.endsWith(item.operationId));
    if (!operation) return send({ errors: [{ code: 'OPERATION_NOT_FOUND', message: 'Operation not found' }] }, 404);
    return send(operation, ['QUOTE_PENDING', 'CONFIRM_PENDING'].includes(operation.state) ? 202 : 200);
  });
};

const loadProtectedAcceptanceHelpers = () => {
  const specPath = 'infra/oci/agents/oci-live-acceptance.spec.js';
  const source = readFileSync(path.resolve(__dirname, '../../..', specPath), 'utf8');
  const helpers = runInNewContext(`${source}\n({ betCard, placeAdditionalAcceptanceBet });`, {
    URL,
    process: { env: {} },
    require: (name) => {
      if (name === '@playwright/test') return { test: () => {}, expect };
      if (name === 'fs' || name === 'child_process') return {};
      if (name === '../scripts/cash-back-acceptance-recovery-stan') {
        return {
          withStoppedResulting: () => {
            throw new Error('Protected recovery operations must not run in client helper tests');
          },
        };
      }
      if (name === 'path' || name === 'crypto') return require(name);
      throw new Error(`Unexpected protected acceptance dependency: ${name}`);
    },
  }, { filename: specPath });
  return { ...helpers, specPath, source };
};

for (const betKind of ['LIVE', 'PRE_MATCH']) {
  test(`protected OCI additional ${betKind} page preserves its offline fixture scope`, async ({ page, context }, testInfo) => {
    const { placeAdditionalAcceptanceBet, specPath, source } = loadProtectedAcceptanceHelpers();
    const state = createLiveBettingMockState();
    state.currentUser.role = 'ADMIN';
    state.bets = [];
    state.events.forEach((event, index) => {
      event.eventId = String(index + 1).repeat(24);
      event.visibility = 'OFFLINE';
    });
    const fixture = state.events.find((event) => Boolean(event.live) === (betKind === 'LIVE'));
    const sibling = state.events.find((event) => event !== fixture);
    if (fixture.live) {
      fixture.live.currentMarkets = [{
        ...fixture.live.currentMarkets[0],
        marketId: `${fixture.eventId}:SECOND_HALF_SCORE`,
        marketType: 'SECOND_HALF_SCORE',
        selections: [{ selectionId: 'score-0-0', side: 'NONE', label: '0 - 0', odds: 3.5 }],
      }];
    }
    const submitBoard = state.submitBoard;
    state.submitBoard = (body) => {
      const result = submitBoard(body);
      if (result.status === 200) {
        state.bets = [{
          _id: `bet-${body.slipId}`, slipId: body.slipId, betKind,
          status: 'CONFIRMED', wager: Number(body.wager), rows: state.boards[betKind].rows,
        }];
        state.boards[betKind] = null;
      }
      return result;
    };
    const configurePage = async (target) => {
      await installFakeEventSource(target);
      await installAppApiMocks(target, state);
    };
    await configurePage(page);
    const scopedUrl = `/?ui=v2&theme=dark&acceptanceEventIds=${fixture.eventId}`;
    await page.goto(scopedUrl);
    await expect(page.getByRole('article', { name: fixture.name })).toBeVisible();
    await expect(page.getByRole('article', { name: sibling.name })).toHaveCount(0);

    const additionalPage = await context.newPage();
    const originalGet = additionalPage.request.get;
    // Browser routing does not intercept the helper's two APIRequestContext reads.
    additionalPage.request.get = async (url) => {
      expect(['/api/slip/boards', '/api/bet']).toContain(url);
      const body = url === '/api/slip/boards' ? state.boards : state.bets;
      return { ok: () => true, json: async () => JSON.parse(JSON.stringify(body)) };
    };
    try {
      await configurePage(additionalPage);
      await additionalPage.goto('/?ui=v2&theme=dark');
      await expect(additionalPage.getByTitle('My bets')).toBeVisible();
      await expect(additionalPage.getByRole('article', { name: fixture.name })).toHaveCount(0);
      await expect(page.getByRole('article', { name: fixture.name })).toBeVisible();

      const placed = await placeAdditionalAcceptanceBet(additionalPage, fixture, betKind);
      expect(placed.status).toBe('CONFIRMED');
      expect(state.submissions).toHaveLength(1);
      expect(state.submissions[0].rows.every((row) => row.eventId === fixture.eventId)).toBe(true);
      expect(new URL(additionalPage.url()).searchParams.get('acceptanceEventIds')).toBe(fixture.eventId);
      await expect(additionalPage.getByRole('article', { name: fixture.name })).toBeVisible();
      await expect(additionalPage.getByRole('article', { name: sibling.name })).toHaveCount(0);
      await additionalPage.reload();
      await expect(additionalPage.getByRole('article', { name: fixture.name })).toBeVisible();

      state.currentUser = null;
      await additionalPage.reload();
      await expect(additionalPage.getByRole('link', { name: 'Log in', exact: true })).toBeVisible();
      await expect(additionalPage.getByRole('article', { name: fixture.name })).toHaveCount(0);
      expect(state.unhandledRequests).toEqual([]);
      await testInfo.attach('protected-additional-page-scope', {
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({
          evidence: 'Actual additional-page helper and rendered application with HTTP mocks; no production operations',
          betKind, source: sourceBinding(),
          protectedSpec: { path: specPath, sha256: createHash('sha256').update(source).digest('hex') },
          unscopedAdditionalPageExcluded: true, mainPageRemainedScoped: true,
          exactFixturePlaced: true, siblingExcluded: true, reloadPreservedScope: true,
          anonymousScopeRefused: true,
        }, null, 2)),
      });
    } finally {
      additionalPage.request.get = originalGet;
      await additionalPage.close();
    }
  });
}

for (const mode of ['compatibility', 'active']) {
  test(`protected OCI bet-card helper selects the exact rendered slip in ${mode} mode across reload`, async ({ page }, testInfo) => {
    const { betCard, specPath, source } = loadProtectedAcceptanceHelpers();
    const state = createState();
    const slipId = state.bets[1].slipId; // A second card catches accidental first-card selection.
    const siblingId = state.bets[0].slipId;
    await prepare(page, state);
    if (mode === 'compatibility') {
      await page.route('**/api/bet/*/cash-back/{quote,accept}', (route) => route.fulfill({
        status: 503, contentType: 'application/json', headers: { 'cache-control': 'no-store' },
        body: JSON.stringify({ errors: [{ code: 'AUTHORITY_UNAVAILABLE', message: 'AUTHORITY_UNAVAILABLE' }] }),
      }));
    }
    await page.goto('/bets?ui=v1&theme=dark');
    const snapshots = [];
    const checkCards = async (stage, status) => {
      const selected = betCard(page, slipId);
      const sibling = betCard(page, siblingId);
      await expect(selected).toHaveCount(1);
      await expect(selected).toHaveAttribute('data-slip-id', slipId);
      await expect(selected.locator('.my-bets-status')).toHaveText(status);
      await expect(sibling).toHaveCount(1);
      await expect(sibling).toHaveAttribute('data-slip-id', siblingId);
      await expect(sibling.locator('.my-bets-status')).toHaveText('CONFIRMED');
      // Negative control: the old protected selector cannot find this real card.
      const oldTextSelector = page.locator('.my-bets-card').filter({ hasText: `Slip ${slipId}` });
      await expect(oldTextSelector).toHaveCount(0);
      snapshots.push({
        stage, slipId: await selected.getAttribute('data-slip-id'),
        status: await selected.locator('.my-bets-status').innerText(),
        siblingId: await sibling.getAttribute('data-slip-id'),
        siblingStatus: await sibling.locator('.my-bets-status').innerText(),
        oldTextMatches: await oldTextSelector.count(),
      });
      return selected;
    };
    const selected = await checkCards('before-action', 'CONFIRMED');
    await selected.getByRole('button', { name: 'Get cash-back offer', exact: true }).click();
    if (mode === 'active') {
      await selected.getByRole('button', { name: 'Confirm full cash back', exact: true }).click();
    } else {
      await expect(selected.getByRole('alert')).toContainText('Current market authority could not be verified');
      await expect(selected.getByRole('button', { name: 'Confirm full cash back', exact: true })).toHaveCount(0);
    }
    const status = mode === 'active' ? 'CASH BACK' : 'CONFIRMED';
    await checkCards('before-reload', status);
    await page.reload();
    const restored = await checkCards('after-reload', status);
    await restored.getByRole('button', { name: 'Cash-back history', exact: true }).click();
    await expect(restored).toContainText(mode === 'active'
      ? '1 receipt loaded. End of available history.' : '0 receipts loaded. End of available history.');
    await expect(restored.locator('.cash-back-receipts li')).toHaveCount(mode === 'active' ? 1 : 0);
    await checkCards('history-loaded', status);
    expect(state.cashRequests.filter((request) => request.path.endsWith('/accept')).map((request) => request.path))
      .toEqual(mode === 'active' ? [`/api/bet/${slipId}/cash-back/accept`] : []);
    await testInfo.attach('protected-bet-card-rendered-contract', {
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({
        evidence: 'Real MyBets render with HTTP mocks; protected registration/operations are not executed',
        mode, source: sourceBinding(),
        protectedSpec: { path: specPath, sha256: createHash('sha256').update(source).digest('hex') },
        snapshots,
      }, null, 2)),
    });
  });
}

test('keyboard, lost responses, reload and a second-tab revision preserve the reviewed amount and receipts', async ({ page, context }, testInfo) => {
  const state = createState();
  state.loseQuoteOnce = true;
  await prepare(page, state);
  await page.goto('/bets?ui=v1&theme=dark');
  const card = getCard(page);
  await expect(card.getByText(longName, { exact: true })).toBeVisible();
  const mode = card.getByRole('button', { name: 'Partial stake', exact: true });
  await mode.focus();
  await page.keyboard.press('Enter');
  const input = card.getByLabel('Stake to close (Stanbucks)');
  await input.fill('40.00');
  await input.press('Tab');
  await expect(card.getByRole('button', { name: 'Get cash-back offer' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('alert')).toContainText('Network failure');
  const firstBody = state.cashRequests.find((item) => item.path.endsWith('/quote')).body;
  await page.reload();
  await expect(card.getByRole('button', { name: 'Confirm partial cash back' })).toBeEnabled();
  expect(state.cashRequests.filter((item) => item.path.endsWith('/quote')).map((item) => item.body)).toEqual([firstBody, firstBody]);
  await expect(input).toHaveValue('40.00');
  await card.getByRole('button', { name: 'Show all selections (5)' }).click();
  await input.focus();

  const secondTab = await context.newPage();
  await prepare(secondTab, state);
  await secondTab.goto('/bets?ui=v2&theme=light');
  const secondCard = getCard(secondTab);
  await expect(secondCard.getByRole('button', { name: 'Confirm partial cash back' })).toBeVisible();
  await secondCard.getByLabel('Stake to close (Stanbucks)').fill('20.00');
  await secondCard.getByRole('button', { name: 'Get new offer' }).click();
  await expect(secondCard.locator('.cash-back-offer')).toContainText('Stake to close20.00');
  await secondCard.getByRole('button', { name: 'Confirm partial cash back' }).click();
  await expect(secondCard).toContainText('Cash back recorded.');
  await page.bringToFront();
  await expect(card).toContainText('This offer is no longer current');
  await expect(input).toHaveValue('40.00');
  await expect(input).toBeFocused();
  await expect(card.getByRole('button', { name: 'Show less selections' })).toHaveAttribute('aria-expanded', 'true');
  await expect(card.getByRole('button', { name: 'Confirm partial cash back' })).toBeDisabled();
  await expect(getCard(page, 'other-slip').getByRole('button', { name: 'Get cash-back offer' })).toBeEnabled();
  await secondTab.close();

  await card.getByRole('button', { name: 'Get new offer' }).click();
  await expect(card.getByRole('button', { name: 'Confirm partial cash back' })).toBeEnabled();
  state.holdNextConfirmation = true;
  await card.getByRole('button', { name: 'Confirm partial cash back' }).focus();
  await page.keyboard.press('Enter');
  await expect(card.getByRole('alert')).toContainText('Network failure');
  const [id, decision] = [...state.pendingDecisions.entries()][0];
  await expect(card).toContainText('Confirmation pending');
  await page.reload();
  await expect(card).toContainText('Confirmation pending');
  await expect.poll(() => Date.now(), { timeout: 10000 }).toBeGreaterThan(Date.parse(decision.quote.expiresAt));
  await expect(card.getByRole('button', { name: 'Get new offer' })).toBeDisabled();
  await expect(card).not.toContainText('Cash back recorded.');
  state.publish(decision); // Delivery of the already-durable, pre-expiry decision.
  await card.getByRole('button', { name: 'Check confirmation status' }).click();
  await expect(card).toContainText('Cash back recorded.');
  await expect(card).toContainText('Remaining stake: 40.00 Stanbucks');
  await card.getByRole('button', { name: 'Cash-back history' }).click();
  await expect(card).toContainText('2 receipts loaded. End of available history.');
  await expect(card.locator('.cash-back-receipts li')).toHaveCount(2);
  const consent = state.cashRequests.filter((item) => item.path.endsWith('/accept') && item.body.clientOperationId === id);
  expect(consent).toHaveLength(1);
  expect(consent[0].body).toEqual({ action: 'CONFIRM', clientOperationId: id, quoteId: decision.quote.quoteId });
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('betstan.cash-back.v1:')));
  expect(stored).toEqual([]);
  const visibleText = await card.innerText();
  expect(visibleText).not.toMatch(/decision-|quote-|exact-selection-|paid|credited|funds transferred/i);
  const operationLookups = state.cashRequests.filter((item) => item.method === 'GET' && item.path.includes('/operations/')).length;
  // Three offers, two tabs, and one seven-second pending recovery are bounded;
  // equivalent storage records must not start a cross-tab request echo loop.
  expect(operationLookups).toBeLessThan(30);
  await testInfo.attach('cash-back-ui-journey', {
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify({
      evidence: 'HTTP mocks; not a live deployment',
      preserved: ['exact retry body', 'partial amount', 'expanded selections', 'input focus', 'sibling form'],
      pendingPastExpiry: true, receipts: state.receipts.length,
      confirmPostsForRecoveredOperation: consent.length,
      operationLookups,
    }, null, 2)),
  });
});

const measureLayout = (page) => page.evaluate(() => {
  const root = document.querySelector('.my-bets-board');
  const rect = (node) => {
    const box = node.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  };
  const visible = (node) => node.getClientRects().length && rect(node).height > 0
    && getComputedStyle(node).visibility !== 'hidden';
  const describe = (node) => ({
    slipId: node.closest('[data-slip-id]')?.dataset.slipId ?? null,
    element: node.tagName.toLowerCase(), className: node.className,
  });
  const containerWidths = [root, ...root.querySelectorAll('.my-bets-toolbar, .my-bets-card, .card-body, .my-bets-row, .my-bets-row > [data-label], .my-bets-footer, .cash-back, .cash-back-amount, .cash-back-offer, .cash-back-history, .cash-back-history__body, .cash-back-values, .cash-back-values > div, .cash-back-actions, .cash-back-receipts')]
    .filter(visible).map((node) => ({ ...describe(node), client: node.clientWidth, scroll: node.scrollWidth }));
  const overflow = containerWidths.filter((entry) => entry.scroll > entry.client);
  const contains = (outer, inner) => inner.left >= outer.left && inner.right <= outer.right
    && inner.top >= outer.top && inner.bottom <= outer.bottom;
  const measurePairs = (nodes) => nodes.flatMap((left, index) => nodes.slice(index + 1).flatMap((right, offset) => {
    // Compare independent controls, not a legitimate interactive ancestor with
    // its descendant. Labels/text are measured separately, not as controls.
    if (left.contains(right) || right.contains(left)) return [];
    const a = rect(left); const b = rect(right);
    return [{
      left: index, right: index + offset + 1,
      sameActionGroup: Boolean(left.closest('.cash-back-actions')
        && left.closest('.cash-back-actions') === right.closest('.cash-back-actions')),
      overlapWidth: Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)),
      overlapHeight: Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)),
    }];
  }));
  const overlaps = (pair) => pair.overlapWidth > 0 && pair.overlapHeight > 0;
  const cardNodes = [...root.querySelectorAll('.my-bets-card')].filter(visible);
  const cards = cardNodes.map((node) => ({ ...describe(node), bounds: rect(node) }));
  const cardPairs = measurePairs(cardNodes);
  const controlNodes = [...root.querySelectorAll('button, input, select, textarea, a[href], [role="button"]')].filter(visible);
  const controls = controlNodes.map((node) => {
    const bounds = rect(node);
    const parent = node.parentElement;
    const card = node.closest('.my-bets-card, .my-bets-toolbar');
    const parentBounds = rect(parent); const cardBounds = rect(card);
    return {
      ...describe(node),
      label: node.getAttribute('aria-label') || node.labels?.[0]?.textContent || node.textContent.trim(),
      bounds, parent: { ...describe(parent), bounds: parentBounds }, cardBounds,
      insideParent: contains(parentBounds, bounds), insideCard: contains(cardBounds, bounds),
    };
  });
  const containmentFailures = controls.filter((control) => !control.insideParent || !control.insideCard);
  const controlPairs = measurePairs(controlNodes);
  const collisions = controlPairs.filter(overlaps);
  const escapedText = [];
  root.querySelectorAll('.cash-back-values dt, .cash-back-values dd, .cash-back-control, .cash-back-amount label').forEach((element) => {
    if (!visible(element)) return;
    const bounds = rect(element);
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text) {
      const range = document.createRange();
      range.selectNodeContents(text);
      [...range.getClientRects()].forEach((line) => {
        if (line.left < bounds.left - 1 || line.right > bounds.right + 1 || line.top < bounds.top - 1 || line.bottom > bounds.bottom + 1) {
          escapedText.push(element.className || element.tagName);
        }
      });
      text = walker.nextNode();
    }
  });
  const unequalRows = [];
  root.querySelectorAll('.cash-back-actions').forEach((group) => {
    const buttons = [...group.children].filter(visible).map(rect);
    buttons.forEach((left, index) => buttons.slice(index + 1).forEach((right) => {
      if (Math.abs(left.top - right.top) < 1 && Math.abs(left.height - right.height) > 1) unequalRows.push([left.height, right.height]);
    }));
  });
  const targets = [...root.querySelectorAll('.cash-back-control, .my-bets-filter-group button')].filter(visible).map(rect);
  return {
    viewport: window.innerWidth, viewportHeight: window.innerHeight,
    document: { scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth },
    rootWidth: rect(root).width, mainWidth: rect(root.closest('main')).width,
    containerWidths, overflow, cards, cardPairs, cardCollisions: cardPairs.filter(overlaps),
    controls, controlPairs, containmentFailures, escapedText, collisions, unequalRows,
    minimumTargetWidth: Math.min(...targets.map((box) => box.width)),
    minimumTargetHeight: Math.min(...targets.map((box) => box.height)),
  };
});

const measureContrast = (page) => page.evaluate(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 1; canvas.height = 1;
  const context = canvas.getContext('2d');
  const rgba = (color) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const values = [...context.getImageData(0, 0, 1, 1).data];
    return [...values.slice(0, 3), values[3] / 255];
  };
  const blend = (front, back) => [...front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3])), 1];
  const background = (element) => {
    if (!element) return [[255, 255, 255, 1]];
    const style = getComputedStyle(element);
    const color = rgba(style.backgroundColor);
    const base = color[3] === 1 ? [color] : background(element.parentElement).map((under) => blend(color, under));
    if (style.backgroundImage === 'none') return base;
    // The shared shell has translucent gradient stops. Bound their entire color
    // range from computed CSS instead of guessing a flat color behind the card.
    const stops = style.backgroundImage.match(/rgba?\([^)]+\)/g);
    if (!stops || style.backgroundImage.includes('url(')) throw new Error('Unmeasured background image');
    const colors = stops.flatMap((stop) => base.map((under) => blend(rgba(stop), under)));
    return [
      [...[0, 1, 2].map((index) => Math.min(...colors.map((entry) => entry[index]))), 1],
      [...[0, 1, 2].map((index) => Math.max(...colors.map((entry) => entry[index]))), 1],
    ];
  };
  const luminance = (color) => color.slice(0, 3).map((value) => value / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const contrast = (left, right) => {
    const a = luminance(left); const b = luminance(right);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const contrastBound = (foreground, backgrounds) => {
    const foregroundLuminance = luminance(foreground);
    const bounds = backgrounds.map(luminance);
    if (foreground[3] === 1 && Math.min(...bounds) <= foregroundLuminance && Math.max(...bounds) >= foregroundLuminance) return 1;
    return Math.min(...backgrounds.map((surface) => contrast(blend(foreground, surface), surface)));
  };
  const text = [...document.querySelectorAll('.cash-back-help, .cash-back-values dt, .cash-back-values dd, .cash-back-error, .cash-back-message, .cash-back-control')]
    .filter((element) => element.getClientRects().length && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
    .map((element) => ({ className: element.className || element.tagName,
      ratio: contrastBound(rgba(getComputedStyle(element).color), background(element)) }));
  const controls = [...document.querySelectorAll('.cash-back-control, .my-bets-filter-group button')]
    .filter((element) => element.getClientRects().length && !element.disabled && element.getAttribute('aria-disabled') !== 'true')
    .map((element) => ({ className: element.className,
      ratio: contrastBound(rgba(getComputedStyle(element).borderTopColor), background(element.parentElement)) }));
  const input = document.querySelector('.cash-back-amount input');
  const focusStyle = getComputedStyle(input);
  const focusRatio = contrastBound(rgba(focusStyle.outlineColor), background(input.parentElement));
  const tokens = getComputedStyle(input);
  const pairs = [
    ['--text-main', '--surface-soft'], ['--text-main', '--surface-elevated'],
    ['--text-subtle', '--surface-soft'], ['--text-subtle', '--surface-elevated'],
    ['--danger', '--surface-soft'], ['--danger', '--surface-elevated'],
    ['--accent-contrast', '--accent'], ['--accent', '--surface-soft'], ['--accent', '--surface-elevated'],
  ].map(([foreground, surface]) => ({ foreground, surface,
    ratio: contrast(rgba(tokens.getPropertyValue(foreground)), rgba(tokens.getPropertyValue(surface))) }));
  return {
    minimumText: Math.min(...text.map((entry) => entry.ratio)),
    minimumControl: Math.min(...controls.map((entry) => entry.ratio)),
    focusRatio, focusWidth: parseFloat(focusStyle.outlineWidth), pairs,
    failures: text.filter((entry) => entry.ratio < 4.5).concat(controls.filter((entry) => entry.ratio < 3)),
  };
});

test('cash-back geometry at three viewports and measured shared-token contrast in all six variant/theme pairs', async ({ page }, testInfo) => {
  const state = createState();
  // Long expanded accumulator, retained partial history and a visible strict-input
  // error share the same scoped primitives across the established shell variants.
  const portion = accepted(quoted({ action: 'QUOTE', clientOperationId: 'history-portion', portion: { mode: 'PARTIAL', stakeMinor: 2000 } }));
  state.publish(portion);
  await prepare(page, state);
  await page.goto('/bets?ui=v1&theme=dark');
  const card = getCard(page);
  await card.getByRole('button', { name: 'Show all selections (5)' }).click();
  await card.getByRole('button', { name: 'Partial stake', exact: true }).click();
  const input = card.getByLabel('Stake to close (Stanbucks)');
  await input.fill('40.00');
  await card.getByRole('button', { name: 'Get cash-back offer' }).click();
  await expect(card.getByRole('button', { name: 'Confirm partial cash back' })).toBeEnabled();
  await card.getByRole('button', { name: 'Cash-back history' }).click();
  await expect(card.locator('.cash-back-receipts li')).toHaveCount(1);
  await input.fill('40.001');
  await card.getByRole('button', { name: 'Get new offer' }).click();
  await expect(card.getByRole('alert')).toContainText('whole cents');
  const otherCard = getCard(page, 'other-slip');
  await otherCard.getByRole('button', { name: 'Get cash-back offer' }).click();
  await expect(otherCard.getByRole('button', { name: 'Confirm full cash back' })).toBeEnabled();
  state.rejectNextConfirmation = 'QUOTE_CHANGED';
  await otherCard.getByRole('button', { name: 'Confirm full cash back' }).click();
  await expect(otherCard).toContainText('Cash back rejected.');

  const geometry = [];
  for (const viewport of [{ width: 1600, height: 1000 }, { width: 768, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const metrics = await measureLayout(page);
    geometry.push(metrics);
    expect(metrics.document.scroll).toBeLessThanOrEqual(metrics.document.client);
    expect(metrics.overflow).toEqual([]);
    expect(metrics.cards).toHaveLength(2);
    expect(metrics.cardPairs).toHaveLength(1);
    expect(metrics.cardCollisions).toEqual([]);
    expect(metrics.controls.length).toBeGreaterThan(0);
    expect(metrics.containmentFailures).toEqual([]);
    expect(metrics.controlPairs.some((pair) => pair.sameActionGroup)).toBe(true);
    expect(metrics.controlPairs.some((pair) => !pair.sameActionGroup)).toBe(true);
    expect(metrics.escapedText).toEqual([]);
    expect(metrics.collisions).toEqual([]);
    expect(metrics.unequalRows).toEqual([]);
    expect(metrics.minimumTargetWidth).toBeGreaterThanOrEqual(44);
    expect(metrics.minimumTargetHeight).toBeGreaterThanOrEqual(44);
    expect(Math.abs(metrics.rootWidth - metrics.mainWidth)).toBeLessThanOrEqual(1);
  }

  await page.setViewportSize({ width: 1600, height: 1000 });
  const contrast = [];
  for (const variant of ['v1', 'v2', 'v3']) {
    for (const theme of ['dark', 'light']) {
      // A same-route location update exercises App's real query-param variant/
      // theme selection without remounting the input or starting a screenshot matrix.
      await page.evaluate(({ variant, theme }) => {
        history.pushState({}, '', `/bets?ui=${variant}&theme=${theme}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, { variant, theme });
      await expect(page.locator('.app-shell')).toHaveClass(new RegExp(`ui-variant-${variant} ui-theme-${theme}`));
      await input.focus();
      await input.press('Tab');
      await page.keyboard.press('Shift+Tab');
      await expect(input).toBeFocused();
      await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
      });
      const metrics = await measureContrast(page);
      contrast.push({ variant, theme, ...metrics });
      if (metrics.failures.length) console.log('CASH_BACK_CONTRAST_FAILURE', JSON.stringify({ variant, theme, ...metrics }));
      expect(metrics.failures).toEqual([]);
      expect(metrics.minimumText).toBeGreaterThanOrEqual(4.5);
      expect(metrics.minimumControl).toBeGreaterThanOrEqual(3);
      expect(metrics.focusRatio).toBeGreaterThanOrEqual(3);
      expect(metrics.focusWidth).toBeGreaterThanOrEqual(3);
      // Decorative accents are deliberately not the control/focus boundary.
      // Actual text above includes the scoped v3-light muted-text correction.
      metrics.pairs.filter((pair) => ['--text-main', '--accent-contrast'].includes(pair.foreground))
        .forEach((pair) => expect(pair.ratio).toBeGreaterThanOrEqual(4.5));
      await expect(input).toHaveValue('40.001');
      await expect(card.getByRole('button', { name: 'Show less selections' })).toHaveAttribute('aria-expanded', 'true');
    }
  }
  const evidence = { evidence: 'Rendered HTTP mocks; computed CSS pixels and WCAG contrast bounds including gradient stops/alpha compositing', source: sourceBinding(), geometry, contrast };
  console.log('CASH_BACK_LAYOUT_EVIDENCE', JSON.stringify(evidence));
  await testInfo.attach('cash-back-layout-and-contrast', { contentType: 'application/json', body: Buffer.from(JSON.stringify(evidence, null, 2)) });
});
