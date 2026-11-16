import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Link, useLocation } from 'react-router-dom';
import { riskRuleNames } from '../../riskRuleLabels';
import '../../styles/risk-centre.css';

const API = '/api/backoffice/risk-centre';
const control = 'form-control backoffice-control';
const action = 'btn backoffice-control backoffice-action';
const ruleName = entry => riskRuleNames[entry?.type] || entry?.label;
const categoryNames = {
  admission: 'Bet acceptance', activity: 'Betting activity',
  accounting: 'Exposure and loss', integrity: 'Always-on safeguards',
};
const windowNames = {
  UTC_DAY: 'Calendar day (UTC)', UTC_WEEK: 'Calendar week (UTC)', UTC_MONTH: 'Calendar month (UTC)',
  ROLLING_1H: 'Last hour', ROLLING_24H: 'Last 24 hours', ROLLING_7D: 'Last 7 days', ROLLING_30D: 'Last 30 days',
};
const RuleStatus = ({ enabled }) => <span className={`market-pill market-pill--${enabled ? 'positive' : 'danger'}`}>
  {enabled ? 'ON' : 'OFF'}
</span>;
const inputScale = definition => definition?.unit === 'minor units' ? 100 : definition?.unit === 'milliseconds' ? 1000 : 1;
const inputUnit = definition => definition?.unit === 'minor units' ? 'Stanbucks' : definition?.unit === 'milliseconds' ? 'seconds' : definition?.unit;
const wireNumber = (raw, definition) => {
  const scale = inputScale(definition);
  if (raw === '' || raw === null || raw === undefined) return NaN;
  if (scale > 1 && !(scale === 100 ? /^\d+(\.\d{1,2})?$/ : /^\d+(\.\d{1,3})?$/).test(String(raw))) return NaN;
  return scale > 1 ? Math.round(Number(raw) * scale) : Number(raw);
};
const idPattern = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,95}$/;
const scopeLists = [
  ['eventIds', 'Event IDs'], ['productIds', 'Product IDs'],
  ['marketIds', 'Market IDs'], ['templateIds', 'Template IDs'],
];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasReadinessField = (accounting, field) => Object.prototype.hasOwnProperty.call(accounting, field);
const activityTypes = ['MAX_SUBMISSIONS', 'MAX_TURNOVER', 'REPEAT_BET_COOLDOWN_MS'];
const validReadyWindows = (windows, catalogue) => {
  const supported = new Set(catalogue.flatMap(entry => entry.parameterDefinitions
    .filter(parameter => parameter.name === 'window' && parameter.type === 'select')
    .flatMap(parameter => parameter.options)));
  return Array.isArray(windows) && windows.every(window => typeof window === 'string'
    && window.length > 0 && (!supported.size || supported.has(window)));
};
const validAccounting = (accounting, catalogue) => plain(accounting) && typeof accounting.ready === 'boolean'
  && ((!hasReadinessField(accounting, 'openPositionsReady') && !hasReadinessField(accounting, 'readyLossWindows'))
    || (typeof accounting.openPositionsReady === 'boolean' && validReadyWindows(accounting.readyLossWindows, catalogue)));
const validActivity = (activity, catalogue) => plain(activity) && typeof activity.tracking === 'boolean'
  && validReadyWindows(activity.readyWindows, catalogue)
  && Number.isFinite(activity.readyCooldownMs) && activity.readyCooldownMs >= 0 && activity.readyCooldownMs <= 2592000000
  && (!hasReadinessField(activity, 'trackedSince') || (typeof activity.trackedSince === 'string'
    && Number.isFinite(Date.parse(activity.trackedSince))
    && new Date(activity.trackedSince).toISOString() === activity.trackedSince));
const activityReadyFor = (activity, type, parameters) => {
  if (type === 'REPEAT_BET_COOLDOWN_MS') {
    const limit = typeof parameters.limit === 'number' ? parameters.limit
      : typeof parameters.limit === 'string' && parameters.limit.trim() ? Number(parameters.limit) : NaN;
    return limit === 0 || Boolean(activity?.tracking && Number.isFinite(limit)
      && limit >= 0 && limit <= activity.readyCooldownMs);
  }
  return Boolean(activity?.tracking && activity.readyWindows.includes(parameters.window));
};
const accountingReadyFor = (accounting, type, window) => {
  if (!hasReadinessField(accounting, 'openPositionsReady')) return accounting.ready;
  if (type === 'MAX_CUSTOMER_LOSS') {
    return accounting.openPositionsReady && accounting.readyLossWindows.includes(window);
  }
  if (['MAX_OPEN_STAKE', 'MAX_OPEN_RETURN', 'MAX_OPERATOR_EXPOSURE'].includes(type)) {
    return accounting.openPositionsReady;
  }
  return accounting.ready;
};
const validRules = rules => Array.isArray(rules) && rules.length <= 128
  && rules.every(rule => plain(rule) && typeof rule.id === 'string' && idPattern.test(rule.id) && typeof rule.type === 'string'
    && typeof rule.enabled === 'boolean' && plain(rule.scope) && plain(rule.parameters));
