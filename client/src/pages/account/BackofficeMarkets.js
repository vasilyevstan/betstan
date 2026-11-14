import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { format } from 'date-fns';
import { useParams } from 'react-router-dom';
import useNow from '../../hook/useNow';
import {
  createMarketRequestId, describeMarketRule, marketActionClass, marketError, marketKeysFromLabels, numericMarketValues,
} from '../../marketUi';
import MarketDefinitionEditor, { blankMarketDefinition } from './MarketDefinitionEditor';
import MarketPreview, { PlayerPreview } from '../../components/MarketPreview';
import MarketLayoutEditor from './MarketLayoutEditor';
import { gridLayout, reconcileLayout } from '../../marketLayout';

const TEMPLATES_PATH = '/api/backoffice/market-templates';
const MIN_ODDS = 1.01;
const MAX_ODDS = 1000;
const TABS = [['event', 'Event markets'], ['library', 'Template library']];
const PUBLISHING_MESSAGE = 'Publishing. The market goes live when pricing is confirmed.';
const MANUAL_SAMPLE = { name: 'Your market', parameters: [], outcomes: [{ key: 'a', label: 'Outcome 1' }, { key: 'b', label: 'Outcome 2' }] };

const requestIdentity = (reference, body) => {
  const fingerprint = JSON.stringify(body);
  if (reference.current?.fingerprint !== fingerprint) reference.current = { fingerprint, id: createMarketRequestId() };
  return reference.current.id;
};
const stableJson = (value) => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item));
const latestVersion = (template) => template.versions[template.versions.length - 1];
const copyDefinition = (definition) => ({ ...definition, name: `${definition.name.slice(0, 115)} copy` });
const parameterDefaults = (definition) => Object.fromEntries(definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue]));
const parameterSummary = (definition, values) => definition.parameters
  .map((parameter) => `${parameter.label} ${values?.[parameter.key] ?? parameter.defaultValue}`).join(', ');
const resultBadge = (definition) => definition.settlementMode === 'FINAL_SCORE' ? 'Automatic result' : 'Manual result';
const validOdds = (value) => value !== '' && value !== null && value !== undefined
  && Number.isFinite(Number(value)) && Number(value) >= MIN_ODDS && Number(value) <= MAX_ODDS;
const selectedMarketStatus = (data, marketId) => data?.markets.find((item) => item.marketId === marketId)?.status;
const formatKickoff = (value) => {
  const parsed = new Date(value ?? '');
  return Number.isNaN(parsed.getTime()) ? 'Kickoff time unavailable' : `Kickoff ${format(parsed, 'MMMM do, yyyy H:mm')}`;
};

export const marketStatus = (market) => {
  if (market.decision) {
    return market.resultPublicationPending ? { label: 'Result pending', tone: 'pending' } : { label: 'Settled', tone: 'neutral' };
  }
  if (market.status === 'PUBLISHED') {
    return market.publishedConfiguration?.availability === 'SUSPENDED'
      ? { label: 'Suspended', tone: 'warning' } : { label: 'Published', tone: 'positive' };
  }
  return {
    DRAFT: { label: 'Draft', tone: 'neutral' },
    PUBLISHING: { label: 'Publishing', tone: 'pending' },
    REJECTED: { label: 'Rejected', tone: 'danger' },
  }[market.status] || { label: 'Status unavailable', tone: 'neutral' };
};
const StatusPill = ({ market }) => {
  const status = marketStatus(market);
  return <span className={`market-pill market-pill--${status.tone}`}>{status.label}</span>;
};

const MarketTabs = ({ active, onChange }) => {
  const tabs = useRef({});
  const move = (event, index) => {
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: TABS.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const [id] = TABS[(next + TABS.length) % TABS.length];
    onChange(id);
    tabs.current[id]?.focus();
  };
  return <div className="market-tabs" role="tablist" aria-label="Markets workspace">
    {TABS.map(([id, label], index) => <button key={id} type="button" role="tab" className="market-tab"
      ref={(node) => { tabs.current[id] = node; }} id={`market-tab-${id}`} aria-controls={`market-panel-${id}`}
      aria-selected={active === id} tabIndex={active === id ? 0 : -1}
      onClick={() => onChange(id)} onKeyDown={(event) => move(event, index)}>{label}</button>)}
  </div>;
};

