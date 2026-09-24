import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import axios from 'axios';
import {
  CASH_BACK_POLL_MS, CASH_BACK_RECOVERY_ERROR, CASH_BACK_RETRY_MS, cashBackReason, createCashBackId,
  initialMyBetsState, isFinalOperation, isPendingOperation, myBetsReducer,
  readCashBackAttempts, readOperationResponse, storageKey, storageOwnerPrefix,
} from '../cashBackUtils';

const basePath = (slipId) => `/api/bet/${encodeURIComponent(slipId)}/cash-back`;
const storageMessage = 'Cash-back recovery data could not be saved. Allow browser storage and reload this page before requesting or confirming an offer.';
const errorCode = (error) => error?.response?.data?.errors?.[0]?.code;
const errorMessage = (error) => errorCode(error) ? cashBackReason(errorCode(error))
  : error?.response ? 'The cash-back service could not be reached. Retry the same operation to check its status.'
    : error?.message?.startsWith('The server response') ? error.message
      : 'Network failure. The outcome is not known. Retry the same operation to check its status.';

const useMyBets = ({ ownerId, onAuthRefresh, onBeforeUpdate, onDecision }) => {
  const [server, dispatch] = useReducer(myBetsReducer, ownerId, initialMyBetsState);
  const [listStatus, setListStatus] = useState({ loading: true, refreshing: false, error: '', permission: false });
  const [attempts, setAttempts] = useState({});
  const [network, setNetwork] = useState({});
  const [actionErrors, setActionErrors] = useState({});
  const [storageError, setStorageError] = useState('');
  const serverRef = useRef(server);
  const records = useRef({});
  const runtime = useRef({});
  const controllers = useRef(new Set());
  const callbacks = useRef({});
  callbacks.current = { onAuthRefresh, onBeforeUpdate, onDecision };
  const mounted = useRef(false);
  const revoked = useRef(false);
  const sequence = useRef(0);
  const scope = useRef({ ownerId });
  if (scope.current.ownerId !== ownerId) scope.current = { ownerId };

  const isCurrent = useCallback((context) => mounted.current && context === scope.current && !revoked.current, []);
  const emit = useCallback((action) => {
    callbacks.current.onBeforeUpdate?.();
    serverRef.current = myBetsReducer(serverRef.current, action);
    dispatch(action);
  }, []);
  const updateRecord = useCallback((context, record) => {
    // Only request identity/content is persisted, never quotes, receipts, auth or source proofs.
    const saved = readCashBackAttempts(context.ownerId)[record.clientOperationId];
    const current = records.current[record.clientOperationId];
    const consent = record.confirmRequest ?? current?.confirmRequest ?? saved?.confirmRequest;
    const operationId = record.operationId ?? current?.operationId ?? saved?.operationId;
    // Canonical property order prevents tabs echoing equivalent records back and
    // forth. A late quote read must not erase consent written by another tab.
    const next = {
      slipId: record.slipId, clientOperationId: record.clientOperationId, createdAt: record.createdAt,
      quoteRequest: record.quoteRequest,
      ...(operationId ? { operationId } : {}),
      ...(consent ? { confirmRequest: consent } : {}),
    };
    const key = storageKey(context.ownerId, next);
    const serialized = JSON.stringify(next);
    if (window.localStorage.getItem(key) !== serialized) window.localStorage.setItem(key, serialized);
    records.current = { ...records.current, [record.clientOperationId]: next };
    setAttempts(records.current);
    return next;
  }, []);
  const revoke = useCallback(() => {
    revoked.current = true;
    controllers.current.forEach((controller) => controller.abort());
    emit({ type: 'RESET', ownerId: scope.current.ownerId });
    setAttempts({});
    setNetwork({});
    setListStatus({ loading: false, refreshing: false, permission: true,
      error: 'Your session could not be verified. Log in to the same account to recover any pending cash back.' });
    callbacks.current.onAuthRefresh?.();
  }, [emit]);

  const refresh = useCallback(async () => {
    const context = scope.current;
    if (!context.ownerId || !isCurrent(context)) return;
    const requestSequence = ++sequence.current;
    const controller = new AbortController();
    controllers.current.add(controller);
    setListStatus((old) => ({ ...old, refreshing: true, error: '' }));
    try {
      const response = await axios.get('/api/bet', { signal: controller.signal, timeout: 10000 });
      if (!isCurrent(context) || controller.signal.aborted) return;
      // Preserve historical keyed-object/empty-object listings as well as arrays,
      // but do not disguise a malformed response as an empty successful list.
      const data = response.data;
      const bets = Array.isArray(data) ? data
        : data && typeof data === 'object' ? Object.values(data) : null;
      if (!bets || bets.some((bet) => !bet || typeof bet.slipId !== 'string')) {
        throw new Error('My Bets returned an unreadable response. Refresh to try again.');
      }
      emit({ type: 'LIST', ownerId: context.ownerId, sequence: requestSequence, bets });
      if (requestSequence === sequence.current) {
        setListStatus({ loading: false, refreshing: false, error: '', permission: false });
      }
    } catch (error) {
      if (!isCurrent(context) || controller.signal.aborted) return;
      if ([401, 403].includes(error?.response?.status)) { revoke(); return; }
      if (requestSequence === sequence.current) {
        setListStatus({ loading: false, refreshing: false, permission: false,
          error: error.message?.startsWith('My Bets') ? error.message : 'My Bets could not be refreshed. Check your connection and try Refresh bets. Previously loaded slips may be out of date.' });
      }
    } finally {
      controllers.current.delete(controller);
    }
  }, [emit, isCurrent, revoke]);

  const runAttempt = useCallback(async (record, confirmNow = false) => {
    const context = scope.current;
    const id = record.clientOperationId;
    if (!context.ownerId || !isCurrent(context) || runtime.current[id]?.busy) return;
    if (record.confirmRequest && !record.operationId) {
      setStorageError(CASH_BACK_RECOVERY_ERROR);
      return;
    }
    const previousRuntime = runtime.current[id] ?? {};
    runtime.current[id] = { ...previousRuntime, busy: true };
    setNetwork((old) => ({ ...old, [id]: { ...old[id], busy: true } }));
    const controller = new AbortController();
    controllers.current.add(controller);
    const options = { signal: controller.signal, timeout: 10000 };
    let sentConfirmation = confirmNow;
    let failed = false;
    try {
      const startedAt = Date.now();
      let response = confirmNow
        ? await axios.post(`${basePath(record.slipId)}/accept`, record.confirmRequest, options)
        : record.operationId
          ? await axios.get(`${basePath(record.slipId)}/operations/${encodeURIComponent(record.operationId)}`, options)
          : await axios.post(`${basePath(record.slipId)}/quote`, record.quoteRequest, options);
      if (!isCurrent(context) || controller.signal.aborted) return;
      // Consent can be recorded while an earlier lookup is in flight. Use the
      // same saved request immediately, rather than losing the click or identity.
      record = records.current[id] ?? record;
      let operation = readOperationResponse(response, record, startedAt);
      // A lost CONFIRM may never have reached Bet. A known operation still QUOTED
      // is resolved by the exact saved POST, even after the browser quote expired.
      if (record.confirmRequest && operation.state === 'QUOTED') {
        sentConfirmation = true;
        response = await axios.post(`${basePath(record.slipId)}/accept`, record.confirmRequest, options);
        if (!isCurrent(context) || controller.signal.aborted) return;
        operation = readOperationResponse(response, record, startedAt);
      }
      const priorOperation = serverRef.current.operations[id];
      record = { ...record, operationId: operation.operationId };
      // A storage failure after a request must not hide a durable response.
      try { record = updateRecord(context, record); } catch { setStorageError(storageMessage); }
      emit({ type: 'OPERATION', ownerId: context.ownerId, operation });
      const effectiveOperation = serverRef.current.operations[id];
      setNetwork((old) => ({ ...old, [id]: {
        busy: false, error: '', invalidOffer: false,
      } }));
      runtime.current[id] = {
        busy: false, dueAt: Date.now() + CASH_BACK_POLL_MS,
        stopped: isFinalOperation(effectiveOperation) || (effectiveOperation.state === 'QUOTED' && !record.confirmRequest),
      };
      if (isFinalOperation(effectiveOperation)) {
        try { window.localStorage.removeItem(storageKey(context.ownerId, record)); } catch { setStorageError(storageMessage); }
        if (!isFinalOperation(priorOperation)) {
          callbacks.current.onDecision?.(effectiveOperation);
          void refresh();
        }
      }
    } catch (error) {
      if (!isCurrent(context) || controller.signal.aborted) return;
      failed = true;
      if ([401, 403].includes(error?.response?.status)) { revoke(); return; }
      const message = errorMessage(error);
      const definiteDenial = sentConfirmation && [400, 404, 409].includes(error?.response?.status);
      const stopped = !record.confirmRequest && [400, 404, 409].includes(error?.response?.status);
      runtime.current[id] = {
        busy: false, dueAt: Date.now() + (definiteDenial ? CASH_BACK_POLL_MS : CASH_BACK_RETRY_MS),
        stopped, invalidOffer: stopped, error: message,
      };
      setNetwork((old) => ({ ...old, [id]: { busy: false, error: message, invalidOffer: stopped } }));
      if (stopped) {
        try { window.localStorage.removeItem(storageKey(context.ownerId, record)); } catch { setStorageError(storageMessage); }
      }
      if (definiteDenial) void refresh();
    } finally {
      controllers.current.delete(controller);
      if (isCurrent(context) && !failed && runtime.current[id]?.busy) runtime.current[id].busy = false;
    }
  }, [emit, isCurrent, refresh, revoke, updateRecord]);

  const syncSavedAttempts = useCallback(() => {
    try {
      const saved = readCashBackAttempts(scope.current.ownerId);
      const merged = { ...records.current };
      Object.values(saved).forEach((record) => {
        // Consent remains sticky until THIS tab sees a terminal/definitively
        // unsubmitted result. A storage deletion is a hint, never an outcome.
        const old = merged[record.clientOperationId];
        merged[record.clientOperationId] = { ...old, ...record,
          ...(old?.confirmRequest ? { confirmRequest: old.confirmRequest } : {}) };
        if (record.confirmRequest && !old?.confirmRequest) runtime.current[record.clientOperationId] = {};
      });
      records.current = merged;
      setAttempts(merged);
      return merged;
    } catch (error) {
      setStorageError(error.message?.startsWith('Saved cash-back') ? error.message : storageMessage);
      return null;
    }
  }, []);

  const reconcile = useCallback((force = false) => {
    if (!scope.current.ownerId || revoked.current) return;
    Object.values(records.current).forEach((record) => {
      const operation = serverRef.current.operations[record.clientOperationId];
      const status = runtime.current[record.clientOperationId];
      if (isFinalOperation(operation)) return;
      if (!force && (status?.stopped || status?.dueAt > Date.now())) return;
      if (force || !operation || isPendingOperation(operation) || record.confirmRequest) void runAttempt(record);
    });
  }, [runAttempt]);

  useEffect(() => {
    const ownedControllers = controllers.current;
    mounted.current = true;
    revoked.current = false;
    records.current = {};
    runtime.current = {};
    setAttempts({});
    setNetwork({});
    setActionErrors({});
    setStorageError('');
    setListStatus({ loading: Boolean(ownerId), refreshing: false, error: '', permission: false });
    emit({ type: 'RESET', ownerId });
    if (ownerId) {
      syncSavedAttempts();
      void refresh();
      reconcile(true);
    }
    return () => {
      mounted.current = false;
      ownedControllers.forEach((controller) => controller.abort());
      ownedControllers.clear();
    };
  }, [ownerId, emit, reconcile, refresh, syncSavedAttempts]);

  useEffect(() => {
    if (!ownerId) return undefined;
    const focus = async () => {
      const context = scope.current;
      if (callbacks.current.onAuthRefresh) {
        const user = await callbacks.current.onAuthRefresh();
        if (!isCurrent(context) || user?.id !== context.ownerId) return;
      }
      syncSavedAttempts();
      void refresh();
      reconcile(true);
    };
    const storage = (event) => {
      if (!event.key?.startsWith(storageOwnerPrefix(ownerId)) || revoked.current) return;
      void focus();
    };
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') reconcile();
    }, CASH_BACK_POLL_MS);
    window.addEventListener('focus', focus);
    window.addEventListener('storage', storage);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('storage', storage);
    };
  }, [ownerId, isCurrent, reconcile, refresh, syncSavedAttempts]);

  const requestQuote = useCallback((slipId, portion) => {
    const context = scope.current;
    if (!isCurrent(context) || !context.ownerId) return null;
    const saved = syncSavedAttempts();
    if (!saved) return null;
    const unresolved = Object.values(saved).some((record) => record.slipId === slipId
      && !isFinalOperation(serverRef.current.operations[record.clientOperationId])
      && (record.confirmRequest || (!runtime.current[record.clientOperationId]?.stopped
        && serverRef.current.operations[record.clientOperationId]?.state !== 'QUOTED')));
    if (unresolved) {
      setActionErrors((old) => ({ ...old, [slipId]: 'An operation on this slip still needs reconciliation. Check its status before requesting another offer.' }));
      reconcile(true);
      return null;
    }
    try {
      const clientOperationId = createCashBackId();
      const record = { slipId, clientOperationId, createdAt: Date.now(),
        quoteRequest: { action: 'QUOTE', clientOperationId, portion } };
      // Retire only quote-only/finished metadata. Pending consent is never discarded.
      Object.values(records.current).filter((old) => old.slipId === slipId).forEach((old) => {
        window.localStorage.removeItem(storageKey(context.ownerId, old));
        delete records.current[old.clientOperationId];
      });
      updateRecord(context, record); // Durable browser identity BEFORE crossing HTTP.
      setActionErrors((old) => ({ ...old, [slipId]: '' }));
      void runAttempt(record);
      return clientOperationId;
    } catch (error) {
      setActionErrors((old) => ({ ...old, [slipId]: error.message?.startsWith('Secure') ? error.message : storageMessage }));
      return null;
    }
  }, [isCurrent, reconcile, runAttempt, syncSavedAttempts, updateRecord]);

  const confirm = useCallback((clientOperationId) => {
    const context = scope.current;
    const saved = syncSavedAttempts();
    const record = saved?.[clientOperationId];
    const operation = serverRef.current.operations[clientOperationId];
    const bet = serverRef.current.bets.find((entry) => entry.slipId === record?.slipId);
    const competing = Object.values(saved ?? {}).some((entry) => entry.slipId === record?.slipId
      && entry.clientOperationId !== clientOperationId && entry.confirmRequest
      && !isFinalOperation(serverRef.current.operations[entry.clientOperationId]));
    if (!record || !isCurrent(context) || competing || operation?.state !== 'QUOTED'
      || record.operationId !== operation.operationId
      || operation.deadline <= Date.now()
      || runtime.current[clientOperationId]?.invalidOffer
      || bet?.status !== 'CONFIRMED'
      || (bet.cashBackFinancial && bet.cashBackFinancial.revision !== operation.quote.financial.revision)) {
      if (record) setActionErrors((old) => ({ ...old, [record.slipId]: 'This offer is no longer confirmable. Check pending operations or request a new offer.' }));
      return;
    }
    try {
      const next = updateRecord(context, { ...record, confirmRequest: { action: 'CONFIRM', clientOperationId, quoteId: operation.quote.quoteId } });
      void runAttempt(next, true);
    } catch {
      setActionErrors((old) => ({ ...old, [record.slipId]: storageMessage }));
    }
  }, [isCurrent, runAttempt, syncSavedAttempts, updateRecord]);

  const applyHistory = useCallback((slipId, receipts) => {
    if (!revoked.current) emit({ type: 'HISTORY', ownerId: scope.current.ownerId, slipId, receipts });
  }, [emit]);

  return {
    bets: server.ownerId === ownerId ? server.bets : [],
    operations: server.ownerId === ownerId ? server.operations : {},
    attempts, network, actionErrors, storageError, listStatus,
    refresh, requestQuote, confirm, applyHistory, revoke,
    retry: (id) => { if (records.current[id]) void runAttempt(records.current[id]); },
  };
};

export default useMyBets;