const validRevision = data => plain(data) && Number.isSafeInteger(data.revision) && data.revision > 0
  && data.defaultsVersion === 1 && validRules(data.rules);
const validSnapshot = data => validRevision(data) && Array.isArray(data.catalogue)
  && data.catalogue.every(entry => plain(entry) && typeof entry.type === 'string'
    && typeof entry.label === 'string' && typeof entry.category === 'string'
    && typeof entry.locked === 'boolean' && plain(entry.defaultParameters)
    && typeof entry.defaultEnabled === 'boolean' && plain(entry.defaultScope)
    && Array.isArray(entry.parameterDefinitions) && entry.parameterDefinitions.every(parameter => (
      plain(parameter) && typeof parameter.name === 'string'
      && ['number', 'select', 'boolean'].includes(parameter.type)
      && (parameter.type !== 'select' || Array.isArray(parameter.options))
    )))
  && plain(data.readiness) && ['READY', 'UNAVAILABLE'].includes(data.readiness.transactions)
  && validAccounting(data.readiness.accounting, data.catalogue)
  && (!hasReadinessField(data.readiness, 'activity') || validActivity(data.readiness.activity, data.catalogue))
  && plain(data.readiness.capabilities) && typeof data.readiness.capabilities.extensibleMarkets === 'boolean';
const draftFor = (rule, entry) => ({
  ...rule, parameters: Object.fromEntries(Object.entries(rule.parameters).map(([key, value]) => (
    [key, typeof value === 'number' ? value / inputScale(entry?.parameterDefinitions.find(field => field.name === key)) : value]
  ))),
  scope: Object.fromEntries(Object.entries(rule.scope).map(([key, value]) => (
    [key, Array.isArray(value) ? value.join(', ') : value]
  ))),
});
const scopeValueNames = {
  betKind: { PRE_MATCH: 'Pre-match', LIVE: 'Live' },
  structure: { SINGLE: 'Singles', ACCUMULATOR: 'Accumulators', BUILDER: 'Bet Builder' },
};
const describeScope = scope => Object.entries(scope).map(([key, value]) => (
  scopeValueNames[key]?.[value]
    || `${scopeLists.find(([name]) => name === key)?.[1] || key}: ${Array.isArray(value) ? value.join(', ') : value}`
)).join('; ') || 'All bets';
const onOff = enabled => (enabled ? 'On' : 'Off');
const describeParameters = (parameters, entry) => Object.entries(parameters).map(([key, value]) => {
  const definition = entry?.parameterDefinitions.find(field => field.name === key);
  if (key === 'perCustomer') return value ? 'Per customer' : 'Across all customers';
  if (key === 'window') return windowNames[value] || value;
  const countUnit = { MAX_SUBMISSIONS: 'bets', MAX_LEGS: 'selections', MAX_EVENTS: 'events', MAX_BUILDER_SELECTIONS: 'Builder selections' };
  return typeof value === 'number'
    ? `${value / inputScale(definition)} ${countUnit[entry?.type] || inputUnit(definition) || key}`
    : `${definition?.label || key}: ${String(value)}`;
}).join(' · ') || 'Block matching bets';
const newId = prefix => `${prefix}:${window.crypto.randomUUID()}`;
const requestOptions = { timeout: 10000 };

function prepareRule(draft, catalogue) {
  const parameters = {};
  catalogue.parameterDefinitions.forEach(definition => {
    const raw = draft.parameters[definition.name];
    if (definition.type === 'number') {
      const value = typeof raw === 'string' && raw.trim() === '' ? NaN : wireNumber(raw, definition);
      const odds = definition.unit === 'decimal odds';
      if (!Number.isFinite(value) || value < definition.min || value > definition.max
        || (!odds && !Number.isSafeInteger(value))
        || (odds && !/^\d+(\.\d{1,2})?$/.test(String(raw)))) {
        const scale = inputScale(definition);
        throw new Error(`${definition.label} must be between ${definition.min / scale} and ${definition.max / scale}${odds || scale === 100 ? ', with at most two decimal places' : scale === 1000 ? ', with at most three decimal places' : ', in whole units'}.`);
      }
      parameters[definition.name] = value;
    } else if (definition.type === 'select') {
      if (!definition.options.includes(raw)) throw new Error(`Choose a supported ${definition.label.toLowerCase()}.`);
      parameters[definition.name] = raw;
    } else parameters[definition.name] = Boolean(raw);
  });
  const scope = {};
  for (const [key, value] of Object.entries(draft.scope)) {
    if (!value) continue;
    if (scopeLists.some(([name]) => name === key)) {
      const ids = value.split(',').map(id => id.trim());
      if (ids.length > 32 || ids.some(id => !idPattern.test(id))) {
        throw new Error('Scope requires 1–32 comma-separated stable IDs per field; names, spaces and URLs are not accepted.');
      }
      scope[key] = [...new Set(ids)];
    } else scope[key] = value;
  }
  return { id: draft.id, type: draft.type, enabled: draft.enabled, scope, parameters };
}

