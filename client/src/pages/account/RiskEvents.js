/* global BigInt */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Link } from 'react-router-dom';

const API = '/api/backoffice/risk-centre/events';
const action = 'btn backoffice-control backoffice-action';
const options = { timeout: 10000 };
const phases = ['PRE_MATCH', 'FIRST_HALF', 'FIRST_HALF_STOPPAGE', 'HALF_TIME', 'SECOND_HALF', 'SECOND_HALF_STOPPAGE'];
const adviceNames = {
  OFF: 'Choice is off', UNAVAILABLE: 'Analysis unavailable', NO_LIMIT: 'No exposure ceiling',
  WITHIN_CEILING: 'Within exposure ceiling', TURN_OFF: 'Consider turning off', LOWER_ODDS: 'Lower odds',
};
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,95}$/.test(value);
const minor = value => typeof value === 'string' && /^-?\d{1,32}$/.test(value);
const nonnegativeMinor = value => typeof value === 'string' && /^\d{1,32}$/.test(value);
const optionalMinor = value => value === null || minor(value);
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const validEvent = event => event && identifier(event.eventId) && typeof event.name === 'string'
  && date(event.time) && phases.includes(event.phase);
const validMetrics = value => value === null || (value && nonnegativeMinor(value.exposureMinor)
  && Number.isSafeInteger(value.openTickets) && value.openTickets >= 0
  && Number.isSafeInteger(value.pendingTickets) && value.pendingTickets >= 0 && value.pendingTickets <= value.openTickets);
const validReport = data => data && date(data.asOf) && Number.isSafeInteger(data.policyRevision) && data.policyRevision > 0
  && data.analysis && typeof data.analysis.ready === 'boolean' && typeof data.analysis.code === 'string';
const validChoice = choice => choice && /^[a-f0-9]{64}$/.test(choice.id)
  && ['STANDARD', 'TEMPLATE', 'LIVE'].includes(choice.origin) && identifier(choice.marketId)
  && typeof choice.marketName === 'string' && typeof choice.label === 'string'
  && Number.isFinite(choice.odds) && choice.odds >= 1 && ['PRE_MATCH', 'LIVE'].includes(choice.betKind)
  && ['sourceOpen', 'off', 'switchConflict', 'singleBlockedByOtherRule'].every(field => typeof choice[field] === 'boolean')
  && Object.prototype.hasOwnProperty.call(adviceNames, choice.advice)
  && (choice.stressReturnMinor === null || nonnegativeMinor(choice.stressReturnMinor)) && optionalMinor(choice.headroomMinor)
  && (choice.advice === 'LOWER_ODDS'
    ? Number.isFinite(choice.suggestedOdds) && choice.suggestedOdds >= 1.01 && choice.suggestedOdds <= 1000
    : choice.suggestedOdds === null);
const formatMinor = value => {
  if (value === null) return 'Unavailable';
  const amount = BigInt(value);
  const absolute = amount < BigInt(0) ? -amount : amount;
  return `${amount < BigInt(0) ? '-' : ''}${(absolute / BigInt(100)).toLocaleString()}.${String(absolute % BigInt(100)).padStart(2, '0')}`;
};
const formatTime = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const phaseName = phase => phase === 'PRE_MATCH' ? 'Pre-match' : phase === 'HALF_TIME' ? 'Half-time' : 'Live';
const unavailable = code => code === 'RISK_DISABLED' ? 'Exposure accounting is not active in this deployment.'
  : code === 'EXPOSURE_READ_CAPACITY_UNAVAILABLE' ? 'This book exceeds the bounded exposure view.'
    : 'Complete open-position accounting is unavailable.';

