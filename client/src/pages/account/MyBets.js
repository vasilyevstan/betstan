import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import useMyBets from '../../hook/useMyBets';
import CashBackPanel from './CashBackPanel';
import { acceptedOddsForBet, cashBackReason, formatMinor, parseStakeMinor, possibleReturn } from '../../cashBackUtils';
import {
  formatDeclineReason,
  formatLegacyLiveSelectionLabel,
  formatLiveMarketType,
  formatRowOutcome,
  getBetKindLabel,
  isTerminalBetStatus,
  normalizeBetKind,
} from '../../liveBettingUtils';

const formatTimestamp = (value, fallback = 'Unknown time') => {
  const parsed = new Date(value ?? '');
  return Number.isNaN(parsed.getTime()) ? fallback : format(parsed, 'MMMM do, yyyy H:mm');
};

const formatRowTimestamp = (value) => formatTimestamp(value, '—');

const statusLabel = (status) => status === 'CASH_BACK' ? 'CASH BACK' : status;

const HandleMyBetsList = ({ currentUser, isCurrentUserResolved = true, onAuthRefresh }) => {
  const loginHref = `/login${window.location.search}`;
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [betKindFilter, setBetKindFilter] = useState('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [datePreset, setDatePreset] = useState('ALL');
  const [sortOrder, setSortOrder] = useState('DESC');
  const [visibleCount, setVisibleCount] = useState(20);
  const [expandedBets, setExpandedBets] = useState({});
  const [feedback, setFeedback] = useState('');
  const feedbackRef = useRef(null);
  const focusedBeforeUpdate = useRef(null);
  const beforeUpdate = useCallback(() => {
    const active = document.activeElement;
    focusedBeforeUpdate.current = active?.closest?.('.my-bets-card') ? active : null;
  }, []);
  const onDecision = useCallback((operation) => {
    if (operation.state === 'ACCEPTED') {
      setFeedback(`${operation.receipt.mode === 'FULL' ? 'Full' : 'Partial'} cash back recorded: ${formatMinor(operation.receipt.quote.closedStakeMinor)} Stanbucks closed; nominal return ${formatMinor(operation.receipt.quote.returnMinor)} Stanbucks. Current filters are unchanged. Receipts remain in cash-back history.`);
    } else if (operation.state === 'REJECTED') {
      setFeedback(`Cash back rejected. ${cashBackReason(operation.receipt.reason)}`);
    }
  }, []);
  const model = useMyBets({ ownerId: currentUser?.id ?? '', onAuthRefresh, onBeforeUpdate: beforeUpdate, onDecision });
  const betsList = model.bets;

  useEffect(() => { setFeedback(''); setExpandedBets({}); }, [currentUser?.id]);
  useLayoutEffect(() => {
    const previousFocus = focusedBeforeUpdate.current;
    focusedBeforeUpdate.current = null;
    if (previousFocus && !document.contains(previousFocus)) {
      setFeedback((current) => current || 'Bets updated. The focused slip no longer matches the current view. Your filters are unchanged.');
      feedbackRef.current?.focus();
    }
  }, [betsList]);

  const filteredAndSortedBets = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const now = Date.now();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return betsList
      .filter((bet) => {
        if (statusFilter !== 'ALL' && bet.status !== statusFilter) return false;
        if (betKindFilter !== 'ALL' && normalizeBetKind(bet.betKind) !== betKindFilter) return false;

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
          statusLabel(bet.status),
          bet.cashBackFinancial?.cumulativeClosedStakeMinor > 0 ? 'partial cash back' : '',
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
  }, [betsList, statusFilter, betKindFilter, datePreset, searchTerm, sortOrder]);

  useEffect(() => {
    setVisibleCount(20);
  }, [statusFilter, betKindFilter, datePreset, searchTerm, sortOrder]);

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
      case 'CASH_BACK':
        return 'cash-back-status';
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
    const betKey = bet._id ?? bet.slipId;
    const isExpanded = !!expandedBets[betKey];
    const hasHiddenRows = rows.length > 4;
    const rowsToRender = hasHiddenRows && !isExpanded ? rows.slice(0, 4) : rows;
    const betStatusColor = getStatusColorClass(bet.status);
    const financial = bet.cashBackFinancial;
    const terminal = isTerminalBetStatus(bet.status);
    const settled = ['WIN', 'LOSS', 'VOID'].includes(bet.status);
    const remainder = financial?.remainingStakeMinor ?? parseStakeMinor(String(bet.wager));
    const acceptedOdds = acceptedOddsForBet(bet);

    return <div className="card mb-2 my-bets-card" key={betKey} data-slip-id={bet.slipId}>
      <div className="card-body">
        <div className="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-3">
          <div>
            <h2 className="card-title h5 mb-1">{formatTimestamp(bet.timestamp)}</h2>
            <div className="my-bets-badges">
              <span className={`bet-kind-badge bet-kind-badge--${betKind.toLowerCase()}`}>{betKindLabel}</span>
              <span className={`my-bets-status ${betStatusColor}`}>{statusLabel(bet.status)}</span>
              {financial?.cumulativeClosedStakeMinor > 0 && bet.status !== 'CASH_BACK'
                ? <span className="cash-back-badge">PARTIAL CASH BACK</span> : null}
            </div>
          </div>
          <div className="text-secondary small">{rows.length === 1 ? 'Single' : `Accumulator · ${rows.length} selections`}</div>
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
          const rowOutcome = formatRowOutcome(row, bet.status);
          const rowColor = row.status === 'WIN' ? ' text-success' : row.status === 'LOSS' ? ' text-danger' : '';
          const productLabel = rowKind === 'LIVE'
            ? (row.productName || formatLiveMarketType(row.marketType))
            : row.productName;
          const winningSelection = typeof row.winningSelection === 'string' ? row.winningSelection.trim() : '';
          // `oddsName` describes the bettor's own pick (uses `row.side`); `winningSelection`
          // describes whoever actually won, which is a distinct field (`row.winningSide`) --
          // never the bettor's own side, since on a LOSS row those two are different.
          const oddsNameLabel = formatLegacyLiveSelectionLabel(row.oddsName, row, 'selected');
          const winningSelectionLabel = winningSelection ? formatLegacyLiveSelectionLabel(row.winningSelection, row, 'winning') : '';
          const selectionLabel = winningSelection && row.status !== 'NOT_SETTLED'
            ? `${oddsNameLabel} (winner: ${winningSelectionLabel})`
            : oddsNameLabel;

          return <div className="row my-bets-row" key={row._id || row.id}>
            <div className={`col-5 col-md-4${rowColor}`} data-label="Event / Time">
              <div className="my-bets-event-name">{row.eventName}</div>
              <div className="my-bets-event-time">Event time: {formatRowTimestamp(row.eventTime ?? row.timestamp)}</div>
            </div>
            <div className={`col-3 col-md-3${rowColor}`} data-label="Market">
              <div>{productLabel}</div>
              <div className="my-bets-market-meta">
                <span className={`bet-kind-badge bet-kind-badge--${rowKind.toLowerCase()}`}>{getBetKindLabel(rowKind)}</span>
                {rowKind === 'LIVE' && row.marketType ? <span>{formatLiveMarketType(row.marketType)}</span> : null}
              </div>
              {row.declineReason ? <div className="my-bets-note my-bets-note--danger">{formatDeclineReason(row.declineReason)}</div> : null}
            </div>
            <div className={`col-2 col-md-3${rowColor}`} data-label="Selection">{selectionLabel}</div>
            <div className={`col-2 col-md-2 text-end${rowColor}`} data-label="Odds / Outcome">
              <div>{row.oddsValue}</div>
              <div className="my-bets-outcome">{rowOutcome}</div>
            </div>
          </div>;
        })}

        {hasHiddenRows ? (
          <button
            type="button"
            className="btn btn-sm my-bets-expand mt-2"
            aria-expanded={isExpanded}
            onClick={() => toggleExpandedBet(betKey)}
          >
            {isExpanded ? 'Show less selections' : `Show all selections (${rows.length})`}
          </button>
        ) : null}
      </div>
      <div className="card-body my-bets-footer">
        <span>Original wager: {financial ? formatMinor(financial.originalStakeMinor) : bet.wager} Stanbucks</span>
        <span>Accepted total odds: {totalOdds.toFixed(2)}</span>
        <span>{bet.status === 'DECLINED' ? 'Unaccepted stake' : settled ? 'Remainder stake that settled' : 'Remaining stake'}: {remainder === null ? bet.wager : formatMinor(remainder)} Stanbucks</span>
        {terminal ? <span>Active exposure: 0.00 Stanbucks</span>
          : <span>Possible return on remaining stake: {remainder === null ? (totalOdds * bet.wager).toFixed(2) : possibleReturn(remainder, acceptedOdds)} Stanbucks</span>}
        {financial?.cumulativeClosedStakeMinor > 0 ? <>
          <span>Cumulative closed principal: {formatMinor(financial.cumulativeClosedStakeMinor)} Stanbucks</span>
          <span>Cumulative recorded nominal return: {formatMinor(financial.cumulativeReturnMinor)} Stanbucks</span>
        </> : null}
      </div>
      <div className="card-body">
        <CashBackPanel bet={bet} ownerId={currentUser?.id} model={model} />
      </div>
    </div>;
  });

  if (!currentUser?.id) {
    return <div className="card card-body empty-state-card" role="status">
      {!isCurrentUserResolved ? 'Loading your account…' : <>Log in to view your bets and recover cash-back operations. <a href={loginHref}>Log in</a></>}
    </div>;
  }

  return <div className="my-bets-board">
    <div ref={feedbackRef} className="my-bets-feedback" tabIndex={-1} role="status">{feedback}</div>
    <section className="card my-bets-toolbar mb-2">
      <div className="card-body d-grid gap-2">
        <div className="my-bets-filter-groups">
          <div className="my-bets-filter-group" role="group" aria-label="Filter bets by status">
            <span className="my-bets-filter-label">Status</span>
            {['ALL', 'PENDING', 'CONFIRMED', 'CASH_BACK', 'WIN', 'LOSS', 'VOID', 'DECLINED'].map((status) => (
              <button
                aria-pressed={statusFilter === status}
                key={status}
                type="button"
                className={`btn btn-sm ${statusFilter === status ? 'btn-primary' : 'btn-shell my-bets-filter'}`}
                onClick={() => setStatusFilter(status)}
              >
                {statusFilter === status ? <span aria-hidden="true">✓ </span> : null}
                {statusLabel(status)}
              </button>
            ))}
          </div>
          <div className="my-bets-filter-group" role="group" aria-label="Filter bets by type">
            <span className="my-bets-filter-label">Bet type</span>
            {[
              { value: 'ALL', label: 'ALL TYPES' },
              { value: 'PRE_MATCH', label: 'PRE-MATCH' },
              { value: 'LIVE', label: 'LIVE' },
            ].map(({ value, label }) => (
              <button
                aria-pressed={betKindFilter === value}
                key={value}
                type="button"
                className={`btn btn-sm ${betKindFilter === value ? 'btn-primary' : 'btn-shell my-bets-filter'}`}
                onClick={() => setBetKindFilter(value)}
              >
                {betKindFilter === value ? <span aria-hidden="true">✓ </span> : null}
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="d-flex flex-wrap gap-2 align-items-center">
          <input
            type="search"
            aria-label="Search bets"
            className="form-control my-bets-search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search event, market, selection, or bet kind"
          />
          <select aria-label="Filter bets by date" className="form-select my-bets-select" value={datePreset} onChange={(event) => setDatePreset(event.target.value)}>
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
          <button type="button" className="btn btn-shell cash-back-control"
            disabled={model.listStatus.refreshing || model.listStatus.permission} onClick={() => void model.refresh()}>
            Refresh bets
          </button>
        </div>
        <small className="text-secondary">{filteredAndSortedBets.length} bets found</small>
      </div>
    </section>

    {model.listStatus.loading ? <div className="card card-body" role="status">Loading My Bets…</div> : null}
    {!model.listStatus.loading && model.listStatus.refreshing ? <p role="status">Refreshing bets…</p> : null}
    {model.listStatus.error ? <div role="alert" className="card card-body cash-back-error">
      {model.listStatus.error}
      {model.listStatus.permission ? <a href={loginHref}>Log in</a> : null}
    </div> : null}
    {model.storageError ? <p role="alert" className="cash-back-error">{model.storageError}</p> : null}
    {renderedBets.length === 0 && !model.listStatus.loading && !model.listStatus.error ? (
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