export default function RiskCentre() {
  const { search } = useLocation();
  const [snapshot, setSnapshot] = useState(null);
  const snapshotRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState(null);
  const [draft, setDraft] = useState(null);
  const [baseRevision, setBaseRevision] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [stale, setStale] = useState(false);
  const [pendingSelection, setPendingSelection] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [confirmationRevision, setConfirmationRevision] = useState(null);
  const [operation, setOperation] = useState(null);
  const operationRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const mounted = useRef(false);
  const readSequence = useRef(0);
  const feedback = useRef(null);
  const editorHeading = useRef(null);
  const confirmationHeading = useRef(null);
  const focusEditor = useRef(false);

  const acceptSnapshot = useCallback(data => {
    if (snapshotRef.current && data.revision < snapshotRef.current.revision) {
      throw new Error('The server returned an older policy. Refresh again before saving.');
    }
    snapshotRef.current = data;
    setSnapshot(data);
  }, []);
  const reload = useCallback(async () => {
    const sequence = ++readSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const response = await axios.get(API, requestOptions);
      if (!mounted.current || sequence !== readSequence.current) return;
      if (!validSnapshot(response.data)) throw new Error('Invalid Risk Centre response.');
      acceptSnapshot(response.data);
    } catch {
      if (mounted.current && sequence === readSequence.current) {
        setLoadError('Risk Centre could not be loaded. Your input is preserved. Try refreshing.');
      }
    } finally {
      if (mounted.current && sequence === readSequence.current) setLoading(false);
    }
  }, [acceptSnapshot]);
  useEffect(() => {
    mounted.current = true;
    reload();
    return () => { mounted.current = false; readSequence.current += 1; };
  }, [reload]);
  useEffect(() => {
    if (error || message) feedback.current?.focus();
  }, [error, message]);
  useEffect(() => {
    if (focusEditor.current) {
      editorHeading.current?.focus();
      focusEditor.current = false;
    }
  }, [selected, draft]);
  useEffect(() => {
    if (confirmation) confirmationHeading.current?.focus();
  }, [confirmation]);

  const select = item => {
    setSelected(item);
    const rule = snapshot.rules.find(candidate => candidate.id === item.id);
    const definition = snapshot.catalogue.find(candidate => candidate.type === item.type);
    const creating = !item.id && definition && !definition.locked;
    setDraft(rule ? draftFor(rule, definition) : creating
      ? draftFor({ id: newId('rule'), type: item.type, enabled: false, scope: {}, parameters: definition.defaultParameters }, definition) : null);
    setBaseRevision(snapshot.revision);
    setDirty(Boolean(creating));
    setStale(false);
    setError('');
    setMessage('');
    setConfirmation(null);
    setPendingSelection(null);
    focusEditor.current = true;
  };
  const choose = item => {
    if (dirty) setPendingSelection(item);
    else select(item);
  };
  const edit = update => {
    setDraft(current => ({ ...current, ...update }));
    setDirty(true);
    setError('');
    setMessage('');
    setConfirmation(null);
  };
  const requestConfirmation = kind => {
    setConfirmationRevision(snapshot.revision);
    setConfirmation(kind);
  };
  const entry = snapshot?.catalogue.find(item => item.type === (draft?.type || selected?.type));
  const currentRule = snapshot?.rules.find(rule => rule.id === draft?.id);
  const accounting = snapshot?.readiness.accounting;
  const accountingUnavailable = entry?.category === 'accounting'
    && !accountingReadyFor(accounting, entry.type, draft?.parameters.window ?? entry.defaultParameters.window);
  const activity = snapshot?.readiness.activity;
  const activityControl = activityTypes.includes(entry?.type);
  const activityUnavailable = activityControl
    && !activityReadyFor(activity, entry.type, draft ? {
      ...draft.parameters,
      limit: wireNumber(draft.parameters.limit, entry.parameterDefinitions.find(field => field.name === 'limit')),
    } : entry.defaultParameters);
  const accountingNotice = !accounting ? null
    : hasReadinessField(accounting, 'openPositionsReady')
      ? !accounting.openPositionsReady
        ? 'Open-position accounting unavailable: exposure and customer-loss controls require complete authoritative open positions. Missing history is not a zero balance.'
        : !accounting.ready
          ? `Accounting partially ready: open-position exposure controls are available. Customer-loss controls require a ready selected window. Ready loss windows: ${accounting.readyLossWindows.join(', ') || 'none'}. The server rechecks readiness on Save.`
          : null
      : !accounting.ready
        ? 'Accounting unavailable: complete authoritative history is required before exposure or customer-loss controls can be turned on. Missing history is not a zero balance.'
        : null;
  const readOnly = !snapshot || loading || snapshot.readiness.transactions !== 'READY' || Boolean(loadError);
  const conflict = draft && (stale || baseRevision !== snapshot?.revision);
  const frozen = busy || Boolean(operation);
  const actionsLocked = readOnly || frozen || conflict;
  const activationBlocked = Boolean(accountingUnavailable || activityUnavailable);
  const savedOn = Boolean(currentRule?.enabled);
  const changed = dirty || selected?.id === null;

  const completed = (result, pending) => {
    if (!validRevision(result) || result.requestId !== pending.body.requestId
      || result.revision !== pending.body.expectedRevision + 1) {
      throw new Error('Save response could not be verified.');
    }
    readSequence.current += 1;
    setLoading(false);
    const previous = snapshotRef.current;
    const accepted = result.revision >= previous.revision ? { ...previous, ...result } : previous;
    acceptSnapshot(accepted);
    const rule = accepted.rules.find(item => item.id === pending.ruleId);
    const ruleEntry = rule && accepted.catalogue.find(item => item.type === rule.type);
    const name = ruleName(ruleEntry) || 'Rule';
    const saved = `Revision ${result.revision} saved.`;
    const outcome = pending.kind === 'all' ? `All rules restored to defaults. ${saved}`
      : pending.kind === 'remove' ? `${ruleName(snapshotRef.current.catalogue.find(item => item.type === pending.ruleType)) || 'Rule'} removed. ${saved}`
        : !rule ? saved
          : pending.kind === 'restore' ? `${name} restored to its default (${onOff(rule.enabled).toLowerCase()}). ${saved}`
            : rule.enabled ? `${name} is on: ${describeParameters(rule.parameters, ruleEntry)} · ${describeScope(rule.scope)}. Applies to new bets. ${saved}`
              : pending.wasOn ? `${name} is off — it no longer affects new bets. ${saved}`
                : `${name} saved as off — it has no effect on bets. ${saved}`;
    focusEditor.current = false;
    setDraft(rule ? draftFor(rule, accepted.catalogue.find(item => item.type === rule.type)) : null);
    setSelected(rule ? { id: rule.id, type: rule.type } : null);
    setBaseRevision(accepted.revision);
    setDirty(false);
    setStale(false);
    setConfirmation(null);
    setError('');
    setMessage(accepted.revision > result.revision
      ? `Revision ${result.revision} saved, but revision ${accepted.revision} is now active. Check this rule's status.`
      : outcome);
    operationRef.current = null;
    setOperation(null);
    setHistory(null);
  };
  const execute = async pending => {
    if (busy) return;
    operationRef.current = pending;
    setOperation(pending);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await axios.request({
        method: pending.method, url: pending.url, data: pending.body, ...requestOptions,
      });
      if (mounted.current) completed(response.data, pending);
    } catch (failure) {
      if (!mounted.current) return;
      const status = failure.response?.status;
      const code = failure.response?.data?.code;
      if (status >= 400 && status < 500 && status !== 408 && code !== 'OPERATION_CONFLICT') {
        operationRef.current = null;
        setOperation(null);
        if (code === 'REVISION_CONFLICT') setStale(true);
        setError(code === 'REVISION_CONFLICT'
          ? 'This policy changed before Save. Refresh, review the active values, then explicitly use the refreshed revision. Your input is preserved.'
          : failure.response?.data?.message || 'The change was rejected. Review your input and try again.');
      } else {
        setError('Save outcome is uncertain. Your input and operation ID are preserved. Check the result or retry the exact same save before making another change.');
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  // The pressed action, never a separate checkbox, decides whether the rule is on.
  const save = enable => {
    if (readOnly || frozen || conflict || !draft || entry.locked) return;
    try {
      const rule = { ...prepareRule(draft, entry), enabled: enable };
      if (enable && accountingUnavailable) throw new Error("Can't turn on yet: accounting history is not ready. Save it as off instead.");
      if (enable && activityUnavailable) throw new Error("Can't turn on yet: activity history is not ready for this window or cooldown. Save it as off or choose supported settings.");
      const creating = selected.id === null;
      if (!creating && !currentRule) throw new Error('This rule was removed in the active revision. Your input is preserved; create a new rule explicitly rather than restoring a removed rule implicitly.');
      execute({
        method: creating ? 'POST' : 'PUT',
        url: creating ? `${API}/rules` : `${API}/rules/${rule.id}`,
        ruleId: rule.id, kind: 'save', wasOn: Boolean(currentRule?.enabled),
        body: { expectedRevision: baseRevision, requestId: newId('save'), rule },
      });
    } catch (failure) { setError(failure.message); }
  };
  const submit = event => {
    event.preventDefault();
    // Enter only performs the visible primary save; it never turns a rule off.
    if (changed) save(true);
  };
  const confirmMutation = () => {
    if (confirmationRevision !== snapshot.revision || readOnly || frozen) return;
    const remove = confirmation === 'remove';
    const resetAll = confirmation === 'all';
    execute({
      method: remove ? 'DELETE' : 'POST',
      url: remove ? `${API}/rules/${draft.id}` : `${API}/reset`,
      ruleId: resetAll ? undefined : draft.id,
      kind: remove ? 'remove' : resetAll ? 'all' : 'restore', ruleType: draft?.type,
      body: {
        expectedRevision: confirmationRevision, requestId: newId('save'),
        ...(!remove && !resetAll ? { ruleId: draft.id } : {}),
      },
    });
  };
  const checkOperation = async () => {
    const pending = operationRef.current;
    if (!pending || busy) return;
    setBusy(true);
    try {
      const response = await axios.get(`${API}/operations/${pending.body.requestId}`, requestOptions);
      if (mounted.current) completed(response.data, pending);
    } catch (failure) {
      if (mounted.current) setError(failure.response?.status === 404
        ? 'This operation is not recorded yet. Retry the exact same save; its operation ID is unchanged.'
        : 'The save result could not be verified. Keep this page open and retry the same operation.');
    } finally { if (mounted.current) setBusy(false); }
  };
  const loadHistory = async () => {
    setHistoryBusy(true);
    setHistoryError('');
    try {
      const response = await axios.get(`${API}/history`, requestOptions);
      if (!Array.isArray(response.data?.items) || !response.data.items.every(item => (
        validRevision(item) && typeof item.occurredAt === 'string'
      ))) throw new Error('Invalid history');
      if (mounted.current) setHistory(response.data.items);
    } catch {
      if (mounted.current) setHistoryError('Revision history is unavailable. Try again.');
    } finally { if (mounted.current) setHistoryBusy(false); }
  };
  const items = snapshot ? [
    ...snapshot.rules.map(rule => ({ ...rule, catalogue: snapshot.catalogue.find(item => item.type === rule.type) })),
    ...snapshot.catalogue.filter(item => item.locked && item.category !== 'unavailable').map(item => ({ id: item.type, type: item.type, catalogue: item })),
  ] : [];
  const visible = items.filter(item => (!category || item.catalogue?.category === category)
    && `${ruleName(item.catalogue)} ${item.catalogue?.label} ${item.id} ${item.catalogue?.description}`.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(visible.map(item => item.catalogue?.category))];

  return <section className="markets-page backoffice-markets risk-centre" aria-labelledby="risk-title">
    <nav className="market-breadcrumb" aria-label="Breadcrumb"><ol>
      <li><Link to={`/backoffice${search}`}>Backoffice</Link></li><li aria-current="page">Risk Centre</li>
    </ol></nav>
    <header className="market-page-heading">
      <h1 className="h3" id="risk-title">Risk Centre</h1>
      <p>Choose a rule, set its value, then turn it on. Changes apply to new bets, not bets already waiting.</p>
      <p className="market-help">This simulation's rules are public: anyone can edit them. When rules overlap, the stricter limit applies.</p>
      <div className="market-form-actions">
        <button type="button" className={action} disabled={loading || busy} onClick={reload}>Refresh rules</button>
        {snapshot ? <span>{snapshot.readiness.transactions === 'READY' ? 'Active' : 'Read-only policy'} revision {snapshot.revision} · Defaults version {snapshot.defaultsVersion}</span> : null}
      </div>
    </header>
    {loading ? <p role="status">Loading rules…</p> : null}
    {loadError ? <p className="market-notice market-notice--danger" role="alert">{loadError}</p> : null}
    {error || message ? <div ref={feedback} id="risk-input-error" tabIndex="-1" role={error ? 'alert' : 'status'}
      className={`market-notice market-notice--${error ? 'danger' : 'positive'}`}>
      <p>{error || message}</p>
    </div> : null}
    {operation ? <div className="market-form-actions" aria-label="Uncertain save recovery">
      <button type="button" className={action} disabled={busy} onClick={checkOperation}>Check save result</button>
      <button type="button" className={action} disabled={busy} onClick={() => execute(operationRef.current)}>Retry same save</button>
      {busy ? <span role="status">Saving or checking the same operation…</span> : null}
    </div> : null}
    {snapshot ? <>
      {snapshot.readiness.transactions !== 'READY' ? <p className="market-notice market-notice--warning" role="status">Rule editing is not available in this deployment. Existing bet validation continues to run.</p> : null}
      <div className="risk-layout">
        <section className="market-library" aria-labelledby="risk-list-title">
          <h2 className="h5" id="risk-list-title">Rules and safeguards</h2>
          <div className="market-form-actions">
            <label>Add a rule<select className={control} value="" disabled={frozen || readOnly}
              onChange={event => {
                const type = event.target.value;
                if (!type) return;
                choose({ id: null, type });
              }}>
              <option value="">Choose a supported control</option>
              {snapshot.catalogue.filter(item => !item.locked).map(item => <option key={item.type} value={item.type}>{ruleName(item)}</option>)}
            </select></label>
          </div>
          <div className="market-form-grid">
            <label>Search rules<input className={control} type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <label>Category<select className={control} value={category} onChange={event => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {[...new Set(snapshot.catalogue.filter(item => item.category !== 'unavailable').map(item => item.category))].map(value => <option key={value} value={value}>{categoryNames[value] || value}</option>)}
            </select></label>
          </div>
          <p className="market-help">{snapshot.rules.filter(rule => !rule.id.startsWith('default:')).length || 'No'} custom rules. New rules stay off until you turn them on.</p>
          {!visible.length ? <p role="status">No rules match these filters.</p> : null}
          {groups.map(group => <section key={group} className="risk-rule-group" aria-labelledby={`risk-group-${group}`}>
            <h3 className="h6" id={`risk-group-${group}`}>{categoryNames[group] || group}</h3>
            <ul className="risk-rule-list">{visible.filter(item => item.catalogue?.category === group).map(item => <li key={item.id}>
              <button type="button" className={action} aria-pressed={selected?.id === item.id}
                disabled={frozen} onClick={() => choose({ id: item.id, type: item.type })}>
                <span className="risk-rule-title"><strong>{ruleName(item.catalogue) || item.type}</strong>
                  <RuleStatus enabled={item.catalogue?.locked || item.enabled} />
                </span>
                <small>{item.catalogue?.locked ? 'Locked safeguard · Always on' : describeScope(item.scope)}</small>
                {!item.catalogue?.locked ? <small>{describeParameters(item.parameters, item.catalogue)}</small> : null}
              </button>
            </li>)}</ul>
          </section>)}
          <div className="market-form-actions">
            <button type="button" className={action} disabled={frozen || readOnly}
              onClick={() => requestConfirmation('all')}>Restore all defaults</button>
          </div>
        </section>
        <section className="market-detail" aria-labelledby="risk-editor-title">
          <h2 className="h5" id="risk-editor-title" tabIndex="-1" ref={editorHeading}>{ruleName(entry) || 'Choose a rule'}</h2>
          {pendingSelection ? <div className="market-notice market-notice--warning" role="alert">
            <p>Discard your unsaved input to select another rule?</p>
            <div className="market-form-actions">
              <button className={action} type="button" onClick={() => select(pendingSelection)}>Discard input and continue</button>
              <button className={action} type="button" onClick={() => { setPendingSelection(null); editorHeading.current?.focus(); }}>Keep editing</button>
            </div>
          </div> : null}
          {!entry ? <p>Select a rule to inspect its active value, factory default and scope.</p> : <>
            {!entry.locked && draft ? <p className="risk-status">
              {currentRule ? <><RuleStatus enabled={currentRule.enabled} /> — {currentRule.enabled
                ? `checked on new bets · ${describeScope(currentRule.scope)}` : 'has no effect on bets'}</> : <><strong>Not saved</strong> — no effect yet</>}
            </p> : null}
            <p>{entry.description}</p>
            {entry.locked ? <p>Locked — always on. This correctness safeguard cannot be turned off, edited or removed.</p> : <>
              {draft ? <>
                <details className="risk-secondary">
                  <summary>Current settings and defaults</summary>
                  <dl className="risk-values">
                    <dt>Saved value</dt><dd>{currentRule ? `${onOff(currentRule.enabled)} · ${describeParameters(currentRule.parameters, entry)}` : 'Not saved; no effect yet'}</dd>
                    <dt>Active scope</dt><dd>{currentRule ? describeScope(currentRule.scope) : 'Not saved'}</dd>
                    <dt>Default value</dt><dd>{describeParameters(entry.defaultParameters, entry)}</dd>
                    <dt>Default status and scope</dt><dd>{onOff(entry.defaultEnabled)} · {describeScope(entry.defaultScope)}</dd>
                  </dl>
                </details>
                {entry.category === 'accounting' && accountingNotice ? <p className="market-help">{accountingNotice}</p> : null}
                {accountingUnavailable ? <p className="market-help">
                  {draft.type === 'MAX_CUSTOMER_LOSS'
                    ? 'Unavailable for activation: open-position accounting and the selected loss window must be ready.'
                    : 'Unavailable for activation until the required accounting evidence is ready.'}
                  {' '}You can still save it as off. The server rechecks readiness on Save.
                </p> : null}
                {activityControl ? <p className="market-help">
                  {activity?.tracking
                    ? `Activity tracking is on. Ready windows: ${activity.readyWindows.join(', ') || 'none'}. Available cooldown history: ${activity.readyCooldownMs} ms.`
                    : 'Activity history unavailable: authoritative tracking evidence is absent or tracking is off.'}
                  {' '}{activityUnavailable ? 'This selected window or cooldown is unavailable for activation. Change the settings or save it as off. ' : ''}
                  {draft.type === 'REPEAT_BET_COOLDOWN_MS' ? 'A zero cooldown is a no-op, not active protection. ' : ''}
                  The server rechecks activity completeness on Save.
                </p> : null}
                {draft.type === 'DELAY_MS' ? <p className="market-help">Default: no added delay. Transport and missing-event-data retries can still keep a bet pending. Waiting does not extend a quote's expiry.</p> : null}
                {draft.type === 'MAX_OPERATOR_EXPOSURE' ? <p className="market-help">The enforced closure-safe conservative bound differs from informational exact liability. Exact hedge credit is not spendable admission capacity.</p> : null}
                {baseRevision !== snapshot.revision ? <div className="market-notice market-notice--warning" role="alert">
                  <p>Your input is based on revision {baseRevision}; active revision is {snapshot.revision}. Review the active values above before saving over this revision.</p>
                  <button type="button" className={action} disabled={readOnly || frozen || (stale && baseRevision === snapshot.revision)} onClick={() => {
                    setBaseRevision(snapshot.revision); setStale(false); setError('');
                  }}>Use refreshed revision</button>
                </div> : null}
                <form onSubmit={submit} noValidate>
                  <fieldset disabled={readOnly || frozen}>
                    <legend className="h6">Rule settings</legend>
                    <div className="market-form-grid">{entry.parameterDefinitions.map(definition => <label key={definition.name}>
                      {definition.label}{definition.unit ? ` (${inputUnit(definition)})` : ''}
                      {definition.type === 'boolean' ? <input type="checkbox" checked={Boolean(draft.parameters[definition.name])}
                        onChange={event => edit({ parameters: { ...draft.parameters, [definition.name]: event.target.checked } })} />
                        : definition.type === 'select' ? <select className={control} value={draft.parameters[definition.name]}
                          onChange={event => edit({ parameters: { ...draft.parameters, [definition.name]: event.target.value } })}>
                          {definition.options.map(option => <option key={option} value={option}>{windowNames[option] || option}</option>)}
                        </select> : <input className={control} type="number" value={draft.parameters[definition.name]}
                          min={definition.min / inputScale(definition)} max={definition.max / inputScale(definition)}
                          step={definition.unit === 'decimal odds' || inputScale(definition) === 100 ? '0.01' : inputScale(definition) === 1000 ? '0.001' : '1'}
                          aria-describedby={error ? 'risk-input-error' : undefined}
                          onChange={event => edit({ parameters: { ...draft.parameters, [definition.name]: event.target.value } })} />}
                    </label>)}</div>
                    <h3 className="h6 risk-scope-title">Applies to</h3>
                    <div className="market-form-grid">
                      <label>Bet kind<select className={control} value={draft.scope.betKind || ''} onChange={event => edit({ scope: { ...draft.scope, betKind: event.target.value } })}>
                        <option value="">Pre-match and live</option><option value="PRE_MATCH">Pre-match</option><option value="LIVE">Live</option>
                      </select></label>
                      <label>Structure<select className={control} value={draft.scope.structure || ''} onChange={event => edit({ scope: { ...draft.scope, structure: event.target.value } })}>
                        <option value="">All bet types</option><option value="SINGLE">Single</option><option value="ACCUMULATOR">Accumulator</option><option value="BUILDER">Bet Builder</option>
                      </select></label>
                    </div>
                    <details className="risk-secondary" open={scopeLists.some(([key]) => Boolean(currentRule?.scope[key])) || undefined}>
                      <summary>Specific events, products or markets</summary>
                      <p className="market-help">Optional. Leave blank to apply to all. Enter comma-separated IDs only when targeting a specific event, product, market or template.</p>
                      <div className="market-form-grid">{scopeLists.map(([key, label]) => <label key={key}>{label}<input className={control} value={draft.scope[key] || ''} maxLength={3103}
                        onChange={event => edit({ scope: { ...draft.scope, [key]: event.target.value } })} /></label>)}
                      </div>
                    </details>
                  </fieldset>
                  {activationBlocked ? <p className="market-help" id="risk-activation-reason">
                    Can't turn on yet: {accountingUnavailable ? 'accounting history is not ready' : 'activity history is not ready for this window or cooldown'}. You can save it as off.
                  </p> : null}
                  <div className="market-form-actions">
                    {changed ? <>
                      <button className={`${action} backoffice-action--primary`} type="submit"
                        disabled={actionsLocked || activationBlocked} aria-describedby={activationBlocked ? 'risk-activation-reason' : undefined}>
                        {savedOn ? 'Save changes' : 'Save and turn on'}
                      </button>
                      <button className={action} type="button" disabled={actionsLocked} onClick={() => save(false)}>
                        {savedOn ? 'Save and turn off' : 'Save as off'}
                      </button>
                    </> : savedOn
                      ? <button className={`${action} backoffice-action--primary`} type="button" disabled={actionsLocked} onClick={() => save(false)}>Turn off</button>
                      : <button className={`${action} backoffice-action--primary`} type="button" disabled={actionsLocked || activationBlocked}
                        aria-describedby={activationBlocked ? 'risk-activation-reason' : undefined} onClick={() => save(true)}>Turn on</button>}
                    {currentRule ? <button type="button" className={action} disabled={readOnly || frozen || conflict}
                      onClick={() => requestConfirmation(draft.id.startsWith('default:') ? 'default' : 'remove')}>
                      {draft.id.startsWith('default:') ? 'Restore default' : 'Remove'}
                    </button> : null}
                  </div>
                </form>
              </> : null}
            </>}
          </>}
          {confirmation ? <div className="market-notice market-notice--warning" role="alert">
            <h3 className="h6" tabIndex="-1" ref={confirmationHeading}>{confirmation === 'all' ? 'Restore the complete factory policy?' : confirmation === 'remove' ? 'Remove this custom rule?' : 'Restore this factory rule?'}</h3>
            <p>{confirmation === 'all' ? `Replace all ${snapshot.rules.length} active rules with shipped defaults and remove every custom override.`
              : confirmation === 'remove' ? 'Remove this restriction from new receipts.' : `Restore ${onOff(entry.defaultEnabled).toLowerCase()} status, ${describeScope(entry.defaultScope)} scope and default value: ${describeParameters(entry.defaultParameters, entry)}.`}
              {' '}Unsaved input will be discarded. Exposure, usage history and pending policies are not reset.</p>
            {confirmation === 'all' ? <details open>
              <summary>Factory policy preview</summary>
              <ul>{snapshot.catalogue.filter(item => !item.locked).map(item => <li key={item.type}>
                {ruleName(item)}: {onOff(item.defaultEnabled)} · {describeScope(item.defaultScope)} · {describeParameters(item.defaultParameters, item)}
              </li>)}</ul>
            </details> : null}
            {confirmationRevision !== snapshot.revision ? <p>Policy changed while this confirmation was open. Cancel and review a new preview before continuing.</p> : null}
            <div className="market-form-actions">
              <button type="button" className={action} disabled={readOnly || frozen || confirmationRevision !== snapshot.revision} onClick={confirmMutation}>Confirm {confirmation === 'remove' ? 'remove' : 'restore'}</button>
              <button type="button" className={action} disabled={busy} onClick={() => { setConfirmation(null); editorHeading.current?.focus(); }}>Cancel</button>
            </div>
          </div> : null}
        </section>
      </div>
      <section className="risk-support" aria-labelledby="risk-history-title">
        <h2 className="h5" id="risk-history-title">Revision history</h2>
        <p className="market-help">Anonymous changes are unattributed. No customer records or exposure details are shown.</p>
        <button type="button" className={action} disabled={historyBusy} onClick={loadHistory}>{historyBusy ? 'Loading history…' : 'Load recent revisions'}</button>
        {historyError ? <p role="alert">{historyError}</p> : null}
        {history ? <ol>{history.map(item => <li key={item.revision}>Revision {item.revision} · <time dateTime={item.occurredAt}>{item.occurredAt}</time> · {item.rules.length} rules</li>)}</ol> : null}
      </section>
    </> : null}
  </section>;
}
