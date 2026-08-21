import React, { useEffect } from 'react';
import { format } from 'date-fns';
import useSlipBoards from '../hook/useSlipBoards';
import {
  BET_KIND,
  formatDeclineReason,
  formatMarketStatus,
  getBetKindLabel,
} from '../liveBettingUtils';
import { BOARD_KINDS, getBoardId, getRowId } from '../hook/useSlipBoards';

const formatTimestamp = (value, fallback = '—') => {
  const parsed = new Date(value ?? '');
  return Number.isNaN(parsed.getTime()) ? fallback : format(parsed, 'MMM d, HH:mm');
};

const getBoardTitle = (betKind) => (
  betKind === BET_KIND.LIVE ? 'LIVE SLIP' : 'PRE-MATCH SLIP'
);

const getBoardPrompt = (betKind, currentUser) => {
  if (!currentUser) {
    return {
      title: 'Login and bet!',
      body: betKind === BET_KIND.LIVE
        ? 'Sign in to track live selections and place in-play bets.'
        : 'Sign in to track pre-match selections and place slips.',
    };
  }

  return {
    title: betKind === BET_KIND.LIVE ? 'Build your live board' : 'Build your pre-match board',
    body: betKind === BET_KIND.LIVE
      ? 'Choose an in-play market to keep live bets separate from pre-match picks.'
      : 'Pick pre-match odds from the events page to compose your slip.',
  };
};

const getBoardStatusMessage = (betKind, boardState) => {
  if (!boardState?.isAwaitingDecision) {
    return null;
  }

  if (boardState.targetedStatus === 'DECLINED') {
    return betKind === BET_KIND.LIVE
      ? 'Review declined. Syncing the latest live quote…'
      : 'Review declined. Restoring the latest board…';
  }

  return betKind === BET_KIND.LIVE
    ? 'Awaiting live moderation and approval…'
    : 'Awaiting pre-match approval…';
};

const BoardModeration = ({ row }) => {
  if (!row?.moderation) {
    return null;
  }

  const moderation = row.moderation;

  return <div className="slip-row-card__moderation" role="note">
    <div className="fw-semibold text-danger">Declined: {formatDeclineReason(moderation.declineReason)}</div>
    <div className="slip-row-card__moderation-meta">
      {typeof moderation.currentOdds === 'number' ? <span>Current quote {moderation.currentOdds}</span> : null}
      {typeof moderation.quoteVersion === 'number' ? <span>Quote v{moderation.quoteVersion}</span> : null}
      {moderation.marketStatus ? <span>{formatMarketStatus(moderation.marketStatus)}</span> : null}
    </div>
  </div>;
};

const SlipBoardPanel = ({
  betKind,
  board,
  boardState,
  currentUser,
  error,
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
  const moderationCount = rows.filter((row) => row?.moderation).length;
  const totalOdds = rows.reduce((accumulator, row) => (
    accumulator * (Number(row?.oddsValue) || 1)
  ), 1);

  const possibleWin = Number(wager);
  const possibleWinValue = Number.isFinite(possibleWin)
    ? (possibleWin * totalOdds).toFixed(2)
    : null;

  if (rows.length === 0) {
    const prompt = getBoardPrompt(betKind, currentUser);

    return <section
      className={`slip-board slip-board--${uiVariant} slip-board--kind-${betKind.toLowerCase()}`}
      aria-labelledby={`slip-board-title-${betKind}`}
    >
      <div className="slip-board__heading">
        <div id={`slip-board-title-${betKind}`} className="slip-board__title">{getBoardTitle(betKind)}</div>
        <span className={`bet-kind-badge bet-kind-badge--${betKind.toLowerCase()}`}>{getBetKindLabel(betKind)}</span>
      </div>
      <div className="card card-body empty-state-card slip-board__empty-state">
        <div className="slip-board__empty-main">{prompt.title}</div>
        <small className="text-secondary">{prompt.body}</small>
      </div>
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
          {moderationCount > 0 ? <span className="text-danger">{moderationCount} quote issue{moderationCount > 1 ? 's' : ''}</span> : null}
        </div>
      </div>
      {board?.declineReason ? <span className="slip-board__status text-danger">{formatDeclineReason(board.declineReason)}</span> : null}
    </div>

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
              <div className="slip-row-card__selection">{row.oddsName}</div>
            </div>
            <div className="slip-row-card__odds">{row.oddsValue}</div>
          </div>
          <BoardModeration row={row} />
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
      <button
        type="button"
        className={`btn w-100 mb-2 slip-action-primary slip-action-primary--${uiVariant}`}
        disabled={isBusy}
        onClick={() => onSubmitBoard(betKind)}
      >
        {boardState?.isSubmitting ? 'Submitting…' : boardState?.isAwaitingDecision ? 'Awaiting review…' : 'BET!'}
      </button>
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

const HandleSlip = ({ currentUser, onBoardSubmitted, onSelectionKeysChange, refreshSignal, uiVariant }) => {
  const {
    boardStateByKind,
    boards,
    cleanBoard,
    deleteRow,
    errors,
    isLoading,
    selectedSelectionKeys,
    submitBoard,
    updateWager,
    wagers,
  } = useSlipBoards({ currentUser, refreshSignal, onBoardSubmitted });

  useEffect(() => {
    onSelectionKeysChange?.(selectedSelectionKeys);
  }, [onSelectionKeysChange, selectedSelectionKeys]);

  if (isLoading) {
    return <div className={`slip-boards slip-boards--${uiVariant}`}>
      {BOARD_KINDS.map((betKind) => (
        <section
          key={betKind}
          className={`slip-board slip-board--${uiVariant} slip-board--kind-${betKind.toLowerCase()}`}
          aria-busy="true"
          aria-labelledby={`loading-slip-board-${betKind}`}
        >
          <div id={`loading-slip-board-${betKind}`} className="slip-board__title">{getBoardTitle(betKind)}</div>
          <div className="card card-body empty-state-card">Loading {getBetKindLabel(betKind).toLowerCase()} board…</div>
        </section>
      ))}
    </div>;
  }

  return <div className={`slip-boards slip-boards--${uiVariant}`}>
    {BOARD_KINDS.map((betKind) => (
      <SlipBoardPanel
        key={betKind}
        betKind={betKind}
        board={boards[betKind]}
        boardState={boardStateByKind[betKind]}
        currentUser={currentUser}
        error={errors[betKind]}
        onCleanBoard={cleanBoard}
        onDeleteRow={deleteRow}
        onSubmitBoard={submitBoard}
        onWagerChange={updateWager}
        uiVariant={uiVariant}
        wager={wagers[betKind]}
      />
    ))}
  </div>;
};

export default HandleSlip;
