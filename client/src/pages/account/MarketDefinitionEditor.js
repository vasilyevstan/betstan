import React, { useState } from 'react';
import { PlayerPreview } from '../../components/MarketPreview';
import { marketActionClass, marketComparisons, marketMetrics, uniqueMarketKey } from '../../marketUi';
import { layoutError, reconcileLayout } from '../../marketLayout';
import MarketLayoutEditor from './MarketLayoutEditor';

const numberInput = (value) => value === '' ? '' : Number(value);
const newRule = () => ({ kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'GT', value: 2.5 });
export const blankMarketDefinition = () => ({
  schemaVersion: 1, name: '', settlementMode: 'MANUAL', outcomeMode: 'EXCLUSIVE', coverage: 'COMPLETE',
  terms: '', parameters: [], outcomes: [{ key: '', label: '' }, { key: '', label: '' }],
});

// Local-only identity lets keys follow labels until the operator edits a key directly.
let localSequence = 0;
const withLocalIdentity = (items) => items.map((item) => ({ ...item, localId: ++localSequence, keyEdited: Boolean(item.key) }));
const withoutLocalIdentity = (items) => items.map(({ localId, keyEdited, ...item }) => item);
const deriveKeys = (items, fallback) => {
  const used = new Set(items.filter((item) => item.keyEdited).map((item) => item.key));
  return items.map((item, index) => item.keyEdited ? item
    : { ...item, key: uniqueMarketKey(item.label, `${fallback}-${index + 1}`, used) });
};
const renameReference = (rule, from, to) => {
  if (!rule) return rule;
  if (rule.kind === 'COMPARE') {
    return typeof rule.value === 'object' && rule.value.parameter === from ? { ...rule, value: { parameter: to } } : rule;
  }
  if (rule.kind === 'NOT') return { ...rule, rule: renameReference(rule.rule, from, to) };
  return { ...rule, rules: rule.rules.map((child) => renameReference(child, from, to)) };
};

