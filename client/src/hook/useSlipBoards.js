import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  BET_KIND,
  BET_STATUS,
  extractSelectionKeysFromBoards,
  normalizeBetKind,
} from '../liveBettingUtils';

const BOARD_KINDS = [BET_KIND.PRE_MATCH, BET_KIND.LIVE];
const POLL_INTERVAL_MS = 2000;
const REFRESH_DELAY_MS = 250;
const SLIP_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
});
const TERMINAL_HISTORY_STATUSES = new Set([
  BET_STATUS.CONFIRMED,
  BET_STATUS.WIN,
  BET_STATUS.LOSS,
  BET_STATUS.VOID,
]);

const EMPTY_BOARDS = Object.freeze({
  [BET_KIND.PRE_MATCH]: null,
  [BET_KIND.LIVE]: null,
});

const EMPTY_WAGERS = Object.freeze({
  [BET_KIND.PRE_MATCH]: '',
  [BET_KIND.LIVE]: '',
});

const EMPTY_ERRORS = Object.freeze({
  [BET_KIND.PRE_MATCH]: null,
  [BET_KIND.LIVE]: null,
});
const RETRYABLE_PLACEMENT_ERROR = 'Placement status is still reconciling. Retry with the same wager and selections.';
const CHANGED_PLACEMENT_ERROR = 'This slip changed after a previous placement attempt. Wait for the board to update before placing it again.';

const getBoardId = (board) => board?._id ?? board?.id ?? null;
const getRowId = (row) => row?._id ?? row?.id ?? null;
const isSubmittedBoard = (board) => board?.status === SLIP_STATUS.SUBMITTED;
const hasTrackedPendingBoards = (pendingBoards) => BOARD_KINDS.some((betKind) => Boolean(pendingBoards?.[betKind]));
const hasAuthoritativeSubmittedBoards = (boards) => BOARD_KINDS.some((betKind) => isSubmittedBoard(boards?.[betKind]));

const getWindowCrypto = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.crypto ?? null;
};

const createPlacementAttemptId = () => {
  const windowCrypto = getWindowCrypto();

  if (typeof windowCrypto?.randomUUID === 'function') {
    return windowCrypto.randomUUID();
  }

  if (typeof windowCrypto?.getRandomValues !== 'function') {
    throw new Error('Secure random placement attempt ids are unavailable');
  }

  const randomBytes = windowCrypto.getRandomValues(new Uint8Array(16));
  randomBytes[6] = (randomBytes[6] & 0x0f) | 0x40;
  randomBytes[8] = (randomBytes[8] & 0x3f) | 0x80;

  const hexBytes = Array.from(randomBytes, (value) => value.toString(16).padStart(2, '0'));
  return [
    hexBytes.slice(0, 4).join(''),
    hexBytes.slice(4, 6).join(''),
    hexBytes.slice(6, 8).join(''),
    hexBytes.slice(8, 10).join(''),
    hexBytes.slice(10, 16).join(''),
  ].join('-');
};

const normalizeBoard = (board, fallbackKind) => {
  if (!board || typeof board !== 'object') {
    return null;
  }

  const betKind = normalizeBetKind(board.betKind ?? fallbackKind);
  const status = board.status === SLIP_STATUS.SUBMITTED ? SLIP_STATUS.SUBMITTED : SLIP_STATUS.DRAFT;

  return {
    ...board,
    betKind,
    status,
    sourceSlipId: board.sourceSlipId ?? null,
    rows: Array.isArray(board.rows)
      ? board.rows.map((row) => ({
        ...row,
        betKind: normalizeBetKind(row?.betKind ?? betKind),
      }))
      : [],
  };
};

const normalizeBoardsPayload = (payload) => ({
  [BET_KIND.PRE_MATCH]: normalizeBoard(payload?.[BET_KIND.PRE_MATCH], BET_KIND.PRE_MATCH),
  [BET_KIND.LIVE]: normalizeBoard(payload?.[BET_KIND.LIVE], BET_KIND.LIVE),
});

