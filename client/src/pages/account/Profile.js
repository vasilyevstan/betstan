import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Link, useLocation } from 'react-router-dom';
import { formatLiveMarketType } from '../../liveBettingUtils';

const PERIODS = [
  { value: 'ALL', label: 'All time' },
  { value: 'TODAY', label: 'Today' },
  { value: '7D', label: 'Last 7 days' },
  { value: '30D', label: 'Last 30 days' },
  { value: 'CUSTOM', label: 'Custom dates' },
];
const DAY_MS = 86400000;
const countKeys = [
  'acceptedBets', 'wins', 'losses', 'openBets', 'voidedBets', 'cashBackBets',
  'pendingSubmissions', 'declinedSubmissions',
];
const styleKeys = ['preMatchBets', 'liveBets', 'singleBets', 'accumulatorBets'];
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const submittedBets = (data) => data.acceptedBets + data.pendingSubmissions + data.declinedSubmissions;
const hasStyle = (data) => styleKeys.some((key) => key in data) || 'favouriteMarket' in data;
const isNamedCount = (value) => typeof value?.name === 'string' && value.name.trim().length > 0
  && Number.isSafeInteger(value.selections) && value.selections > 0;
const validStyle = (data) => styleKeys.every((key) => isCount(data[key]))
  && data.preMatchBets + data.liveBets === submittedBets(data)
  && data.singleBets + data.accumulatorBets === submittedBets(data)
  && (data.favouriteMarket === null || isNamedCount(data.favouriteMarket));
const optional = (data, key, valid) => !(key in data) || data[key] === null || valid(data[key]);
const validResult = (entry) => ['WIN', 'LOSS'].includes(entry?.result) && isCount(entry.selections)
  && (entry.placedAt === null || (typeof entry.placedAt === 'string' && Number.isFinite(Date.parse(entry.placedAt))))
  && [entry.eventName, entry.pick].every((value) => value === null || typeof value === 'string');
const validInsights = (data) => optional(data, 'favouriteTeam', isNamedCount)
  && optional(data, 'bestWinningPick', (pick) => Number.isFinite(pick.odds) && pick.odds > 1
    && ['eventName', 'pick', 'market'].every((key) => typeof pick[key] === 'string'))
  && (!('recentResults' in data) || (Array.isArray(data.recentResults) && data.recentResults.every(validResult)))
  && optional(data, 'scoreboardRank', (rank) => Number.isSafeInteger(rank.position) && rank.position > 0
    && Number.isSafeInteger(rank.players) && rank.players >= rank.position);
const validStats = (data, range) => data
  && countKeys.every((key) => isCount(data[key]))
  && data.acceptedBets === data.wins + data.losses + data.openBets + data.voidedBets + data.cashBackBets
  && typeof data.totalStaked === 'string' && /^\d+(?:\.\d+)?(?:E[+-]?\d+)?$/.test(data.totalStaked)
  && data.range?.from === range.from && data.range?.toExclusive === range.toExclusive
  && (!hasStyle(data) || validStyle(data))
  && validInsights(data);
const nameError = (error) => {
  const entry = error?.response?.data?.errors?.[0];
  return [entry?.msg, entry?.message].find((message) => typeof message === 'string' && message.trim())
    || 'Your name could not be saved. Try again.';
};
const validDisplayName = (value) => typeof value === 'string'
  && value.trim().length > 0 && Array.from(value.trim()).length <= 254
  && !Array.from(value).some((character) => {
    const code = character.codePointAt(0);
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029;
  });
