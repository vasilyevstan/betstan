import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  cashBackReason, formatMinor, isFinalOperation, parseStakeMinor, possibleReturn, validReceipt,
} from '../../cashBackUtils';
import { formatLegacyLiveSelectionLabel, formatLiveMarketType } from '../../liveBettingUtils';

const displayTime = (value) => new Date(value).toLocaleString();
const nominal = (value) => `${formatMinor(value)} Stanbucks`;
const mergeReceipts = (current, incoming) => Array.from(
  new Map([...current, ...incoming].map((receipt) => [receipt.decisionId, receipt])).values(),
).sort((left, right) => Date.parse(right.decisionTime) - Date.parse(left.decisionTime));

const CashBackHistory = ({ slipId, ownerId, receipt, revision, onHistory, onAuthFailure }) => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState({ loading: false, error: '' });
  const active = useRef(null);
  const loadedRevision = useRef(null);
  const currentRevision = useRef(revision);
  const wasOpen = useRef(false);
  currentRevision.current = revision;
  const historyId = useId();
  const owner = useRef(ownerId);
  owner.current = ownerId;

  useEffect(() => () => active.current?.abort(), [ownerId, slipId]);
  useEffect(() => {
    if (receipt?.outcome === 'ACCEPTED') setItems((old) => mergeReceipts(old, [receipt]));
  }, [receipt]);

  const load = useCallback(async (nextCursor = null) => {
    if (active.current) return;
    const controller = new AbortController();
    const requestedOwner = ownerId;
    const requestedRevision = currentRevision.current ?? 0;
    active.current = controller;
    setStatus({ loading: true, error: '' });
    try {
      const response = await axios.get(`/api/bet/${encodeURIComponent(slipId)}/cash-back/history${nextCursor ? `?cursor=${encodeURIComponent(nextCursor)}` : ''}`,
        { signal: controller.signal, timeout: 10000 });
      if (controller.signal.aborted || requestedOwner !== owner.current) return;
      const page = response.data;
      if (!Array.isArray(page?.items) || page.items.length > 20
        || !(page.nextCursor === null || typeof page.nextCursor === 'string')
        || page.items.some((item) => item.outcome !== 'ACCEPTED' || !validReceipt(item, slipId))) {
        throw new Error('Cash-back history could not be verified. Try loading it again.');
      }
      setItems((old) => mergeReceipts(old, page.items));
      loadedRevision.current = Math.max(requestedRevision, ...page.items.map((item) => item.financial.revision));
      setCursor(page.nextCursor);
      setLoaded(true);
      setStatus({ loading: false, error: '' });
      onHistory(slipId, page.items);
    } catch (error) {
      if (controller.signal.aborted || requestedOwner !== owner.current) return;
      if ([401, 403].includes(error?.response?.status)) { onAuthFailure(); return; }
      const reason = error?.response?.data?.errors?.[0]?.code;
      setStatus({ loading: false, error: reason ? cashBackReason(reason)
        : 'Cash-back history could not be loaded. Check your connection and retry this page.' });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }, [ownerId, slipId, onHistory, onAuthFailure]);

  useEffect(() => {
    // A new authoritative revision may add a receipt while history is open.
    // Refresh one bounded first page, never pretend a cached page is complete.
    const opening = open && !wasOpen.current;
    wasOpen.current = open;
    if (open && (opening || (!status.loading && !status.error
      && loadedRevision.current !== null && revision > loadedRevision.current))) void load();
  }, [open, revision, load, status.loading, status.error]);

  return <div className={`cash-back-history${open ? ' cash-back-history--open' : ''}`}>
    <button type="button" className="btn btn-shell my-bets-expand cash-back-control"
      aria-expanded={open} aria-controls={historyId}
      onClick={() => {
        setOpen(!open);
        if (!open) setCursor(null);
      }}>
      {open ? 'Hide cash-back history' : 'Cash-back history'}
    </button>
    {open ? <div id={historyId} className="cash-back-history__body">
      <h4 className="h6">Recorded cash back</h4>
      <p className="cash-back-help">Immutable accepted portions, newest first. Original selections and wager are unchanged.</p>
      {status.loading ? <p role="status">Loading cash-back history…</p> : null}
      {status.error ? <p role="alert" className="cash-back-error">{status.error}</p> : null}
      {items.length ? <ol className="cash-back-receipts">
        {items.map((item) => <li key={item.decisionId}>
          <strong>{item.mode === 'FULL' ? 'Full cash back' : 'Partial cash back'}</strong>
          <time dateTime={item.decisionTime}>{displayTime(item.decisionTime)}</time>
          <dl className="cash-back-values">
            <div><dt>Closed principal</dt><dd>{nominal(item.quote.closedStakeMinor)}</dd></div>
            <div><dt>Recorded nominal return</dt><dd>{nominal(item.quote.returnMinor)}</dd></div>
          </dl>
        </li>)}
      </ol> : loaded && !status.error ? <p>No accepted cash back has been recorded.</p> : null}
      {loaded ? <p className="cash-back-help">
        {items.length} receipt{items.length === 1 ? '' : 's'} loaded.
        {cursor ? ' Earlier receipts are available.' : ' End of available history.'}
      </p> : null}
      {status.error || cursor ? <button type="button" className="btn btn-shell cash-back-control"
        disabled={status.loading} onClick={() => void load(cursor)}>
        {status.error ? 'Retry history page' : 'Load earlier receipts'}
      </button> : null}
    </div> : null}
  </div>;
};