const ManualResult = ({ market, busy, onConfirm }) => {
  const [result, setResult] = useState('SETTLED');
  const [winners, setWinners] = useState([]);
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const definition = market.template.definition;
  const exclusive = definition.outcomeMode === 'EXCLUSIVE';
  return <section className="market-section market-section--result" aria-labelledby="manual-result-heading">
    <h3 className="market-subheading" id="manual-result-heading">Record result</h3>
    {definition.terms ? <p className="market-terms">{definition.terms}</p> : null}
    <fieldset disabled={busy || Boolean(review)}>
      <legend className="visually-hidden">Result decision</legend>
      <label>Decision<select className="form-select" value={result} onChange={(event) => setResult(event.target.value)}>
        <option value="SETTLED">Declare the winning outcomes</option><option value="VOID">Void this market</option>
      </select></label>
      {result === 'SETTLED' ? <div className="market-result-options" role="group" aria-label="Winning outcomes">
        {definition.outcomes.map((outcome) => <label key={outcome.key}>
          <input type={exclusive ? 'radio' : 'checkbox'} name="manual-winner" checked={winners.includes(outcome.key)}
            onChange={(event) => setWinners(exclusive ? [outcome.key]
              : event.target.checked ? [...winners, outcome.key] : winners.filter((key) => key !== outcome.key))} />
          {outcome.label}
        </label>)}
        {definition.coverage === 'PARTIAL' ? <button type="button" className={marketActionClass()} onClick={() => setWinners([])}>
          No listed outcome won
        </button> : null}
      </div> : null}
      <button type="button" className={`${marketActionClass()} mt-2`}
        disabled={result === 'SETTLED' && definition.coverage === 'COMPLETE' && !winners.length}
        onClick={() => {
          setError('');
          try {
            setReview({ revision: market.revision, result, winningOutcomeKeys: result === 'VOID' ? [] : winners,
              requestId: createMarketRequestId() });
          } catch (failure) { setError(marketError(failure)); }
        }}>Review final decision</button>
    </fieldset>
    {error ? <p className="market-notice market-notice--danger" role="alert">{error}</p> : null}
    {review ? <div className="market-result-review">
      <p><strong>{review.result === 'VOID' ? 'Void all selections in this market.'
        : review.winningOutcomeKeys.length ? `Winners: ${definition.outcomes.filter((outcome) => review.winningOutcomeKeys.includes(outcome.key)).map((outcome) => outcome.label).join(', ')}.`
          : 'None of the listed outcomes won.'}</strong> This decision cannot be changed.</p>
      <div className="market-form-actions">
        <button type="button" className={marketActionClass(true)}
          disabled={busy} onClick={() => onConfirm(review)}>Confirm final decision</button>
        <button type="button" className={marketActionClass()} disabled={busy} onClick={() => setReview(null)}>Back</button>
      </div>
    </div> : null}
  </section>;
};