const buildPendingBoard = (board, targetedStatus = BET_STATUS.PENDING) => {
  const slipId = getBoardId(board);
  if (!slipId) {
    return null;
  }

  return {
    slipId,
    board,
    targetedStatus,
  };
};

const getSubmittedWagerValue = (board) => {
  const wager = Number(board?.submittedEvent?.wager);
  return Number.isFinite(wager) && wager > 0 ? String(wager) : null;
};

const buildPlacementFingerprint = ({ betKind, slipId, wager, rows }) => JSON.stringify({
  betKind,
  slipId,
  wager,
  rows: Array.isArray(rows)
    ? rows.map((row) => ({
      rowId: getRowId(row),
      eventId: row?.eventId ?? null,
      oddsId: row?.oddsId ?? null,
      oddsValue: row?.oddsValue ?? null,
      betKind: normalizeBetKind(row?.betKind ?? betKind),
      marketId: row?.marketId ?? null,
      marketVersion: row?.marketVersion ?? null,
      quoteVersion: row?.quoteVersion ?? null,
      selectionId: row?.selectionId ?? null,
    }))
    : [],
});

const buildPlacementSnapshot = ({ betKind, board, wager }) => {
  const slipId = getBoardId(board);

  return {
    betKind,
    slipId,
    wager,
    fingerprint: buildPlacementFingerprint({
      betKind,
      slipId,
      wager,
      rows: board?.rows,
    }),
  };
};

const buildPlacementAttempt = ({ betKind, board, wager, placementAttemptId }) => {
  const snapshot = buildPlacementSnapshot({ betKind, board, wager });

  return {
    betKind,
    slipId: snapshot.slipId,
    wager,
    placementAttemptId,
    fingerprint: snapshot.fingerprint,
    requestBody: {
      betKind,
      slipId: snapshot.slipId,
      wager,
      placementAttemptId,
    },
    promise: null,
  };
};

const placementAttemptMatchesSnapshot = (attempt, snapshot) => (
  attempt?.betKind === snapshot.betKind
  && attempt?.slipId === snapshot.slipId
  && attempt?.fingerprint === snapshot.fingerprint
);

const isRetryablePlacementError = (error) => {
  const status = error?.response?.status;
  return !status || (status >= 500 && status < 600);
};

const toAuthoritativeSubmittedBoard = (value, betKind, slipId) => {
  const authoritativeBoard = normalizeBoard(value, betKind);
  if (!authoritativeBoard || !isSubmittedBoard(authoritativeBoard)) {
    return null;
  }

  if (normalizeBetKind(authoritativeBoard.betKind ?? betKind) !== betKind) {
    return null;
  }

  return getBoardId(authoritativeBoard) === slipId ? authoritativeBoard : null;
};

const getConflictSubmittedBoard = (error, betKind, slipId) => {
  if (error?.response?.status !== 409) {
    return null;
  }

  return toAuthoritativeSubmittedBoard(error?.response?.data?.slip, betKind, slipId);
};

const shouldRetirePlacementAttemptForBoard = (attempt, board, betKind) => {
  if (!attempt || !board) {
    return false;
  }

  if (normalizeBetKind(board?.betKind ?? betKind) !== betKind) {
    return false;
  }

  const boardId = getBoardId(board);
  if (!boardId) {
    return false;
  }

  return (
    isSubmittedBoard(board)
    || boardId !== attempt.slipId
    || board?.sourceSlipId === attempt.slipId
  );
};

const getErrorMessage = (error, fallbackMessage) => {
  const message = error?.response?.data?.message;
  if (typeof message === 'string' && message.trim()) {
    return message;
  }

  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }

  return fallbackMessage;
};

const findBetStatusBySlipId = (bets, slipId) => {
  if (!Array.isArray(bets) || !slipId) {
    return null;
  }

  return bets.find((bet) => bet?.slipId === slipId)?.status ?? null;
};