function EventAnalysis({ eventId, revision, disabled, canSwitch, onSwitch, onRefreshRules, search, showEventHeading = false }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [stake, setStake] = useState('1');
  const [stakeMinor, setStakeMinor] = useState(100);
  const [stakeError, setStakeError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const sequence = useRef(0);
  const switchFocus = useRef(null);
  useEffect(() => {
    const read = ++sequence.current;
    setLoading(true);
    setError('');
    axios.get(`${API}/${encodeURIComponent(eventId)}?stakeMinor=${stakeMinor}`, options).then(response => {
      if (read !== sequence.current) return;
      const report = response.data;
      if (!validReport(report) || !validEvent(report.event) || report.event.eventId !== eventId
        || !validMetrics(report.metrics) || report.stakeMinor !== stakeMinor
        || !Array.isArray(report.choices) || report.choices.length > 1000 || !report.choices.every(validChoice)
        || new Set(report.choices.map(choice => choice.id)).size !== report.choices.length
        || (!report.analysis.ready && report.choices.some(choice => !['OFF', 'UNAVAILABLE'].includes(choice.advice) || choice.headroomMinor !== null))
        || (report.analysis.ready ? report.metrics === null : report.metrics !== null)) throw new Error('Invalid event analysis.');
      setData(report);
    }).catch(() => {
      if (read === sequence.current) setError('This event analysis could not be refreshed. Switching is disabled. Refresh the analysis or event list.');
    }).finally(() => { if (read === sequence.current) setLoading(false); });
    return () => { sequence.current += 1; };
  }, [eventId, revision, stakeMinor, refresh]);
  const recalculate = event => {
    event.preventDefault();
    const amount = /^\d+(\.\d{1,2})?$/.test(stake) ? Math.round(Number(stake) * 100) : NaN;
    if (!Number.isSafeInteger(amount) || amount < 1 || amount > 1000000000000) {
      setStakeError('Enter 0.01 to 10,000,000,000 Stanbucks, with at most two decimal places.'); return;
    }
    setStakeError('');
    setStakeMinor(amount);
    setRefresh(value => value + 1);
  };
  const stale = data && data.policyRevision !== revision;
  const locked = disabled || loading || Boolean(error) || stale;
  useEffect(() => {
    if (locked || !switchFocus.current) return;
    const target = switchFocus.current;
    switchFocus.current = null;
    if (target.isConnected && document.activeElement === document.body) target.focus({ preventScroll: true });
  }, [locked]);
  const groups = new Map();
  data?.choices.forEach(choice => {
    const key = `${choice.origin}:${choice.marketId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(choice);
  });
  return <section className="risk-event-analysis" aria-label="Market choice analysis" aria-busy={loading}>
    {showEventHeading && data && !error ? <header className="risk-events__heading">
      <div><h2 className="h5">{data.event.name}</h2>
        <p className="market-help">{phaseName(data.event.phase)} · {formatTime(data.event.time)}</p></div>
      <Link className={action} to={`/backoffice/events/${encodeURIComponent(eventId)}/markets${search}`}>Event markets</Link>
    </header> : null}
    <form className="risk-stress-form" noValidate onSubmit={recalculate}>
      <label>Test stake (Stanbucks)<input className="form-control backoffice-control" type="number" min="0.01" step="0.01"
        value={stake} aria-describedby={stakeError ? 'risk-stake-error' : 'risk-stress-help'}
        onChange={event => setStake(event.target.value)} /></label>
      <button className={action} type="submit" disabled={loading}>Recalculate</button>
    </form>
    <p className="market-help" id="risk-stress-help">Tests one new single at the shown odds. Pending exposure reserves its full payout. Other bet rules still apply.</p>
    {stakeError ? <p id="risk-stake-error" role="alert">{stakeError}</p> : null}
    {loading ? <p role="status">Calculating event stress...</p> : null}
    {error ? <p role="alert" className="market-notice market-notice--danger">{error}</p> : null}
    {error ? <button className={action} type="button" onClick={() => setRefresh(value => value + 1)}>Refresh analysis</button> : null}
    {data && !error ? <>
      {stale ? <div className="market-notice market-notice--warning" role="status">
        <p>Rules changed. Refresh the active policy before switching a choice.</p>
        <button type="button" className={action} onClick={onRefreshRules}>Refresh active policy</button>
      </div> : null}
      {!data.analysis.ready ? <p className="market-notice market-notice--warning" role="status">
        {unavailable(data.analysis.code)} Missing evidence is not zero exposure; no odds recommendation is available.
      </p> : null}
      {data.choices.some(choice => choice.advice === 'NO_LIMIT') ? <p className="market-help">
        No book-wide exposure ceiling applies to some choices. Set one in Rules to get odds recommendations; per-customer limits are not book budgets.
      </p> : null}
      {!canSwitch ? <p className="market-help">Choice switches require the current Risk Centre service and active transaction-capable policy storage.</p> : null}
      <p className="risk-event-analysis__summary">
        <strong>Existing loss bound: {data.metrics ? `${formatMinor(data.metrics.exposureMinor)} Stanbucks` : 'Unavailable'}</strong>
        <span>Tested stake: {formatMinor(String(data.stakeMinor))} Stanbucks</span>
      </p>
      {!data.choices.length ? <p>No market choices are available in this snapshot. Refresh the event list.</p> : null}
      {[...groups.entries()].map(([key, choices]) => <section className="risk-event-market" key={key} aria-label={`${choices[0].marketName} choices`}>
        <div className="risk-event-market__heading">
          <h3 className="h6">{choices[0].marketName}</h3>
          {choices[0].origin === 'TEMPLATE' ? <Link className={action} to={`/backoffice/events/${encodeURIComponent(eventId)}/markets${search}`}>Manage odds</Link> : null}
        </div>
        <ul className="risk-choice-list">{choices.map(choice => <li className="risk-choice" key={choice.id}>
          <div className="risk-choice__identity"><strong>{choice.label}</strong>
            {!choice.sourceOpen ? <small>Paused or unavailable at source</small> : null}
            {choice.singleBlockedByOtherRule ? <small>Another rule still blocks this single</small> : null}
          </div>
          <dl className="risk-choice__values">
            <div><dt>Odds</dt><dd>{choice.odds.toFixed(2)}</dd></div>
            <div><dt>Test payout</dt><dd>{formatMinor(choice.stressReturnMinor)}</dd></div>
          </dl>
          <div className="risk-choice__advice">
            <strong className={['LOWER_ODDS', 'TURN_OFF'].includes(choice.advice) ? 'market-pill market-pill--danger' : ''}>
              {choice.advice === 'LOWER_ODDS' ? `Lower odds to ${choice.suggestedOdds.toFixed(2)} or less` : adviceNames[choice.advice]}
            </strong>
            {choice.headroomMinor !== null ? <small>Book headroom: {formatMinor(choice.headroomMinor)} Stanbucks</small> : null}
          </div>
          <div className="risk-choice__controls">
            {choice.switchConflict ? <small>Switch rule changed; review it in Rules</small> : <>
              <span className={`market-pill market-pill--${choice.off ? 'danger' : 'positive'}`}>{choice.off ? 'Off' : 'On'}</span>
              <button type="button" className={action} role="switch" aria-checked={!choice.off}
                aria-label={`Allow ${choice.label} in ${choice.marketName} for ${data.event.name}`}
                disabled={locked || !canSwitch}
                onClick={event => {
                  switchFocus.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
                  onSwitch(choice, data.event, data.policyRevision);
                }}>{choice.off ? 'Turn on' : 'Turn off'}</button>
            </>}
          </div>
        </li>)}</ul>
      </section>)}
      <p className="market-help" role="status">Analysis updated {formatTime(data.asOf)}. Policy revision {data.policyRevision}.</p>
    </> : null}
    <p className="market-help">Recommendations affect future bets only. Lower odds or an off switch do not reduce accepted exposure. Turning on removes only this choice switch; other restrictions remain.</p>
  </section>;
}

function OpenEventRisks({ revision, disabled, canSwitch, onSwitch, onRefreshRules, search }) {
  const [page, setPage] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState(null);
  const [previous, setPrevious] = useState([]);
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState(null);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const read = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const response = await axios.get(`${API}${cursor ? `?after=${encodeURIComponent(cursor)}` : ''}`, options);
      if (read !== sequence.current) return;
      const report = response.data;
      if (!validReport(report) || !Array.isArray(report.events) || report.events.length > 25
        || !report.events.every(event => validEvent(event) && validMetrics(event.metrics)
          && (report.analysis.ready ? event.metrics !== null : event.metrics === null))
        || (report.nextAfter !== null && !identifier(report.nextAfter))) throw new Error('Invalid event list.');
      setPage(report);
    } catch {
      if (read === sequence.current) setError('Open events could not be loaded. No partial or zero-exposure result is shown. Try refreshing.');
    } finally { if (read === sequence.current) setLoading(false); }
  }, [cursor]);
  useEffect(() => {
    load();
    return () => { sequence.current += 1; };
  }, [load, refresh]);
  return <section className="risk-events" aria-labelledby="risk-events-title">
    <div className="risk-events__heading">
      <div><h2 className="h5" id="risk-events-title">Open events for betting</h2>
        <p className="market-help">Open upcoming and in-play events. Conservative loss bounds, not a probability forecast.</p></div>
      <button type="button" className={action} disabled={loading} onClick={() => { setSelected(null); setRefresh(value => value + 1); }}>Refresh events</button>
    </div>
    {loading ? <p role="status">Loading open events...</p> : null}
    {error ? <p className="market-notice market-notice--danger" role="alert">{error}</p> : null}
    {page && !loading && !error ? <>
      {!page.analysis.ready ? <p className="market-notice market-notice--warning" role="status">
        {unavailable(page.analysis.code)} Exposure is unavailable, not zero.
      </p> : null}
      {!page.events.length ? <p>No open events. Online upcoming and in-play events will appear here.</p> : null}
      <ul className="risk-events-list">{page.events.map(event => <li key={event.eventId}>
        <button type="button" className={`${action} risk-event-summary`} aria-expanded={selected === event.eventId}
          aria-controls={`risk-event-${event.eventId}`} aria-label={`${selected === event.eventId ? 'Hide' : 'Review'} risk for ${event.name}`}
          onClick={() => setSelected(value => value === event.eventId ? null : event.eventId)}>
          <span><strong>{event.name}</strong><small>{phaseName(event.phase)} · {formatTime(event.time)}</small></span>
          <span>{event.metrics ? <><strong>{formatMinor(event.metrics.exposureMinor)} Stanbucks</strong>
            <small>Loss bound · {event.metrics.openTickets} open tickets</small></> : <strong>Exposure unavailable</strong>}</span>
          <span aria-hidden="true">{selected === event.eventId ? 'Hide' : 'Review'}</span>
        </button>
        {selected === event.eventId ? <div id={`risk-event-${event.eventId}`}>
          <EventAnalysis eventId={event.eventId} revision={revision} disabled={disabled} canSwitch={canSwitch}
            onSwitch={onSwitch} onRefreshRules={onRefreshRules} search={search} />
        </div> : null}
      </li>)}</ul>
      {page.events.length ? <p className="market-help">{page.events.length} events on this page. Exposure updated {formatTime(page.asOf)}.</p> : null}
      <div className="market-form-actions">
        <button type="button" className={action} disabled={!previous.length} onClick={() => {
          setCursor(previous[previous.length - 1]); setPrevious(value => value.slice(0, -1)); setSelected(null);
        }}>Previous events</button>
        <button type="button" className={action} disabled={!page.nextAfter} onClick={() => {
          setPrevious(value => [...value, cursor]); setCursor(page.nextAfter); setSelected(null);
        }}>Next events</button>
      </div>
    </> : null}
    <AnalysisNotes />
  </section>;
}

function AnalysisNotes() {
  return <details className="risk-secondary">
      <summary>How to read this analysis</summary>
      <p>Event loss bounds count each open ticket once, retaining full standalone payout bounds after partial closure and pending principal. Multi-event tickets can appear under more than one event; do not add event totals together.</p>
      <p>Odds recommendations test the selected stake against every matching, enabled operator-exposure ceiling across the whole applicable book. No ceiling means no recommendation. Per-customer budgets, correlations and black-swan probabilities are not inferred.</p>
      <p>Choice switches decline new receipts, including Builders and accumulators containing the choice. Choices can remain visible to players. Pending and accepted tickets keep their original policy and price.</p>
  </details>;
}

export default function RiskEvents({ eventId, ...props }) {
  return eventId ? <div className="risk-events">
    <EventAnalysis key={eventId} eventId={eventId} showEventHeading {...props} />
    <AnalysisNotes />
  </div> : <OpenEventRisks {...props} />;
}
