import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
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

  return <div className="cash-back-history">
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

const CashBackPanel = ({ bet, ownerId, model }) => {
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const [mode, setMode] = useState('FULL');
  const [amount, setAmount] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const [edited, setEdited] = useState(false);
  const [validation, setValidation] = useState('');
  const [now, setNow] = useState(Date.now());
  const initialized = useRef(false);
  const candidates = Object.values(model.attempts).filter((attempt) => attempt.slipId === bet.slipId)
    .sort((left, right) => right.createdAt - left.createdAt);
  const attempt = model.attempts[selectedId] ?? candidates[0];
  const operation = model.operations[attempt?.clientOperationId];
  const latestReceipt = Object.values(model.operations)
    .filter((entry) => entry.slipId === bet.slipId && entry.receipt?.outcome === 'ACCEPTED')
    .sort((left, right) => right.receipt.financial.revision - left.receipt.financial.revision)[0]?.receipt;
  const quote = operation?.quote ?? operation?.receipt?.quote;
  const terminal = isFinalOperation(operation);
  const pendingAttempt = candidates.find((candidate) => candidate.confirmRequest
    && !isFinalOperation(model.operations[candidate.clientOperationId]));
  const pendingConfirm = Boolean(pendingAttempt);
  const retryAttempt = pendingAttempt ?? attempt;
  const network = model.network[retryAttempt?.clientOperationId];
  const gettingOffer = Boolean(attempt && !terminal && !network?.invalidOffer
    && (!operation || operation.state === 'QUOTE_PENDING'));
  const locked = pendingConfirm || gettingOffer;
  const expired = quote && now >= operation.deadline;
  const changed = Boolean(quote && (edited || network?.invalidOffer || bet.status !== 'CONFIRMED'
    || (bet.cashBackFinancial && bet.cashBackFinancial.revision !== quote.financial.revision)));
  const canConfirm = Boolean(quote && operation.state === 'QUOTED'
    && !expired && !changed && !locked && !network?.busy && !model.storageError);
  const showForm = bet.status === 'CONFIRMED' || attempt;

  useEffect(() => {
    if (attempt && !initialized.current) {
      initialized.current = true;
      setSelectedId(attempt.clientOperationId);
      if (!edited) {
        setMode(attempt.quoteRequest.portion.mode);
        if (attempt.quoteRequest.portion.mode === 'PARTIAL') setAmount(formatMinor(attempt.quoteRequest.portion.stakeMinor));
      }
    }
  }, [attempt, edited]);

  useEffect(() => {
    if (!quote || terminal) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [quote, terminal]);

  const edit = () => {
    setEdited(true);
    setValidation('');
  };
  const getOffer = () => {
    const stakeMinor = mode === 'PARTIAL' ? parseStakeMinor(amount) : null;
    const remaining = bet.cashBackFinancial?.remainingStakeMinor ?? parseStakeMinor(String(bet.wager));
    if (mode === 'PARTIAL' && (stakeMinor === null || (remaining !== null && stakeMinor >= remaining))) {
      setValidation(cashBackReason('INVALID_AMOUNT'));
      return;
    }
    const id = model.requestQuote(bet.slipId, mode === 'FULL' ? { mode: 'FULL' } : { mode: 'PARTIAL', stakeMinor });
    if (id) {
      initialized.current = true;
      setSelectedId(id);
      setEdited(false);
      setValidation('');
    }
  };

  let message = '';
  if (pendingConfirm) message = 'Confirmation pending. Waiting for a durable decision; this slip cannot start another cash back, even if the displayed offer expires.';
  else if (operation?.state === 'ACCEPTED') message = 'Cash back recorded. The receipt below is authoritative.';
  else if (operation?.state === 'REJECTED') message = `Cash back rejected. ${cashBackReason(operation.receipt.reason)}`;
  else if (operation?.state === 'UNAVAILABLE') message = `Cash back unavailable. ${cashBackReason(operation.reason)}`;
  else if (gettingOffer) message = 'Getting an offer. Availability is being checked by the server.';
  else if (changed) message = 'This offer is no longer current. Review a new offer before confirming; your entered amount has not been changed.';
  else if (expired) message = cashBackReason('QUOTE_EXPIRED');
  else if (quote) message = 'Offer ready to review. Nothing is recorded until you explicitly confirm and the server accepts.';
  const error = validation || model.actionErrors[bet.slipId] || network?.error;

  return <section className="cash-back" aria-label={`Cash back for ${bet.rows?.map((row) => row.eventName).join(', ') || 'this slip'}`}>
    <h3 className="h6">Cash back</h3>
    {showForm ? <>
      <p id={helpId} className="cash-back-help">
        Nominal Stanbucks only (0.01 precision). The server checks every original selection and the cutoff; a confirmed status alone does not guarantee availability.
      </p>
      <div role="group" aria-label="Cash-back mode" className="cash-back-actions" aria-describedby={helpId}>
        <button type="button" aria-pressed={mode === 'FULL'}
          className={`btn cash-back-control ${mode === 'FULL' ? 'btn-primary' : 'btn-shell'}`}
          aria-disabled={pendingConfirm || bet.status !== 'CONFIRMED'}
          onClick={() => { if (!pendingConfirm && bet.status === 'CONFIRMED') { setMode('FULL'); edit(); } }}>
          {mode === 'FULL' ? <span aria-hidden="true">✓ </span> : null}Full remainder</button>
        <button type="button" aria-pressed={mode === 'PARTIAL'}
          className={`btn cash-back-control ${mode === 'PARTIAL' ? 'btn-primary' : 'btn-shell'}`}
          aria-disabled={pendingConfirm || bet.status !== 'CONFIRMED'}
          onClick={() => { if (!pendingConfirm && bet.status === 'CONFIRMED') { setMode('PARTIAL'); edit(); } }}>
          {mode === 'PARTIAL' ? <span aria-hidden="true">✓ </span> : null}Partial stake</button>
      </div>
      {mode === 'PARTIAL' ? <div className="cash-back-amount">
        <label htmlFor={inputId}>Stake to close (Stanbucks)</label>
        <input id={inputId} type="number" step="0.01" min="0.01" inputMode="decimal"
          className="form-control cash-back-control" value={amount}
          readOnly={pendingConfirm || bet.status !== 'CONFIRMED'}
          aria-invalid={Boolean(validation)} aria-describedby={`${helpId}${error ? ` ${errorId}` : ''}`}
          onChange={(event) => { setAmount(event.target.value); edit(); }} />
        <span className="cash-back-help">A partial must leave at least 0.01 Stanbucks.</span>
      </div> : null}
      <div className="cash-back-actions">
        <button type="button" className="btn btn-shell cash-back-control"
          disabled={locked || bet.status !== 'CONFIRMED' || Boolean(model.storageError)}
          aria-describedby={error ? errorId : helpId} onClick={getOffer}>
          {attempt ? 'Get new offer' : 'Get cash-back offer'}
        </button>
        {pendingAttempt || (attempt && !terminal && (locked || network?.error)) ? <button type="button"
          className="btn btn-shell cash-back-control" disabled={network?.busy}
          onClick={() => model.retry(retryAttempt.clientOperationId)}>
          {pendingConfirm ? 'Check confirmation status' : 'Retry same offer request'}
        </button> : null}
      </div>
    </> : null}
    {message ? <p role={['ACCEPTED', 'REJECTED'].includes(operation?.state) ? undefined : 'status'}
      className={`cash-back-message${operation?.state === 'REJECTED' ? ' cash-back-error' : ''}`}>{message}</p> : null}
    {error ? <p id={errorId} role="alert" className="cash-back-error">{error}</p> : null}
    {quote ? <div className="cash-back-offer">
      <h4 className="h6">{terminal ? 'Reviewed offer' : 'Offer to review'} — {quote.mode === 'FULL' ? 'Full cash back' : 'Partial cash back'}</h4>
      <ul className="cash-back-selections" aria-label="All original selections for this offer">
        {(bet.rows ?? []).map((row) => <li key={row._id ?? row.id}>
          {row.eventName} · {row.productName || formatLiveMarketType(row.marketType)} · {formatLegacyLiveSelectionLabel(row.oddsName, row, 'selected')} · Accepted odds {row.oddsValue}
        </li>)}
      </ul>
      <dl className="cash-back-values">
        <div><dt>Stake to close</dt><dd>{nominal(quote.closedStakeMinor)}</dd></div>
        <div><dt>Quoted nominal return</dt><dd>{nominal(quote.returnMinor)}</dd></div>
        <div><dt>Original wager</dt><dd>{nominal(quote.financial.originalStakeMinor)}</dd></div>
        <div><dt>Accepted total odds</dt><dd>{quote.acceptedCombinedOdds}</dd></div>
        <div><dt>Remaining stake after cash back</dt><dd>{nominal(quote.remainingStakeMinorAfter)}</dd></div>
        <div><dt>Possible return on remaining stake</dt><dd>{possibleReturn(quote.remainingStakeMinorAfter, quote.acceptedCombinedOdds)} Stanbucks</dd></div>
      </dl>
      {!terminal ? <p className="cash-back-help">
        Offer expires at <time dateTime={quote.expiresAt}>{displayTime(quote.expiresAt)}</time>.
        {' '}{Math.max(0, Math.ceil((operation.deadline - now) / 1000))}s remaining (informational, not a guarantee of availability).
      </p> : null}
      <button type="button" className="btn btn-primary cash-back-control" disabled={!canConfirm}
        onClick={() => model.confirm(attempt.clientOperationId)}>
        {quote.mode === 'FULL' ? 'Confirm full cash back' : 'Confirm partial cash back'}
      </button>
    </div> : null}
    <CashBackHistory slipId={bet.slipId} ownerId={ownerId} receipt={latestReceipt} revision={bet.cashBackFinancial?.revision}
      onHistory={model.applyHistory} onAuthFailure={model.revoke} />
  </section>;
};

export default CashBackPanel;
