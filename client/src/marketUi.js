export { createCashBackId as createMarketRequestId } from './cashBackUtils';

export const marketError = (error, fallback = 'The market request failed. Reload its current status before trying again.') => (
  error.response?.data?.message || error.response?.data?.errors?.[0]?.message || error.message || fallback
);
export const selectionKey = (selection) => `${selection.origin}:${selection.marketId}:${selection.outcomeKey}`;
export const marketMetrics = {
  HOME_GOALS: 'Home goals', AWAY_GOALS: 'Away goals', TOTAL_GOALS: 'Total goals', GOAL_DIFFERENCE: 'Home minus away goals',
};
export const marketComparisons = { EQ: '=', GT: '>', GTE: '>=', LT: '<', LTE: '<=' };
export const describeMarketRule = (rule) => {
  if (!rule) return 'Rule unavailable';
  if (rule.kind === 'COMPARE') {
    const value = typeof rule.value === 'object' ? `[${rule.value.parameter}]` : rule.value;
    return `${marketMetrics[rule.metric]} ${marketComparisons[rule.comparison]} ${value}`;
  }
  if (rule.kind === 'NOT') return `Not (${describeMarketRule(rule.rule)})`;
  return `(${rule.rules.map(describeMarketRule).join(rule.kind === 'ALL' ? ' and ' : ' or ')})`;
};
export const numericMarketValues = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => {
  if (value === '' || !Number.isFinite(Number(value))) throw new Error(`Enter a number for ${key}.`);
  return [key, Number(value)];
}));
