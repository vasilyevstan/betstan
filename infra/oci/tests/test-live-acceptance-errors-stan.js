const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../agents/oci-live-acceptance.spec.js'), 'utf8',
);
const start = source.indexOf('const RETRYABLE_LIVE_SELECTION_ERRORS =');
const end = source.indexOf('const readOwnedBet =', start);
assert.ok(start >= 0 && end > start);
const load = (expect) => vm.runInNewContext(
  `${source.slice(start, end)}
({ createBrowserErrorAudit, handledLiveSelectionFailures, selectLiveMarket });`,
  { URL, createHash, expect },
);
const origin = 'https://fixture.invalid';
const stale = 'Live quote is stale';
const resourceError = (status) => (
  `Failed to load resource: the server responded with a status of ${status} ()`
);
const assertionStart = source.indexOf('  expect(browserErrors.overflow).toBe(false);');
const assertionEnd = source.indexOf('  expect(apiFailures).toEqual([]);', assertionStart);
assert.ok(assertionStart >= 0 && assertionEnd > assertionStart);
const assertTerminal = new Function(
  'browserErrors', 'pageErrors', 'consoleErrors', 'httpErrors', 'apiFailures', 'expect',
  source.slice(assertionStart, assertionEnd + '  expect(apiFailures).toEqual([]);'.length),
);
const expectValue = (actual) => ({
  toBe: (expected) => assert.equal(actual, expected),
  toEqual: (expected) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected),
});
let cases = 0;

async function fixture() {
  const helpers = load();
  const page = new EventEmitter();
  const session = new EventEmitter();
  session.send = async () => ({});
  session.detach = async () => {
    if (session.onDetach) await session.onDetach();
    session.detached = true;
  };
  page.context = () => ({ newCDPSession: async () => session });
  page.url = () => origin;
  const finish = await helpers.createBrowserErrorAudit(page);
  let sequence = 0;
  const response = ({
    url = `${origin}/api/event/odds`,
    method = 'POST',
    body = JSON.stringify({ quoteVersion: sequence + 1 }),
    status = 400,
    handled = true,
    network = true,
    duplicate = false,
    log = true,
    logFirst = false,
  } = {}) => {
    const request = { method: () => method, postData: () => body };
    const result = { url: () => url, status: () => status, request: () => request };
    const requestId = `request-${++sequence}`;
    const entry = {
      level: 'error', source: 'network', url,
      networkRequestId: requestId, text: resourceError(status),
    };
    if (log && logFirst) session.emit('Log.entryAdded', { entry });
    page.emit('response', result);
    if (handled) helpers.handledLiveSelectionFailures.set(request, stale);
    if (network) {
      const event = { requestId, request: { url, method, postData: body } };
      session.emit('Network.requestWillBeSent', event);
      if (duplicate) session.emit('Network.requestWillBeSent', event);
      session.emit('Network.responseReceived', { requestId, response: { status } });
    }
    if (log && !logFirst) session.emit('Log.entryAdded', { entry });
  };
  return { session, response, finish };
}

