/* global BigInt */
import { isTerminalBetStatus } from './liveBettingUtils';

export const CASH_BACK_POLL_MS = 2000;
export const CASH_BACK_RETRY_MS = 10000;
export const CASH_BACK_STORAGE_PREFIX = 'betstan.cash-back.v1:';
export const CASH_BACK_RECOVERY_ERROR = 'Saved cash-back recovery data could not be verified. Keep this browser data and refresh My Bets to check the slip. Do not start another cash back until the original operation is resolved.';

export const cashBackReason = (reason) => ({
  BET_NOT_CONFIRMED: 'Only a confirmed slip with open exposure can request cash back. Refresh My Bets.',
  SELECTION_RESOLVED: 'An original selection has already resolved. Cash back is no longer available for this slip.',
  PRE_MATCH_CUTOFF: 'The earliest kickoff has been reached. A pre-match slip cannot switch to live cash back.',
  MARKET_UNAVAILABLE: 'An exact selected market is unavailable or suspended. Request a new offer when it is available.',
  QUOTE_EXPIRED: 'This offer expired. Request a new offer and review it before confirming.',
  QUOTE_CHANGED: 'The offer changed. Request a new offer and explicitly confirm the new amounts.',
  STALE_REVISION: 'This slip changed, possibly in another tab. Refresh it and request a new offer.',
  INVALID_AMOUNT: 'Enter a stake of at least 0.01 Stanbucks in whole cents. A partial must leave at least 0.01.',
  LEGACY_PRECISION_UNSUPPORTED: 'This legacy wager cannot be represented in whole cents. Cash back is unavailable; the original wager is unchanged.',
  AUTHORITY_UNAVAILABLE: 'Current market authority could not be verified. No new offer is available. Try again later.',
  OPERATION_CONFLICT: 'This request conflicts with an existing operation. Check its status before requesting another offer.',
  RESERVATION_DENIED: 'A market update or another decision took priority. Refresh the slip before requesting a new offer.',
  AUTHENTICATION_REQUIRED: 'Your session could not be verified. Log in to the same account to recover this operation.',
  BET_NOT_FOUND: 'This slip is not available to your account. Refresh My Bets or log in to its owner account.',
  OPERATION_NOT_FOUND: 'The operation could not be found for this account. Retry its status with the same account; do not submit a different confirmation.',
  QUOTE_UNAVAILABLE: 'No confirmable offer is available for this operation. Check its status.',
  INVALID_REQUEST: 'The cash-back request could not be read. Refresh the page before trying again.',
  INVALID_CURSOR: 'This history page could not be read. Close and reopen cash-back history to start again.',
  CASH_BACK_UNAVAILABLE: 'Cash back is temporarily unavailable. Retry this same request to recover its status.',
}[reason] || 'Cash back could not be completed. Refresh the slip and check the operation status before trying again.');

// No binary rounding, clamping, exponent notation or implicit PARTIAL -> FULL conversion.
export const parseStakeMinor = (value) => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value) || value.length > 20) return null;
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  return minor >= BigInt(1) && minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
};

export const formatMinor = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) return 'Unavailable';
  const minor = BigInt(value);
  return `${minor / BigInt(100)}.${String(minor % BigInt(100)).padStart(2, '0')}`;
};

// Display-only potential return at ACCEPTED odds, never cash-back pricing.
export const possibleReturn = (stakeMinor, acceptedOdds) => {
  if (!Number.isSafeInteger(stakeMinor) || stakeMinor < 0 || !/^\d+(?:\.\d+)?$/.test(String(acceptedOdds))) return 'Unavailable';
  const [whole, fraction = ''] = String(acceptedOdds).split('.');
  const cents = BigInt(stakeMinor) * BigInt(whole + fraction) / (BigInt(10) ** BigInt(fraction.length));
  return `${cents / BigInt(100)}.${String(cents % BigInt(100)).padStart(2, '0')}`;
};

export const acceptedOddsForBet = (bet) => {
  let product = BigInt(1);
  let scale = 0;
  for (const row of bet.rows ?? []) {
    const text = String(row.oddsValue ?? 1); // Preserve the existing legacy history fallback.
    if (!/^\d+(?:\.\d+)?$/.test(text)) return '';
    const [whole, fraction = ''] = text.split('.');
    product *= BigInt(whole + fraction);
    scale += fraction.length;
  }
  const digits = String(product).padStart(scale + 1, '0');
  return scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
};

