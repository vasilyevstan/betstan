import {
  acceptedOddsForBet, cashBackReason, formatMinor, initialMyBetsState, myBetsReducer,
  parseStakeMinor, possibleReturn, readOperationResponse, readCashBackAttempts, storageKey,
} from './cashBackUtils';
import { accepted, bet, financial, quoted } from '../tests/fixtures/cashBack';

const request = { action: 'QUOTE', clientOperationId: 'first', portion: { mode: 'PARTIAL', stakeMinor: 4000 } };
const attempt = { slipId: 'slip-one', clientOperationId: 'first', quoteRequest: request };
const ownerId = 'owner';
const list = (bets, sequence = 1) => ({ type: 'LIST', ownerId, bets, sequence });

describe('cash-back exact display and fixed DTO boundary', () => {
  afterEach(() => localStorage.clear());
  it.each(['', '0', '0.001', '1.001', '-1', '1e2', ' 1', '1 ', '+1', 'Infinity', 'NaN', '1,01', '90071992547409.92'])(
    'refuses %p without rounding or converting it', (input) => expect(parseStakeMinor(input)).toBeNull(),
  );
  it.each([['0.01', 1], ['40.00', 4000], ['40', 4000], ['90071992547409.91', Number.MAX_SAFE_INTEGER]])(
    'parses %p exactly', (input, minor) => expect(parseStakeMinor(input)).toBe(minor),
  );
  it('formats exact cents and uses accepted odds only for possible remainder return', () => {
    expect(formatMinor(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
    expect(possibleReturn(6000, '3')).toBe('180.00');
    expect(possibleReturn(1, '1.5')).toBe('0.01');
    expect(acceptedOddsForBet(bet({ rows: [{ oddsValue: 1.2 }, { oddsValue: 2.5 }] }))).toBe('3.00');
  });
  it('never gives a rerender/poll a fresh quote lifetime and conservatively accounts for HTTP Date', () => {
    const start = Date.now();
    const dto = quoted(request, { now: start, lifetime: 1000 });
    const operation = readOperationResponse({ status: 200, data: dto }, attempt, start);
    expect(operation.deadline).toBe(start + 1000);
    const bound = readOperationResponse({ status: 200, data: dto, headers: { date: new Date(start + 500).toUTCString() } }, attempt, start);
    expect(bound.deadline).toBeLessThanOrEqual(operation.deadline);
  });
  it('refuses success-shaped 202 and accepted-without-receipt bodies', () => {
    const dto = accepted(quoted(request));
    expect(() => readOperationResponse({ status: 202, data: dto }, attempt, Date.now())).toThrow('could not be verified');
    expect(() => readOperationResponse({ status: 200, data: { ...dto, receipt: null } }, attempt, Date.now())).toThrow();
  });
  it('rejects wrong slip/client/amount DTOs and maps unknown reasons to actionable copy', () => {
    const dto = quoted(request);
    for (const changed of [{ slipId: 'other' }, { clientOperationId: 'other' }, { quote: { ...dto.quote, closedStakeMinor: 4001 } }]) {
      expect(() => readOperationResponse({ status: 200, data: { ...dto, ...changed } }, attempt, Date.now())).toThrow();
    }
    expect(cashBackReason('NEW_REASON')).toContain('check the operation status');
  });
  it('isolates recovery by owner and allowlists exact request content', () => {
    localStorage.clear();
    localStorage.setItem(storageKey('owner', attempt), JSON.stringify({ ...attempt, extra: 'not-replayed' }));
    expect(readCashBackAttempts('other')).toEqual({});
    expect(readCashBackAttempts('owner').first).toEqual(expect.objectContaining(attempt));
    expect(readCashBackAttempts('owner').first.extra).toBeUndefined();
    localStorage.clear();
  });
  it.each([
    ['confirmation without a server operation', { operationId: undefined }],
    ['empty server operation', { operationId: '' }],
    ['malformed server operation', { operationId: {} }],
    ['empty slip identity', { slipId: '' }],
    ['null confirmation', { confirmRequest: null }],
    ['empty quote identity', { confirmRequest: { action: 'CONFIRM', clientOperationId: 'first', quoteId: '' } }],
    ['mismatched confirmation identity', { confirmRequest: { action: 'CONFIRM', clientOperationId: 'another', quoteId: 'reviewed-token' } }],
  ])('rejects %s in untrusted recovery data', (_, changes) => {
    const record = { ...attempt, operationId: 'server-operation',
      confirmRequest: { action: 'CONFIRM', clientOperationId: 'first', quoteId: 'reviewed-token' }, ...changes };
    localStorage.setItem(storageKey(ownerId, attempt), JSON.stringify(record));
    expect(() => readCashBackAttempts(ownerId)).toThrow('Saved cash-back recovery data');
  });
  it('binds saved content to its owner-scoped storage key', () => {
    localStorage.setItem(storageKey(ownerId, { clientOperationId: 'another' }), JSON.stringify(attempt));
    expect(() => readCashBackAttempts(ownerId)).toThrow('Saved cash-back recovery data');
  });
  it('does not substitute a newly returned quote identity for saved consent', () => {
    const dto = quoted(request);
    const saved = { ...attempt, operationId: dto.operationId,
      confirmRequest: { action: 'CONFIRM', clientOperationId: request.clientOperationId, quoteId: 'different-reviewed-token' } };
    expect(() => readOperationResponse({ status: 200, data: dto }, saved, Date.now())).toThrow('could not be verified');
  });
});

describe('one monotonic My Bets reducer', () => {
  it('keeps late receipts discoverable without rewinding settled remaining principal or row winners', () => {
    let state = myBetsReducer(initialMyBetsState(ownerId), list([bet()]));
    const partial = accepted(quoted(request));
    state = myBetsReducer(state, list([bet({
      status: 'WIN',
      cashBackFinancial: { ...partial.receipt.financial, revision: 3, status: 'WIN' },
      rows: [{ ...bet().rows[0], status: 'WIN', winningSelection: 'Northern Falcons' }],
    })], 3));
    state = myBetsReducer(state, { type: 'OPERATION', ownerId, operation: partial });
    state = myBetsReducer(state, list([bet()], 2));
    state = myBetsReducer(state, list([bet()], 4));
    expect(state.bets[0].status).toBe('WIN');
    expect(state.bets[0].cashBackFinancial.revision).toBe(3);
    expect(state.bets[0].cashBackFinancial.remainingStakeMinor).toBe(6000);
    expect(state.bets[0].rows[0].winningSelection).toBe('Northern Falcons');
    expect(state.operations.first.receipt).toEqual(partial.receipt);
  });
  it('does not regress a terminal operation or full cash back from late list/quote/history responses', () => {
    const fullRequest = { ...request, portion: { mode: 'FULL' } };
    const offer = quoted(fullRequest);
    const full = accepted(offer);
    let state = myBetsReducer(initialMyBetsState(ownerId), list([bet()]));
    state = myBetsReducer(state, { type: 'OPERATION', ownerId, operation: full });
    state = myBetsReducer(state, { type: 'OPERATION', ownerId, operation: offer });
    state = myBetsReducer(state, list([bet({ status: 'LOSS', rows: [{ ...bet().rows[0], status: 'LOSS', winningSelection: 'Other' }] })], 2));
    state = myBetsReducer(state, { type: 'HISTORY', ownerId, slipId: 'slip-one', receipts: [{ financial: financial() }] });
    expect(state.bets[0].status).toBe('CASH_BACK');
    expect(state.bets[0].rows).toEqual(bet().rows);
    expect(state.operations.first.state).toBe('ACCEPTED');
  });
  it('retains receipt-before-list evidence and rejects results belonging to a previous account', () => {
    const portion = accepted(quoted(request));
    let state = myBetsReducer(initialMyBetsState(ownerId), { type: 'OPERATION', ownerId, operation: portion });
    state = myBetsReducer(state, list([bet()]));
    expect(state.bets[0].cashBackFinancial.remainingStakeMinor).toBe(6000);
    state = myBetsReducer(state, { type: 'RESET', ownerId: 'other' });
    expect(myBetsReducer(state, list([bet()])).bets).toEqual([]);
  });
});
