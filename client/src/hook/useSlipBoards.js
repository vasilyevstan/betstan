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
const CHANGED_PLACEMENT_ERROR = 'This slip changed after a previous placement attempt. Wait for the slip to update before placing it again.';
const RELOAD_REQUIRED_PLACEMENT_ERROR = 'This slip changed before placement. Review the latest selections and try again.';
const BOARD_CONFIRMATION_MISSING_ERROR = 'Slip is refreshing. Wait for the latest selections before placing it again.';

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

const getBoardRevision = (board) => {
  const boardRevision = Number(board?.boardRevision);
  return Number.isSafeInteger(boardRevision) && boardRevision > 0 ? boardRevision : null;
};

const getBoardFingerprint = (board) => (
  typeof board?.boardFingerprint === 'string' && board.boardFingerprint.trim()
    ? board.boardFingerprint
    : null
);

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
    boardRevision: getBoardRevision(board),
    boardFingerprint: getBoardFingerprint(board),
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

const buildPlacementFingerprint = ({
  betKind,
  slipId,
  wager,
  boardRevision,
  boardFingerprint,
}) => JSON.stringify({
  betKind,
  slipId,
  wager,
  boardRevision,
  boardFingerprint,
});

const buildPlacementSnapshot = ({ betKind, board, wager }) => {
  const slipId = getBoardId(board);
  const boardRevision = getBoardRevision(board);
  const boardFingerprint = getBoardFingerprint(board);

  return {
    betKind,
    slipId,
    wager,
    boardRevision,
    boardFingerprint,
    fingerprint: buildPlacementFingerprint({
      betKind,
      slipId,
      wager,
      boardRevision,
      boardFingerprint,
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
      expectedBoardRevision: snapshot.boardRevision,
      expectedBoardFingerprint: snapshot.boardFingerprint,
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

const getReloadConflict = (error, betKind) => {
  if (error?.response?.status !== 409 || !error?.response?.data?.reload?.required) {
    return null;
  }

  const authoritativeBoard = normalizeBoard(error?.response?.data?.slip, betKind);
  if (
    authoritativeBoard
    && (
      isSubmittedBoard(authoritativeBoard)
      || normalizeBetKind(authoritativeBoard.betKind ?? betKind) !== betKind
    )
  ) {
    return null;
  }

  return {
    board: authoritativeBoard ?? null,
    message: getErrorMessage(error, RELOAD_REQUIRED_PLACEMENT_ERROR),
  };
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

  const currentUserId = currentUser?.id ?? '';

  const mountedRef = useRef(false);
  const authContextRef = useRef({
    userId: currentUserId,
    generation: 0,
  });
  if (authContextRef.current.userId !== currentUserId) {
    authContextRef.current = {
      userId: currentUserId,
      generation: authContextRef.current.generation + 1,
    };
  }
  const pollTimerRef = useRef(null);
  const refreshTimerRef = useRef(null);
  const pendingBoardsRef = useRef({});
  const placementAttemptsRef = useRef({});
  const previousRefreshSignalRef = useRef(refreshSignal);
  const requestSequenceRef = useRef(0);
  const appliedRequestSequenceRef = useRef(0);

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

  const getAuthContext = useCallback(() => ({ ...authContextRef.current }), []);

  const hasActiveAuthContext = useCallback((authContext) => (
    mountedRef.current
    && authContextRef.current.userId === authContext.userId
    && authContextRef.current.generation === authContext.generation
  ), []);

  const canApplyRequest = useCallback((requestId, requestedAuthContext) => (
    hasActiveAuthContext(requestedAuthContext)
    && requestId >= appliedRequestSequenceRef.current
  ), [hasActiveAuthContext]);

  const canApplyEnrichment = useCallback((requestId, requestedAuthContext) => (
    hasActiveAuthContext(requestedAuthContext)
    && requestId === appliedRequestSequenceRef.current
  ), [hasActiveAuthContext]);

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

  const applyAuthoritativeDraftBoard = useCallback((betKind, authoritativeBoard) => {
    const normalizedBoard = normalizeBoard(authoritativeBoard, betKind);

    if (
      normalizedBoard
      && (
        isSubmittedBoard(normalizedBoard)
        || normalizeBetKind(normalizedBoard.betKind ?? betKind) !== betKind
      )
    ) {
      return false;
    }

    const nextPendingBoards = { ...pendingBoardsRef.current };
    delete nextPendingBoards[betKind];
    pendingBoardsRef.current = nextPendingBoards;
    setBoards((currentBoards) => ({
      ...currentBoards,
      [betKind]: normalizedBoard ?? null,
    }));
    setPendingBoards((currentPendingBoards) => {
      const updatedPendingBoards = { ...currentPendingBoards };
      delete updatedPendingBoards[betKind];
      return updatedPendingBoards;
    });

    return true;
  }, []);

  const enrichBoardsWithHistory = useCallback(async ({ requestId, requestedAuthContext, authoritativeBoards }) => {
    try {
      const betsResponse = await axios.get('/api/bet');
      if (!canApplyEnrichment(requestId, requestedAuthContext)) {
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

  const loadBoards = useCallback(async ({ includeBets = true, authContext = getAuthContext() } = {}) => {
    const requestedAuthContext = authContext;
    if (!requestedAuthContext.userId) {
      return;
    }

    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;

    try {
      const boardsResponse = await axios.get('/api/slip/boards');
      const authoritativeBoards = normalizeBoardsPayload(boardsResponse.data);
      if (!canApplyRequest(requestId, requestedAuthContext)) {
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
        void enrichBoardsWithHistory({ requestId, requestedAuthContext, authoritativeBoards });
      }
    } catch (error) {
      if (canApplyRequest(requestId, requestedAuthContext)) {
        appliedRequestSequenceRef.current = requestId;
        setIsLoading(false);
      }
    }
  }, [canApplyRequest, enrichBoardsWithHistory, getAuthContext, reconcilePlacementAttemptForBoard]);

  const scheduleRefresh = useCallback((delay = REFRESH_DELAY_MS, options = {}, authContext = getAuthContext()) => {
    clearScheduledRefresh();
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      if (!hasActiveAuthContext(authContext)) {
        return;
      }

      void loadBoards({ ...options, authContext });
    }, delay);
  }, [clearScheduledRefresh, getAuthContext, hasActiveAuthContext, loadBoards]);

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
    void loadBoards({ includeBets: true, authContext: getAuthContext() });
  }, [clearScheduledRefresh, currentUserId, getAuthContext, loadBoards, stopPolling]);

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
      const pollAuthContext = getAuthContext();
      pollTimerRef.current = setInterval(() => {
        if (!hasActiveAuthContext(pollAuthContext)) {
          return;
        }

        void loadBoards({ includeBets: true, authContext: pollAuthContext });
      }, POLL_INTERVAL_MS);
    }

    return () => {
      stopPolling();
    };
  }, [getAuthContext, hasActiveAuthContext, loadBoards, pendingBoards, stopPolling]);

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
    const submissionAuthContext = getAuthContext();

    clearBoardError(betKind);

    if (!slipId) {
      setBoardError(betKind, 'No slip ready to submit');
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

    if (currentSnapshot.boardRevision === null || !currentSnapshot.boardFingerprint) {
      setBoardError(betKind, BOARD_CONFIRMATION_MISSING_ERROR);
      scheduleRefresh(REFRESH_DELAY_MS, { includeBets: true }, submissionAuthContext);
      return;
    }

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
        if (!hasActiveAuthContext(submissionAuthContext)) {
          return;
        }

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
        if (hasActiveAuthContext(submissionAuthContext)) {
          await loadBoards({ includeBets: true, authContext: submissionAuthContext });
        }
      } catch (error) {
        if (!hasActiveAuthContext(submissionAuthContext)) {
          return;
        }

        const conflictBoard = getConflictSubmittedBoard(error, betKind, slipId);
        if (conflictBoard) {
          applyAuthoritativeSubmittedBoard(betKind, conflictBoard);
          retirePlacementAttempt(betKind, currentAttempt.placementAttemptId);
          if (hasActiveAuthContext(submissionAuthContext)) {
            await loadBoards({ includeBets: true, authContext: submissionAuthContext });
          }
          return;
        }

        const reloadConflict = getReloadConflict(error, betKind);
        if (reloadConflict) {
          applyAuthoritativeDraftBoard(betKind, reloadConflict.board);
          retirePlacementAttempt(betKind, currentAttempt.placementAttemptId);
          setBoardError(betKind, reloadConflict.message);
          if (hasActiveAuthContext(submissionAuthContext)) {
            await loadBoards({ includeBets: true, authContext: submissionAuthContext });
          }
          return;
        }

        if (isRetryablePlacementError(error)) {
          setBoardError(betKind, RETRYABLE_PLACEMENT_ERROR);
          scheduleRefresh(REFRESH_DELAY_MS, { includeBets: true }, submissionAuthContext);
          return;
        }

        retirePlacementAttempt(betKind, currentAttempt.placementAttemptId);
        setBoardError(betKind, getErrorMessage(error, 'Unable to submit slip'));
      } finally {
        const latestAttempt = placementAttemptsRef.current[betKind];
        if (latestAttempt?.placementAttemptId === currentAttempt.placementAttemptId) {
          latestAttempt.promise = null;
        }

        if (hasActiveAuthContext(submissionAuthContext)) {
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
    applyAuthoritativeDraftBoard,
    applyAuthoritativeSubmittedBoard,
    boards,
    clearBoardError,
    getAuthContext,
    hasActiveAuthContext,
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