export const isPendingOperation = (operation) => (
  operation?.state === 'QUOTE_PENDING' || operation?.state === 'CONFIRM_PENDING'
);
export const isFinalOperation = (operation) => (
  ['ACCEPTED', 'REJECTED', 'UNAVAILABLE'].includes(operation?.state)
);

export const validFinancial = (value) => Boolean(value && [
  value.revision, value.originalStakeMinor, value.remainingStakeMinor,
  value.cumulativeClosedStakeMinor, value.cumulativeReturnMinor,
].every((amount) => Number.isSafeInteger(amount) && amount >= 0)
  && value.originalStakeMinor === value.remainingStakeMinor + value.cumulativeClosedStakeMinor
  && ['PENDING', 'CONFIRMED', 'DECLINED', 'WIN', 'LOSS', 'VOID', 'CASH_BACK'].includes(value.status)
  && (value.status !== 'CASH_BACK' || value.remainingStakeMinor === 0));

const referenceMatches = (reference, attempt) => reference
  && reference.clientOperationId === attempt.clientOperationId
  && reference.slipId === attempt.slipId
  && (!attempt.operationId || reference.operationId === attempt.operationId);

const validQuote = (quote, attempt) => Boolean(quote
  && referenceMatches(quote.operation, attempt)
  && typeof quote.quoteId === 'string' && quote.quoteId
  && (!attempt.confirmRequest || quote.quoteId === attempt.confirmRequest.quoteId)
  && quote.mode === attempt.quoteRequest.portion.mode
  && validFinancial(quote.financial) && quote.financial.status === 'CONFIRMED'
  && [quote.closedStakeMinor, quote.returnMinor].every((value) => Number.isSafeInteger(value) && value >= 1)
  && Number.isSafeInteger(quote.remainingStakeMinorAfter)
  && quote.closedStakeMinor + quote.remainingStakeMinorAfter === quote.financial.remainingStakeMinor
  && (quote.mode === 'FULL' ? quote.remainingStakeMinorAfter === 0
    : quote.remainingStakeMinorAfter >= 1 && quote.closedStakeMinor === attempt.quoteRequest.portion.stakeMinor)
  && typeof quote.acceptedCombinedOdds === 'string' && /^\d+(?:\.\d+)?$/.test(quote.acceptedCombinedOdds)
  && typeof quote.currentCombinedOdds === 'string' && /^\d+(?:\.\d+)?$/.test(quote.currentCombinedOdds)
  && Date.parse(quote.expiresAt) > Date.parse(quote.issuedAt)
  && Date.parse(quote.expiresAt) - Date.parse(quote.issuedAt) <= 7000);

export const validReceipt = (receipt, slipId) => Boolean(receipt
  && typeof receipt.decisionId === 'string' && receipt.decisionId
  && Number.isFinite(Date.parse(receipt.decisionTime)) && validFinancial(receipt.financial)
  && (receipt.outcome === 'ACCEPTED'
    ? receipt.mode === receipt.quote?.mode && validQuote(receipt.quote, {
      slipId, clientOperationId: receipt.quote?.operation?.clientOperationId,
      quoteRequest: { portion: { mode: receipt.mode, stakeMinor: receipt.quote?.closedStakeMinor } },
    })
      && receipt.financial.revision === receipt.quote.financial.revision + 1
      && receipt.financial.remainingStakeMinor === receipt.quote.remainingStakeMinorAfter
      && receipt.financial.cumulativeClosedStakeMinor === receipt.quote.financial.cumulativeClosedStakeMinor + receipt.quote.closedStakeMinor
      && receipt.financial.cumulativeReturnMinor === receipt.quote.financial.cumulativeReturnMinor + receipt.quote.returnMinor
      && receipt.financial.status === (receipt.mode === 'FULL' ? 'CASH_BACK' : 'CONFIRMED')
    : receipt.outcome === 'REJECTED' && receipt.operation?.slipId === slipId && typeof receipt.reason === 'string'));

