export { createCashBackId as createMarketRequestId } from './cashBackUtils';

export const marketError = (error, fallback = 'The market request failed. Reload its current status before trying again.') => (
  error.response?.data?.message || error.response?.data?.errors?.[0]?.message || error.message || fallback
);
export const selectionKey = (selection) => `${selection.origin}:${selection.marketId}:${selection.outcomeKey}`;
export const marketMetrics = {
  HOME_GOALS: 'Home goals', AWAY_GOALS: 'Away goals', TOTAL_GOALS: 'Total goals', GOAL_DIFFERENCE: 'Home minus away goals',
};
export const marketComparisons = { EQ: '=', GT: '>', GTE: '>=', LT: '<', LTE: '<=' };
export const describeMarketRule = (rule, parameters) => {
  if (!rule) return 'Rule unavailable';
  if (rule.kind === 'COMPARE') {
    const value = typeof rule.value === 'object'
      ? (parameters?.[rule.value.parameter] ?? `[${rule.value.parameter}]`) : rule.value;
    return `${marketMetrics[rule.metric]} ${marketComparisons[rule.comparison]} ${value}`;
  }
  if (rule.kind === 'NOT') return `Not (${describeMarketRule(rule.rule, parameters)})`;
  return `(${rule.rules.map((child) => describeMarketRule(child, parameters)).join(rule.kind === 'ALL' ? ' and ' : ' or ')})`;
};
export const marketActionClass = (primary = false) => `btn backoffice-control backoffice-action${primary ? ' backoffice-action--primary' : ''}`;
const reservedMarketKeys = ['constructor', 'prototype', '__proto__'];
const slugMarketKey = (label) => String(label ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 56).replace(/-+$/, '');
// Stable keys are derived from labels; collisions and reserved words get a numeric suffix.
export const uniqueMarketKey = (label, fallback, used) => {
  const base = slugMarketKey(label) || fallback;
  let key = base;
  for (let suffix = 2; used.has(key) || reservedMarketKeys.includes(key); suffix += 1) key = `${base}-${suffix}`;
  used.add(key);
  return key;
};
export const marketKeysFromLabels = (labels, fallback = 'outcome') => {
  const used = new Set();
  return labels.map((label, index) => uniqueMarketKey(label, `${fallback}-${index + 1}`, used));
};
export const numericMarketValues = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => {
  if (value === '' || !Number.isFinite(Number(value))) throw new Error(`Enter a number for ${key}.`);
  return [key, Number(value)];
}));
// Player-facing market name: a single bound parameter reads as "Total goals 2.5".
export const marketTitle = (definition, parameters = {}) => {
  const name = definition?.name?.trim() ?? '';
  const bound = (definition?.parameters ?? []).filter((parameter) => (
    parameters?.[parameter.key] !== undefined && parameters[parameter.key] !== null && parameters[parameter.key] !== ''));
  if (!bound.length) return name;
  if (bound.length === 1) return `${name} ${parameters[bound[0].key]}`;
  return `${name} · ${bound.map((parameter) => `${parameter.label}: ${parameters[parameter.key]}`).join(', ')}`;
};
export const formatMarketOdds = (value) => {
  const odds = value === '' || value === null || value === undefined ? Number.NaN : Number(value);
  return Number.isFinite(odds) && odds > 1 ? odds.toFixed(2) : '–';
};
