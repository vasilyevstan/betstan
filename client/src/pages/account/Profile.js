import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Link, useLocation } from 'react-router-dom';

const ALL_TIME = { from: null, toExclusive: null, label: 'All time' };
const countKeys = [
  'acceptedBets', 'wins', 'losses', 'openBets', 'voidedBets', 'cashBackBets',
  'pendingSubmissions', 'declinedSubmissions',
];
const validStats = (data, range) => data
  && countKeys.every((key) => Number.isSafeInteger(data[key]) && data[key] >= 0)
  && data.acceptedBets === data.wins + data.losses + data.openBets + data.voidedBets + data.cashBackBets
  && typeof data.totalStaked === 'string' && /^\d+(?:\.\d+)?(?:E[+-]?\d+)?$/.test(data.totalStaked)
  && data.range?.from === range.from && data.range?.toExclusive === range.toExclusive;
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

const SignedOutProfile = ({ search }) => <section className="card profile-panel">
  <h1>My profile</h1>
  <p>Sign in to view your profile and betting activity.</p>
  <Link className="btn btn-shell" to={{ pathname: '/login', search }}>Log in</Link>
</section>;

const PlayerProfile = ({ user, onAuthRefresh, onProfileSaved, search }) => {
  const effectiveName = user.displayName ?? user.email;
  const [name, setName] = useState({ value: effectiveName, saved: effectiveName, phase: 'idle', error: '' });
  const saveRequest = useRef(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [dateError, setDateError] = useState('');
  const [range, setRange] = useState(ALL_TIME);
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
    const requestRange = { from: range.from, toExclusive: range.toExclusive };
    setStats({ loading: true, data: null, error: '' });
    axios.get('/api/bet/me/stats', {
      params: range.from ? requestRange : {},
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
      setStats({ loading: false, data: null, error: 'Your betting statistics are unavailable. Try Refresh statistics.' });
    });
    return () => controller.abort();
  }, [range.from, range.toExclusive, refresh, authExpired, expireSession]);

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

  const applyDates = (event) => {
    event.preventDefault();
    const start = localDay(fromDay);
    const end = localDay(toDay);
    if (!start || !end || start > end) {
      setDateError('Choose both dates, with From on or before To.');
      return;
    }
    end.setDate(end.getDate() + 1);
    setDateError('');
    setRange({ from: start.toISOString(), toExclusive: end.toISOString(), label: `${fromDay} to ${toDay}` });
  };

  const resetDates = () => {
    setFromDay('');
    setToDay('');
    setDateError('');
    setRange(ALL_TIME);
  };

  if (authExpired) return <SignedOutProfile search={search} />;
  const totals = stats.data;
  const empty = totals && totals.acceptedBets + totals.pendingSubmissions + totals.declinedSubmissions === 0;
  return <div className="profile-page">
    <header className="profile-heading">
      <h1>My profile</h1>
      <p className="text-secondary">Your name and personal betting activity.</p>
    </header>
    <section className="card profile-panel" aria-labelledby="profile-name-heading">
      <h2 className="h5" id="profile-name-heading">Your name</h2>
      <p className="profile-login">Login: <strong>{user.email}</strong></p>
      <form className="profile-name-form" onSubmit={saveName}>
        <div className="profile-field">
          <label htmlFor="profile-display-name">Display name</label>
          <input id="profile-display-name" className="form-control" type="text"
            autoComplete="nickname" value={name.value} disabled={name.phase === 'saving'}
            aria-describedby={`profile-name-hint${name.error ? ' profile-name-error' : ''}`}
            aria-invalid={Boolean(name.error)}
            onChange={(event) => setName((current) => ({
              ...current, value: event.target.value, phase: 'idle', error: '',
            }))}
          />
        </div>
        <button className="btn btn-shell" type="submit"
          disabled={name.phase === 'saving' || name.value === name.saved}>
          {name.phase === 'saving' ? 'Saving name...' : 'Save name'}
        </button>
        <p className="profile-hint" id="profile-name-hint">
          Private to your profile and signed-in header. Your login stays the same.
        </p>
        {name.error ? <p className="text-danger profile-feedback" role="alert" id="profile-name-error">{name.error}</p> : null}
        <p className="profile-feedback" role="status">{name.phase === 'saved' ? 'Name saved.' : ''}</p>
      </form>
    </section>
    <section className="card profile-panel" aria-labelledby="profile-stats-heading">
      <div className="profile-section-heading">
        <h2 className="h5" id="profile-stats-heading">Betting activity</h2>
        <button className="btn btn-shell" type="button" disabled={stats.loading}
          onClick={() => setRefresh((value) => value + 1)}>Refresh statistics</button>
      </div>
      <form className="profile-date-form" onSubmit={applyDates}>
        <div className="profile-field">
          <label htmlFor="profile-from">From</label>
          <input className="form-control" id="profile-from" type="date" value={fromDay}
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
        <button className="btn btn-shell" type="button"
          disabled={!range.from && !fromDay && !toDay} onClick={resetDates}>All time</button>
        <p className="profile-hint" id="profile-date-hint">
          Both local dates are included. Results reflect the current outcomes of bets placed in that range.
        </p>
        <p className="text-danger profile-feedback" role={dateError ? 'alert' : undefined} id="profile-date-error">{dateError}</p>
      </form>
      <p className="profile-range">Statistics for <strong>{range.label}</strong>.</p>
      <div aria-busy={stats.loading}>
        {stats.loading ? <p role="status">Loading your betting statistics...</p> : null}
        {stats.error ? <p className="text-danger" role="alert">{stats.error}</p> : null}
        {totals ? <>
          {empty ? <p>{range.from ? 'No betting activity in this date range.' : 'No betting activity yet.'}</p> : null}
          <dl className="profile-totals">
            {[
              ['Bets', totals.acceptedBets.toLocaleString()],
              ['Wins', totals.wins.toLocaleString()],
              ['Losses', totals.losses.toLocaleString()],
              ['Total staked', <>{totals.totalStaked} <span>Stanbucks</span></>],
            ].map(([label, value]) => <div key={label}>
              <dt>{label}</dt><dd>{value}</dd>
            </div>)}
          </dl>
          <dl className="profile-breakdown">
            {[
              ['Open', totals.openBets], ['Voided', totals.voidedBets], ['Cash back', totals.cashBackBets],
              ['Awaiting moderation', totals.pendingSubmissions], ['Declined', totals.declinedSubmissions],
            ].map(([label, value]) => <div key={label}>
              <dt>{label}</dt><dd>{value.toLocaleString()}</dd>
            </div>)}
          </dl>
        </> : null}
      </div>
      <p className="profile-hint">Bets counts accepted tickets, including voids and cash back. An accumulator counts once.
        Pending and declined submissions are shown separately.</p>
      <p className="profile-hint">Total staked excludes pending, declined and fully voided bets.
        Winnings and cash-back returns are not deducted. Nominal Stanbucks, not a wallet balance.</p>
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
