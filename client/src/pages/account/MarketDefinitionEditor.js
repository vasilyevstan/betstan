import React, { useState } from 'react';
import { marketComparisons, marketMetrics } from '../../marketUi';

const numberInput = (value) => value === '' ? '' : Number(value);
const newRule = () => ({ kind: 'COMPARE', metric: 'TOTAL_GOALS', comparison: 'GT', value: 2.5 });
export const blankMarketDefinition = () => ({
  schemaVersion: 1, name: '', settlementMode: 'MANUAL', outcomeMode: 'EXCLUSIVE', coverage: 'COMPLETE',
  terms: '', parameters: [], outcomes: [{ key: 'first', label: '' }, { key: 'second', label: '' }],
});

const RuleEditor = ({ rule, parameters, onChange, depth = 1 }) => <div className="market-rule">
  <div className="market-form-grid">
    <label>Condition
      <select className="form-select" value={rule.kind} onChange={(event) => {
        const kind = event.target.value;
        onChange(kind === 'COMPARE' ? newRule() : kind === 'NOT'
          ? { kind, rule: newRule() } : { kind, rules: [newRule()] });
      }}>
        <option value="COMPARE">Compare a score fact</option>
        <option value="ALL" disabled={depth >= 8}>All conditions (AND)</option>
        <option value="ANY" disabled={depth >= 8}>Any condition (OR)</option>
        <option value="NOT" disabled={depth >= 8}>Not this condition</option>
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
        {parameters.map((parameter, index) => <option key={index} value={parameter.key}>{parameter.label || parameter.key}</option>)}
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
      {rule.rules.length > 1 ? <button className="btn btn-shell" type="button" onClick={() => onChange({
        ...rule, rules: rule.rules.filter((_, position) => position !== index),
      })}>Remove condition {index + 1}</button> : null}
    </div>)}
    <button className="btn btn-shell" type="button" disabled={rule.rules.length >= 127}
      onClick={() => onChange({ ...rule, rules: [...rule.rules, newRule()] })}>Add condition</button>
  </div> : null}
</div>;

