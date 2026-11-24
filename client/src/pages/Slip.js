import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { format } from 'date-fns';
import useSlipBoards from '../hook/useSlipBoards';
import {
  BET_KIND,
  formatDeclineReason,
  formatMarketStatus,
  getBetKindLabel,
} from '../liveBettingUtils';
import { BOARD_KINDS, getBoardId, getRowId } from '../hook/useSlipBoards';
import MarketSelections from '../components/MarketSelections';
import TabList from '../components/TabList';

const formatTimestamp = (value, fallback = '—') => {
  const parsed = new Date(value ?? '');
  return Number.isNaN(parsed.getTime()) ? fallback : format(parsed, 'MMM d, HH:mm');
};

const getBoardTitle = (betKind) => (
  betKind === BET_KIND.LIVE ? 'LIVE SLIP' : 'PRE-MATCH SLIP'
);

const getBoardPrompt = (betKind) => ({
  title: betKind === BET_KIND.LIVE ? 'Build your live slip' : 'Build your pre-match slip',
  body: betKind === BET_KIND.LIVE
    ? 'Choose an in-play market to keep live bets separate from pre-match picks.'
    : 'Pick pre-match odds from the events page to compose your slip.',
});

const getBoardStatusMessage = (betKind, boardState) => {
  if (!boardState?.isAwaitingDecision) {
    return null;
  }

  if (boardState.targetedStatus === 'DECLINED') {
    return betKind === BET_KIND.LIVE
      ? 'Review declined. Syncing the latest live quote…'
      : 'Review declined. Restoring the latest slip…';
  }

  return betKind === BET_KIND.LIVE
    ? 'Awaiting live moderation and approval…'
    : 'Awaiting pre-match approval…';
};

// Reasons that describe one selection (its price, market or event), never the ticket as a whole.
const SELECTION_DECLINE_REASONS = new Set([
  'STALE_QUOTE', 'MARKET_CLOSED', 'MARKET_SUSPENDED', 'INVALID_SELECTION',
  'EVENT_STARTED', 'EVENT_NOT_LIVE', 'EVENT_RESULTED',
]);

// A whole-ticket decline marks every row with the board's reason; show it once on the slip.
export const isWholeSlipDecline = (board, rows) => {
  const reason = board?.declineReason;
  if (!reason) return false;
  const flagged = rows.filter((row) => row?.moderation);
  if (flagged.length === 0) return true;
  return !SELECTION_DECLINE_REASONS.has(reason) && flagged.length === rows.length
    && flagged.every((row) => row.moderation.declineReason === reason);
};

const BoardModeration = ({ row }) => {
  if (!row?.moderation) {
    return null;
  }

  const moderation = row.moderation;

  return <div className="slip-row-card__moderation" role="note">
    <div className="fw-semibold text-danger">Declined: {formatDeclineReason(moderation.declineReason, moderation.reasonCodes)}</div>
    <div className="slip-row-card__moderation-meta">
      {typeof moderation.currentOdds === 'number' ? <span>Current quote {moderation.currentOdds}</span> : null}
      {typeof moderation.quoteVersion === 'number' ? <span>Quote v{moderation.quoteVersion}</span> : null}
      {moderation.marketStatus ? <span>{formatMarketStatus(moderation.marketStatus)}</span> : null}
    </div>
  </div>;
};

// Guests can build, edit and clear a slip; only a signed-in user can place it.
const LoginToBetButton = ({ uiVariant }) => {
  const navigate = useNavigate();
  const { search } = useLocation();

  return <button
    type="button"
    className={`btn w-100 mb-2 slip-action-primary slip-action-primary--${uiVariant}`}
    onClick={() => navigate({ pathname: '/login', search })}
  >
    Log in to bet
  </button>;
};

