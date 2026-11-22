import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { Link, useLocation, useParams } from 'react-router-dom';
import { riskRuleNames } from '../../riskRuleLabels';
import RiskEvents from './RiskEvents';
import '../../styles/risk-centre.css';

const API = '/api/backoffice/risk-centre';
const control = 'form-control backoffice-control';
const action = 'btn backoffice-control backoffice-action';
const ruleName = entry => riskRuleNames[entry?.type] || entry?.label;
const categoryNames = {
  admission: 'Bet acceptance', activity: 'Betting activity', accounting: 'Exposure and loss',
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
  ['selectionIds', 'Choice keys (managed in Backoffice Events)'],
  ['marketTypes', 'Built-in types (managed in Markets)'],
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
const validBuiltinMarkets = markets => Array.isArray(markets) && markets.length > 0 && markets.length <= 32
  && new Set(markets.map(market => market?.id)).size === markets.length
  && markets.every(market => plain(market) && typeof market.id === 'string' && idPattern.test(market.id)
    && typeof market.name === 'string' && market.name.trim().length > 0
    && ['PRE_MATCH', 'LIVE'].includes(market.betKind) && market.id.startsWith(`${market.betKind}:`));
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
  && (!hasReadinessField(data, 'builtinMarkets') || validBuiltinMarkets(data.builtinMarkets))
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
const DELETED_MARKET = 'Deleted market';
const scopeValueNames = {
  betKind: { PRE_MATCH: 'Pre-match', LIVE: 'Live' },
  structure: { SINGLE: 'Singles', ACCUMULATOR: 'Accumulators', BUILDER: 'Bet Builder' },
};
const describeScope = (scope, templateNames) => Object.entries(scope).map(([key, value]) => (
  scopeValueNames[key]?.[value]
    || (['templateIds', 'marketTypes'].includes(key) && templateNames && Array.isArray(value)
      ? `Market: ${value.map(id => templateNames.get(id) || id).join(', ')}`
      : `${scopeLists.find(([name]) => name === key)?.[1] || key}: ${Array.isArray(value) ? value.join(', ') : value}`)
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
const CASH_BACK_API = '/api/backoffice/cash-back-setting';
const TEMPLATES_API = '/api/backoffice/market-templates';
const ACCESS_API = '/api/backoffice/access-controls';
const BETTING_RULE_ID = 'betting:all';
const accessSwitches = [
  { name: 'registration', field: 'registrationEnabled', label: 'New registrations',
    stopped: 'New registrations are stopped. Existing customers can still sign in.',
    allowed: 'New registrations are allowed.' },
  { name: 'login', field: 'loginEnabled', label: 'Customer sign-in',
    stopped: 'Customer sign-in is stopped. People already signed in stay signed in until their session ends; administrators can still sign in.',
    allowed: 'Customer sign-in is allowed.' },
];
const betKindSections = [
  { key: '', title: 'All events', add: 'Add rule for all events', scopeLabel: 'All bets',
    note: 'Applies to pre-match and live bets.', empty: 'No rules for all events.' },
  { key: 'PRE_MATCH', title: 'Pre-match', add: 'Add pre-match rule', scopeLabel: 'All pre-match bets',
    note: 'Always checked: the event has not started and the price is current.',
    empty: 'No pre-match rules yet. Add one to set a pre-match-only limit.' },
  { key: 'LIVE', title: 'Live', add: 'Add live rule', scopeLabel: 'All live bets',
    note: 'Always checked: the event is in play, the market is open and the price has not changed.',
    empty: 'No live rules yet. Add one to set a live-only limit or delay.' },
];
const kindTitle = betKind => betKindSections.find(section => section.key === (betKind || ''))?.title || betKind;
const scopeSummary = (scope, templateNames) => {
  const { betKind, ...rest } = scope;
  const extra = describeScope(rest, templateNames);
  return extra === 'All bets' ? kindTitle(betKind) : `${kindTitle(betKind)} · ${extra}`;
};
const ruleTitle = (rule, catalogue, templateNames) => (
  `${ruleName(catalogue.find(item => item.type === rule.type)) || rule.type} (${scopeSummary(rule.scope, templateNames)})`
);
const describeRule = (rule, catalogue) => {
  const entry = catalogue.find(item => item.type === rule.type);
  return `${onOff(rule.enabled)} · ${describeParameters(rule.parameters, entry)}`;
};
const marketSwitch = rule => rule.type === 'DENY' && ['templateIds', 'marketTypes'].some(field => (
  Object.keys(rule.scope).join() === field && Array.isArray(rule.scope[field])
));
// An enabled Block bets rule with no scope declines every new bet, pre-match and live.
const closesBetting = rule => rule.type === 'DENY' && rule.enabled && !Object.keys(rule.scope).length;
const marketNames = (rule, templateNames) => (rule.scope.templateIds || rule.scope.marketTypes).map(id => templateNames?.get(id) || id).join(', ');
// Human-readable differences between two complete policy revisions.
export const describeChanges = (before, after, catalogue, templateNames) => {
  const previous = new Map(before.rules.map(rule => [rule.id, rule]));
  const changes = [];
  after.rules.forEach(rule => {
    const old = previous.get(rule.id);
    const entry = catalogue.find(item => item.type === rule.type);
    if (!old && rule.id === BETTING_RULE_ID && closesBetting(rule)) {
      changes.push('Betting closed for all events');
      return;
    }
    if (!old) {
      changes.push(marketSwitch(rule) && rule.enabled
        ? `Market ${marketNames(rule, templateNames)} turned off for all events`
        : `Added ${ruleTitle(rule, catalogue, templateNames)}: ${describeRule(rule, catalogue)}`);
      return;
    }
    const parts = [];
    if (old.enabled !== rule.enabled) parts.push(`turned ${onOff(rule.enabled).toLowerCase()}`);
    const [oldValue, newValue] = [describeParameters(old.parameters, entry), describeParameters(rule.parameters, entry)];
    if (oldValue !== newValue) parts.push(`${oldValue} → ${newValue}`);
    const [oldScope, newScope] = [scopeSummary(old.scope, templateNames), scopeSummary(rule.scope, templateNames)];
    if (oldScope !== newScope) parts.push(`applies to ${oldScope} → ${newScope}`);
    if (parts.length) changes.push(`${ruleTitle(old, catalogue, templateNames)}: ${parts.join('; ')}`);
  });
  const current = new Set(after.rules.map(rule => rule.id));
  before.rules.filter(rule => !current.has(rule.id)).forEach(rule => changes.push(
    rule.id === BETTING_RULE_ID && closesBetting(rule) ? 'Betting opened for all events'
      : marketSwitch(rule) && rule.enabled ? `Market ${marketNames(rule, templateNames)} turned on for all events`
        : `Removed ${ruleTitle(rule, catalogue, templateNames)}`));
  return changes;
};
const formatTime = value => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const templateName = template => template.versions?.[template.versions.length - 1]?.definition?.name || template.templateId;
const marketRuleId = id => `market:${id}`;
const blocksMarket = (rule, market) => marketSwitch(rule) && rule.enabled && rule.scope[market.field]?.includes(market.id);
const ownsMarket = (rule, market) => marketSwitch(rule) && !Object.keys(rule.parameters).length
  && rule.scope[market.field]?.length === 1 && rule.scope[market.field][0] === market.id;
const validAccess = data => plain(data) && typeof data.registrationEnabled === 'boolean' && typeof data.loginEnabled === 'boolean';
const validCashBack = data => plain(data) && typeof data.enabled === 'boolean' && Number.isSafeInteger(data.revision);
const validTemplates = data => plain(data) && Array.isArray(data.templates) && data.templates.every(template => (
  plain(template) && typeof template.templateId === 'string' && Array.isArray(template.versions)
));

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

export default function RiskCentre({ eventAnalysis = false }) {
  const { search } = useLocation();
  const { eventId } = useParams();
  const pageTitle = eventAnalysis ? 'Black swan analysis' : 'Risk Centre';
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
  const [cashBack, setCashBack] = useState(null);
  const [cashBackBusy, setCashBackBusy] = useState(false);
  const [templates, setTemplates] = useState(null);
  const [access, setAccess] = useState(null);
  const [accessBusy, setAccessBusy] = useState(false);
  const [switchesLoaded, setSwitchesLoaded] = useState(false);
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
        setLoadError(eventAnalysis ? 'The active policy could not be loaded. Try refreshing before reviewing event analysis.'
          : 'Risk Centre could not be loaded. Your input is preserved. Try refreshing.');
      }
    } finally {
      if (mounted.current && sequence === readSequence.current) setLoading(false);
    }
  }, [acceptSnapshot, eventAnalysis]);
  useEffect(() => {
    mounted.current = true;
    reload();
    return () => { mounted.current = false; readSequence.current += 1; };
  }, [reload]);
  // Global switches are optional extras: a failure only marks them unavailable.
  const loadSwitches = useCallback(async () => {
    const [cash, markets, accounts] = await Promise.allSettled([
      axios.get(CASH_BACK_API, requestOptions), axios.get(TEMPLATES_API, requestOptions), axios.get(ACCESS_API, requestOptions),
    ]);
    if (!mounted.current) return;
    setAccess(accounts.status === 'fulfilled' && validAccess(accounts.value?.data) ? accounts.value.data : null);
    setCashBack(cash.status === 'fulfilled' && validCashBack(cash.value?.data) ? cash.value.data : null);
    setTemplates(markets.status === 'fulfilled' && validTemplates(markets.value?.data) ? markets.value.data : null);
    setSwitchesLoaded(true);
  }, []);
  useEffect(() => { if (!eventAnalysis) loadSwitches(); }, [eventAnalysis, loadSwitches]);
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
      ? draftFor({ id: newId('rule'), type: item.type, enabled: false, scope: item.betKind ? { betKind: item.betKind } : {}, parameters: definition.defaultParameters }, definition) : null);
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
    if (pending.kind === 'market' || pending.kind === 'betting' || pending.kind === 'choice') {
      // A market or betting switch is a separate rule: keep the editor's selection and unsaved input.
      if (!dirty && draft) {
        const kept = accepted.rules.find(item => item.id === draft.id);
        setDraft(kept ? draftFor(kept, accepted.catalogue.find(item => item.type === kept.type)) : null);
        if (!kept) setSelected(null);
        setBaseRevision(accepted.revision);
      }
      setError('');
      setMessage(pending.kind === 'choice' ? '' : `${pending.label} Revision ${result.revision} saved.`);
      operationRef.current = null;
      setOperation(null);
      setHistory(null);
      return;
    }
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
        if (code === 'REVISION_CONFLICT' && pending.kind === 'choice') reload();
        setError(code === 'REVISION_CONFLICT'
          ? pending.kind === 'choice' ? 'The policy changed before the switch. Current rules are reloading; review them before trying again. Your rule input is preserved.'
            : 'This policy changed before Save. Refresh, review the active values, then explicitly use the refreshed revision. Your input is preserved.'
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
  const switchMarket = (market, off) => {
    if (readOnly || frozen) return;
    const id = marketRuleId(market.id);
    const own = snapshot.rules.find(rule => rule.id === id);
    if (own && !ownsMarket(own, market)) {
      setError('This market switch rule was changed. Review it in Rules before switching this market.');
      return;
    }
    const name = market.label || market.name;
    const body = { expectedRevision: snapshot.revision, requestId: newId('save') };
    const rule = { id, type: 'DENY', enabled: true, scope: { [market.field]: [market.id] }, parameters: {} };
    execute(off ? {
      method: own ? 'PUT' : 'POST', url: own ? `${API}/rules/${id}` : `${API}/rules`, ruleId: id, kind: 'market',
      label: `${name} is off for all events. New bets on it are declined.`, body: { ...body, rule },
    } : {
      method: 'DELETE', url: `${API}/rules/${id}`, ruleId: id, kind: 'market',
      label: `${name} is on for all events.`, body,
    });
  };
  const switchBetting = close => {
    if (readOnly || frozen) return;
    const own = snapshot.rules.find(rule => rule.id === BETTING_RULE_ID);
    const body = { expectedRevision: snapshot.revision, requestId: newId('save') };
    const rule = { id: BETTING_RULE_ID, type: 'DENY', enabled: true, scope: {}, parameters: {} };
    execute(close ? {
      method: own ? 'PUT' : 'POST', url: own ? `${API}/rules/${BETTING_RULE_ID}` : `${API}/rules`, ruleId: BETTING_RULE_ID, kind: 'betting',
      label: 'Betting is closed for all events. New pre-match and live bets are declined.', body: { ...body, rule },
    } : {
      method: 'DELETE', url: `${API}/rules/${BETTING_RULE_ID}`, ruleId: BETTING_RULE_ID, kind: 'betting',
      label: 'Betting is open for all events.', body,
    });
  };
  const switchChoice = (choice, event, revision) => {
    if (readOnly || frozen || !snapshot.readiness.capabilities.selectionBlocking) return;
    if (revision !== snapshot.revision) {
      setError('The analysis and active policy differ. Refresh the active policy and review the choice before switching.'); return;
    }
    const id = `choice:${choice.id}`;
    const own = snapshot.rules.find(rule => rule.id === id);
    const body = { expectedRevision: revision, requestId: newId('save') };
    const rule = { id, type: 'DENY', enabled: true,
      scope: { betKind: choice.betKind, eventIds: [event.eventId], selectionIds: [choice.id] }, parameters: {} };
    execute(choice.off ? {
      method: 'DELETE', url: `${API}/rules/${id}`, ruleId: id, kind: 'choice', body,
    } : {
      method: own ? 'PUT' : 'POST', url: own ? `${API}/rules/${id}` : `${API}/rules`, ruleId: id, kind: 'choice',
      body: { ...body, rule },
    });
  };
  const switchAccess = async item => {
    if (!access || accessBusy) return;
    const current = access[item.field];
    setAccessBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await axios.request({
        method: 'PUT', url: `${ACCESS_API}/${item.name}`, ...requestOptions,
        data: { enabled: !current, expectedEnabled: current },
      });
      if (!validAccess(response.data)) throw new Error('Invalid access response.');
      if (!mounted.current) return;
      setAccess(response.data);
      setMessage(response.data[item.field] ? item.allowed : item.stopped);
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure.response?.status === 409
        ? `The ${item.label.toLowerCase()} setting was changed by someone else. The current setting is shown; try again if needed.`
        : `The ${item.label.toLowerCase()} setting could not be changed. Refresh to check the current setting.`);
      if (failure.response?.status === 409) loadSwitches();
    } finally { if (mounted.current) setAccessBusy(false); }
  };
  const switchCashBack = async () => {
    if (!cashBack || cashBackBusy) return;
    setCashBackBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await axios.request({
        method: 'PUT', url: CASH_BACK_API, ...requestOptions,
        data: { enabled: !cashBack.enabled, expectedEnabled: cashBack.enabled },
      });
      if (!validCashBack(response.data)) throw new Error('Invalid cash-back response.');
      if (!mounted.current) return;
      setCashBack(response.data);
      setMessage(response.data.enabled
        ? 'Cash back is on for all events. Per-event switches still apply.'
        : 'Cash back is off for all events. New cash-back requests are refused; requests already being processed can finish.');
    } catch (failure) {
      if (!mounted.current) return;
      setError(failure.response?.status === 409
        ? 'Cash back was changed by someone else. The current setting is shown; try again if needed.'
        : 'Cash back could not be changed. Refresh to check the current setting.');
      if (failure.response?.status === 409) loadSwitches();
    } finally { if (mounted.current) setCashBackBusy(false); }
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
  const items = snapshot ? snapshot.rules.map(rule => ({ ...rule, catalogue: snapshot.catalogue.find(item => item.type === rule.type) })) : [];
  const filtering = Boolean(query || category);
  const visible = items.filter(item => (!category || item.catalogue?.category === category)
    && `${ruleName(item.catalogue)} ${item.catalogue?.label} ${item.id} ${item.catalogue?.description}`.toLowerCase().includes(query.toLowerCase()));
  const templateNames = new Map((templates?.templates || []).map(template => [template.templateId, templateName(template)]));
  (snapshot?.builtinMarkets || []).forEach(market => templateNames.set(market.id, market.name));
  if (templates) items.filter(rule => marketSwitch(rule) && rule.scope.templateIds).forEach(rule => rule.scope.templateIds
    .filter(id => rule.id === marketRuleId(id) && !templateNames.has(id))
    .forEach(id => templateNames.set(id, DELETED_MARKET)));
  const markets = [
    ...(snapshot?.builtinMarkets || []).map(market => ({
      ...market, field: 'marketTypes', detail: `Built-in / ${market.betKind === 'LIVE' ? 'Live' : 'Pre-match'}`,
    })),
    ...(templates?.templates || []).map(template => ({
      id: template.templateId, name: templateName(template), field: 'templateIds',
      detail: template.archived ? 'Template / Archived' : 'Template',
    })),
  ];
  const ownBetting = snapshot?.rules.find(rule => rule.id === BETTING_RULE_ID && closesBetting(rule));
  const bettingClosed = Boolean(snapshot?.rules.some(closesBetting));
  const overlapping = draft && entry && !entry.locked ? snapshot.rules.filter(rule => rule.id !== draft.id
    && rule.type === draft.type && rule.enabled
    && (!draft.scope.betKind || !rule.scope.betKind || rule.scope.betKind === draft.scope.betKind)) : [];
  const sortedHistory = history ? [...history].sort((a, b) => b.revision - a.revision) : null;

  return <section className="markets-page backoffice-markets risk-centre" aria-labelledby="risk-title">
    <nav className="market-breadcrumb" aria-label="Breadcrumb"><ol>
      <li><Link to={`/backoffice${search}`}>Backoffice</Link></li>
      {eventAnalysis && eventId ? <li><Link to={`/backoffice/events/analysis${search}`}>Black swan analysis</Link></li> : null}
      <li aria-current="page">{eventAnalysis && eventId ? 'Event analysis' : pageTitle}</li>
    </ol></nav>
    <header className="market-page-heading">
      <h1 className="h3" id="risk-title">{pageTitle}</h1>
      <p>{eventAnalysis ? 'Review event exposure, stress the current odds, and switch individual choices for new bets.'
        : 'Choose a rule, set its value, then turn it on. Changes apply to new bets, not bets already waiting.'}</p>
      {eventAnalysis && eventId ? <p className="market-help">Conservative loss bounds, not a probability forecast.</p> : null}
      <p className="market-help">This simulation's rules are public: anyone can edit them. When rules overlap, the stricter limit applies.</p>
      <div className="market-form-actions">
        <button type="button" className={action} disabled={loading || busy} onClick={() => { reload(); if (!eventAnalysis) loadSwitches(); }}>
          {eventAnalysis ? 'Refresh policy' : 'Refresh rules'}
        </button>
        {eventAnalysis ? <Link className={action} to={`/backoffice/risk-centre${search}`}>Risk Centre rules</Link> : null}
        {snapshot ? <span>{snapshot.readiness.transactions === 'READY' ? 'Active' : 'Read-only policy'} revision {snapshot.revision} · Defaults version {snapshot.defaultsVersion}</span> : null}
      </div>
    </header>
    {loading ? <p role="status">{eventAnalysis ? 'Loading active policy...' : 'Loading rules…'}</p> : null}
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
      {eventAnalysis ? <RiskEvents eventId={eventId} revision={snapshot.revision} disabled={readOnly || frozen}
          canSwitch={snapshot.readiness.transactions === 'READY' && snapshot.readiness.capabilities.selectionBlocking === true}
          onSwitch={switchChoice} onRefreshRules={reload} search={search} /> : <>
      <section className="risk-switches" aria-labelledby="risk-switches-title">
        <h2 className="h5" id="risk-switches-title">All-events switches</h2>
        <section className="risk-switch" aria-labelledby="risk-betting-title">
          <h3 className="h6" id="risk-betting-title">Betting</h3>
          <p className="market-help">Closing betting declines every new bet, pre-match and live. Bets received before closing finish normally.</p>
          {snapshot.readiness.transactions === 'READY' ? <ul className="risk-switch-list"><li>
            <span className="risk-switch-list__name">All bets</span>
            <RuleStatus enabled={!bettingClosed} />
            {ownBetting || !bettingClosed ? <button type="button" className={action} disabled={readOnly || frozen}
              aria-label={`${ownBetting ? 'Open' : 'Close'} betting for all events`} onClick={() => switchBetting(!ownBetting)}>
              {ownBetting ? 'Open betting' : 'Close betting'}
            </button> : <small>Closed by a Block bets rule</small>}
          </li></ul> : <p className="market-help">Betting can't be switched in this deployment.</p>}
        </section>
        <section className="risk-switch" aria-labelledby="risk-accounts-title">
          <h3 className="h6" id="risk-accounts-title">Accounts</h3>
          <p className="market-help">Stopping sign-in also stops registration, because new accounts are signed in straight away. Administrators can still sign in, and people already signed in stay signed in until their session ends.</p>
          {access ? <ul className="risk-switch-list">{accessSwitches.map(item => <li key={item.name}>
            <span className="risk-switch-list__name">{item.label}</span>
            <RuleStatus enabled={access[item.field]} />
            <button type="button" className={action} disabled={accessBusy} onClick={() => switchAccess(item)}
              aria-label={`${access[item.field] ? 'Stop' : 'Allow'} ${item.label.toLowerCase()}`}>
              {access[item.field] ? 'Stop' : 'Allow'}
            </button>
            {item.name === 'registration' && access.registrationEnabled && !access.loginEnabled
              ? <small>Paused while sign-in is stopped</small> : null}
          </li>)}</ul> : null}
          {!access && switchesLoaded ? <p className="market-help">Account switches are unavailable. Try refreshing.</p> : null}
        </section>
        <section className="risk-switch" aria-labelledby="risk-cashback-title">
          <h3 className="h6" id="risk-cashback-title">Cash back</h3>
          <p className="market-help">For every event. Per-event cash-back switches in Backoffice still apply.</p>
          {cashBack ? <ul className="risk-switch-list"><li>
            <span className="risk-switch-list__name">All events</span>
            <RuleStatus enabled={cashBack.enabled} />
            <button type="button" className={action} disabled={cashBackBusy} onClick={switchCashBack}
              aria-label={`${cashBack.enabled ? 'Turn off' : 'Turn on'} cash back for all events`}>
              {cashBack.enabled ? 'Turn off' : 'Turn on'}
            </button>
          </li></ul> : null}
          {!cashBack && switchesLoaded ? <p className="market-help">Cash-back setting is unavailable. Try refreshing.</p> : null}
        </section>
        <section className="risk-switch" aria-labelledby="risk-markets-title">
          <h3 className="h6" id="risk-markets-title">Markets</h3>
          <p className="market-help">All built-in market types and saved templates. Turning one off blocks new bets on it in every event, including Bet Builder. Other rules and event availability still apply; turning on does not unarchive a template.</p>
          {!snapshot.builtinMarkets ? <p className="market-help">Built-in market switches are unavailable in this deployment.</p> : null}
          {templates && !templates.enabled ? <p className="market-help">Custom markets are turned off in this deployment.</p> : null}
          {!templates && switchesLoaded ? <p className="market-help">Custom market templates are unavailable. Try refreshing.</p> : null}
          {templates && !templates.templates.length ? <p className="market-help">No custom markets yet. Create one in <Link to={`/backoffice/markets${search}`}>Market designer</Link>.</p> : null}
          {markets.length ? <ul className="risk-switch-list">{markets.map(market => {
            const { name } = market;
            const label = markets.some(other => other !== market && other.name === name) ? `${name} (${market.detail})` : name;
            const existing = snapshot.rules.find(rule => rule.id === marketRuleId(market.id));
            const conflict = Boolean(existing && !ownsMarket(existing, market));
            const own = existing?.enabled && !conflict;
            const blocked = snapshot.rules.some(rule => blocksMarket(rule, market));
            return <li key={`${market.field}:${market.id}`}>
              <span className="risk-switch-list__name">{name}<small>{market.detail}</small></span>
              <RuleStatus enabled={!blocked} />
              {conflict ? <small>Switch rule changed; manage it in Rules</small> : own || !blocked ? <button type="button" className={action} disabled={readOnly || frozen || !idPattern.test(marketRuleId(market.id))}
                aria-label={`${own ? 'Turn on' : 'Turn off'} ${label} for all events`} onClick={() => switchMarket({ ...market, label }, !own)}>
                {own ? 'Turn on' : 'Turn off'}
              </button> : <small>Off by a Block bets rule</small>}
            </li>;
          })}</ul> : null}
        </section>
      </section>
      <div className="risk-layout">
        <section className="market-library" aria-labelledby="risk-list-title">
          <h2 className="h5" id="risk-list-title">Rules</h2>
          <div className="market-form-grid">
            <label>Search rules<input className={control} type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
            <label>Category<select className={control} value={category} onChange={event => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {[...new Set(snapshot.catalogue.filter(item => !item.locked && item.category !== 'unavailable').map(item => item.category))].map(value => <option key={value} value={value}>{categoryNames[value] || value}</option>)}
            </select></label>
          </div>
          <p className="market-help">{snapshot.rules.filter(rule => !rule.id.startsWith('default:')).length || 'No'} custom rules. New rules stay off until you turn them on.</p>
          {filtering && !visible.length ? <p role="status">No rules match these filters.</p> : null}
          {betKindSections.map(section => {
            const sectionItems = visible.filter(item => (item.scope.betKind || '') === section.key);
            if (filtering && !sectionItems.length) return null;
            const sectionId = `risk-kind-${section.key || 'ALL'}`;
            return <section key={sectionId} className="risk-kind" aria-labelledby={sectionId}>
              <div className="risk-kind__header">
                <h3 className="h6" id={sectionId}>{section.title}</h3>
                <select className={`${control} risk-kind__add`} aria-label={section.add} value="" disabled={frozen || readOnly}
                  onChange={event => {
                    const type = event.target.value;
                    if (type) choose({ id: null, type, betKind: section.key || undefined });
                  }}>
                  <option value="">+ Add rule</option>
                  {snapshot.catalogue.filter(item => !item.locked).map(item => <option key={item.type} value={item.type}>{ruleName(item)}</option>)}
                </select>
              </div>
              <p className="market-help risk-kind__note">{section.note}</p>
              {!sectionItems.length ? <p className="risk-kind__empty">{section.empty}</p> : null}
              {[...new Set(sectionItems.map(item => item.catalogue?.category))].map(group => <section key={group || 'other'}
                className="risk-rule-group" aria-labelledby={`${sectionId}-${group}`}>
                <h4 className="risk-rule-group__title" id={`${sectionId}-${group}`}>{categoryNames[group] || group}</h4>
                <ul className="risk-rule-list">{sectionItems.filter(item => item.catalogue?.category === group).map(item => {
                  const { betKind, ...rest } = item.scope;
                  const scopeText = describeScope(rest, templateNames);
                  return <li key={item.id}>
                    <button type="button" className={action} aria-pressed={selected?.id === item.id}
                      disabled={frozen} onClick={() => choose({ id: item.id, type: item.type })}>
                      <span className="risk-rule-title"><strong>{ruleName(item.catalogue) || item.type}</strong>
                        <RuleStatus enabled={item.enabled} />
                      </span>
                      <small>{scopeText === 'All bets' ? section.scopeLabel : scopeText}</small>
                      <small>{describeParameters(item.parameters, item.catalogue)}</small>
                    </button>
                  </li>;
                })}</ul>
              </section>)}
            </section>;
          })}
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
                  <fieldset disabled={readOnly || frozen || Boolean(draft.scope.selectionIds)}>
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
                        <option value="">All events</option><option value="PRE_MATCH">Pre-match</option><option value="LIVE">Live</option>
                      </select></label>
                      <label>Structure<select className={control} value={draft.scope.structure || ''} onChange={event => edit({ scope: { ...draft.scope, structure: event.target.value } })}>
                        <option value="">All bet types</option><option value="SINGLE">Single</option><option value="ACCUMULATOR">Accumulator</option><option value="BUILDER">Bet Builder</option>
                      </select></label>
                    </div>
                    {overlapping.length ? <div className="risk-overlap" role="note" aria-label="Other rules that also apply">
                      <p><strong>Also applies to these bets:</strong></p>
                      <ul>{overlapping.map(rule => <li key={rule.id}>
                        {ruleName(entry)} ({scopeSummary(rule.scope, templateNames)}): {describeParameters(rule.parameters, entry)}
                      </li>)}</ul>
                      <p>When more than one rule matches a bet, the stricter limit wins. To loosen the limit, also change or turn off the other rule.</p>
                    </div> : null}
                    <details className="risk-secondary" open={scopeLists.some(([key]) => Boolean(currentRule?.scope[key])) || undefined}>
                      <summary>Specific events, products or markets</summary>
                      <p className="market-help">Optional. Leave blank to apply to all. Enter comma-separated IDs only when targeting a specific event, product, market or template.</p>
                      <div className="market-form-grid">{scopeLists.filter(([key]) => key !== 'selectionIds' || draft.scope.selectionIds).map(([key, label]) => <label key={key}>{label}<input className={control} value={draft.scope[key] || ''} maxLength={3103}
                        onChange={event => edit({ scope: { ...draft.scope, [key]: event.target.value } })} /></label>)}
                      </div>
                    </details>
                  </fieldset>
                  {draft.scope.selectionIds ? <p className="market-help">This choice's identity is managed in Backoffice Events. You can turn this Block bets rule off or remove it here; its scope is read-only.</p> : null}
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
        {sortedHistory ? <ol className="risk-history">{sortedHistory.map(item => {
          const previous = history.find(candidate => candidate.revision === item.revision - 1);
          const changes = previous ? describeChanges(previous, item, snapshot.catalogue, templateNames) : null;
          const count = changes ? `${changes.length} ${changes.length === 1 ? 'change' : 'changes'}`
            : item.revision === 1 ? 'Factory defaults' : 'Changes not loaded';
          return <li key={item.revision}><details>
            <summary><strong>Revision {item.revision}</strong> · <time dateTime={item.occurredAt}>{formatTime(item.occurredAt)}</time> · {count}</summary>
            {changes ? changes.length ? <ul className="risk-history__changes">{changes.map((change, index) => <li key={index}>{change}</li>)}</ul>
              : <p className="market-help">No rule changes.</p>
              : <p className="market-help">{item.revision === 1 ? 'The shipped factory policy.' : 'The previous revision is not in the loaded history, so changes cannot be compared.'}</p>}
            <details className="risk-secondary">
              <summary>All {item.rules.length} rules in this revision</summary>
              <ul>{item.rules.map(rule => <li key={rule.id}>{ruleTitle(rule, snapshot.catalogue, templateNames)}: {describeRule(rule, snapshot.catalogue)}</li>)}</ul>
            </details>
          </details></li>;
        })}</ol> : null}
      </section>
      </>}
    </> : null}
  </section>;
}
