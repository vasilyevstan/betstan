import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import useNow from '../../hook/useNow';
import MarketSelections from '../../components/MarketSelections';
import { createMarketRequestId, marketError, selectionKey } from '../../marketUi';

const EventMarketView = ({ eventId, currentUser, onSelectionPlaced }) => {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('SINGLE');
  const [selected, setSelected] = useState([]);
  const [review, setReview] = useState(null);
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const acting = useRef(false);
  const sequence = useRef(0);
  const quoteHeading = useRef(null);
  const feedback = useRef(null);
  const now = useNow();
  const path = `/api/event/events/${encodeURIComponent(eventId)}`;

  const load = async () => {
    const request = ++sequence.current;
    setLoading(true);
    setError('');
    setReview(null);
    setSelected([]);
    try {
      const { data } = await axios.get(`${path}/markets`);
      if (active.current && request === sequence.current) setCatalog(data);
    } catch (failure) {
      if (active.current && request === sequence.current) setError(marketError(failure));
    } finally {
      if (active.current && request === sequence.current) setLoading(false);
    }
  };
  useEffect(() => {
    active.current = true;
    void load();
    return () => { active.current = false; sequence.current += 1; };
    // The parent keys the entire workspace by event and authenticated owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const available = catalog?.enabled && catalog.event.visibility === 'ONLINE'
    && catalog.event.status !== 'RESULTED' && Date.parse(catalog.event.time) > now;
  const groups = (catalog?.markets ?? []).map(({ configuration, preview, builderEligible }) => ({
    id: configuration.marketId, name: configuration.template.definition.name,
    manual: configuration.template.definition.settlementMode === 'MANUAL',
    bindings: configuration.template.definition.parameters
      .map((parameter) => `${parameter.label}: ${configuration.parameters[parameter.key]}`).join(', '),
    available: configuration.availability === 'OPEN', builderEligible,
    outcomes: configuration.template.definition.outcomes.map((outcome) => ({
      origin: 'TEMPLATE', marketId: configuration.marketId, outcomeKey: outcome.key,
      quoteRevision: configuration.revision, label: outcome.label, odds: preview.odds[outcome.key],
    })),
  }));
  if (mode === 'BUILDER') {
    const standard = new Map();
    (catalog?.standardSelections ?? []).forEach((selection) => {
      if (!standard.has(selection.marketId)) standard.set(selection.marketId, {
        id: selection.marketId, name: selection.marketName, available: true, builderEligible: true, outcomes: [],
      });
      standard.get(selection.marketId).outcomes.push(selection);
    });
    groups.unshift(...standard.values());
  }
  const choose = (selection) => {
    setReview(null);
    setReplace(false);
    setError('');
    setMessage('');
    setSelected((previous) => {
      const exists = previous.some((item) => selectionKey(item) === selectionKey(selection));
      if (exists) return previous.filter((item) => selectionKey(item) !== selectionKey(selection));
      return mode === 'SINGLE' ? [selection] : [...previous, selection];
    });
  };
  const getQuote = async () => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    setReview(null);
    setReplace(false);
    try {
      const { data: boards } = await axios.get('/api/slip/boards');
      if (!Object.prototype.hasOwnProperty.call(boards, 'PRE_MATCH')) throw new Error('Your slip could not be verified. Reload and try again.');
      const board = boards.PRE_MATCH;
      if (board && (board.status !== 'DRAFT' || !Number.isSafeInteger(board.boardRevision) || !board.boardFingerprint)) {
        throw new Error('Your pre-match slip is awaiting review or refreshing. Wait for it before adding a market.');
      }
      if (!active.current) return;
      const { data: quote } = await axios.post(`${path}/market-quotes`, {
        requestId: createMarketRequestId(), kind: mode,
        selections: selected.map(({ origin, marketId, outcomeKey, quoteRevision }) => ({ origin, marketId, outcomeKey, quoteRevision })),
      });
      if (active.current) setReview({
        quote, boardRevision: board?.boardRevision ?? null, boardFingerprint: board?.boardFingerprint ?? null,
        conflicts: (board?.rows ?? []).filter((row) => row.eventId === eventId),
      });
    } catch (failure) {
      if (active.current) setError(marketError(failure));
    } finally {
      acting.current = false;
      if (active.current) {
        setBusy(false);
        window.requestAnimationFrame(() => {
          if (active.current && document.activeElement === document.body) quoteHeading.current?.focus();
        });
      }
    }
  };
  const addToSlip = async () => {
    if (acting.current || !review) return;
    if (Date.parse(review.quote.expiresAt) <= Date.now()) {
      setReview(null);
      setError('Quote expired. Get a fresh quote and review it again.');
      return;
    }
    acting.current = true;
    setBusy(true);
    setError('');
    try {
      await axios.post('/api/slip/market-selection', {
        quoteId: review.quote.quoteId, expectedBoardRevision: review.boardRevision,
        expectedBoardFingerprint: review.boardFingerprint, replaceEventSelections: replace,
      });
      if (active.current) {
        setReview(null);
        setSelected([]);
        setMessage('Added to your pre-match slip. Review your wager and place the slip before the quote expires.');
        onSelectionPlaced?.();
      }
    } catch (failure) {
      if (active.current) {
        setReview(null);
        setError(`${marketError(failure)} Refresh your slip, then get a fresh quote and review it again.`);
        onSelectionPlaced?.();
      }
    } finally {
      acting.current = false;
      if (active.current) {
        setBusy(false);
        window.requestAnimationFrame(() => {
          if (active.current && document.activeElement === document.body) feedback.current?.focus();
        });
      }
    }
  };
  const seconds = review ? Math.max(0, Math.ceil((Date.parse(review.quote.expiresAt) - Date.now()) / 1000)) : 0;
  return <section className="markets-page">
    <header className="market-page-heading">
      <a className="inline-control-target" href={`/${window.location.search}`}>Back to events</a>
      <h1 className="h3">{catalog?.event.name || 'Event markets'}</h1>
      <p>More markets and same-match combinations.</p>
    </header>
    <div className="market-toolbar" role="group" aria-label="Selection mode">
      {['SINGLE', 'BUILDER'].map((value) => <button key={value} type="button" className="btn btn-shell"
        aria-pressed={mode === value} disabled={busy} onClick={() => {
          setMode(value); setSelected([]); setReview(null); setError(''); setMessage('');
        }}>{value === 'SINGLE' ? 'More markets' : 'Bet Builder'}</button>)}
      <button type="button" className="btn btn-shell" disabled={busy || loading} onClick={load}>Refresh markets</button>
    </div>
    {mode === 'BUILDER' ? <p className="market-help">Choose 2-10 modeled selections from this match. The combined price accounts for overlap; individual odds are not multiplied. Manual and operator-priced markets cannot enter a Builder.</p>
      : <p className="market-help">Choose one outcome. Custom singles can share a slip with other matches, not independent selections from this same match.</p>}
    {loading ? <p role="status">Loading markets...</p> : null}
    {error ? <div className="alert alert-danger" role="alert">{error}</div> : null}
    <div ref={feedback} tabIndex={-1} role="status" className={message ? 'market-feedback' : undefined}>{message}</div>
    {!loading && catalog && !available ? <p role="status">New market betting is unavailable for this event. Existing bets keep their accepted rules.</p> : null}
    {!loading && catalog && !groups.length ? <p>No additional markets are published yet.</p> : null}
    {!loading ? groups.map((group) => {
      const outcomes = <div className="market-outcomes">
        {group.outcomes.map((outcome) => {
          const chosen = selected.some((item) => selectionKey(item) === selectionKey(outcome));
          return <button type="button" className="btn btn-shell market-outcome" key={selectionKey(outcome)}
            aria-pressed={chosen}
            disabled={busy || !available || !group.available || (mode === 'BUILDER' && (!group.builderEligible || (!chosen && selected.length >= 10)))}
            onClick={() => choose(outcome)}>
            <span>{outcome.label}</span><strong>{outcome.odds.toFixed(2)}</strong>
          </button>;
        })}
      </div>;
      return <section key={group.id} className="market-group" aria-labelledby={`market-${group.id}`}>
        <h2 className="h5" id={`market-${group.id}`}>{group.name}</h2>
        {group.bindings ? <p className="market-help">{group.bindings}</p> : null}
        <p className="market-help">{!group.available ? 'Suspended. ' : ''}{group.manual ? 'Operator-declared result.' : 'Settled from the final score.'}
          {!group.builderEligible ? ' Single or different-match accumulator only.' : ''}</p>
        {group.outcomes.length > 12 ? <details className="market-outcome-disclosure">
          <summary>{group.outcomes.length} outcomes ({selected.filter((item) => item.marketId === group.id).length} selected)</summary>
          {outcomes}
        </details> : outcomes}
      </section>;
    }) : null}
    {catalog ? <section className="market-quote" aria-labelledby="market-quote-heading">
      <h2 ref={quoteHeading} tabIndex={-1} className="h5" id="market-quote-heading">{mode === 'BUILDER' ? `Your Builder (${selected.length}/10)` : 'Your selection'}</h2>
      <p>{selected.length ? selected.map((selection) => selection.label).join(' + ') : 'Choose outcomes above to review a current price.'}</p>
      {!currentUser ? <a className="inline-control-target" href={`/login${window.location.search}`}>Log in to get a quote</a>
        : <button type="button" className="btn btn-primary"
          disabled={busy || loading || !available || selected.length < (mode === 'BUILDER' ? 2 : 1)}
          onClick={getQuote}>{busy ? 'Working...' : mode === 'BUILDER' ? 'Get combined odds' : 'Get quote'}</button>}
      {review ? <>
        <p className="market-quote__price">Quoted odds <strong>{review.quote.odds.toFixed(2)}</strong></p>
        <MarketSelections marketBet={review.quote} />
        <p>{seconds ? `Quote expires in ${seconds}s. Place the slip before it expires.` : 'Quote expired. Get a fresh quote before adding it.'}</p>
        {review.conflicts.length ? <div className="market-replacement">
          <p>These selections from this match will be removed:</p>
          <ul>{review.conflicts.map((row) => <li key={row.id || row._id}>{row.productName}: {row.oddsName} at {row.oddsValue}</li>)}</ul>
          <label><input type="checkbox" checked={replace} disabled={busy} onChange={(event) => setReplace(event.target.checked)} />
            Replace these same-match selections with this quote</label>
        </div> : null}
        <button type="button" className="btn btn-primary"
          disabled={busy || !seconds || (review.conflicts.length > 0 && !replace)} onClick={addToSlip}>
          Add quoted selection to slip
        </button>
      </> : null}
    </section> : null}
  </section>;
};

const EventMarkets = (props) => {
  const { eventId } = useParams();
  return <EventMarketView key={`${eventId}:${props.currentUser?.id || 'anonymous'}`} eventId={eventId} {...props} />;
};
export default EventMarkets;
