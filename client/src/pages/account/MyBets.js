import React, { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import axios from 'axios';
import {
  formatDeclineReason,
  formatLiveMarketType,
  formatRowOutcome,
  getBetKindLabel,
  normalizeBetKind,
} from '../../liveBettingUtils';

const formatTimestamp = (value, fallback = 'Unknown time') => {
  const parsed = new Date(value ?? '');
  return Number.isNaN(parsed.getTime()) ? fallback : format(parsed, 'MMMM do, yyyy H:mm');
};

const formatRowTimestamp = (value) => formatTimestamp(value, '—');

const HandleMyBetsList = () => {
  const [bets, setBets] = useState({});
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [datePreset, setDatePreset] = useState('ALL');
  const [sortOrder, setSortOrder] = useState('DESC');
  const [visibleCount, setVisibleCount] = useState(20);
  const [expandedBets, setExpandedBets] = useState({});

  const fetchBets = async () => {
    try {
      const response = await axios.get('/api/bet');
      const data = response.data;
      setBets(data && typeof data === 'object' ? data : {});
    } catch (error) {
      // ignore
    }
  };

  useEffect(() => {
    fetchBets();
  }, []);

  const betsList = useMemo(() => Object.values(bets ?? {}), [bets]);

  const filteredAndSortedBets = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return betsList
      .filter((bet) => {
        if (statusFilter !== 'ALL' && bet.status !== statusFilter) return false;

        if (datePreset !== 'ALL') {
          const betTime = new Date(bet.timestamp);
          if (Number.isNaN(betTime.getTime())) return false;

          if (datePreset === 'TODAY' && betTime.getTime() < todayStart.getTime()) return false;
          if (datePreset === '7D' && betTime.getTime() < now - (7 * 24 * 60 * 60 * 1000)) return false;
          if (datePreset === '30D' && betTime.getTime() < now - (30 * 24 * 60 * 60 * 1000)) return false;
        }

        if (!normalizedSearch) return true;

        const betKindLabel = getBetKindLabel(bet.betKind).toLowerCase();
        const rows = bet.rows ?? [];
        const haystack = [
          bet.status,
          betKindLabel,
          bet.declineReason,
          ...rows.map((row) => [
            row.eventName,
            row.productName,
            row.marketType,
            row.oddsName,
            row.declineReason,
            row.status,
            getBetKindLabel(row.betKind ?? bet.betKind),
          ].join(' ')),
        ]
          .join(' ')
          .toLowerCase();

        return haystack.includes(normalizedSearch);
      })
      .sort((left, right) => {
        const leftTime = new Date(left.timestamp).getTime() || 0;
        const rightTime = new Date(right.timestamp).getTime() || 0;
        return sortOrder === 'DESC' ? rightTime - leftTime : leftTime - rightTime;
      });
  }, [betsList, statusFilter, datePreset, searchTerm, sortOrder]);

  useEffect(() => {
    setVisibleCount(20);
  }, [statusFilter, datePreset, searchTerm, sortOrder]);

  const visibleBets = filteredAndSortedBets.slice(0, visibleCount);
  const hasMoreBets = visibleCount < filteredAndSortedBets.length;

  const toggleExpandedBet = (betId) => {
    setExpandedBets((currentExpandedBets) => ({
      ...currentExpandedBets,
      [betId]: !currentExpandedBets[betId],
    }));
  };

  const getStatusColorClass = (status) => {
    switch (status) {
      case 'PENDING':
        return 'text-warning';
      case 'CONFIRMED':
        return 'text-info';
      case 'DECLINED':
        return 'text-danger';
      case 'WIN':
        return 'text-success';
      case 'LOSS':
        return 'text-danger';
      case 'VOID':
        return 'text-secondary';
      default:
        return 'text-success';
    }
  };

  const renderedBets = visibleBets.map((bet) => {
    const betKind = normalizeBetKind(bet.betKind);
    const betKindLabel = getBetKindLabel(betKind);
    const rows = bet.rows ?? [];
    const totalOdds = rows.reduce((accumulator, row) => accumulator * (row.oddsValue ?? 1), 1);
    const isExpanded = !!expandedBets[bet._id];
    const hasHiddenRows = rows.length > 4;
    const rowsToRender = hasHiddenRows && !isExpanded ? rows.slice(0, 4) : rows;
    const betStatusColor = getStatusColorClass(bet.status);

    return <div className="card mb-2 my-bets-card" key={bet._id ?? bet.slipId}>
      <div className="card-body">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
          <div>
            <h5 className="card-title mb-1">{formatTimestamp(bet.timestamp)}</h5>
            <div className="my-bets-badges">
              <span className={`bet-kind-badge bet-kind-badge--${betKind.toLowerCase()}`}>{betKindLabel}</span>
              <span className={`my-bets-status ${betStatusColor}`}>{bet.status}</span>
            </div>
          </div>
          <div className="text-secondary small">Slip {bet.slipId}</div>
        </div>

        {bet.declineReason ? <div className="my-bets-note my-bets-note--danger">Declined: {formatDeclineReason(bet.declineReason)}</div> : null}

        <div className="card-subtitle row my-bets-row my-bets-row--header">
          <div className="col-5 col-md-4">Event / Time</div>
          <div className="col-3 col-md-3">Market</div>
          <div className="col-2 col-md-3">Selection</div>
          <div className="col-2 col-md-2 text-end">Odds / Outcome</div>
        </div>

        {rowsToRender.map((row) => {
          const rowKind = normalizeBetKind(row.betKind ?? betKind);
          const rowOutcome = formatRowOutcome(row);
          const rowColor = row.status === 'WIN' ? ' text-success' : row.status === 'LOSS' ? ' text-danger' : '';
          const productLabel = rowKind === 'LIVE'
            ? (row.productName || formatLiveMarketType(row.marketType))
            : row.productName;
          const winningSelection = typeof row.winningSelection === 'string' ? row.winningSelection.trim() : '';
          const selectionLabel = winningSelection && row.status !== 'NOT_SETTLED'
            ? `${row.oddsName} (winner: ${winningSelection})`
            : row.oddsName;

          return <div className="row my-bets-row" key={row._id || row.id}>
            <div className={`col-5 col-md-4${rowColor}`}>
              <div className="text-truncate" title={row.eventName}>{row.eventName}</div>
              <div className="my-bets-event-time">Event time: {formatRowTimestamp(row.eventTime ?? row.timestamp)}</div>
            </div>
            <div className={`col-3 col-md-3${rowColor}`}>
              <div>{productLabel}</div>
              <div className="my-bets-market-meta">
                <span className={`bet-kind-badge bet-kind-badge--${rowKind.toLowerCase()}`}>{getBetKindLabel(rowKind)}</span>
                {rowKind === 'LIVE' && row.marketType ? <span>{formatLiveMarketType(row.marketType)}</span> : null}
              </div>
              {row.declineReason ? <div className="my-bets-note my-bets-note--danger">{formatDeclineReason(row.declineReason)}</div> : null}
            </div>
            <div className={`col-2 col-md-3${rowColor}`}>{selectionLabel}</div>
            <div className={`col-2 col-md-2 text-end${rowColor}`}>
              <div>{row.oddsValue}</div>
              <div className="my-bets-outcome">{rowOutcome}</div>
            </div>
          </div>;
        })}

        {hasHiddenRows ? (
          <button
            type="button"
            className="btn btn-sm my-bets-expand mt-2"
            onClick={() => toggleExpandedBet(bet._id)}
          >
            {isExpanded ? 'Show less selections' : `Show all selections (${rows.length})`}
          </button>
        ) : null}
      </div>
      <div className="card-body my-bets-footer">
        <span>Wager: {bet.wager}</span>
        <span>Total odds: {totalOdds.toFixed(2)}</span>
        <span>Possible win: {(totalOdds * bet.wager).toFixed(2)} Stanbucks</span>
      </div>
    </div>;
  });

  return <div className="my-bets-board">
    <section className="card my-bets-toolbar mb-2">
      <div className="card-body d-grid gap-2">
        <div className="d-flex flex-wrap gap-2">
          {['ALL', 'PENDING', 'CONFIRMED', 'WIN', 'LOSS', 'VOID', 'DECLINED'].map((status) => (
            <button
              key={status}
              type="button"
              className={`btn btn-sm ${statusFilter === status ? 'btn-primary' : 'btn-shell my-bets-filter'}`}
              onClick={() => setStatusFilter(status)}
            >
              {status}
            </button>
          ))}
        </div>
        <div className="d-flex flex-wrap gap-2 align-items-center">
          <input
            type="search"
            className="form-control my-bets-search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search event, market, selection, or bet kind"
          />
          <select className="form-select my-bets-select" value={datePreset} onChange={(event) => setDatePreset(event.target.value)}>
            <option value="ALL">All dates</option>
            <option value="TODAY">Today</option>
            <option value="7D">Last 7 days</option>
            <option value="30D">Last 30 days</option>
          </select>
          <button
            type="button"
            className="btn btn-sm btn-shell my-bets-filter"
            onClick={() => setSortOrder((currentSortOrder) => (currentSortOrder === 'DESC' ? 'ASC' : 'DESC'))}
          >
            {sortOrder === 'DESC' ? 'Newest first' : 'Oldest first'}
          </button>
        </div>
        <small className="text-secondary">{filteredAndSortedBets.length} bets found</small>
      </div>
    </section>

    {renderedBets.length === 0 ? (
      <div className="card card-body empty-state-card">No bets match the active filters.</div>
    ) : renderedBets}

    {hasMoreBets ? (
      <div className="d-grid mt-2">
        <button type="button" className="btn btn-shell my-bets-load-more" onClick={() => setVisibleCount((currentVisibleCount) => currentVisibleCount + 20)}>
          Load more
        </button>
      </div>
    ) : null}
  </div>;
};

export default HandleMyBetsList;