const localDay = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date : null;
};
const nextLocalMidnight = (now) => {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return date;
};
// Same windows as My bets: Today starts at local midnight; 7 and 30 days roll back from now.
const periodRange = (period, now = new Date()) => {
  if (period.preset === 'CUSTOM') return { from: period.from, toExclusive: period.toExclusive };
  if (period.preset === 'ALL') return { from: null, toExclusive: null };
  const end = nextLocalMidnight(now);
  const start = period.preset === 'TODAY'
    ? new Date(new Date(now).setHours(0, 0, 0, 0))
    : new Date(now.getTime() - (period.preset === '7D' ? 7 : 30) * DAY_MS);
  return { from: start.toISOString(), toExclusive: end.toISOString() };
};
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const dayRangeLabel = (start, end) => (typeof dayFormat.formatRange === 'function'
  ? dayFormat.formatRange(start, end)
  : `${dayFormat.format(start)} – ${dayFormat.format(end)}`);
const numberParts = new Intl.NumberFormat().formatToParts(1234.5);
const groupSeparator = numberParts.find((part) => part.type === 'group')?.value ?? ',';
const decimalSeparator = numberParts.find((part) => part.type === 'decimal')?.value ?? '.';
// Group the exact decimal string without Number(): stakes can exceed double precision.
const formatStake = (value) => {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const groups = match[1].match(/\d{1,3}(?=(?:\d{3})*$)/g);
  return <>
    {groups.map((group, index) => <React.Fragment key={index}>
      {index ? <>{groupSeparator}<wbr /></> : null}{group}
    </React.Fragment>)}
    {match[2] ? `${decimalSeparator}${match[2]}` : null}
  </>;
};
const shortDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const shortDate = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const placedDay = (date) => (date.getFullYear() === new Date().getFullYear() ? shortDay : shortDate).format(date);
const plural = (count, word) => `${count.toLocaleString()} ${count === 1 ? word : `${word}s`}`;
const marketLabel = (name) => {
  if (!/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return name;
  const label = formatLiveMarketType(name);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const RecentResult = ({ entry }) => {
  const won = entry.result === 'WIN';
  const accumulator = entry.selections > 1;
  const pick = accumulator ? null : entry.pick;
  return <li>
    <span className={`profile-result profile-result--${won ? 'won' : 'lost'}`}>{won ? 'Won' : 'Lost'}</span>
    <span className="profile-recent__text">
      <span className="profile-recent__title">
        {accumulator ? `${entry.selections}-selection accumulator` : entry.eventName ?? 'Single bet'}
      </span>
      {pick || entry.placedAt ? <span className="profile-recent__meta">
        {pick}{pick && entry.placedAt ? ' · ' : null}
        {entry.placedAt ? <time dateTime={entry.placedAt}>{placedDay(new Date(entry.placedAt))}</time> : null}
      </span> : null}
    </span>
  </li>;
};

const Split = ({ left, right }) => <li className="profile-split">
  <div className="profile-split__values">
    <span><strong>{left.value.toLocaleString()}</strong> {left.label}</span>
    <span className="visually-hidden">, </span>
    <span>{right.label} <strong>{right.value.toLocaleString()}</strong></span>
  </div>
  <div className="profile-split__bar" aria-hidden="true">
    {[left, right].filter(({ value }) => value > 0).map(({ label, value, tone }) => (
      <span key={label} className={`profile-split__fill profile-split__fill--${tone}`} style={{ flexGrow: value }} />
    ))}
  </div>
</li>;

const SignedOutProfile = ({ search }) => <section className="card profile-panel">
  <h1>My profile</h1>
  <p>Sign in to view your profile and betting activity.</p>
  <Link className="btn btn-shell" to={{ pathname: '/login', search }}>Log in</Link>
</section>;

const PlayerProfile = ({ user, onAuthRefresh, onProfileSaved, search }) => {
  const effectiveName = user.displayName ?? user.email;
  const [name, setName] = useState({ value: effectiveName, saved: effectiveName, phase: 'idle', error: '' });
  const [editing, setEditing] = useState(false);
  const saveRequest = useRef(null);
  const nameInput = useRef(null);
  const editButton = useRef(null);
  const returnFocus = useRef(false);
  const fromInput = useRef(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [dateError, setDateError] = useState('');
  const [period, setPeriod] = useState({ preset: 'ALL' });
  const [refresh, setRefresh] = useState(0);
  const [stats, setStats] = useState({ loading: true, data: null, error: '' });

  useEffect(() => {
    setName((current) => ({
      ...current,
      saved: effectiveName,
      value: current.value === current.saved ? effectiveName : current.value,
    }));
  }, [effectiveName]);

  useEffect(() => () => saveRequest.current?.abort(), []);

  useLayoutEffect(() => {
    if (editing) nameInput.current?.focus();
    else if (returnFocus.current) {
      returnFocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  useLayoutEffect(() => {
    if (customOpen) fromInput.current?.focus();
  }, [customOpen]);

  const expireSession = useCallback(() => {
    setAuthExpired(true);
    saveRequest.current?.abort();
    setName({ value: '', saved: '', phase: 'idle', error: '' });
    setStats({ loading: false, data: null, error: '' });
    onAuthRefresh?.();
  }, [onAuthRefresh]);

  useEffect(() => {
    if (authExpired) return undefined;
    const controller = new AbortController();
    const requestRange = periodRange(period);
    setStats((current) => ({ loading: true, data: current.data, error: '' }));
    axios.get('/api/bet/me/stats', {
      params: requestRange.from ? requestRange : {},
      signal: controller.signal,
    }).then(({ data }) => {
      if (controller.signal.aborted) return;
      if (!validStats(data, requestRange)) throw new Error('Invalid personal statistics response');
      setStats({ loading: false, data, error: '' });
    }).catch((error) => {
      if (controller.signal.aborted) return;
      if ([401, 403].includes(error?.response?.status)) {
        expireSession();
        return;
      }
      setStats({ loading: false, data: null, error: 'Your betting statistics are unavailable. Try Refresh.' });
    });
    return () => controller.abort();
  }, [period, refresh, authExpired, expireSession]);

  const closeEditor = (value) => {
    returnFocus.current = true;
    setEditing(false);
    if (value !== undefined) setName((current) => ({ ...current, value, error: '' }));
  };

  const saveName = async (event) => {
    event.preventDefault();
    if (saveRequest.current) return;
    const displayName = name.value.trim();
    if (!validDisplayName(name.value)) {
      setName((current) => ({ ...current, phase: 'idle', error: 'Use 1 to 254 characters of single-line text.' }));
      return;
    }

    const controller = new AbortController();
    saveRequest.current = controller;
    setName((current) => ({ ...current, phase: 'saving', error: '' }));
    try {
      const { data } = await axios.patch('/api/auth/profile', { displayName }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!validDisplayName(data?.displayName) || data.displayName !== data.displayName.trim()) {
        throw new Error('Invalid profile response');
      }
      setName({ value: data.displayName, saved: data.displayName, phase: 'saved', error: '' });
      closeEditor();
      onProfileSaved?.(user.id, data.displayName);
    } catch (error) {
      if (controller.signal.aborted) return;
      if ([401, 403].includes(error?.response?.status)) {
        expireSession();
        return;
      }
      setName((current) => ({ ...current, phase: 'idle', error: nameError(error) }));
    } finally {
      if (saveRequest.current === controller) saveRequest.current = null;
    }
  };

  const choosePeriod = (preset) => {
    if (preset === 'CUSTOM') {
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    setDateError('');
    setPeriod((current) => (current.preset === preset ? current : { preset }));
  };

  const applyDates = (event) => {
    event.preventDefault();
    const start = localDay(fromDay);
    const end = localDay(toDay);
    if (!start || !end || start > end) {
      setDateError('Choose both dates, with From on or before To.');
      return;
    }
    const label = dayRangeLabel(start, end);
    end.setDate(end.getDate() + 1);
    setDateError('');
    setPeriod({ preset: 'CUSTOM', from: start.toISOString(), toExclusive: end.toISOString(), label });
  };

  if (authExpired) return <SignedOutProfile search={search} />;
  const totals = stats.data;
  const totalBets = totals && submittedBets(totals);
  const style = totals && hasStyle(totals) ? totals : null;
  const settled = totals ? totals.wins + totals.losses : 0;
  const selectedPeriod = customOpen ? 'CUSTOM' : period.preset;
  const periodLabel = period.label ?? PERIODS.find(({ value }) => value === period.preset).label;
  const initial = Array.from(name.saved)[0]?.toUpperCase() ?? '';
  const rank = totals?.scoreboardRank ?? null;
  const recent = totals && Array.isArray(totals.recentResults) ? totals.recentResults : null;
  const inPeriod = period.preset === 'ALL' ? 'yet' : 'in this period';
  const highlights = [];
  if (style?.favouriteMarket) highlights.push({
    label: 'Favourite market', value: marketLabel(style.favouriteMarket.name),
    detail: plural(style.favouriteMarket.selections, 'selection'),
  });
  if (totals && 'favouriteTeam' in totals) highlights.push(totals.favouriteTeam ? {
    label: 'Favourite team', value: totals.favouriteTeam.name,
    detail: plural(totals.favouriteTeam.selections, 'selection'),
  } : { label: 'Favourite team', detail: 'Back the same team twice to see one' });
  if (totals && 'bestWinningPick' in totals) {
    const best = totals.bestWinningPick;
    highlights.push(best ? {
      label: 'Best winning pick', value: best.odds.toFixed(2),
      detail: [best.pick, marketLabel(best.market), best.eventName].filter((part) => part.trim()).join(' · '),
    } : { label: 'Best winning pick', detail: `No winning selections ${inPeriod}` });
  }
  return <div className="profile-page">
    <header className="profile-heading">
      <h1>My profile</h1>
    </header>
    <section className="card profile-identity" aria-labelledby="profile-name-heading">
      <span className="profile-identity__avatar" aria-hidden="true">{initial}</span>
      <div className="profile-identity__text">
        <h2 className="profile-identity__name" id="profile-name-heading">{name.saved}</h2>
        <p className="profile-identity__login">Login <span>{user.email}</span></p>
        {rank ? <p className="profile-identity__rank">
          Scoreboard rank <strong>#{rank.position.toLocaleString()}</strong> of {plural(rank.players, 'player')}
        </p> : null}
      </div>
      {editing ? null : <button ref={editButton} className="btn btn-shell profile-identity__action"
        type="button" onClick={() => setEditing(true)}>Edit name</button>}
      <p className="profile-feedback profile-identity__feedback" role="status">
        {name.phase === 'saved' && !editing ? 'Name saved.' : ''}
      </p>
      {editing ? <form className="profile-name-form" onSubmit={saveName}>
        <div className="profile-field">
          <label htmlFor="profile-display-name">Display name</label>
          <input ref={nameInput} id="profile-display-name" className="form-control" type="text"
            autoComplete="nickname" value={name.value} disabled={name.phase === 'saving'}
            aria-describedby={`profile-name-hint${name.error ? ' profile-name-error' : ''}`}
            aria-invalid={Boolean(name.error)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && name.phase !== 'saving') closeEditor(name.saved);
            }}
            onChange={(event) => setName((current) => ({
              ...current, value: event.target.value, phase: 'idle', error: '',
            }))}
          />
        </div>
        <button className="btn btn-primary" type="submit"
          disabled={name.phase === 'saving' || name.value === name.saved}>
          {name.phase === 'saving' ? 'Saving name...' : 'Save name'}
        </button>
        <button className="btn btn-shell" type="button" disabled={name.phase === 'saving'}
          onClick={() => closeEditor(name.saved)}>Cancel</button>
        <p className="profile-hint" id="profile-name-hint">
          Only you see this name, on your profile and in the header. Your login stays the same.
        </p>
        {name.error ? <p className="text-danger profile-feedback" role="alert" id="profile-name-error">{name.error}</p> : null}
      </form> : null}
    </section>
    <section className="card profile-activity" aria-labelledby="profile-stats-heading">
      <div className="profile-section-heading">
        <h2 id="profile-stats-heading">Betting activity</h2>
        <button className="btn btn-shell" type="button" disabled={stats.loading}
          onClick={() => setRefresh((value) => value + 1)}>
          Refresh<span className="visually-hidden"> statistics</span>
        </button>
      </div>
      <div className="profile-periods" role="group" aria-label="Statistics period">
        {PERIODS.map(({ value, label }) => <button key={value} type="button" aria-pressed={selectedPeriod === value}
          className={`btn btn-sm ${selectedPeriod === value ? 'btn-primary' : 'btn-shell'}`}
          onClick={() => choosePeriod(value)}>
          {selectedPeriod === value ? <span className="state-mark" aria-hidden="true" /> : null}
          {label}
        </button>)}
      </div>
      {customOpen ? <form className="profile-date-form" onSubmit={applyDates}>
        <div className="profile-field">
          <label htmlFor="profile-from">From</label>
          <input ref={fromInput} className="form-control" id="profile-from" type="date" value={fromDay}
            aria-describedby="profile-date-hint profile-date-error" aria-invalid={Boolean(dateError)}
            onChange={(event) => { setFromDay(event.target.value); setDateError(''); }} />
        </div>
        <div className="profile-field">
          <label htmlFor="profile-to">To</label>
          <input className="form-control" id="profile-to" type="date" value={toDay}
            aria-describedby="profile-date-hint profile-date-error" aria-invalid={Boolean(dateError)}
            onChange={(event) => { setToDay(event.target.value); setDateError(''); }} />
        </div>
        <button className="btn btn-shell" type="submit">Apply dates</button>
        <p className="profile-hint" id="profile-date-hint">Both days are included, in your local time.</p>
        <p className="text-danger profile-feedback" role={dateError ? 'alert' : undefined} id="profile-date-error">{dateError}</p>
      </form> : null}
      <p className="profile-range" role="status">
        <strong>{periodLabel}</strong>
        {' · '}{period.preset === 'ALL' ? 'every bet you have placed' : 'bets placed in this period'}
        {', outcomes as they stand now.'}
        {stats.loading && totals ? ' Updating…' : ''}
      </p>
      {stats.loading && !totals ? <p className="profile-loading">Loading your betting statistics...</p> : null}
      {stats.error ? <p className="text-danger profile-error" role="alert">{stats.error}</p> : null}
      {totals && totalBets === 0 ? <div className="profile-empty">
        <p>{period.preset === 'ALL' ? 'No betting activity yet.' : 'No bets placed in this period.'}</p>
        {period.preset === 'ALL' ? <Link className="btn btn-shell" to={{ pathname: '/', search }}>Browse events</Link> : null}
      </div> : null}
      {totals && totalBets > 0 ? <div className="profile-sheet" aria-busy={stats.loading}>
        <dl className="profile-figures">
          <div>
            <dt>Bets</dt>
            <dd><span className="profile-figure">{totalBets.toLocaleString()}</span></dd>
          </div>
          <div>
            <dt>Win rate</dt>
            <dd>
              <span className="profile-figure">{settled ? `${Math.round((totals.wins / settled) * 100)}%` : '—'}</span>
              <span className="profile-figure-note">{settled
                ? `${totals.wins.toLocaleString()} of ${settled.toLocaleString()} settled bets won`
                : 'No settled bets yet'}</span>
            </dd>
          </div>
          <div className="profile-figures__stake">
            <dt>Total staked</dt>
            <dd>
              <span className="profile-figure">{formatStake(totals.totalStaked)}</span>
              <span className="profile-figure-note">Stanbucks · not a balance</span>
            </dd>
          </div>
        </dl>
        <div className="profile-sheet__grid">
          <section aria-labelledby="profile-style-heading">
            <h3 className="profile-label" id="profile-style-heading">How you bet</h3>
            <ul className="profile-splits">
              <Split left={{ label: 'Won', value: totals.wins, tone: 'won' }}
                right={{ label: 'Lost', value: totals.losses, tone: 'lost' }} />
              {style ? <>
                <Split left={{ label: 'Pre-match', value: style.preMatchBets, tone: 'prematch' }}
                  right={{ label: 'Live', value: style.liveBets, tone: 'live' }} />
                <Split left={{ label: 'Singles', value: style.singleBets, tone: 'single' }}
                  right={{ label: 'Accumulators', value: style.accumulatorBets, tone: 'accumulator' }} />
              </> : null}
            </ul>
            {highlights.length ? <dl className="profile-highlights">
              {highlights.map(({ label, value, detail }) => <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {value ? <strong>{value}</strong> : <strong className="profile-highlights__none">None yet</strong>}
                  <span>{detail}</span>
                </dd>
              </div>)}
            </dl> : null}
          </section>
          <div className="profile-sheet__side">
            <section aria-labelledby="profile-status-heading">
              <h3 className="profile-label" id="profile-status-heading">Ticket status</h3>
              <dl className="profile-breakdown">
                {[
                  ['Open', totals.openBets], ['Voided', totals.voidedBets], ['Cash back', totals.cashBackBets],
                  ['Awaiting moderation', totals.pendingSubmissions], ['Declined', totals.declinedSubmissions],
                ].map(([label, value]) => <div key={label}>
                  <dt>{label}</dt><dd>{value.toLocaleString()}</dd>
                </div>)}
              </dl>
            </section>
            {recent ? <section aria-labelledby="profile-recent-heading">
              <h3 className="profile-label" id="profile-recent-heading">Recent results</h3>
              {recent.length ? <ol className="profile-recent">
                {recent.map((entry, index) => <RecentResult key={index} entry={entry} />)}
              </ol> : <p className="profile-hint">No won or lost bets {inPeriod}.</p>}
            </section> : null}
          </div>
        </div>
      </div> : null}
      <div className="profile-footer">
        <details className="profile-notes">
          <summary>How these are counted</summary>
          <ul>
            <li>Bets counts every ticket you submitted, including ones awaiting moderation, declined,
              voided or cashed back. An accumulator counts once.</li>
            <li>Win rate compares won and lost bets only; open, voided and cashed-back bets are left out.</li>
            <li>Total staked adds the original stakes of accepted bets, except fully voided ones.
              Winnings and cash-back returns are not deducted. Stanbucks are nominal, not a wallet balance.</li>
            <li>Favourite market is the market you picked most often, counting each selection.</li>
            <li>Favourite team counts each selection that backs a named team, such as a match winner or a live
              home or away pick; picking a team to be booked does not count. Teams change from match to match, so one appears once you back the same team twice.</li>
            <li>Best winning pick is the highest odds among your selections that won, including accumulator legs.</li>
            <li>Recent results lists up to five won or lost bets, most recently placed first.</li>
            <li>Scoreboard rank is your all-time place on the public scoreboard: most bets first, then highest wager.</li>
            <li>Periods use the date each bet was placed. Outcomes are shown as they stand now.</li>
          </ul>
        </details>
        <Link className="btn btn-shell" to={{ pathname: '/bets', search }}>View my bets</Link>
      </div>
    </section>
  </div>;
};

const Profile = ({ currentUser, isCurrentUserResolved, onAuthRefresh, onProfileSaved }) => {
  const { search } = useLocation();
  if (!isCurrentUserResolved) return <section className="card profile-panel">
    <h1>My profile</h1><p role="status">Checking your session...</p>
  </section>;
  if (!currentUser) return <SignedOutProfile search={search} />;
  return <PlayerProfile key={currentUser.id} user={currentUser}
    onAuthRefresh={onAuthRefresh} onProfileSaved={onProfileSaved} search={search} />;
};

export default Profile;