const SlipBoardPanel = ({
  betKind,
  board,
  boardState,
  error,
  hasLoadError,
  isGuest,
  onDeleteRow,
  onCleanBoard,
  onSubmitBoard,
  onWagerChange,
  uiVariant,
  wager,
}) => {
  const rows = Array.isArray(board?.rows) ? board.rows : [];
  const boardId = getBoardId(board);
  const isBusy = boardState?.isSubmitting || boardState?.isAwaitingDecision;
  const statusMessage = getBoardStatusMessage(betKind, boardState);
  const wholeSlipDecline = isWholeSlipDecline(board, rows);
  const moderationCount = wholeSlipDecline ? 0 : rows.filter((row) => row?.moderation).length;
  const totalOdds = rows.reduce((accumulator, row) => (
    accumulator * (Number(row?.oddsValue) || 1)
  ), 1);

  const possibleWin = Number(wager);
  const possibleWinValue = Number.isFinite(possibleWin)
    ? (possibleWin * totalOdds).toFixed(2)
    : null;

  if (rows.length === 0) {
    const prompt = getBoardPrompt(betKind);

    return <section
      className={`slip-board slip-board--${uiVariant} slip-board--kind-${betKind.toLowerCase()}`}
      aria-labelledby={`slip-board-title-${betKind}`}
    >
      <div className="slip-board__heading">
        <div id={`slip-board-title-${betKind}`} className="slip-board__title">{getBoardTitle(betKind)}</div>
        <span className={`bet-kind-badge bet-kind-badge--${betKind.toLowerCase()}`}>{getBetKindLabel(betKind)}</span>
      </div>
      {/* The prompt is for a board that loaded empty; a failed load says nothing about the board. */}
      {hasLoadError ? null : <div className="card card-body empty-state-card slip-board__empty-state">
        <div className="slip-board__empty-main">{prompt.title}</div>
        <small className="text-secondary">{prompt.body}</small>
      </div>}
      {error ? <div className="alert alert-danger slip-board__error" role="alert">{error}</div> : null}
    </section>;
  }

  return <section
    className={`slip-board slip-board--${uiVariant} slip-board--kind-${betKind.toLowerCase()}`}
    aria-labelledby={`slip-board-title-${betKind}`}
  >
    <div className="slip-board__heading">
      <div>
        <div id={`slip-board-title-${betKind}`} className="slip-board__title">{getBoardTitle(betKind)}</div>
        <div className="slip-board__meta">
          <span className={`bet-kind-badge bet-kind-badge--${betKind.toLowerCase()}`}>{getBetKindLabel(betKind)}</span>
          {moderationCount > 0 ? <span className="text-danger">{moderationCount} declined selection{moderationCount > 1 ? 's' : ''}</span> : null}
        </div>
      </div>
    </div>

    {wholeSlipDecline ? <div className="slip-board__decline" role="note">
      Declined: {formatDeclineReason(board.declineReason, board.reasonCodes)}
    </div> : null}

    {statusMessage ? <div className="slip-board__pending" aria-live="polite">{statusMessage}</div> : null}
    {error ? <div className="alert alert-danger slip-board__error" role="alert">{error}</div> : null}

    {rows.map((row) => {
      const rowId = getRowId(row);
      return <div className="card slip-row-card" key={rowId ?? `${row.eventId}-${row.oddsId}`}>
        <div className="card-body">
          <div className="card-subtitle text-muted d-flex justify-content-between align-items-start gap-2 mb-2">
            <div>
              <div>{row.eventName}</div>
              <div className="slip-row-card__meta">Kickoff {formatTimestamp(row.eventTime ?? row.timestamp)}</div>
            </div>
            <button
              aria-label={`Remove ${row.oddsName} from ${getBetKindLabel(betKind)} slip`}
              className="btn-close slip-row-close"
              disabled={isBusy}
              type="button"
              onClick={() => onDeleteRow(betKind, boardId, rowId)}
            ></button>
          </div>
          <div className="card-text d-flex justify-content-between align-items-start gap-2">
            <div>
              <div>{row.productName}</div>
              {row.marketBet ? <MarketSelections marketBet={row.marketBet} />
                : <div className="slip-row-card__selection">{row.oddsName}</div>}
            </div>
            <div className="slip-row-card__odds">{row.oddsValue}</div>
          </div>
          {row.marketBet ? <p className="market-help">
            Quote expires {formatTimestamp(row.marketBet.expiresAt)}. To refresh it, select the outcome again on the match card.
          </p> : null}
          {wholeSlipDecline ? null : <BoardModeration row={row} />}
        </div>
      </div>;
    })}

    <div className="d-flex justify-content-between mt-2 px-1 slip-board__summary">
      <small>Odds: {totalOdds.toFixed(2)}</small>
      <small>{possibleWinValue ? `Win ${possibleWinValue}` : 'Enter a wager to calculate a win'}</small>
    </div>

    <div className="card p-2 mt-2 slip-board__actions">
      <div className="form-group mb-2">
        <label className="form-label visually-hidden" htmlFor={`wager-${betKind}`}>Wager for {getBoardTitle(betKind)}</label>
        <input
          id={`wager-${betKind}`}
          value={wager}
          type="number"
          className="form-control"
          disabled={isBusy}
          placeholder="Wager"
          onChange={(event) => onWagerChange(betKind, event.target.value)}
        />
      </div>
      {isGuest ? <LoginToBetButton uiVariant={uiVariant} /> : <button
        type="button"
        className={`btn w-100 mb-2 slip-action-primary slip-action-primary--${uiVariant}`}
        disabled={isBusy}
        onClick={() => onSubmitBoard(betKind)}
      >
        {boardState?.isSubmitting ? 'Submitting…' : boardState?.isAwaitingDecision ? 'Awaiting review…' : 'BET!'}
      </button>}
      <button
        type="button"
        className={`btn w-100 slip-action-secondary slip-action-secondary--${uiVariant}`}
        disabled={isBusy}
        onClick={() => onCleanBoard(betKind, boardId)}
      >
        CLEAN
      </button>
    </div>
  </section>;
};

