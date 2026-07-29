
import React,  { useState, useEffect, useMemo }  from "react";
import { format } from "date-fns";
import axios from "axios";

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
        const res = await axios.get('/api/bet');
        const data = res.data;
        setBets(data && typeof data === 'object' ? data : {});
      } catch (error) {
        // ignore
      }
    }

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

          const rows = bet.rows ?? [];
          const haystack = [
            bet.status,
            ...rows.map((row) => `${row.eventName} ${row.productName} ${row.oddsName}`),
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
      setExpandedBets((previous) => ({
        ...previous,
        [betId]: !previous[betId],
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
        default:
          return 'text-success';
      }
    };

    const renderedBets = visibleBets.map((bet) => {
      const rows = bet.rows ?? [];
      const totalOdds = rows.reduce((accumulator, row) => accumulator * (row.oddsValue ?? 1), 1);
      const isExpanded = !!expandedBets[bet._id];
      const hasHiddenRows = rows.length > 4;
      const rowsToRender = hasHiddenRows && !isExpanded ? rows.slice(0, 4) : rows;

      const rowHeader = <div className="card-subtitle row my-bets-row my-bets-row--header" key={bet._id + '_row_header'}>
        <div className="col-5 col-md-4">Event / Time</div>
        <div className="col-3 col-md-3">Product</div>
        <div className="col-2 col-md-3">Selection</div>
        <div className="col-2 col-md-2 text-end">Odds</div>
      </div>;

      const renderedRows = rowsToRender.map((row) => {
        const rowColor = row.status === 'WIN' ? ' text-success' : row.status === 'LOSS' ? ' text-danger' : '';
        const eventTimeDate = new Date(row.timestamp);
        const eventTime = Number.isNaN(eventTimeDate.getTime())
          ? '—'
          : format(eventTimeDate, "MMM d, yyyy H:mm");
        const winningSelection = typeof row.winningSelection === 'string' ? row.winningSelection.trim() : '';
        const isSettled = row.status === 'WIN' || row.status === 'LOSS';
        const selectionLabel = isSettled && winningSelection
          ? `${row.oddsName} (winner: ${winningSelection})`
          : row.oddsName;

        return <div className="row my-bets-row" key={row._id || row.id}>
          <div className={"col-5 col-md-4" + rowColor}>
            <div className="text-truncate" title={row.eventName}>{row.eventName}</div>
            <div className="my-bets-event-time">Event time: {eventTime}</div>
          </div>
          <div className={"col-3 col-md-3" + rowColor}>{row.productName}</div>
          <div className={"col-2 col-md-3" + rowColor}>{selectionLabel}</div>
          <div className={"col-2 col-md-2 text-end" + rowColor}>{row.oddsValue}</div>
        </div>;
      });

      const betTimeDate = new Date(bet.timestamp);
      const betTime = Number.isNaN(betTimeDate.getTime()) ? 'Unknown time' : format(betTimeDate, "MMMM do, yyyy H:mm");
      const betStatusColor = getStatusColorClass(bet.status);

      return <div className="card mb-2 my-bets-card" key={bet._id}>
              <div className="card-body">
                  <h5 className="card-title d-flex justify-content-between align-items-start gap-2">
                    <div>{betTime}</div>
                    <div className={`my-bets-status ${betStatusColor}`}>{bet.status}</div>
                  </h5>
                  <div>{rowHeader}{renderedRows}</div>
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
            {['ALL', 'PENDING', 'CONFIRMED', 'WIN', 'LOSS', 'DECLINED'].map((status) => (
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
              placeholder="Search event, product, or selection"
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
              onClick={() => setSortOrder((previous) => previous === 'DESC' ? 'ASC' : 'DESC')}
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
          <button type="button" className="btn btn-shell my-bets-load-more" onClick={() => setVisibleCount((previous) => previous + 20)}>
            Load more
          </button>
        </div>
      ) : null}
    </div>;
};

export default HandleMyBetsList;