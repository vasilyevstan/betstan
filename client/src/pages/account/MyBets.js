import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import useMyBets from '../../hook/useMyBets';
import CashBackPanel, { emptyCashBackDraft } from './CashBackPanel';
import { acceptedOddsForBet, cashBackReason, formatMinor, isFinalOperation, parseStakeMinor, possibleReturn } from '../../cashBackUtils';
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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [drafts, setDrafts] = useState({ ownerId: currentUser?.id, values: {} });
  const boardId = useId();
  const updateDraft = useCallback((slipId, update) => {
    setDrafts((old) => {
      const values = old.ownerId === currentUser?.id ? old.values : {};
      return { ownerId: currentUser?.id, values: {
        ...values, [slipId]: update(values[slipId] ?? emptyCashBackDraft),
      } };
    });
  }, [currentUser?.id]);
  const [feedback, setFeedback] = useState('');
  const feedbackRef = useRef(null);
  const focusedBeforeUpdate = useRef(null);
  const beforeUpdate = useCallback(() => {
    const active = document.activeElement;
    focusedBeforeUpdate.current = active?.closest?.('.my-bets-card, .my-bets-pending') ? active : null;
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

  useEffect(() => {
    setFeedback('');
    setExpandedBets({});
    setDrafts({ ownerId: currentUser?.id, values: {} });
  }, [currentUser?.id]);
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
  const hiddenPending = Object.values(drafts.ownerId === currentUser?.id ? model.attempts : {}).filter((attempt) => attempt.confirmRequest
    && !isFinalOperation(model.operations[attempt.clientOperationId])
    && !visibleBets.some((bet) => bet.slipId === attempt.slipId));

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
    const betKey = `${currentUser?.id}:${bet.slipId}`;
    const isExpanded = !!expandedBets[betKey];
    const detailsId = `${boardId}-${bet.slipId}`;
    const firstRow = rows[0];
    const betStatusColor = getStatusColorClass(bet.status);
    const financial = bet.cashBackFinancial;
    const terminal = isTerminalBetStatus(bet.status);
    const settled = ['WIN', 'LOSS', 'VOID'].includes(bet.status);
    const remainder = financial?.remainingStakeMinor ?? parseStakeMinor(String(bet.wager));
    const acceptedOdds = acceptedOddsForBet(bet);

    return <div className="card mb-2 my-bets-card" key={betKey} data-slip-id={bet.slipId}>
      <div className="card-body my-bets-summary">
        <div className="my-bets-summary-heading">
            <div className="my-bets-badges">
              <span className={`bet-kind-badge bet-kind-badge--${betKind.toLowerCase()}`}>{betKindLabel}</span>
              <span className={`my-bets-status ${betStatusColor}`}>{statusLabel(bet.status)}</span>
              {financial?.cumulativeClosedStakeMinor > 0 && bet.status !== 'CASH_BACK'
                ? <span className="cash-back-badge">PARTIAL CASH BACK</span> : null}
              <span>{rows.length === 1 ? 'Single' : `Accumulator · ${rows.length} selections`}</span>
            </div>
            <span className="my-bets-placed">Placed {formatTimestamp(bet.timestamp)}</span>
        </div>
        <h2 className="h5 my-bets-event-name">{firstRow?.eventName || 'Bet selections'}</h2>
        {firstRow ? <p className="my-bets-pick">
          {firstRow.productName || formatLiveMarketType(firstRow.marketType)} · {formatLegacyLiveSelectionLabel(firstRow.oddsName, firstRow, 'selected')}
          {rows.length > 1 ? <strong> · Plus {rows.length - 1} more selections</strong> : null}
        </p> : null}
        <div className="my-bets-position">
          <span>Original wager: <strong>{financial ? formatMinor(financial.originalStakeMinor) : bet.wager} Stanbucks</strong></span>
          <span>{bet.status === 'DECLINED' ? 'Unaccepted stake' : settled ? 'Remainder stake that settled' : 'Remaining stake'}: <strong>{remainder === null ? bet.wager : formatMinor(remainder)} Stanbucks</strong></span>
          {terminal ? <span>Active exposure: <strong>0.00 Stanbucks</strong></span> : null}
        </div>

        {bet.declineReason ? <div className="my-bets-note my-bets-note--danger">Declined: {formatDeclineReason(bet.declineReason)}</div> : null}
        <button type="button" className="btn btn-shell my-bets-expand cash-back-control"
          aria-expanded={isExpanded} aria-controls={detailsId} onClick={() => toggleExpandedBet(betKey)}>
          {isExpanded ? 'Hide bet details' : `Bet details · ${rows.length} selection${rows.length === 1 ? '' : 's'}`}
        </button>
      </div>
      {isExpanded ? <div id={detailsId} className="card-body my-bets-details">
        <h3 className="h6">All selections and financial details</h3>
        <div className="card-subtitle row my-bets-row my-bets-row--header">
          <div className="col-5 col-md-4">Event / Time</div>
          <div className="col-3 col-md-3">Market</div>
          <div className="col-2 col-md-3">Selection</div>
          <div className="col-2 col-md-2 text-end">Odds / Outcome</div>
        </div>

        {rows.map((row) => {
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

      <div className="my-bets-footer">
        <span>Accepted total odds: {totalOdds.toFixed(2)}</span>
        {!terminal ? <span>Possible return on remaining stake: {remainder === null ? (totalOdds * bet.wager).toFixed(2) : possibleReturn(remainder, acceptedOdds)} Stanbucks</span> : null}
        {financial?.cumulativeClosedStakeMinor > 0 ? <>
          <span>Cumulative closed principal: {formatMinor(financial.cumulativeClosedStakeMinor)} Stanbucks</span>
          <span>Cumulative recorded nominal return: {formatMinor(financial.cumulativeReturnMinor)} Stanbucks</span>
        </> : null}
      </div>
      </div> : null}
      <div className="card-body my-bets-cash-back">
        <CashBackPanel bet={bet} ownerId={currentUser?.id} model={model}
          draft={drafts.ownerId === currentUser?.id ? drafts.values[bet.slipId] ?? emptyCashBackDraft : emptyCashBackDraft}
          onDraftChange={updateDraft} />
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
      <div className="card-body">
        <div className="my-bets-find">
          <h1 className="h5">My bets</h1>
          <input type="search" aria-label="Search bets" className="form-control my-bets-search"
            value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search event, market or selection" />
          <button type="button" className="btn btn-shell cash-back-control"
            aria-expanded={filtersOpen} aria-controls={`${boardId}-filters`} onClick={() => setFiltersOpen(!filtersOpen)}>
            Filters
          </button>
          <button type="button" className="btn btn-shell cash-back-control"
            disabled={model.listStatus.refreshing || model.listStatus.permission} onClick={() => void model.refresh()}>
            Refresh bets
          </button>
        </div>
        <div className="my-bets-filter-context">
          <span role="status">{filteredAndSortedBets.length} bets found</span>
          <span>{statusFilter === 'ALL' ? 'All statuses' : statusLabel(statusFilter)} · {betKindFilter === 'ALL' ? 'All types' : getBetKindLabel(betKindFilter)} · {{ ALL: 'All dates', TODAY: 'Today', '7D': 'Last 7 days', '30D': 'Last 30 days' }[datePreset]} · {sortOrder === 'DESC' ? 'Newest first' : 'Oldest first'}</span>
          {statusFilter !== 'ALL' || betKindFilter !== 'ALL' || datePreset !== 'ALL' || searchTerm ? <button
            type="button" className="btn btn-shell cash-back-control" onClick={() => {
              setStatusFilter('ALL'); setBetKindFilter('ALL'); setDatePreset('ALL'); setSearchTerm('');
            }}>Clear filters</button> : null}
        </div>
        <div id={`${boardId}-filters`} hidden={!filtersOpen} className="my-bets-filter-disclosure">
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
        </div>
        </div>
      </div>
    </section>

    {model.listStatus.loading ? <div className="card card-body" role="status">Loading My Bets…</div> : null}
    {!model.listStatus.loading && model.listStatus.refreshing ? <p role="status">Refreshing bets…</p> : null}
    {model.listStatus.error ? <div role="alert" className="card card-body cash-back-error">
      {model.listStatus.error}
      {model.listStatus.permission ? <a href={loginHref}>Log in</a> : null}
    </div> : null}
    {model.storageError ? <p role="alert" className="cash-back-error">{model.storageError}</p> : null}
    {hiddenPending.length ? <section className="card card-body my-bets-pending" aria-label="Pending cash-back confirmations outside this view">
      <h2 className="h6">Cash-back confirmations outside this view</h2>
      <p>Your filters are unchanged. These confirmations still need a durable decision.</p>
      {hiddenPending.map((attempt) => {
        const pendingBet = betsList.find((bet) => bet.slipId === attempt.slipId);
        const operation = model.operations[attempt.clientOperationId];
        const quote = operation?.quote;
        return <div key={attempt.clientOperationId} className="my-bets-pending-item">
          <span>{pendingBet?.rows?.[0]?.eventName || 'Previously submitted bet'} · {pendingBet?.rows?.length > 1 ? `${pendingBet.rows.length} selections · ` : ''}{attempt.quoteRequest.portion.mode === 'FULL' ? 'Full' : 'Partial'} confirmation pending
            {quote ? ` · ${formatMinor(quote.closedStakeMinor)} Stanbucks to close` : ''}
            {pendingBet ? ` · Placed ${formatTimestamp(pendingBet.timestamp)}` : ''}
          </span>
          <button type="button" className="btn btn-shell cash-back-control"
            aria-disabled={Boolean(model.network[attempt.clientOperationId]?.busy)}
            onClick={() => { if (!model.network[attempt.clientOperationId]?.busy) model.retry(attempt.clientOperationId); }}>
            Check confirmation status
          </button>
          {model.network[attempt.clientOperationId]?.error ? <p role="alert" className="cash-back-error">{model.network[attempt.clientOperationId].error}</p> : null}
        </div>;
      })}
    </section> : null}
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