const mergePendingBoards = (authoritativeBoards, bets, previousPendingBoards) => {
  const nextBoards = { ...EMPTY_BOARDS };
  const nextPendingBoards = {};

  BOARD_KINDS.forEach((betKind) => {
    const authoritativeBoard = authoritativeBoards[betKind];
    if (authoritativeBoard) {
      nextBoards[betKind] = authoritativeBoard;

      if (isSubmittedBoard(authoritativeBoard)) {
        const pendingBoard = buildPendingBoard(authoritativeBoard, BET_STATUS.PENDING);
        if (pendingBoard) {
          nextPendingBoards[betKind] = pendingBoard;
        }
      }

      return;
    }

    const previousPendingBoard = previousPendingBoards[betKind];
    if (!previousPendingBoard) {
      nextBoards[betKind] = null;
      return;
    }

    const historyStatus = findBetStatusBySlipId(bets, previousPendingBoard.slipId);
    if (TERMINAL_HISTORY_STATUSES.has(historyStatus)) {
      nextBoards[betKind] = null;
      return;
    }

    nextBoards[betKind] = previousPendingBoard.board ?? null;
    nextPendingBoards[betKind] = {
      ...previousPendingBoard,
      targetedStatus: historyStatus === BET_STATUS.DECLINED
        ? BET_STATUS.DECLINED
        : previousPendingBoard.targetedStatus ?? BET_STATUS.PENDING,
    };
  });

  return {
    boards: nextBoards,
    pendingBoards: nextPendingBoards,
  };
};