const MarketEditor = ({
  market, writable, hasRetainedModel, busy, focusToken, onUpdate, onPreview, onResult, onReload,
}) => {
  const definition = market.template.definition;
  const automatic = definition.settlementMode === 'FINAL_SCORE';
  const heading = useRef(null);
  const [parameters, setParameters] = useState(market.parameters);
  const [pricing, setPricing] = useState(market.pricing || {
    method: 'OPERATOR', odds: Object.fromEntries(definition.outcomes.map((outcome) => [outcome.key, ''])),
  });
  const [availability, setAvailability] = useState(market.availability);
  const [generation, setGeneration] = useState(market.pricing?.generatedFrom || {
    method: automatic ? 'SCORE_MODEL' : definition.outcomeMode === 'INDEPENDENT' ? 'PROBABILITIES' : 'EQUAL_CHANCE',
    values: {},
  });
  const [preview, setPreview] = useState(null);
  const [reviewedRevision, setReviewedRevision] = useState(market.revision);
  useEffect(() => { if (focusToken) heading.current?.focus(); }, [focusToken]);
  const stale = reviewedRevision !== market.revision;
  const locked = !writable || busy || stale || market.status === 'PUBLISHING' || Boolean(market.decision);
  const odds = pricing.method === 'OPERATOR' ? pricing.odds : preview?.odds;
  const oddsReady = pricing.method === 'OPERATOR' && definition.outcomes.every((outcome) => validOdds(pricing.odds?.[outcome.key]));
  const publishBlocker = pricing.method === 'SCORE_MODEL'
    ? (hasRetainedModel === false ? 'This event has no pricing model. Add a manual market instead.'
      : !preview && !market.configuration ? 'Generate odds first.' : '')
    : oddsReady ? '' : `Enter odds from ${MIN_ODDS} to ${MAX_ODDS} for every outcome.`;
  const generationBody = () => ({
    method: generation.method,
    ...(['PROBABILITIES', 'WEIGHTS'].includes(generation.method) ? {
      values: numericMarketValues(Object.fromEntries(definition.outcomes.map((outcome) => [outcome.key, generation.values?.[outcome.key] ?? '']))),
    } : {}),
    ...(generation.method === 'WEIGHTS' && definition.coverage === 'PARTIAL'
      ? numericMarketValues({ unlistedWeight: generation.unlistedWeight ?? '' }) : {}),
  });
  const generate = async () => {
    const result = await onPreview(() => ({ definition, parameters: numericMarketValues(parameters), generation: generationBody() }));
    if (!result) return;
    setPreview(result);
    setPricing(generation.method === 'SCORE_MODEL' ? { method: 'SCORE_MODEL' }
      : { method: 'OPERATOR', odds: result.odds, generatedFrom: generationBody() });
  };
  const save = async (publish) => {
    const includePricing = pricing.method === 'SCORE_MODEL' || oddsReady;
    const saved = await onUpdate(() => ({
      revision: reviewedRevision, parameters: numericMarketValues(parameters), availability, publish,
      ...(includePricing ? {
        pricing: pricing.method === 'SCORE_MODEL' ? pricing : { ...pricing, odds: numericMarketValues(pricing.odds) },
      } : {}),
    }), publish ? PUBLISHING_MESSAGE
      : includePricing ? 'Draft saved.' : 'Draft saved without odds. Enter odds for every outcome before publishing.');
    if (saved) setReviewedRevision(saved.revision);
  };
  const updateGeneration = (next) => { setGeneration(next); setPreview(null); };
  return <section className="market-editor" aria-labelledby="event-market-editor-heading">
    <header className="market-editor__header">
      <h2 className="market-editor__title" id="event-market-editor-heading" tabIndex={-1} ref={heading}>{definition.name}</h2>
      <div className="market-editor__meta">
        <StatusPill market={market} />
        <span className="market-badge">{resultBadge(definition)}</span>
        {market.template.version > 1 ? <span className="market-badge">Template v{market.template.version}</span> : null}
      </div>
    </header>
    {stale ? <div className="market-notice market-notice--warning" role="alert">
      <p>This market changed. Your unsaved inputs are still shown.</p>
      <button type="button" className={marketActionClass()} disabled={busy} onClick={onReload}>Discard edits and reload market</button>
    </div> : null}
    {market.publicationError ? <p className="market-notice market-notice--danger" role="alert">{market.publicationError}</p> : null}
    {market.status === 'PUBLISHING' ? <p className="market-notice" role="status">Publishing. This updates automatically.</p> : null}
    {market.publishedConfiguration && market.status !== 'PUBLISHED' && market.status !== 'PUBLISHING' && !market.decision
      ? <p className="market-help">The last published version stays live until you publish again.</p> : null}
    {market.decision ? <p className="market-notice" role="status">Locked result: {market.decision.result === 'VOID' ? 'Void'
      : definition.outcomes.filter((outcome) => market.decision.winningOutcomeKeys.includes(outcome.key)).map((outcome) => outcome.label).join(', ') || 'No listed winner'}.
      {market.resultPublicationPending ? ' Result publication is pending and retries automatically.' : ''}</p> : null}
    <fieldset className="market-editor__form" disabled={locked}>
      <legend className="visually-hidden">Market settings and odds</legend>
      <section className="market-section" aria-labelledby="market-settings-heading">
        <h3 className="market-subheading" id="market-settings-heading">Settings</h3>
        <div className="market-form-grid">
          {definition.parameters.map((parameter) => <label key={parameter.key}>{parameter.label}
            <input className="form-control" type="number" step="any" min={parameter.minimum} max={parameter.maximum}
              required value={parameters[parameter.key]} disabled={Boolean(market.configuration)}
              onChange={(event) => { setParameters({ ...parameters, [parameter.key]: event.target.value }); setPreview(null); }} />
          </label>)}
          <label>Availability<select className="form-select" value={availability} onChange={(event) => setAvailability(event.target.value)}>
            <option value="OPEN">Open for betting</option><option value="SUSPENDED">Suspended</option>
          </select></label>
        </div>
        {definition.parameters.length && market.configuration
          ? <p className="market-help">Published lines can't change. Add another market for a different line.</p> : null}
      </section>
      <section className="market-section" aria-labelledby="market-odds-heading">
        <h3 className="market-subheading" id="market-odds-heading">Odds</h3>
        <div className="market-generate">
          {automatic ? <p className="market-help">Odds come from this event's pricing model.</p>
            : <label>Generate odds from<select className="form-select" value={generation.method}
              onChange={(event) => updateGeneration({ method: event.target.value, values: {} })}>
              <option value="EQUAL_CHANCE" disabled={definition.outcomeMode === 'INDEPENDENT'}>Equal chance</option>
              <option value="PROBABILITIES">Probabilities (0-1)</option>
              <option value="WEIGHTS" disabled={definition.outcomeMode === 'INDEPENDENT'}>Relative weights</option>
            </select></label>}
          <button className={marketActionClass()} type="button" disabled={automatic && hasRetainedModel === false}
            onClick={generate}>Generate odds</button>
        </div>
        {generation.method === 'EQUAL_CHANCE' ? <p className="market-help">Equal chance is a starting point, not a prediction.
          {definition.coverage === 'PARTIAL' ? ' It includes an unlisted outcome.' : ''} You can edit the odds afterwards.</p> : null}
        {['PROBABILITIES', 'WEIGHTS'].includes(generation.method) ? <div className="market-form-grid">
          {definition.outcomes.map((outcome) => <label key={outcome.key}>
            {outcome.label}: {generation.method === 'PROBABILITIES' ? 'probability (0-1)' : 'relative weight'}
            <input className="form-control" type="number" step="any" min="0"
              max={generation.method === 'PROBABILITIES' ? '1' : undefined}
              value={generation.values?.[outcome.key] ?? ''} onChange={(event) => updateGeneration({
                ...generation, values: { ...generation.values, [outcome.key]: event.target.value },
              })} />
          </label>)}
          {generation.method === 'WEIGHTS' && definition.coverage === 'PARTIAL' ? <label>Unlisted-outcome weight
            <input className="form-control" type="number" step="any" min="0" value={generation.unlistedWeight ?? ''}
              onChange={(event) => updateGeneration({ ...generation, unlistedWeight: event.target.value })} />
          </label> : null}
        </div> : null}
        <table className="market-odds-table">
          <thead><tr>
            <th scope="col">Outcome</th>
            {automatic ? <th scope="col">Wins when</th> : null}
            <th scope="col" className="market-odds-table__price">Decimal odds</th>
          </tr></thead>
          <tbody>{definition.outcomes.map((outcome) => <tr key={outcome.key}>
            <th scope="row">{outcome.label}</th>
            {automatic ? <td className="market-help">{describeMarketRule(outcome.rule, parameters)}</td> : null}
            <td className="market-odds-table__price">{odds ? <input className="form-control market-price-input" type="number"
              step="0.01" min={MIN_ODDS} max={MAX_ODDS} aria-label={`${outcome.label}: decimal odds`}
              readOnly={pricing.method === 'SCORE_MODEL'} value={odds[outcome.key] ?? ''} onChange={(event) => setPricing({
                method: 'OPERATOR', odds: { ...odds, [outcome.key]: event.target.value },
              })} /> : <span className="market-help">Not generated</span>}</td>
          </tr>)}</tbody>
        </table>
        {automatic && preview ? <label className="market-check-label market-help">
          <input type="checkbox" checked={pricing.method === 'OPERATOR'} onChange={(event) => setPricing(event.target.checked
            ? { method: 'OPERATOR', odds: preview.odds } : { method: 'SCORE_MODEL' })} />
          Edit generated odds
        </label> : null}
        {preview ? <p role="status" className="market-help">Price preview. Review the odds, then publish.</p> : null}
        <PlayerPreview definition={definition} parameters={parameters} odds={odds} layout={market.layout}
          note={odds ? null : 'odds appear once generated or entered'} />
      </section>
      {market.decision ? null : <div className="market-editor__footer">
        {publishBlocker ? <p className="market-help market-editor__reason" id="market-publish-reason">{publishBlocker}</p> : null}
        <button type="button" className={marketActionClass()} onClick={() => save(false)}>Save draft</button>
        <button type="button" className={marketActionClass(true)} disabled={Boolean(publishBlocker)}
          aria-describedby={publishBlocker ? 'market-publish-reason' : undefined} onClick={() => save(true)}>Publish market</button>
      </div>}
    </fieldset>
    {!market.decision && definition.settlementMode === 'MANUAL' && market.publishedConfiguration && market.status !== 'PUBLISHING'
      ? <ManualResult market={market} busy={busy || stale} onConfirm={onResult} /> : null}
  </section>;
};

const MANUAL_CHOICE = 'manual';
const AddMarketPanel = ({ templates, starters, hasRetainedModel, busy, onCreate, onSaveTemplate, onCancel }) => {
  const options = useMemo(() => {
    const saved = templates.filter((template) => !template.archived).map((template) => {
      const latest = latestVersion(template);
      return { id: `template:${template.templateId}`, kind: 'template', templateId: template.templateId,
        version: latest.version, definition: latest.definition, layout: latest.layout };
    });
    const known = new Set(saved.map((option) => stableJson(option.definition)));
    return [...starters.filter((starter) => ['1x2', 'correct-score'].includes(starter.id)
      || !known.has(stableJson(starter.definition))).map((starter) => ({
      id: `starter:${starter.id}`, kind: 'starter', starterId: starter.id, definition: starter.definition, layout: starter.layout,
    })), ...saved];
  }, [templates, starters]);
  const [choice, setChoice] = useState(MANUAL_CHOICE);
  const [values, setValues] = useState({});
  const [manual, setManual] = useState({ name: '', terms: '', outcomes: [{ key: 'manual-1', label: '' }, { key: 'manual-2', label: '' }] });
  const [manualLayout, setManualLayout] = useState(() => gridLayout(manual.outcomes));
  const manualSequence = useRef(2);
  const [designing, setDesigning] = useState(false);
  const option = options.find((item) => item.id === choice);
  const needsModel = (definition) => definition.settlementMode === 'FINAL_SCORE' && hasRetainedModel === false;
  const choose = (next) => {
    setChoice(next.id);
    setValues(next.definition ? parameterDefaults(next.definition) : {});
  };
  const setOutcome = (index, label) => setManual({
    ...manual, outcomes: manual.outcomes.map((current, position) => position === index ? { ...current, label } : current),
  });
  const setManualOutcomes = (outcomes) => {
    setManual({ ...manual, outcomes });
    setManualLayout(reconcileLayout(manualLayout, outcomes));
  };
  const submit = (event) => {
    event.preventDefault();
    if (option) { setDesigning(true); return; }
    const labels = manual.outcomes.map((outcome) => outcome.label.trim());
    const keys = marketKeysFromLabels(labels);
    void onCreate({ definition: {
      schemaVersion: 1, name: manual.name.trim(), settlementMode: 'MANUAL', outcomeMode: 'EXCLUSIVE', coverage: 'COMPLETE',
      terms: manual.terms.trim(), parameters: [], outcomes: labels.map((label, index) => ({ key: keys[index], label })),
    }, parameters: {}, layout: { ...manualLayout, tiles: manualLayout.tiles.map((tile) => ({
      ...tile, outcomeKey: keys[manual.outcomes.findIndex((outcome) => outcome.key === tile.outcomeKey)],
    })) } });
  };
  const choiceRow = (item) => {
    const definition = item.definition;
    return <li key={item.id}>
      <label className={`market-choice${choice === item.id ? ' market-choice--selected' : ''}`}>
        <input type="radio" name="market-choice" value={item.id} checked={choice === item.id}
          onChange={() => choose(item)} />
        <span className="market-choice__body">
          <span className="market-choice__name">{definition ? definition.name : 'Free draw'}</span>
          <span className="market-choice__meta">
            {definition ? <>
              <span className="market-badge">{resultBadge(definition)}</span>
              <span className="market-badge">{item.kind === 'starter' ? 'Starter template' : `Template v${item.version}`}</span>
            </> : <span>Manual market: your outcomes, design, odds and result.</span>}
          </span>
          <MarketPreview compact definition={definition ?? MANUAL_SAMPLE} layout={item.layout}
            parameters={definition ? parameterDefaults(definition) : {}} />
        </span>
      </label>
    </li>;
  };
  if (designing && option) return <MarketDefinitionEditor
    initial={{ ...copyDefinition(option.definition), parameters: option.definition.parameters.map((parameter) => ({
      ...parameter, defaultValue: Number(values[parameter.key]),
    })) }} initialLayout={option.layout} sourceName={option.definition.name} hasRetainedModel={hasRetainedModel}
    disabled={busy} submitLabel="Save design and create draft"
    onSaveTemplate={async (definition, layout) => { if (await onSaveTemplate(definition, layout)) onCancel(); }}
    onCancel={() => setDesigning(false)} onSave={(definition, layout) => onCreate({
      definition, layout, parameters: parameterDefaults(definition),
    })} />;
  return <form className="market-add" id="market-add-panel" aria-labelledby="market-add-heading" onSubmit={submit}>
    <div className="market-toolbar__header">
      <h2 className="market-editor__title" id="market-add-heading">Add a market</h2>
      {option ? <button type="submit" className={marketActionClass(true)} disabled={busy}>Use template</button> : null}
    </div>
    <fieldset disabled={busy}>
      <legend className="market-subheading">Start from</legend>
      <ul className="market-choices">{[{ id: MANUAL_CHOICE }, ...options].map(choiceRow)}</ul>
    </fieldset>
    <fieldset className="market-section" disabled={busy}>
      <legend className="market-subheading">{option ? 'Settings' : 'Free draw'}</legend>
      {option ? (option.definition.parameters.length ? <div className="market-form-grid">
        {option.definition.parameters.map((parameter) => <label key={parameter.key}>{parameter.label}
          <input className="form-control" type="number" step="any" required min={parameter.minimum} max={parameter.maximum}
            value={values[parameter.key] ?? ''} onChange={(event) => setValues({ ...values, [parameter.key]: event.target.value })} />
        </label>)}
      </div> : <p className="market-help">Use this template to rename and design your own copy. The original stays unchanged.</p>) : <>
        <label>Market name<input className="form-control" required maxLength={120} value={manual.name}
          onChange={(event) => setManual({ ...manual, name: event.target.value })} /></label>
        <div className="market-outcome-inputs" role="group" aria-label="Outcomes">
          {manual.outcomes.map((outcome, index) => <div className="market-outcome-input" key={outcome.key}>
            <label>Outcome {index + 1}<input className="form-control" required maxLength={120} value={outcome.label}
              onChange={(event) => setOutcome(index, event.target.value)} /></label>
            {manual.outcomes.length > 2 ? <button type="button" className={marketActionClass()}
              aria-label={`Remove outcome ${index + 1}`} onClick={() => setManualOutcomes(
                manual.outcomes.filter((_, position) => position !== index),
              )}>Remove</button> : null}
          </div>)}
          <button type="button" className={marketActionClass()} disabled={manual.outcomes.length >= 64}
            onClick={() => setManualOutcomes([...manual.outcomes, { key: `manual-${++manualSequence.current}`, label: '' }])}>Add outcome</button>
        </div>
        <label>How the result is decided<textarea className="form-control" rows={2} required maxLength={2000}
          value={manual.terms} onChange={(event) => setManual({ ...manual, terms: event.target.value })} /></label>
        <p className="market-help">Only one outcome can win. It is saved as a template so you can reuse it.</p>
        <MarketLayoutEditor outcomes={manual.outcomes} layout={manualLayout} onChange={setManualLayout} disabled={busy}
          onRename={(key, label) => setOutcome(manual.outcomes.findIndex((outcome) => outcome.key === key), label)} />
      </>}
      <PlayerPreview definition={option ? option.definition : {
        name: manual.name, parameters: [], outcomes: manual.outcomes,
      }} layout={option ? option.layout : manualLayout} parameters={option ? values : {}}
        note="odds are set after you create the draft" />
    </fieldset>
    <div className="market-form-actions">
      {!option ? <button type="submit" className={marketActionClass(true)} disabled={busy}>
        {busy ? 'Creating...' : 'Create draft'}
      </button> : null}
      {option?.kind === 'template' ? <button type="button" className={marketActionClass()}
        disabled={busy || needsModel(option.definition)} onClick={(event) => {
          if (event.currentTarget.form.reportValidity()) void onCreate({ option, parameters: values, layout: option.layout });
        }}>Use saved version</button> : null}
      <button type="button" className={marketActionClass()} disabled={busy} onClick={onCancel}>Cancel</button>
    </div>
  </form>;
};

const TemplateLibrary = ({ library, enabled, busy, onSave, onArchive }) => {
  const [draft, setDraft] = useState(null);
  const sequence = useRef(0);
  const templates = library?.templates ?? [];
  const starters = library?.starters ?? [];
  const open = (definition, extra = {}) => setDraft({ key: ++sequence.current, definition, ...extra });
  const save = async (definition, layout) => { if (await onSave(draft, definition, layout)) setDraft(null); };
  return <div className="market-library">
    <div className="market-library__header">
      <div>
        <h2 className="market-editor__title">Template library</h2>
        <p className="market-help">Templates are shared by all events. Editing creates a new version; existing markets keep theirs.</p>
      </div>
      <button type="button" className={marketActionClass(true)} disabled={busy || !enabled || Boolean(draft)}
        onClick={() => open(blankMarketDefinition(), { start: '' })}>New template</button>
    </div>
    {draft ? <div className="market-library__editor">
      {draft.templateId ? null : <label className="market-library__start">Start from<select className="form-select" value={draft.start}
        disabled={busy} onChange={(event) => {
          const starter = starters.find((item) => item.id === event.target.value);
          open(starter ? copyDefinition(starter.definition) : blankMarketDefinition(), {
            start: event.target.value, layout: starter?.layout, sourceName: starter?.definition.name,
          });
        }}>
        <option value="">Free draw</option>
        {draft.start === 'copy' ? <option value="copy">{draft.sourceName}</option> : null}
        {starters.map((starter) => <option key={starter.id} value={starter.id}>{starter.definition.name}</option>)}
      </select></label>}
      <MarketDefinitionEditor key={draft.key} initial={draft.definition} initialLayout={draft.layout} disabled={busy || !enabled}
        sourceName={draft.sourceName} versioned={Boolean(draft.templateId)} onSave={save} onCancel={() => setDraft(null)} />
    </div> : null}
    {!draft ? <section className="market-standard-designs" aria-label="Starter templates">
      <h3 className="market-subheading">Choose a starting point</h3>
      <p className="market-help">Every starter can become your own named, editable template. Originals and existing event markets stay unchanged.</p>
      <ul className="market-choices">
        {[{ id: '', definition: MANUAL_SAMPLE }, ...starters].map((starter) => <li key={starter.id}>
          <button type="button" className="market-choice" disabled={busy || !enabled}
            aria-label={`Use ${starter.id ? starter.definition.name : 'Free draw'} template`}
            onClick={() => open(starter.id ? copyDefinition(starter.definition) : blankMarketDefinition(), {
              start: starter.id, layout: starter.layout, sourceName: starter.id ? starter.definition.name : undefined,
            })}>
            <span className="market-choice__body">
              <span className="market-choice__name">{starter.id ? starter.definition.name : 'Free draw'}</span>
              <MarketPreview definition={starter.definition} layout={starter.layout} compact />
            </span>
          </button>
        </li>)}
      </ul>
    </section> : null}
    {templates.length ? <ul className="market-template-list">{templates.map((template) => {
      const latest = latestVersion(template);
      return <li key={template.templateId} className="market-template-row">
        <div className="market-template-row__body">
          <span className="market-choice__name">{latest.definition.name}</span>
          <span className="market-choice__meta">
            <span className="market-badge">{resultBadge(latest.definition)}</span>
            <span className="market-badge">v{latest.version}</span>
            {template.archived ? <span className="market-badge market-badge--muted">Archived</span> : null}
          </span>
          <MarketPreview compact definition={latest.definition} layout={latest.layout} parameters={parameterDefaults(latest.definition)} />
        </div>
        <div className="market-template-row__actions">
          <button type="button" className={marketActionClass()} disabled={busy || !enabled || Boolean(draft)}
            aria-label={`Copy ${latest.definition.name}`}
            onClick={() => open(copyDefinition(latest.definition), {
              start: 'copy', layout: latest.layout, sourceName: latest.definition.name,
            })}>Copy</button>
          <button type="button" className={marketActionClass()} disabled={busy || !enabled || template.archived || Boolean(draft)}
            aria-label={`New version of ${latest.definition.name}`}
            onClick={() => open(latest.definition, { templateId: template.templateId, revision: template.revision, layout: latest.layout })}>New version</button>
          <button type="button" className={marketActionClass()} disabled={busy || !enabled}
            aria-label={`${template.archived ? 'Restore' : 'Archive'} ${latest.definition.name}`}
            onClick={() => onArchive(template)}>{template.archived ? 'Restore' : 'Archive'}</button>
        </div>
      </li>;
    })}</ul> : <p className="market-empty">No saved templates yet. Adding a market saves its template here.</p>}
  </div>;
};

const BackofficeMarketView = ({ eventId }) => {
  const [data, setData] = useState(null);
  const [library, setLibrary] = useState(null);
  const [hasRetainedModel, setHasRetainedModel] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('event');
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [editorVersion, setEditorVersion] = useState(0);
  const [focusToken, setFocusToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef(true);
  const acting = useRef(false);
  const sequence = useRef(0);
  const templateRequest = useRef(null);
  const marketRequest = useRef(null);
  const createdTemplate = useRef(null);
  const feedback = useRef(null);
  const now = useNow();
  const path = `/api/backoffice/events/${encodeURIComponent(eventId)}/markets`;
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setRefreshing(true);
    try {
      // The public catalog only tells whether automatic pricing exists; its failure leaves that unknown.
      const retained = axios.get(`/api/event/events/${encodeURIComponent(eventId)}/markets`)
        .then((response) => (typeof response.data?.hasRetainedModel === 'boolean' ? response.data.hasRetainedModel : null), () => null);
      const [eventResponse, templates, model] = await Promise.all([axios.get(path), axios.get(TEMPLATES_PATH), retained]);
      if (active.current && current === sequence.current) {
        setData(eventResponse.data); setLibrary(templates.data); setHasRetainedModel(model); setLoadError('');
      }
    } catch (failure) {
      if (active.current && current === sequence.current) setLoadError(marketError(failure));
    } finally { if (active.current && current === sequence.current) setRefreshing(false); }
  }, [eventId, path]);
  useEffect(() => {
    active.current = true;
    void reload();
    return () => { active.current = false; sequence.current += 1; };
  }, [reload]);
  const pending = data?.markets.some((market) => market.status === 'PUBLISHING' || market.resultPublicationPending);
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => { if (!acting.current) void reload(); }, 3000);
    return () => clearInterval(timer);
  }, [pending, reload]);
  const selectedStatus = selectedMarketStatus(data, selectedId);
  useEffect(() => {
    // Replace the publish acknowledgement once polling shows the outcome.
    if (pending || message !== PUBLISHING_MESSAGE) return;
    setMessage(selectedStatus === 'PUBLISHED' ? 'Published. It now shows on the match card.' : '');
  }, [pending, message, selectedStatus]);
  const run = async (action, success) => {
    if (acting.current) return null;
    acting.current = true;
    const focused = document.activeElement;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await action();
      if (!active.current) return null;
      if (success) { await reload(); setMessage(success); }
      return result;
    } catch (failure) {
      if (active.current) {
        setError(marketError(failure));
        if (failure.response?.status === 409) void reload();
      }
      return null;
    } finally {
      acting.current = false;
      if (active.current) {
        setBusy(false);
        window.requestAnimationFrame(() => {
          if (active.current && document.activeElement === document.body) {
            (document.contains(focused) ? focused : feedback.current)?.focus();
          }
        });
      }
    }
  };
  const templates = library?.templates ?? [];
  const markets = data?.markets ?? [];
  const market = markets.find((item) => item.marketId === selectedId);
  const authoringOn = Boolean(data?.enabled && library?.enabled);
  const resulted = data?.event.status === 'RESULTED';
  const started = data ? resulted || !(Date.parse(data.event.time) > now) : false;
  const writable = authoringOn && !started && !loadError;
  const banner = loadError ? { tone: 'danger', text: data ? `Couldn't refresh markets. ${loadError}` : `Couldn't load markets for this event. ${loadError}` }
    : !data || !library ? null
      : !authoringOn ? { tone: 'warning', text: 'Market authoring is off. You can view markets and record results for published manual markets.' }
        : started ? { tone: 'warning', text: `${resulted ? 'This event has a final result.' : 'Kickoff has passed.'} Markets can't be added or changed. Record results for manual markets below.` }
          : hasRetainedModel === false ? { tone: 'info', text: 'You can copy and design any template. This event has no pricing model: choose Manual result to use a copy here, or save an automatic template for another event.' }
            : null;
  const selectMarket = (marketId) => {
    setAdding(false); setSelectedId(marketId); setError(''); setMessage(''); setFocusToken((token) => token + 1);
  };
  const createMarket = ({ option, definition, parameters, layout }) => run(async () => {
    let reference;
    if (option?.kind === 'template') reference = { templateId: option.templateId, templateVersion: option.version };
    else {
      const templateBody = { ...(option ? { starterId: option.starterId } : { definition }), ...(layout ? { layout } : {}) };
      const fingerprint = stableJson(templateBody);
      // Reuse a template already created by an interrupted attempt instead of creating a duplicate.
      if (createdTemplate.current?.fingerprint === fingerprint) reference = createdTemplate.current.reference;
      else {
        const response = await axios.post(TEMPLATES_PATH, { ...templateBody, requestId: requestIdentity(templateRequest, templateBody) });
        reference = { templateId: response.data.templateId, templateVersion: latestVersion(response.data).version };
        createdTemplate.current = { fingerprint, reference };
      }
    }
    const marketBody = { ...reference, parameters: numericMarketValues(parameters) };
    const response = await axios.post(path, { ...marketBody, requestId: requestIdentity(marketRequest, marketBody) });
    templateRequest.current = null; marketRequest.current = null; createdTemplate.current = null;
    if (active.current) selectMarket(response.data.marketId);
    return response.data;
  }, 'Draft created. Set the odds, then publish.');
  const saveTemplate = (draft, definition, layout) => run(async () => {
    const body = { definition, layout };
    if (draft.templateId) {
      return (await axios.put(`${TEMPLATES_PATH}/${draft.templateId}`, { revision: draft.revision, ...body })).data;
    }
    const saved = (await axios.post(TEMPLATES_PATH, { ...body, requestId: requestIdentity(templateRequest, body) })).data;
    templateRequest.current = null;
    return saved;
  }, 'Template saved. Add it to an event from Event markets.');
  const archiveTemplate = (template) => run(async () => (
    await axios.put(`${TEMPLATES_PATH}/${template.templateId}`, { revision: template.revision, archived: !template.archived })
  ).data, template.archived ? 'Template restored.' : 'Template archived. Existing markets and bets are unchanged.');
  const search = window.location.search;
  return <section className="markets-page backoffice-markets" aria-labelledby="backoffice-markets-title">
    <nav className="market-breadcrumb" aria-label="Breadcrumb">
      <ol>
        <li><a href={`/backoffice${search}`}>Backoffice</a></li>
        <li aria-current="page">Markets</li>
      </ol>
    </nav>
    <header className="market-page-heading">
      <h1 className="h3" id="backoffice-markets-title">{data?.event.name || 'Event markets'}</h1>
      {data ? <p className="market-page-meta">
        <span>{formatKickoff(data.event.time)}</span>
        <span>{resulted ? 'Result recorded' : started ? 'Kicked off' : 'Before kickoff'}</span>
        <span>{data.event.visibility === 'ONLINE' ? 'Online' : data.event.visibility === 'OFFLINE' ? 'Offline' : 'Visibility unknown'}</span>
      </p> : null}
    </header>
    {banner ? <div className={`market-notice market-notice--${banner.tone}`} role={banner.tone === 'danger' ? 'alert' : 'status'}>
      <p>{banner.text}</p>
      {loadError ? <button type="button" className={marketActionClass()} disabled={refreshing} onClick={reload}>Try again</button> : null}
    </div> : null}
    {!data && !loadError ? <p role="status" className="market-help">Loading markets...</p> : null}
    {data ? <>
      <MarketTabs active={tab} onChange={setTab} />
      {error ? <div className="market-notice market-notice--danger" role="alert"><p>{error}</p></div> : null}
      <div ref={feedback} tabIndex={-1} role="status" className={message ? 'market-notice market-notice--positive' : 'visually-hidden'}>
        {message ? <p>{message}</p> : null}
      </div>
      <div role="tabpanel" id="market-panel-event" aria-labelledby="market-tab-event" hidden={tab !== 'event'}>
        <div className="market-workspace">
          <div className="market-toolbar">
            <div className="market-toolbar__header">
              <h2 className="market-sidebar__title">Markets <span className="market-count">{markets.length}</span></h2>
              <div className="market-toolbar__actions">
              <button type="button" className={`${marketActionClass()} market-quiet`} disabled={busy || refreshing}
                onClick={reload}>{refreshing ? 'Refreshing...' : 'Refresh'}</button>
            <button type="button" className={`${marketActionClass(true)} market-add-button`} disabled={busy || !writable}
              aria-expanded={adding} aria-controls="market-add-panel"
              onClick={() => { setAdding(true); setSelectedId(''); setError(''); setMessage(''); }}>Add market</button>
              </div>
            </div>
            {markets.length ? <ul className="market-list">{markets.map((item) => {
              const summary = parameterSummary(item.template.definition, item.parameters);
              return <li key={item.marketId}>
                <button type="button" className="market-row" disabled={busy} aria-pressed={selectedId === item.marketId && !adding}
                  onClick={() => selectMarket(item.marketId)}>
                  <span className="market-row__text">
                    <span className="market-row__name">{item.template.definition.name}</span>
                    {summary ? <span className="market-row__meta">{summary}</span> : null}
                    {item.status === 'REJECTED' && item.publicationError
                      ? <span className="market-row__meta market-row__meta--danger">{item.publicationError}</span> : null}
                  </span>
                  <StatusPill market={item} />
                </button>
              </li>;
            })}</ul> : null}
          </div>
          <div className="market-detail">
            {adding && writable ? <AddMarketPanel templates={templates} starters={library?.starters ?? []}
              hasRetainedModel={hasRetainedModel} busy={busy} onCreate={createMarket}
              onSaveTemplate={(definition, layout) => saveTemplate({}, definition, layout)} onCancel={() => setAdding(false)} />
              : market ? <MarketEditor key={`${market.marketId}:${editorVersion}`} market={market} writable={writable}
                hasRetainedModel={hasRetainedModel} busy={busy} focusToken={focusToken}
                onReload={() => setEditorVersion((version) => version + 1)}
                onUpdate={(body, success) => run(async () => (await axios.put(`${path}/${market.marketId}`, body())).data, success)}
                onPreview={(body) => run(async () => (await axios.post(`/api/event/events/${encodeURIComponent(eventId)}/markets/preview`, body())).data)}
                onResult={(body) => run(async () => (await axios.post(`${path}/${market.marketId}/result`, body)).data,
                  'Result recorded. It is locked and will settle bets.')} />
                : <p className="market-detail__hint">{markets.length ? 'Select a market to edit it.' : writable
                  ? 'Add a market to start.' : 'No markets on this event.'}</p>}
          </div>
        </div>
      </div>
      <div role="tabpanel" id="market-panel-library" aria-labelledby="market-tab-library" hidden={tab !== 'library'}>
        <TemplateLibrary library={library} enabled={authoringOn && !loadError} busy={busy}
          onSave={saveTemplate} onArchive={archiveTemplate} />
      </div>
    </> : null}
  </section>;
};

const BackofficeMarkets = () => {
  const { eventId } = useParams();
  return <BackofficeMarketView key={eventId} eventId={eventId} />;
};
export default BackofficeMarkets;