export const emptyCashBackDraft = {
  mode: 'FULL', amount: '', selectedId: null, edited: false, validation: '', initialized: false,
};

const CashBackPanel = ({ bet, ownerId, model, draft, onDraftChange }) => {
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const { mode, amount, selectedId, edited, validation, initialized } = draft;
  const setDraft = useCallback((update) => onDraftChange(bet.slipId, update), [bet.slipId, onDraftChange]);
  const [now, setNow] = useState(Date.now());
  const [expiredDetailsOpen, setExpiredDetailsOpen] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const requestRef = useRef(null);
  const statusRef = useRef(null);
  const focusedAction = useRef(null);
  const candidates = Object.values(model.attempts).filter((attempt) => attempt.slipId === bet.slipId)
    .sort((left, right) => right.createdAt - left.createdAt);
  const attempt = model.attempts[selectedId] ?? candidates[0];
  const operation = model.operations[attempt?.clientOperationId];
  const latestReceipt = Object.values(model.operations)
    .filter((entry) => entry.slipId === bet.slipId && entry.receipt?.outcome === 'ACCEPTED')
    .sort((left, right) => right.receipt.financial.revision - left.receipt.financial.revision)[0]?.receipt;
  const pendingAttempt = candidates.find((candidate) => candidate.confirmRequest
    && !isFinalOperation(model.operations[candidate.clientOperationId]));
  const pendingConfirm = Boolean(pendingAttempt);
  // A selected draft is not evidence about another tab's submitted operation.
  const displayedOperation = pendingConfirm ? model.operations[pendingAttempt.clientOperationId] : operation;
  const quote = displayedOperation?.quote ?? displayedOperation?.receipt?.quote;
  const terminal = isFinalOperation(displayedOperation);
  const retryAttempt = pendingAttempt ?? attempt;
  const network = model.network[retryAttempt?.clientOperationId];
  const gettingOffer = Boolean(attempt && !terminal && !network?.invalidOffer
    && (!operation || operation.state === 'QUOTE_PENDING'));
  const locked = pendingConfirm || gettingOffer;
  const expired = !pendingConfirm && !terminal && quote && now >= displayedOperation.deadline;
  const changed = Boolean(!pendingConfirm && quote && (edited || network?.invalidOffer || bet.status !== 'CONFIRMED'
    || (bet.cashBackFinancial && bet.cashBackFinancial.revision !== quote.financial.revision)));
  const canConfirm = Boolean(quote && operation?.state === 'QUOTED'
    && initialized && selectedId === attempt?.clientOperationId
    && !expired && !changed && !locked && !network?.busy && !model.storageError);
  const showForm = bet.status === 'CONFIRMED' || (mode === 'PARTIAL' && inputFocused) || pendingConfirm;

  useEffect(() => {
    if (attempt && !initialized) {
      setDraft((old) => ({ ...old, initialized: true, selectedId: attempt.clientOperationId,
        ...(!old.edited ? {
          mode: attempt.quoteRequest.portion.mode,
          amount: attempt.quoteRequest.portion.mode === 'PARTIAL' ? formatMinor(attempt.quoteRequest.portion.stakeMinor) : old.amount,
        } : {}),
      }));
    }
  }, [attempt, initialized, setDraft]);

  useEffect(() => {
    if (!quote || terminal || pendingConfirm) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [quote, terminal, pendingConfirm]);

  const getOffer = () => {
    const stakeMinor = mode === 'PARTIAL' ? parseStakeMinor(amount) : null;
    const remaining = bet.cashBackFinancial?.remainingStakeMinor ?? parseStakeMinor(String(bet.wager));
    if (mode === 'PARTIAL' && (stakeMinor === null || (remaining !== null && stakeMinor >= remaining))) {
      setDraft((old) => ({ ...old, validation: cashBackReason('INVALID_AMOUNT') }));
      return;
    }
    const id = model.requestQuote(bet.slipId, mode === 'FULL' ? { mode: 'FULL' } : { mode: 'PARTIAL', stakeMinor });
    if (id) {
      setDraft((old) => ({ ...old, initialized: true, selectedId: id, edited: false, validation: '' }));
      setExpiredDetailsOpen(false);
    }
  };

  let message = '';
  if (pendingConfirm) message = 'Confirmation pending. Waiting for a durable decision, even after offer expiry.';
  else if (displayedOperation?.state === 'ACCEPTED') message = 'Cash back recorded. See the receipt in cash-back history.';
  else if (displayedOperation?.state === 'REJECTED') message = `Cash back rejected. ${cashBackReason(displayedOperation.receipt.reason)}`;
  else if (displayedOperation?.state === 'UNAVAILABLE') message = `Cash back unavailable. ${cashBackReason(displayedOperation.reason)}`;
  else if (gettingOffer) message = 'Getting an offer. Availability is being checked by the server.';
  else if (expired) message = cashBackReason('QUOTE_EXPIRED');
  else if (changed) message = 'This offer is no longer current. Review a new offer before confirming; your entered amount has not been changed.';
  const error = validation || model.actionErrors[bet.slipId] || network?.error;
  const reviewVisible = quote && !terminal && !expired && !pendingConfirm;
  useLayoutEffect(() => {
    if (focusedAction.current && !document.contains(focusedAction.current)
      && document.activeElement === document.body) {
      const target = pendingConfirm || requestRef.current?.disabled ? statusRef.current : requestRef.current ?? statusRef.current;
      target?.focus();
      focusedAction.current = null;
    }
  }, [reviewVisible, pendingConfirm, expired, showForm]);

  return <section className="cash-back" aria-label={`Cash back for ${bet.rows?.map((row) => row.eventName).join(', ') || 'this slip'}`}>
    <div className="cash-back-strip">
    <h3 className="h6">Cash back</h3>
    {showForm ? <>
      <div className="cash-back-editor" hidden={expired && !edited && !expiredDetailsOpen && !inputFocused}>
      <div role="group" aria-label="Cash-back mode" className="cash-back-actions" aria-describedby={helpId}>
        <button type="button" aria-pressed={mode === 'FULL'}
          className={`btn cash-back-control ${mode === 'FULL' ? 'btn-primary' : 'btn-shell'}`}
          aria-disabled={pendingConfirm || bet.status !== 'CONFIRMED'}
          onClick={() => { if (!pendingConfirm && bet.status === 'CONFIRMED') setDraft((old) => ({ ...old, mode: 'FULL', edited: true, validation: '' })); }}>
          {mode === 'FULL' ? <span aria-hidden="true">✓ </span> : null}Full remainder</button>
        <button type="button" aria-pressed={mode === 'PARTIAL'}
          className={`btn cash-back-control ${mode === 'PARTIAL' ? 'btn-primary' : 'btn-shell'}`}
          aria-disabled={pendingConfirm || bet.status !== 'CONFIRMED'}
          onClick={() => { if (!pendingConfirm && bet.status === 'CONFIRMED') setDraft((old) => ({ ...old, mode: 'PARTIAL', edited: true, validation: '' })); }}>
          {mode === 'PARTIAL' ? <span aria-hidden="true">✓ </span> : null}Partial stake</button>
      </div>
      {mode === 'PARTIAL' ? <div className="cash-back-amount">
        <label htmlFor={inputId}>Stake to close (Stanbucks)</label>
        <input id={inputId} type="number" step="0.01" min="0.01" inputMode="decimal"
          className="form-control cash-back-control" value={amount}
          readOnly={pendingConfirm || bet.status !== 'CONFIRMED'}
          aria-invalid={Boolean(validation)} aria-describedby={`${helpId}${error ? ` ${errorId}` : ''}`}
          onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
          onChange={(event) => {
            const value = event.target.value;
            setDraft((old) => ({ ...old, amount: value, edited: true, validation: '' }));
          }} />
      </div> : null}
      </div>
      <div className="cash-back-actions">
        <button ref={requestRef} type="button" className="btn btn-shell cash-back-control"
          disabled={bet.status !== 'CONFIRMED' || Boolean(model.storageError)} aria-disabled={locked}
          aria-describedby={error ? errorId : helpId}
          onFocus={(event) => { focusedAction.current = event.currentTarget; }}
          onKeyDown={(event) => { if (event.repeat && ['Enter', ' '].includes(event.key)) event.preventDefault(); }}
          onClick={(event) => { if (!locked && event.detail < 2) getOffer(); }}>
          {attempt ? 'Get new offer' : 'Get cash-back offer'}
        </button>
        {pendingAttempt || (attempt && !terminal && (locked || network?.error)) ? <button type="button"
          className="btn btn-shell cash-back-control" aria-disabled={Boolean(network?.busy)}
          onClick={() => { if (!network?.busy) model.retry(retryAttempt.clientOperationId); }}>
          {pendingConfirm ? 'Check confirmation status' : 'Retry same offer request'}
        </button> : null}
      </div>
    </> : null}
    </div>
    {message ? <p ref={statusRef} tabIndex={-1} role={['ACCEPTED', 'REJECTED'].includes(displayedOperation?.state) ? undefined : 'status'}
      className={`cash-back-message${displayedOperation?.state === 'REJECTED' ? ' cash-back-error' : ''}`}>{message}</p> : null}
    {error ? <p id={errorId} role="alert" className="cash-back-error">{error}</p> : null}
    {pendingConfirm && quote ? <p className="cash-back-pending-values">
      Submitted {quote.mode === 'FULL' ? 'full' : 'partial'} cash back: {nominal(quote.closedStakeMinor)} to close · Quoted nominal return {nominal(quote.returnMinor)} · Remaining stake after cash back {nominal(quote.remainingStakeMinorAfter)}.
    </p> : null}
    {pendingConfirm && pendingAttempt.clientOperationId !== attempt?.clientOperationId ? <p className="cash-back-help">
      Your entered draft is paused. The submitted confirmation above is a different operation; your draft amount has not changed.
    </p> : null}
    {reviewVisible || expired ? <div className={expired ? 'cash-back-expired' : 'cash-back-offer'}>
      {expired ? <button type="button" className="btn btn-shell cash-back-control"
        aria-expanded={expiredDetailsOpen} aria-controls={`${helpId}-expired`}
        onClick={() => setExpiredDetailsOpen(!expiredDetailsOpen)}>Expired offer details</button> : null}
      <div id={expired ? `${helpId}-expired` : undefined} hidden={expired && !expiredDetailsOpen}>
      <h4 className="h6">{expired ? 'Expired offer' : 'Offer to review'} — {quote.mode === 'FULL' ? 'Full cash back' : 'Partial cash back'}</h4>
      <dl className="cash-back-values cash-back-review-values">
        <div><dt>Stake to close</dt><dd>{nominal(quote.closedStakeMinor)}</dd></div>
        <div><dt>Quoted nominal return</dt><dd>{nominal(quote.returnMinor)}</dd></div>
        <div><dt>Remaining stake after cash back</dt><dd>{nominal(quote.remainingStakeMinorAfter)}</dd></div>
      </dl>
      <details className="cash-back-review-context">
        <summary className="cash-back-control">Original selections, wager and odds</summary>
      <ul className="cash-back-selections" aria-label="All original selections for this offer">
        {(bet.rows ?? []).map((row) => <li key={row._id ?? row.id}>
          {row.eventName} · {row.productName || formatLiveMarketType(row.marketType)} · {formatLegacyLiveSelectionLabel(row.oddsName, row, 'selected')} · Accepted odds {row.oddsValue}
        </li>)}
      </ul>
      <dl className="cash-back-values">
        <div><dt>Original wager</dt><dd>{nominal(quote.financial.originalStakeMinor)}</dd></div>
        <div><dt>Accepted total odds</dt><dd>{quote.acceptedCombinedOdds}</dd></div>
        <div><dt>Possible return on remaining stake</dt><dd>{possibleReturn(quote.remainingStakeMinorAfter, quote.acceptedCombinedOdds)} Stanbucks</dd></div>
      </dl>
      </details>
      {!expired ? <p className="cash-back-help">
        Offer expires at <time dateTime={quote.expiresAt}>{displayTime(quote.expiresAt)}</time>.
        {' '}{Math.max(0, Math.ceil((displayedOperation.deadline - now) / 1000))}s remaining (informational, not a guarantee of availability).
      </p> : null}
      {!expired ? <button type="button" className="btn btn-primary cash-back-control" disabled={!canConfirm}
        onFocus={(event) => { focusedAction.current = event.currentTarget; }}
        onKeyDown={(event) => { if (event.repeat && ['Enter', ' '].includes(event.key)) event.preventDefault(); }}
        onClick={(event) => { if (event.detail < 2) model.confirm(attempt.clientOperationId); }}>
        {quote.mode === 'FULL' ? 'Confirm full cash back' : 'Confirm partial cash back'}
      </button> : null}
      </div>
    </div> : null}
    {reviewVisible || (mode === 'PARTIAL' && !expired && showForm) ? <p id={helpId} className="cash-back-help">
      Nominal Stanbucks only (0.01 precision). {mode === 'PARTIAL' ? 'A partial must leave at least 0.01 Stanbucks. ' : ''}
      {reviewVisible ? 'Nothing is recorded until you explicitly confirm and the server accepts.' : 'The server checks each offer; a confirmed bet does not guarantee availability.'}
    </p> : <span id={helpId} className="visually-hidden">The server checks each offer; a confirmed bet does not guarantee availability.</span>}
    <CashBackHistory slipId={bet.slipId} ownerId={ownerId} receipt={latestReceipt} revision={bet.cashBackFinancial?.revision}
      onHistory={model.applyHistory} onAuthFailure={model.revoke} />
  </section>;
};

export default CashBackPanel;