const useSlipBoards = ({ currentUser, refreshSignal, onBoardSubmitted }) => {
  const [boards, setBoards] = useState(EMPTY_BOARDS);
  const [wagers, setWagers] = useState(EMPTY_WAGERS);
  const [errors, setErrors] = useState(EMPTY_ERRORS);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingBoards, setPendingBoards] = useState({});
  const [submittingBoards, setSubmittingBoards] = useState({});

  const mountedRef = useRef(false);
  const currentUserIdRef = useRef(currentUser?.id ?? '');
  const pollTimerRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const pendingBoardsRef = useRef({});
  const placementAttemptsRef = useRef({});
  const previousRefreshSignalRef = useRef(refreshSignal);
  const requestSequenceRef = useRef(0);
  const appliedRequestSequenceRef = useRef(0);

  const currentUserId = currentUser?.id ?? '';

  useEffect(() => {
    currentUserIdRef.current = currentUserId;
  }, [currentUserId]);

  useEffect(() => {
    pendingBoardsRef.current = pendingBoards;
  }, [pendingBoards]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const clearScheduledRefresh = useCallback(() => {
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const canApplyRequest = useCallback((requestId, requestedUserId) => (
    mountedRef.current
    && currentUserIdRef.current === requestedUserId
    && requestId >= appliedRequestSequenceRef.current
  ), []);

  const canApplyEnrichment = useCallback((requestId, requestedUserId) => (
    mountedRef.current
    && currentUserIdRef.current === requestedUserId
    && requestId === appliedRequestSequenceRef.current
  ), []);

  const retirePlacementAttempt = useCallback((betKind, placementAttemptId) => {
    const currentAttempt = placementAttemptsRef.current[betKind];
    if (!currentAttempt) {
      return;
    }

    if (placementAttemptId && currentAttempt.placementAttemptId !== placementAttemptId) {
      return;
    }

    delete placementAttemptsRef.current[betKind];
  }, []);

  const reconcilePlacementAttemptForBoard = useCallback((betKind, board) => {
    const currentAttempt = placementAttemptsRef.current[betKind];

    if (!shouldRetirePlacementAttemptForBoard(currentAttempt, board, betKind)) {
      return;
    }

    retirePlacementAttempt(betKind, currentAttempt?.placementAttemptId);
    setErrors((currentErrors) => ({
      ...currentErrors,
      [betKind]: null,
    }));
  }, [retirePlacementAttempt]);

  const applyAuthoritativeSubmittedBoard = useCallback((betKind, authoritativeBoard) => {
    const normalizedBoard = normalizeBoard(authoritativeBoard, betKind);
    const nextPendingBoard = buildPendingBoard(normalizedBoard, BET_STATUS.PENDING);

    if (!normalizedBoard || !nextPendingBoard) {
      return false;
    }

    pendingBoardsRef.current = {
      ...pendingBoardsRef.current,
      [betKind]: nextPendingBoard,
    };
    setBoards((currentBoards) => ({
      ...currentBoards,
      [betKind]: normalizedBoard,
    }));
    setPendingBoards((currentPendingBoards) => ({
      ...currentPendingBoards,
      [betKind]: nextPendingBoard,
    }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      [betKind]: null,
    }));

    const submittedWager = getSubmittedWagerValue(normalizedBoard);
    if (submittedWager !== null) {
      setWagers((currentWagers) => ({
        ...currentWagers,
        [betKind]: submittedWager,
      }));
    }

    onBoardSubmitted?.(betKind);
    return true;
  }, [onBoardSubmitted]);

  const enrichBoardsWithHistory = useCallback(async ({ requestId, requestedUserId, authoritativeBoards }) => {
    try {
      const betsResponse = await axios.get('/api/bet');
      if (!canApplyEnrichment(requestId, requestedUserId)) {
        return;
      }

      if (!Array.isArray(betsResponse?.data)) {
        return;
      }

      const merged = mergePendingBoards(authoritativeBoards, betsResponse.data, pendingBoardsRef.current);
      pendingBoardsRef.current = merged.pendingBoards;
      setBoards(merged.boards);
      setPendingBoards(merged.pendingBoards);
    } catch (error) {
      // optional enrichment must never override authoritative boards on failure
    }
  }, [canApplyEnrichment]);

  const loadBoards = useCallback(async ({ includeBets = true } = {}) => {
    const requestedUserId = currentUserIdRef.current;
    if (!requestedUserId) {
      return;
    }

    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;

    try {
      const boardsResponse = await axios.get('/api/slip/boards');
      const authoritativeBoards = normalizeBoardsPayload(boardsResponse.data);
      if (!canApplyRequest(requestId, requestedUserId)) {
        return;
      }

      BOARD_KINDS.forEach((betKind) => {
        reconcilePlacementAttemptForBoard(betKind, authoritativeBoards[betKind]);
      });

      appliedRequestSequenceRef.current = requestId;
      const merged = mergePendingBoards(authoritativeBoards, [], pendingBoardsRef.current);
      pendingBoardsRef.current = merged.pendingBoards;
      setBoards(merged.boards);
      setPendingBoards(merged.pendingBoards);
      setIsLoading(false);

      if (
        includeBets
        && (hasTrackedPendingBoards(merged.pendingBoards) || hasAuthoritativeSubmittedBoards(authoritativeBoards))
      ) {
        void enrichBoardsWithHistory({ requestId, requestedUserId, authoritativeBoards });
      }
    } catch (error) {
      if (canApplyRequest(requestId, requestedUserId)) {
        appliedRequestSequenceRef.current = requestId;
        setIsLoading(false);
      }
    }
  }, [canApplyRequest, enrichBoardsWithHistory, reconcilePlacementAttemptForBoard]);

  const scheduleRefresh = useCallback((delay = REFRESH_DELAY_MS, options = {}) => {
    clearScheduledRefresh();
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void loadBoards(options);
    }, delay);
  }, [clearScheduledRefresh, loadBoards]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      stopPolling();
      clearScheduledRefresh();
    };
  }, [clearScheduledRefresh, stopPolling]);

  useEffect(() => {
    requestSequenceRef.current += 1;
    appliedRequestSequenceRef.current = requestSequenceRef.current;
    clearScheduledRefresh();
    stopPolling();

    if (!currentUserId) {
      pendingBoardsRef.current = {};
      setPendingBoards({});
      setBoards(EMPTY_BOARDS);
      setErrors(EMPTY_ERRORS);
      setWagers(EMPTY_WAGERS);
      setSubmittingBoards({});
      placementAttemptsRef.current = {};
      setIsLoading(false);
      return;
    }

    setErrors(EMPTY_ERRORS);
    setIsLoading(true);
    void loadBoards({ includeBets: true });
  }, [clearScheduledRefresh, currentUserId, loadBoards, stopPolling]);

  useEffect(() => {
    if (previousRefreshSignalRef.current === refreshSignal) {
      return;
    }

    previousRefreshSignalRef.current = refreshSignal;
    scheduleRefresh();
  }, [refreshSignal, scheduleRefresh]);

  useEffect(() => {
    if (!hasTrackedPendingBoards(pendingBoards)) {
      stopPolling();
      return undefined;
    }

    if (!pollTimerRef.current) {
      pollTimerRef.current = setInterval(() => {
        void loadBoards({ includeBets: true });
      }, POLL_INTERVAL_MS);
    }

    return () => {
      stopPolling();
    };
  }, [loadBoards, pendingBoards, stopPolling]);

  const selectedSelectionKeys = useMemo(() => extractSelectionKeysFromBoards(boards), [boards]);

  const updateWager = useCallback((betKind, value) => {
    setWagers((currentWagers) => ({
      ...currentWagers,
      [betKind]: value,
    }));
  }, []);

  const clearBoardError = useCallback((betKind) => {
    setErrors((currentErrors) => ({
      ...currentErrors,
      [betKind]: null,
    }));
  }, []);

  const setBoardError = useCallback((betKind, message) => {
    setErrors((currentErrors) => ({
      ...currentErrors,
      [betKind]: message,
    }));
  }, []);

  const deleteRow = useCallback(async (betKind, slipId, slipRowId) => {
    clearBoardError(betKind);

    try {
      await axios.post('/api/slip/row', { betKind, slipId, slipRowId });
      await loadBoards({ includeBets: true });
    } catch (error) {
      setBoardError(betKind, getErrorMessage(error, 'Unable to remove selection'));
    }
  }, [clearBoardError, loadBoards, setBoardError]);

  const cleanBoard = useCallback(async (betKind, slipId) => {
    clearBoardError(betKind);

    try {
      await axios.post('/api/slip/row/clean', { betKind, slipId });
      await loadBoards({ includeBets: true });
    } catch (error) {
      setBoardError(betKind, getErrorMessage(error, 'Unable to clear slip'));
    }
  }, [clearBoardError, loadBoards, setBoardError]);

  const submitBoard = useCallback(async (betKind) => {
    const board = boards[betKind];
    const slipId = getBoardId(board);
    const wagerValue = Number(wagers[betKind]);

    clearBoardError(betKind);

    if (!slipId) {
      setBoardError(betKind, 'No board ready to submit');
      return;
    }

    if (!Number.isFinite(wagerValue) || wagerValue <= 0) {
      setBoardError(betKind, 'Enter a wager greater than zero');
      return;
    }

    reconcilePlacementAttemptForBoard(betKind, board);

    const currentSnapshot = buildPlacementSnapshot({
      betKind,
      board,
      wager: wagerValue,
    });

    let currentAttempt = placementAttemptsRef.current[betKind];
    if (currentAttempt) {
      if (!placementAttemptMatchesSnapshot(currentAttempt, currentSnapshot)) {
        setBoardError(betKind, CHANGED_PLACEMENT_ERROR);
        return;
      }

      if (currentAttempt.promise) {
        await currentAttempt.promise;
        return;
      }
    } else {
      let placementAttemptId;
      try {
        placementAttemptId = createPlacementAttemptId();
      } catch (error) {
        setBoardError(betKind, getErrorMessage(error, 'Unable to submit slip'));
        return;
      }

      currentAttempt = buildPlacementAttempt({
        betKind,
        board,
        wager: wagerValue,
        placementAttemptId,
      });
      placementAttemptsRef.current[betKind] = currentAttempt;
    }

    setSubmittingBoards((currentSubmittingBoards) => ({
      ...currentSubmittingBoards,
      [betKind]: true,
    }));

    const submissionPromise = (async () => {
      try {
        const response = await axios.post('/api/slip/bet', currentAttempt.requestBody);
        const authoritativeBoard = toAuthoritativeSubmittedBoard(
          response?.data,
          betKind,
          slipId,
        ) ?? {
          ...board,
          status: SLIP_STATUS.SUBMITTED,
          submittedAt: new Date().toISOString(),
          submittedEvent: {
            ...board?.submittedEvent,
            wager: currentAttempt.wager,
            betKind,
          },
        };

        applyAuthoritativeSubmittedBoard(betKind, authoritativeBoard);
        retirePlacementAttempt(betKind, currentAttempt.placementAttemptId);
        await loadBoards({ includeBets: true });
      } catch (error) {
        const conflictBoard = getConflictSubmittedBoard(error, betKind, slipId);
        if (conflictBoard) {
          applyAuthoritativeSubmittedBoard(betKind, conflictBoard);
          retirePlacementAttempt(betKind, currentAttempt.placementAttemptId);
          await loadBoards({ includeBets: true });
          return;
        }

        if (isRetryablePlacementError(error)) {
          setBoardError(betKind, RETRYABLE_PLACEMENT_ERROR);
          scheduleRefresh();
          return;
        }

        retirePlacementAttempt(betKind, currentAttempt.placementAttemptId);
        setBoardError(betKind, getErrorMessage(error, 'Unable to submit slip'));
      } finally {
        const latestAttempt = placementAttemptsRef.current[betKind];
        if (latestAttempt?.placementAttemptId === currentAttempt.placementAttemptId) {
          latestAttempt.promise = null;
        }

        if (mountedRef.current) {
          setSubmittingBoards((currentSubmittingBoards) => ({
            ...currentSubmittingBoards,
            [betKind]: false,
          }));
        }
      }
    })();

    currentAttempt.promise = submissionPromise;

    await submissionPromise;
  }, [
    applyAuthoritativeSubmittedBoard,
    boards,
    clearBoardError,
    loadBoards,
    reconcilePlacementAttemptForBoard,
    retirePlacementAttempt,
    scheduleRefresh,
    setBoardError,
    wagers,
  ]);

  const boardStateByKind = useMemo(() => ({
    [BET_KIND.PRE_MATCH]: {
      isSubmitting: !!submittingBoards[BET_KIND.PRE_MATCH],
      isAwaitingDecision: !!pendingBoards[BET_KIND.PRE_MATCH],
      targetedStatus: pendingBoards[BET_KIND.PRE_MATCH]?.targetedStatus ?? null,
    },
    [BET_KIND.LIVE]: {
      isSubmitting: !!submittingBoards[BET_KIND.LIVE],
      isAwaitingDecision: !!pendingBoards[BET_KIND.LIVE],
      targetedStatus: pendingBoards[BET_KIND.LIVE]?.targetedStatus ?? null,
    },
  }), [pendingBoards, submittingBoards]);

  return {
    boards,
    wagers,
    errors,
    isLoading,
    boardStateByKind,
    selectedSelectionKeys,
    updateWager,
    deleteRow,
    cleanBoard,
    submitBoard,
  };
};

export default useSlipBoards;
export {
  BOARD_KINDS,
  POLL_INTERVAL_MS,
  REFRESH_DELAY_MS,
  SLIP_STATUS,
  EMPTY_BOARDS,
  getBoardId,
  getRowId,
  hasAuthoritativeSubmittedBoards,
  hasTrackedPendingBoards,
  isSubmittedBoard,
  mergePendingBoards,
  normalizeBoard,
  normalizeBoardsPayload,
};