const getRowCount = (board) => (Array.isArray(board?.rows) ? board.rows.length : 0);

// A populated board is controls all the way down, but every one of them is disabled while it is
// busy. A panel with nothing focusable in it is reachable only if it is itself focusable.
const hasFocusableControls = (board, boardState) => (
  getRowCount(board) > 0 && !boardState?.isSubmitting && !boardState?.isAwaitingDecision
);

const HandleSlip = ({
  currentUser,
  isCurrentUserLookupFailed,
  isCurrentUserResolved,
  onBoardSubmitted,
  onSelectionKeysChange,
  refreshSignal,
  tabRequest,
  uiVariant,
}) => {
  const {
    boardStateByKind,
    boards,
    cleanBoard,
    deleteRow,
    errors,
    isGuest,
    isLoading,
    loadError,
    selectedSelectionKeys,
    submitBoard,
    updateWager,
    wagers,
  } = useSlipBoards({
    currentUser,
    isCurrentUserLookupFailed,
    isCurrentUserResolved,
    refreshSignal,
    onBoardSubmitted,
  });
  const [activeKind, setActiveKind] = useState(BET_KIND.PRE_MATCH);
  // The first-load rule below must never override a tab the user (or a placed pick) already chose.
  const tabChosenRef = useRef(false);
  const initialTabResolvedRef = useRef(false);
  // A request that predates this mount (the slip is unmounted on some routes) must not jump the tab.
  const handledTabRequestRef = useRef(tabRequest?.nonce);

  useEffect(() => {
    onSelectionKeysChange?.(selectedSelectionKeys);
  }, [onSelectionKeysChange, selectedSelectionKeys]);

  useEffect(() => {
    if (!tabRequest || tabRequest.nonce === handledTabRequestRef.current) {
      return;
    }

    handledTabRequestRef.current = tabRequest.nonce;
    if (BOARD_KINDS.includes(tabRequest.betKind)) {
      tabChosenRef.current = true;
      setActiveKind(tabRequest.betKind);
    }
  }, [tabRequest]);

  useEffect(() => {
    // A failed load has not shown the first boards yet, so the rule waits for one that did.
    if (isLoading || loadError || initialTabResolvedRef.current) {
      return;
    }

    initialTabResolvedRef.current = true;
    if (
      !tabChosenRef.current
      && getRowCount(boards[BET_KIND.LIVE]) > 0
      && getRowCount(boards[BET_KIND.PRE_MATCH]) === 0
    ) {
      setActiveKind(BET_KIND.LIVE);
    }
  }, [boards, isLoading, loadError]);

  const selectTab = (betKind) => {
    tabChosenRef.current = true;
    setActiveKind(betKind);
  };

  const tabs = BOARD_KINDS.map((betKind) => ({
    id: betKind,
    label: getBetKindLabel(betKind),
    count: getRowCount(boards[betKind]),
  }));

  // Both panels stay mounted (the inactive one is only hidden) so typed wagers and per-kind state survive tab switches.
  return <div className={`slip-boards slip-boards--${uiVariant}`}>
    {loadError ? <div className="alert alert-danger slip-board__error" role="alert">{loadError}</div> : null}
    <TabList idPrefix="slip" label="Slip" tabs={tabs} activeId={activeKind} onChange={selectTab} />
    {BOARD_KINDS.map((betKind) => {
      const isActive = betKind === activeKind;
      // WAI-ARIA tabs pattern: a shown panel with nothing focusable in it joins the tab sequence itself.
      const hasFocusableContent = !isLoading && hasFocusableControls(boards[betKind], boardStateByKind[betKind]);

      return <div
        key={betKind}
        role="tabpanel"
        id={`slip-panel-${betKind}`}
        aria-labelledby={`slip-tab-${betKind}`}
        hidden={!isActive}
        tabIndex={isActive && !hasFocusableContent ? 0 : undefined}
      >
        {isLoading ? (
          <section
            className={`slip-board slip-board--${uiVariant} slip-board--kind-${betKind.toLowerCase()}`}
            aria-busy="true"
            aria-labelledby={`loading-slip-board-${betKind}`}
          >
            <div id={`loading-slip-board-${betKind}`} className="slip-board__title">{getBoardTitle(betKind)}</div>
            <div className="card card-body empty-state-card">Loading {getBetKindLabel(betKind).toLowerCase()} slip…</div>
          </section>
        ) : (
          <SlipBoardPanel
            betKind={betKind}
            board={boards[betKind]}
            boardState={boardStateByKind[betKind]}
            error={errors[betKind]}
            hasLoadError={Boolean(loadError)}
            isGuest={isGuest}
            onCleanBoard={cleanBoard}
            onDeleteRow={deleteRow}
            onSubmitBoard={submitBoard}
            onWagerChange={updateWager}
            uiVariant={uiVariant}
            wager={wagers[betKind]}
          />
        )}
      </div>;
    })}
  </div>;
};

export default HandleSlip;