export const readOperationResponse = (response, attempt, startedAt) => {
  const operation = response.data;
  if (!referenceMatches(operation, attempt)
    || typeof operation.operationId !== 'string' || !operation.operationId
    || !['QUOTE_PENDING', 'QUOTED', 'UNAVAILABLE', 'CONFIRM_PENDING', 'ACCEPTED', 'REJECTED'].includes(operation.state)
    || (response.status === 202 && !isPendingOperation(operation))
    || (operation.quote && !validQuote(operation.quote, { ...attempt, operationId: operation.operationId }))
    || (operation.state === 'QUOTED' && !operation.quote)
    || (['ACCEPTED', 'REJECTED'].includes(operation.state)
      && (!validReceipt(operation.receipt, attempt.slipId) || operation.receipt.outcome !== operation.state
        || !referenceMatches(operation.receipt.quote?.operation ?? operation.receipt.operation,
          { ...attempt, operationId: operation.operationId })
        || (attempt.confirmRequest && (operation.receipt.quote?.quoteId ?? operation.receipt.quoteId) !== attempt.confirmRequest.quoteId)))) {
    throw new Error('The server response could not be verified. Retry the same operation to check its status.');
  }
  const quote = operation.quote ?? operation.receipt?.quote;
  const receivedAt = Date.now();
  const serverDate = Date.parse(response.headers?.date);
  const expiresAt = Date.parse(quote?.expiresAt);
  // HTTP Date is second-granular. Use its conservative upper bound plus transit
  // time; never restart the seven-second lifetime on a poll or rerender.
  const deadline = Number.isFinite(serverDate)
    ? Math.min(expiresAt, receivedAt + expiresAt - serverDate - 1000 - (receivedAt - startedAt))
    : expiresAt;
  return { ...operation, deadline };
};

const mergeFinancial = (current, incoming) => {
  if (!validFinancial(incoming)) return current;
  if (!current) return incoming;
  if (incoming.revision <= current.revision || isTerminalBetStatus(current.status)) return current;
  return incoming;
};

const applyFinancial = (bet, incoming) => {
  const financial = mergeFinancial(bet.cashBackFinancial, incoming);
  if (!financial) return bet;
  return {
    ...bet,
    cashBackFinancial: financial,
    status: isTerminalBetStatus(bet.status) ? bet.status : financial.status,
  };
};

const mergeBet = (current, incoming) => {
  if (!current) return incoming;
  if (current.status === 'CASH_BACK') return current; // Rows/winner metadata stay immutable.
  const rows = (incoming.rows ?? current.rows ?? []).map((row) => {
    const old = current.rows?.find((entry) => (entry._id ?? entry.id) === (row._id ?? row.id));
    return old && ['WIN', 'LOSS', 'VOID'].includes(old.status) ? old : row;
  });
  return applyFinancial({
    ...current, ...incoming, rows,
    wager: current.wager,
    status: isTerminalBetStatus(current.status) ? current.status : incoming.status,
    cashBackFinancial: current.cashBackFinancial,
  }, incoming.cashBackFinancial);
};

export const initialMyBetsState = (ownerId) => ({ ownerId, bets: [], operations: {}, listSequence: 0 });

// REST lists, quote/decision responses and immutable history all obey the same
// invariant: financial revision only increases and terminal exposure never reopens.
export const myBetsReducer = (state, action) => {
  if (action.type === 'RESET') return initialMyBetsState(action.ownerId);
  if (action.ownerId !== state.ownerId) return state;
  if (action.type === 'LIST') {
    if (action.sequence < state.listSequence) return state;
    const bets = action.bets.map((bet) => {
      let merged = mergeBet(state.bets.find((old) => old.slipId === bet.slipId), bet);
      Object.values(state.operations).filter((op) => op.slipId === bet.slipId).forEach((op) => {
        merged = applyFinancial(merged, op.receipt?.financial ?? op.quote?.financial);
      });
      return merged;
    });
    return { ...state, bets, listSequence: action.sequence };
  }
  if (action.type === 'OPERATION') {
    const incoming = action.operation;
    const current = state.operations[incoming.clientOperationId];
    const rank = { QUOTE_PENDING: 0, QUOTED: 1, CONFIRM_PENDING: 2, UNAVAILABLE: 3, ACCEPTED: 3, REJECTED: 3 };
    if (current && (isFinalOperation(current) || rank[incoming.state] < rank[current.state])) return state;
    const operation = {
      ...incoming,
      deadline: Number.isFinite(current?.deadline) ? Math.min(current.deadline, incoming.deadline) : incoming.deadline,
    };
    return {
      ...state,
      operations: { ...state.operations, [incoming.clientOperationId]: operation },
      bets: state.bets.map((bet) => bet.slipId === incoming.slipId
        ? applyFinancial(bet, incoming.receipt?.financial ?? incoming.quote?.financial) : bet),
    };
  }
  if (action.type === 'HISTORY') {
    return {
      ...state,
      bets: state.bets.map((bet) => bet.slipId === action.slipId
        ? action.receipts.reduce((current, receipt) => applyFinancial(current, receipt.financial), bet) : bet),
    };
  }
  return state;
};