const MarketDefinitionEditor = ({ initial, disabled, onSave, onCancel, versioned }) => {
  const [definition, setDefinition] = useState(initial);
  const change = (field, value) => setDefinition((previous) => ({ ...previous, [field]: value }));
  const updateOutcome = (index, fields) => change('outcomes', definition.outcomes.map((outcome, position) => (
    position === index ? { ...outcome, ...fields } : outcome
  )));
  const updateParameter = (index, fields) => change('parameters', definition.parameters.map((parameter, position) => (
    position === index ? { ...parameter, ...fields } : parameter
  )));
  return <form className="market-definition-editor" onSubmit={(event) => {
    event.preventDefault();
    void onSave(definition);
  }}>
    <fieldset disabled={disabled}>
      <legend>{versioned ? 'Create a new immutable version' : 'Create reusable template'}</legend>
      <p className="market-help">Published markets and placed bets keep their existing version. Stable keys use letters, numbers, dashes or underscores.</p>
      <div className="market-form-grid">
        <label>Template name<input className="form-control" required maxLength={120} value={definition.name}
          onChange={(event) => change('name', event.target.value)} /></label>
        <label>Settlement<select className="form-select" value={definition.settlementMode} onChange={(event) => {
          const settlementMode = event.target.value;
          setDefinition((previous) => ({
            ...previous, settlementMode,
            outcomes: previous.outcomes.map(({ rule, ...outcome }) => settlementMode === 'MANUAL'
              ? outcome : { ...outcome, rule: rule || newRule() }),
          }));
        }}>
          <option value="MANUAL">Operator-declared result</option>
          <option value="FINAL_SCORE">Automatic final score</option>
        </select></label>
        <label>Outcome relationship<select className="form-select" value={definition.outcomeMode}
          onChange={(event) => change('outcomeMode', event.target.value)}>
          <option value="EXCLUSIVE">Only one can win</option>
          <option value="INDEPENDENT">Several can win</option>
        </select></label>
        <label>Coverage<select className="form-select" value={definition.coverage}
          onChange={(event) => change('coverage', event.target.value)}>
          <option value="COMPLETE">All possible results covered</option>
          <option value="PARTIAL">Unlisted results are possible</option>
        </select></label>
      </div>
      <label className="mt-3">Settlement terms<textarea className="form-control" rows={3} maxLength={2000}
        required={definition.settlementMode === 'MANUAL'} value={definition.terms}
        onChange={(event) => change('terms', event.target.value)} /></label>
      <h3 className="h6 mt-3">Reusable numeric parameters</h3>
      <p className="market-help">A parameter can be rebound for each event, such as a goals line. Published bindings are locked.</p>
      {definition.parameters.map((parameter, index) => <fieldset className="market-parameter" key={index}>
        <legend>Parameter {index + 1}</legend>
        <div className="market-form-grid">
          <label>Parameter key<input className="form-control" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
            value={parameter.key} onChange={(event) => updateParameter(index, { key: event.target.value })} /></label>
          <label>Parameter label<input className="form-control" required maxLength={120}
            value={parameter.label} onChange={(event) => updateParameter(index, { label: event.target.value })} /></label>
          {[['minimum', 'Minimum'], ['maximum', 'Maximum'], ['defaultValue', 'Default value']].map(([key, label]) => (
            <label key={key}>{label}<input className="form-control" type="number" step="any" required
              value={parameter[key]} onChange={(event) => updateParameter(index, { [key]: numberInput(event.target.value) })} /></label>
          ))}
        </div>
        <button className="btn btn-shell mt-2" type="button" onClick={() => change('parameters', definition.parameters.filter((_, position) => position !== index))}>
          Remove parameter {index + 1}
        </button>
      </fieldset>)}
      <button className="btn btn-shell" type="button" disabled={definition.parameters.length >= 16}
        onClick={() => change('parameters', [...definition.parameters, { key: '', label: '', minimum: 0, maximum: 99, defaultValue: 2.5 }])}>
        Add parameter
      </button>
      <h3 className="h6 mt-3">Outcomes and rules</h3>
      {definition.settlementMode === 'FINAL_SCORE' ? <p className="market-help">Final scores cover 0-99 goals per team. Up to 128 rule nodes across 8 levels; impossible or overlapping exclusive outcomes cannot be published.</p> : null}
      {definition.outcomes.map((outcome, index) => <fieldset className="market-definition-outcome" key={index}>
        <legend>Outcome {index + 1}</legend>
        <div className="market-form-grid">
          <label>Outcome key<input className="form-control" required maxLength={64} pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
            value={outcome.key} onChange={(event) => updateOutcome(index, { key: event.target.value })} /></label>
          <label>Outcome label<input className="form-control" required maxLength={120}
            value={outcome.label} onChange={(event) => updateOutcome(index, { label: event.target.value })} /></label>
        </div>
        {definition.settlementMode === 'FINAL_SCORE' ? <RuleEditor rule={outcome.rule} parameters={definition.parameters}
          onChange={(rule) => updateOutcome(index, { rule })} /> : null}
        <button className="btn btn-shell mt-2" type="button" disabled={definition.outcomes.length <= 1}
          onClick={() => change('outcomes', definition.outcomes.filter((_, position) => position !== index))}>Remove outcome {index + 1}</button>
      </fieldset>)}
      <button className="btn btn-shell" type="button" disabled={definition.outcomes.length >= 64} onClick={() => change('outcomes', [
        ...definition.outcomes, { key: '', label: '', ...(definition.settlementMode === 'FINAL_SCORE' ? { rule: newRule() } : {}) },
      ])}>Add outcome</button>
      <div className="market-form-actions">
        <button className="btn btn-primary" type="submit">{versioned ? 'Save new version' : 'Save template'}</button>
        <button className="btn btn-shell" type="button" onClick={onCancel}>Cancel template editing</button>
      </div>
    </fieldset>
  </form>;
};
export default MarketDefinitionEditor;