async function check(configure, consoleCount, httpCount, overflow = false) {
  const current = await fixture();
  configure(current);
  const result = await current.finish();
  assert.equal(result.consoleErrors.length, consoleCount);
  assert.equal(result.httpErrors.length, httpCount);
  assert.equal(result.overflow, overflow);
  assert.equal(current.session.detached, true);
  assert.ok(!JSON.stringify(result).includes('private-marker'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 65536);
  for (const values of [
    result.consoleErrors, result.httpErrors, result.handledSelectionErrors,
  ]) {
    assert.ok(values.length <= 128);
    for (const value of values) {
      assert.ok(Object.values(value).every(field => typeof field !== 'string' || field.length <= 96));
    }
  }
  const validate = () => assertTerminal(
    result, [], result.consoleErrors, result.httpErrors, [], expectValue,
  );
  if (consoleCount || httpCount || overflow) assert.throws(validate);
  else validate();
  cases += 1;
  return result;
}

async function unitCases() {
  await check(() => {}, 0, 0);
  await check(({ response }) => response(), 0, 0);
  await check(({ response }) => response({ logFirst: true }), 0, 0);
  await check(({ response }) => { response(); response(); }, 0, 0);
  await check(({ response }) => response({ handled: false }), 1, 1);
  await check(({ response }) => response({ handled: false, status: 500 }), 1, 1);
  await check(({ response }) => response({ handled: false, status: 500, log: false }), 0, 1);
  await check(({ response }) => { response(); response({ handled: false }); }, 1, 1);
  await check(({ response }) => {
    response({ body: '{}' });
    response({ body: '{}', handled: false });
  }, 2, 1);
  await check(({ response }) => {
    response({ body: '{}' });
    response({ body: '{}' });
  }, 2, 0);
  await check(({ response }) => response({ network: false }), 1, 0);
  await check(({ response }) => response({ duplicate: true }), 1, 0);
  await check(({ response }) => response({ body: undefined, method: 'GET' }), 1, 0);
  await check(({ response }) => response({ url: 'https://other.invalid/api/event/odds' }), 1, 0);
  await check(({ response, session }) => {
    response();
    session.emit('Runtime.consoleAPICalled', {
      type: 'error', args: [{ value: resourceError(400) }],
      stackTrace: { callFrames: [{ url: `${origin}/app.js?private-marker` }] },
    });
  }, 1, 0);
  await check(({ session }) => session.emit('Runtime.consoleAPICalled', {
    type: 'error', args: [{ value: 'private-marker' }],
  }), 1, 0);
  await check(({ session }) => session.emit('Log.entryAdded', {
    entry: {
      level: 'error', source: 'network', text: 'net::ERR_CONNECTION_REFUSED',
      url: `${origin}/api/bet/${'a'.repeat(24)}?private-marker`,
    },
  }), 1, 0);
  await check(({ session }) => {
    session.emit('Runtime.consoleAPICalled', { type: 'warning' });
    session.emit('Log.entryAdded', { entry: { level: 'warning' } });
  }, 0, 0);
  await check(({ session }) => {
    session.onDetach = async () => {
      await Promise.resolve();
      session.emit('Runtime.consoleAPICalled', { type: 'error' });
    };
  }, 1, 0);
  await check(({ session, response }) => {
    session.onDetach = async () => {
      await Promise.resolve();
      response({ handled: false });
    };
  }, 1, 1);
  const uuid = '32da0000-4321-4321-9876-012345678901';
  const uuidResult = await check(({ response }) => response({
    url: `${origin}/api/bet/${uuid}`, handled: false, method: 'GET',
  }), 1, 1);
  assert.equal(uuidResult.httpErrors[0].pathname, '/api/bet/:id');
  assert.ok(!JSON.stringify(uuidResult).includes(uuid));
  const encodedResult = await check(({ response }) => response({
    url: `${origin}/api/bet/private-marker%2Fid/cash-back/operations/%55%55%49%44?private-marker`,
    handled: false, method: 'GET',
  }), 1, 1);
  assert.equal(encodedResult.httpErrors[0].pathname, '/api/bet/:id/cash-back/operations/:id');
  assert.ok(!JSON.stringify(encodedResult).includes('%55'));
  await check(({ session }) => session.emit('Log.entryAdded', {
    entry: {
      level: 'error', source: 'private-marker'.repeat(1000), text: resourceError(400),
      url: `${origin}/static/${'private-marker'.repeat(1000)}.js?private-marker`,
    },
  }), 1, 0);
  await check(({ session }) => {
    for (let index = 0; index < 1001; index += 1) {
      session.emit('Runtime.consoleAPICalled', { type: 'error' });
    }
  }, 128, 0, true);
  await check(({ session, response }) => {
    for (let index = 0; index < 128; index += 1) response();
    session.emit('Runtime.consoleAPICalled', { type: 'error' });
  }, 0, 0, true);
  await check(({ response }) => {
    for (let index = 0; index < 128; index += 1) response();
    response({ handled: false });
  }, 0, 0, true);
  await check(({ response }) => {
    for (let index = 0; index < 129; index += 1) {
      response({ handled: false, status: 200, log: false });
    }
  }, 0, 0, true);
}

async function browserCases() {
  const { chromium, expect } = require('../../../client/node_modules/@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of [
      'stale', 'version', 'overlap', 'identical-overlap', 'console', 'worker',
      'server-error', 'unexpected-selection', 'invalid-status',
    ]) {
      const reason = {
        version: 'Market version mismatch', 'unexpected-selection': 'Unexpected selection failure',
      }[scenario] ?? stale;
      let selected;
      const payload = {
        eventId: 'fixture', marketId: 'fixture:SECOND_HALF_SCORE',
        marketVersion: 1, quoteVersion: 1, selectionId: 'HOME',
      };
      const server = http.createServer((request, response) => {
        if (request.url === '/api/event/odds') {
          let body = '';
          request.on('data', (chunk) => { body += chunk; });
          request.on('end', () => {
            const quote = JSON.parse(body);
            const rejected = quote.quoteVersion === 1 || quote.eventId === 'unrelated';
            if (!rejected) selected = quote;
            setTimeout(() => {
              const status = scenario === 'invalid-status' ? 500 : 400;
              response.writeHead(rejected ? status : 200, { 'Content-Type': 'application/json' });
              response.end(JSON.stringify(rejected
                ? { errors: [{ message: quote.eventId === 'unrelated' ? 'Unexpected failure' : reason }] }
                : { selected: true }));
            }, quote.eventId === 'unrelated' ? 0 : 30);
          });
        } else if (request.url === '/api/slip/boards') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ LIVE: { rows: selected ? [selected] : [] } }));
        } else if (request.url === '/api/unexpected') {
          response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ message: 'private-marker' }));
        } else {
          response.writeHead(200, { 'Content-Type': 'text/html' });
          response.end(`<!doctype html><article aria-label="Fixture">
<section data-market-type="SECOND_HALF_SCORE">
<span class="event-market-meta">1</span><button aria-label="Select 1">Select</button>
</section></article><script>
const initial = ${JSON.stringify(payload)};
document.querySelector('button').onclick = async () => {
  const version = Number(document.querySelector('.event-market-meta').textContent);
  const selected = { ...initial, quoteVersion: version };
  const post = body => fetch('/api/event/odds', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(response => response.json());
  const requests = [post(selected)];
  if (version === 1 && '${scenario}' === 'overlap') requests.push(post({
    ...initial, eventId: 'unrelated'
  }));
  if (version === 1 && '${scenario}' === 'identical-overlap') requests.push(post(selected));
  await Promise.all(requests);
  document.querySelector('.event-market-meta').textContent = String(version + 1);
  document.querySelector('button').setAttribute('aria-label', 'Select ' + (version + 1));
};
</script>`);
        }
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const page = await browser.newPage({
        baseURL: `http://127.0.0.1:${server.address().port}`,
      });
      try {
        const helpers = load(expect);
        const finish = await helpers.createBrowserErrorAudit(page);
        const priorErrors = [];
        page.on('console', (message) => {
          if (message.type() === 'error') priorErrors.push(message.text());
        });
        await page.goto('/');
        const selection = helpers.selectLiveMarket({
          page, fixture: { eventId: 'fixture', name: 'Fixture' },
          marketType: 'SECOND_HALF_SCORE',
        });
        const selectionRejected = ['unexpected-selection', 'invalid-status'].includes(scenario);
        if (selectionRejected) await assert.rejects(selection, /Live selection fixture/);
        else await selection;
        if (scenario === 'console') {
          await page.evaluate((message) => console.error(message), resourceError(400));
        }
        if (scenario === 'worker') {
          await page.evaluate(() => new Promise((resolve) => {
            const url = URL.createObjectURL(new Blob([
              "console.error('Unexpected worker error'); postMessage('done');",
            ], { type: 'text/javascript' }));
            const worker = new Worker(url);
            worker.onmessage = () => {
              worker.terminate();
              URL.revokeObjectURL(url);
              resolve();
            };
          }));
        }
        if (scenario === 'server-error') {
          await page.evaluate(() => fetch('/api/unexpected').then(response => response.json()));
        }
        const result = await finish();
        assert.equal(result.overflow, false, scenario);
        assert.ok(priorErrors.length > 0, 'Original blanket assertion must reproduce red');
        const expectedConsole = {
          stale: 0, version: 0, overlap: 1, 'identical-overlap': 2, console: 1,
          worker: 1, 'server-error': 1, 'unexpected-selection': 1, 'invalid-status': 1,
        }[scenario];
        assert.equal(result.consoleErrors.length, expectedConsole, scenario);
        assert.equal(result.httpErrors.length, [
          'overlap', 'identical-overlap', 'server-error', 'unexpected-selection', 'invalid-status',
        ].includes(scenario) ? 1 : 0, scenario);
        assert.equal(result.handledSelectionErrors.length, selectionRejected ? 0 : 1, scenario);
        assert.ok(!JSON.stringify(result).includes('private-marker'));
        console.log(`native_browser_error_audit=PASS scenario=${scenario}`);
        cases += 1;
      } finally {
        await page.close();
        await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      }
    }
  } finally {
    await browser.close();
  }
}

(async () => {
  await unitCases();
  if (process.argv.includes('--browser')) await browserCases();
  console.log(`live_acceptance_error_audit=PASS cases=${cases}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
