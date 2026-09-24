// Source-aligned public DTO fixtures: bet/src/route/CashBack.ts and
// CashBackFacade.ts publicQuote/publicReceipt/cashBackOperationDto/history.
// Deliberately no internal ownership proofs, grants, fingerprints or source IDs.
const { createHash } = require('crypto');

const financial = (overrides = {}) => ({
  revision: 1, status: 'CONFIRMED', originalStakeMinor: 10000,
  remainingStakeMinor: 10000, cumulativeClosedStakeMinor: 0, cumulativeReturnMinor: 0,
  ...overrides,
});

const bet = (overrides = {}) => ({
  _id: 'bet-one', slipId: 'slip-one', betKind: 'PRE_MATCH', status: 'CONFIRMED', wager: 100,
  timestamp: '2026-09-24T12:00:00.000Z',
  cashBackFinancial: financial(),
  rows: [{
    _id: 'row-one', eventId: 'event-one', productId: 'product-one', oddsId: 'odds-one',
    eventName: 'Northern Falcons - Southern Owls', productName: '1X2',
    oddsName: 'Northern Falcons', oddsValue: 3, status: 'NOT_SETTLED',
    eventTime: '2030-01-01T12:00:00.000Z',
  }],
  ...overrides,
});

const quoted = (request, options = {}) => {
  const before = options.financial ?? financial();
  const now = options.now ?? Date.now();
  const operation = {
    operationId: createHash('sha256').update(request.clientOperationId).digest('hex'),
    clientOperationId: request.clientOperationId, slipId: options.slipId ?? 'slip-one', betKind: options.betKind ?? 'PRE_MATCH',
  };
  const closed = request.portion.mode === 'FULL' ? before.remainingStakeMinor : request.portion.stakeMinor;
  return {
    ...operation, state: 'QUOTED',
    quote: {
      operation, quoteId: `quote-${request.clientOperationId}`, mode: request.portion.mode,
      policyVersion: 'cash-back-v1', issuer: 'RESULTING',
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + (options.lifetime ?? 7000)).toISOString(),
      financial: before, closedStakeMinor: closed, remainingStakeMinorAfter: before.remainingStakeMinor - closed,
      returnMinor: options.returnMinor ?? Math.floor(closed / 2),
      acceptedCombinedOdds: '3', currentCombinedOdds: '6',
    },
  };
};

const accepted = (operation) => {
  const quote = operation.quote;
  return {
    ...operation, state: 'ACCEPTED',
    receipt: {
      outcome: 'ACCEPTED', decisionId: `decision-${operation.clientOperationId}`,
      decisionTime: new Date(Date.parse(quote.issuedAt) + 1).toISOString(), mode: quote.mode, quote,
      financial: {
        ...quote.financial, revision: quote.financial.revision + 1,
        status: quote.mode === 'FULL' ? 'CASH_BACK' : 'CONFIRMED',
        remainingStakeMinor: quote.remainingStakeMinorAfter,
        cumulativeClosedStakeMinor: quote.financial.cumulativeClosedStakeMinor + quote.closedStakeMinor,
        cumulativeReturnMinor: quote.financial.cumulativeReturnMinor + quote.returnMinor,
      },
    },
  };
};

const rejected = (operation, reason = 'QUOTE_CHANGED', after = {}) => ({
  ...operation, state: 'REJECTED',
  receipt: {
    outcome: 'REJECTED', decisionId: `rejection-${operation.clientOperationId}`,
    decisionTime: new Date(Date.parse(operation.quote.issuedAt) + 1).toISOString(),
    operation: operation.quote.operation, quoteId: operation.quote.quoteId,
    expectedRevision: operation.quote.financial.revision, reason,
    financial: { ...operation.quote.financial, revision: operation.quote.financial.revision + 1, ...after },
  },
});

module.exports = { financial, bet, quoted, accepted, rejected };