export const createCashBackId = () => {
  if (typeof window.crypto?.randomUUID === 'function') return window.crypto.randomUUID();
  if (!window.crypto?.getRandomValues) throw new Error('Secure request identities are unavailable. Use a supported browser.');
  return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const storageOwnerPrefix = (ownerId) => `${CASH_BACK_STORAGE_PREFIX}${encodeURIComponent(ownerId)}:`;
export const storageKey = (ownerId, attempt) => `${storageOwnerPrefix(ownerId)}${encodeURIComponent(attempt.clientOperationId)}`;

const recoveryIdentifier = (value) => typeof value === 'string'
  && value.length > 0 && value.length <= 256 && value.trim() === value;
const recoveryObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export const readCashBackAttempts = (ownerId) => {
  const attempts = {};
  const prefix = storageOwnerPrefix(ownerId);
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (!key?.startsWith(prefix)) continue;
    let item;
    try { item = JSON.parse(window.localStorage.getItem(key)); } catch { throw new Error(CASH_BACK_RECOVERY_ERROR); }
    if (!recoveryObject(item) || !recoveryIdentifier(item.slipId) || !recoveryIdentifier(item.clientOperationId)
      || key !== storageKey(ownerId, item)
      || (item.operationId !== undefined && !recoveryIdentifier(item.operationId))
      || (item.createdAt !== undefined && (!Number.isFinite(item.createdAt) || item.createdAt < 0))
      || !recoveryObject(item.quoteRequest) || item.quoteRequest.action !== 'QUOTE'
      || item.quoteRequest.clientOperationId !== item.clientOperationId
      || !recoveryObject(item.quoteRequest.portion)
      || !['FULL', 'PARTIAL'].includes(item.quoteRequest.portion?.mode)
      || (item.quoteRequest.portion.mode === 'PARTIAL'
        && (!Number.isSafeInteger(item.quoteRequest.portion.stakeMinor) || item.quoteRequest.portion.stakeMinor < 1))
      // Consent may recover only an already-established server operation, never
      // create a new quote and then treat stored content as its confirmation.
      || (item.confirmRequest !== undefined && (!recoveryIdentifier(item.operationId)
        || !recoveryObject(item.confirmRequest) || item.confirmRequest.action !== 'CONFIRM'
        || item.confirmRequest.clientOperationId !== item.clientOperationId || !recoveryIdentifier(item.confirmRequest.quoteId)))) {
      throw new Error(CASH_BACK_RECOVERY_ERROR);
    }
    // Reconstruct only allowlisted retry content, never replay extra stored fields.
    attempts[item.clientOperationId] = {
      slipId: item.slipId, clientOperationId: item.clientOperationId, createdAt: item.createdAt,
      ...(typeof item.operationId === 'string' ? { operationId: item.operationId } : {}),
      quoteRequest: {
        action: 'QUOTE', clientOperationId: item.clientOperationId,
        portion: item.quoteRequest.portion.mode === 'FULL' ? { mode: 'FULL' }
          : { mode: 'PARTIAL', stakeMinor: item.quoteRequest.portion.stakeMinor },
      },
      ...(item.confirmRequest ? { confirmRequest: {
        action: 'CONFIRM', clientOperationId: item.clientOperationId, quoteId: item.confirmRequest.quoteId,
      } } : {}),
    };
  }
  return attempts;
};
