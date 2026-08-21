import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';

const EMAIL_LIKE_PATTERN = /@/;
const FALLBACK_DISPLAY_NAME = 'Anonymous player';

const normalizeStatEntry = (entry, index) => {
  const displayName = typeof entry?.displayName === 'string' ? entry.displayName.trim() : '';
  const safeDisplayName = !displayName || EMAIL_LIKE_PATTERN.test(displayName)
    ? FALLBACK_DISPLAY_NAME
    : displayName;

  return {
    userKey: typeof entry?.userKey === 'string' && entry.userKey.trim() ? entry.userKey : `row-${index}`,
    displayName: safeDisplayName,
    betCount: Number.isFinite(entry?.betCount) ? entry.betCount : 0,
    wagerTotal: Number.isFinite(entry?.wagerTotal) ? entry.wagerTotal : 0,
  };
};

const HandleUserStatistics = ({ refreshToken, uiVariant }) => {
  const [stats, setStats] = useState([]);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    let isMounted = true;

    const fetchStats = async () => {
      try {
        const response = await axios.get('/api/bet/stats');
        if (!isMounted) {
          return;
        }

        const nextStats = Array.isArray(response.data)
          ? response.data.map(normalizeStatEntry)
          : [];
        setStats(nextStats);
        setHasError(false);
      } catch (error) {
        if (!isMounted) {
          return;
        }

        setStats([]);
        setHasError(true);
      }
    };

    fetchStats();

    return () => {
      isMounted = false;
    };
  }, [refreshToken]);

  const renderedStats = useMemo(() => stats.map((stat, index) => <div className="stat-row" key={stat.userKey}>
    <div className="stat-row__rank text-secondary">{index + 1}</div>
    <div className="stat-row__user" title={stat.displayName}>{stat.displayName}</div>
    <div className="stat-row__count">{stat.betCount}</div>
    <div className="stat-row__wager fw-semibold">{stat.wagerTotal}</div>
  </div>), [stats]);

  return <div className={`flex-wrap scoreboard scoreboard--${uiVariant}`}>
    <div className="card scoreboard__table">
      <div className="stat-row stat-row--header text-secondary">
        <div className="stat-row__rank"></div>
        <div className="stat-row__user">User</div>
        <div className="stat-row__count">Bets</div>
        <div className="stat-row__wager">Wager</div>
      </div>
      {hasError ? (
        <div className="card-body empty-state-card" role="alert">Leaderboard unavailable.</div>
      ) : renderedStats.length === 0 ? (
        <div className="card-body empty-state-card">No public betting activity yet.</div>
      ) : renderedStats}
    </div>
  </div>;
};

export default HandleUserStatistics;