const RuleEditor = ({ rule, parameters, onChange, depth = 1 }) => <div className="market-rule">
  <div className="market-form-grid">
    <label>Condition
      <select className="form-select" value={rule.kind} onChange={(event) => {
        const kind = event.target.value;
        onChange(kind === 'COMPARE' ? newRule() : kind === 'NOT'
          ? { kind, rule: newRule() } : { kind, rules: [newRule()] });
      }}>
        <option value="COMPARE">Score comparison</option>
        <option value="ALL" disabled={depth >= 8}>All of (AND)</option>
        <option value="ANY" disabled={depth >= 8}>Any of (OR)</option>
        <option value="NOT" disabled={depth >= 8}>Not</option>
      </select>
    </label>
    {rule.kind === 'COMPARE' ? <>
      <label>Score fact<select className="form-select" value={rule.metric}
        onChange={(event) => onChange({ ...rule, metric: event.target.value })}>
        {Object.entries(marketMetrics).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Comparison<select className="form-select" value={rule.comparison}
        onChange={(event) => onChange({ ...rule, comparison: event.target.value })}>
        {Object.entries(marketComparisons).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      <label>Compare with<select className="form-select"
        value={typeof rule.value === 'object' ? rule.value.parameter : ''}
        onChange={(event) => onChange({ ...rule, value: event.target.value ? { parameter: event.target.value } : 0 })}>
        <option value="">Fixed number</option>
        {parameters.map((parameter) => <option key={parameter.localId} value={parameter.key}>{parameter.label || parameter.key}</option>)}
      </select></label>
      {typeof rule.value !== 'object' ? <label>Comparison value<input className="form-control" type="number" step="any" required
        value={rule.value} onChange={(event) => onChange({ ...rule, value: numberInput(event.target.value) })} /></label> : null}
    </> : null}
  </div>
  {rule.kind === 'NOT' ? <div className="market-rule__children">
    <RuleEditor rule={rule.rule} parameters={parameters} depth={depth + 1} onChange={(next) => onChange({ ...rule, rule: next })} />
  </div> : null}
  {rule.kind === 'ALL' || rule.kind === 'ANY' ? <div className="market-rule__children">
    {rule.rules.map((child, index) => <div key={index}>
      <RuleEditor rule={child} parameters={parameters} depth={depth + 1} onChange={(next) => onChange({
        ...rule, rules: rule.rules.map((current, position) => position === index ? next : current),
      })} />
      {rule.rules.length > 1 ? <button className={marketActionClass()} type="button" onClick={() => onChange({
        ...rule, rules: rule.rules.filter((_, position) => position !== index),
      })}>Remove condition {index + 1}</button> : null}
    </div>)}
    <button className={marketActionClass()} type="button" disabled={rule.rules.length >= 127}
      onClick={() => onChange({ ...rule, rules: [...rule.rules, newRule()] })}>Add condition</button>
  </div> : null}
</div>;

const MarketDefinitionEditor = ({ initial, initialLayout, disabled, onSave, onCancel, versioned, sourceName }) => {
  const [definition, setDefinition] = useState(() => {
    const outcomes = deriveKeys(withLocalIdentity(initial.outcomes), 'outcome');
    return { ...initial, parameters: withLocalIdentity(initial.parameters), outcomes, layout: reconcileLayout(initialLayout, outcomes) };
  });
  const change = (field, value) => setDefinition((previous) => ({
    ...previous, [field]: value,
    ...(field === 'outcomes' ? { layout: reconcileLayout(previous.layout, value, previous.outcomes) } : {}),
  }));
  const updateOutcome = (index, fields) => setDefinition((previous) => {
    const outcomes = deriveKeys(previous.outcomes.map((outcome, position) => (
      position === index ? { ...outcome, ...fields } : outcome
    )), 'outcome');
    return { ...previous, outcomes, layout: reconcileLayout(previous.layout, outcomes, previous.outcomes) };
  });
  const updateParameter = (index, fields) => setDefinition((previous) => {
    const parameters = deriveKeys(previous.parameters.map((parameter, position) => (
      position === index ? { ...parameter, ...fields } : parameter
    )), 'parameter');
    let { outcomes } = previous;
    parameters.forEach((parameter, position) => {
      const before = previous.parameters[position]?.key;
      if (before && before !== parameter.key) {
        outcomes = outcomes.map((outcome) => ({ ...outcome, rule: renameReference(outcome.rule, before, parameter.key) }));
      }
    });
    return { ...previous, parameters, outcomes };
  });
  const automatic = definition.settlementMode === 'FINAL_SCORE';
  const save = () => {
    const { parameters, outcomes, layout, ...rest } = definition;
    if (layoutError(layout, outcomes)) return;
    void onSave({
      ...rest,
      parameters: withoutLocalIdentity(parameters),
      outcomes: withoutLocalIdentity(outcomes).map(({ rule, ...outcome }) => automatic ? { ...outcome, rule } : outcome),
    }, layout);
  };
  return <form className="market-definition-editor" onSubmit={(event) => {
    event.preventDefault();
    save();
  }}>
    <fieldset disabled={disabled}>
      <legend>{versioned ? `New version of ${initial.name}` : 'New template'}</legend>
      {sourceName ? <p className="market-help">Starting from {sourceName}. Rename and design your copy; the source template stays unchanged.</p>
        : <p className="market-help">Markets already on events keep their version. Keys are created from labels; edit one only if you need a specific identifier.</p>}
      <div className="market-form-grid">
        <label>Template name<input className="form-control" required maxLength={120} value={definition.name}
          onChange={(event) => change('name', event.target.value)} /></label>
        <label>Result<select className="form-select" value={definition.settlementMode} onChange={(event) => {
          const settlementMode = event.target.value;
          setDefinition((previous) => ({
            ...previous, settlementMode,
            outcomes: previous.outcomes.map((outcome) => settlementMode === 'MANUAL'
              ? outcome : { ...outcome, rule: outcome.rule || newRule() }),
          }));
        }}>
          <option value="MANUAL">Manual</option>
          <option value="FINAL_SCORE">Automatic (final score)</option>
        </select></label>
        <label>Winners<select className="form-select" value={definition.outcomeMode}
          onChange={(event) => change('outcomeMode', event.target.value)}>
          <option value="EXCLUSIVE">One winner</option>
          <option value="INDEPENDENT">Several winners</option>
        </select></label>
        <label>Coverage<select className="form-select" value={definition.coverage}
          onChange={(event) => change('coverage', event.target.value)}>
          <option value="COMPLETE">Covers every result</option>
          <option value="PARTIAL">Other results possible</option>
        </select></label>
      </div>
      <label className="mt-3">Settlement terms<textarea className="form-control" rows={3} maxLength={2000}
        required={!automatic} value={definition.terms}
        onChange={(event) => change('terms', event.target.value)} /></label>
      <MarketLayoutEditor outcomes={definition.outcomes} layout={definition.layout} disabled={disabled}
        onChange={(layout) => change('layout', layout)}
        onRename={(key, label) => updateOutcome(definition.outcomes.findIndex((outcome) => outcome.key === key), { label })} />
      <h3 className="market-subheading">Parameters</h3>
      <p className="market-help">A number chosen per event, such as a goals line. It is locked once the market is published.</p>
      {definition.parameters.map((parameter, index) => <fieldset className="market-parameter" key={parameter.localId}>
        <legend>Parameter {index + 1}</legend>
        <div className="market-form-grid">
          <label>Parameter label<input className="form-control" required maxLength={80}
            value={parameter.label} onChange={(event) => updateParameter(index, { label: event.target.value })} /></label>
          <label>Parameter key<input className="form-control" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
            value={parameter.key} onChange={(event) => updateParameter(index, { key: event.target.value, keyEdited: true })} /></label>
          {[['minimum', 'Minimum'], ['maximum', 'Maximum'], ['defaultValue', 'Default value']].map(([key, label]) => (
            <label key={key}>{label}<input className="form-control" type="number" step="any" required
              value={parameter[key]} onChange={(event) => updateParameter(index, { [key]: numberInput(event.target.value) })} /></label>
          ))}
        </div>
        <button className={`${marketActionClass()} mt-2`} type="button"
          onClick={() => change('parameters', definition.parameters.filter((_, position) => position !== index))}>
          Remove parameter {index + 1}
        </button>
      </fieldset>)}
      <button className={marketActionClass()} type="button" disabled={definition.parameters.length >= 16}
        onClick={() => change('parameters', deriveKeys([...definition.parameters, ...withLocalIdentity([
          { key: '', label: '', minimum: 0, maximum: 99, defaultValue: 2.5 },
        ])], 'parameter'))}>
        Add parameter
      </button>
      <h3 className="market-subheading">Outcomes</h3>
      {automatic ? <p className="market-help">Each outcome wins when its condition matches the final score (0-99 goals per team). Exclusive outcomes must not overlap.</p> : null}
      {definition.outcomes.map((outcome, index) => <fieldset className="market-definition-outcome" key={outcome.localId}>
        <legend>Outcome {index + 1}</legend>
        <div className="market-form-grid">
          <label>Outcome label<input className="form-control" required maxLength={120}
            value={outcome.label} onChange={(event) => updateOutcome(index, { label: event.target.value })} /></label>
          <label>Outcome key<input className="form-control" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
            value={outcome.key} onChange={(event) => updateOutcome(index, { key: event.target.value, keyEdited: true })} /></label>
        </div>
        {automatic ? <RuleEditor rule={outcome.rule} parameters={definition.parameters}
          onChange={(rule) => updateOutcome(index, { rule })} /> : null}
        <button className={`${marketActionClass()} mt-2`} type="button" disabled={definition.outcomes.length <= 1}
          onClick={() => change('outcomes', definition.outcomes.filter((_, position) => position !== index))}>Remove outcome {index + 1}</button>
      </fieldset>)}
      <button className={marketActionClass()} type="button" disabled={definition.outcomes.length >= 64} onClick={() => change('outcomes', deriveKeys([
        ...definition.outcomes, ...withLocalIdentity([{ key: '', label: '', ...(automatic ? { rule: newRule() } : {}) }]),
      ], 'outcome'))}>Add outcome</button>
      <PlayerPreview definition={definition} layout={definition.layout} note="default values; odds are set per event"
        parameters={Object.fromEntries(definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue]))} />
      <div className="market-form-actions">
        <button className={marketActionClass(true)} type="submit" disabled={Boolean(layoutError(definition.layout, definition.outcomes))}>
          {versioned ? 'Save new version' : 'Save template'}
        </button>
        <button className={marketActionClass()} type="button" onClick={onCancel}>Cancel</button>
      </div>
    </fieldset>
  </form>;
};
export default MarketDefinitionEditor;
