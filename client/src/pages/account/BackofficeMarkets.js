import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';
import useNow from '../../hook/useNow';
import { createMarketRequestId, describeMarketRule, marketError, numericMarketValues } from '../../marketUi';
import MarketDefinitionEditor, { blankMarketDefinition } from './MarketDefinitionEditor';

const requestIdentity = (reference, body) => {
  const fingerprint = JSON.stringify(body);
  if (reference.current?.fingerprint !== fingerprint) reference.current = { fingerprint, id: createMarketRequestId() };
  return reference.current.id;
};
const statusLabel = (market) => market.decision
  ? (market.resultPublicationPending ? 'Result locked, publication pending' : 'Result locked')
  : market.status === 'PUBLISHED'
    ? (market.publishedConfiguration?.availability === 'SUSPENDED' ? 'Suspended' : 'Published')
    : ({ DRAFT: 'Draft', PUBLISHING: 'Publication pending', REJECTED: 'Publication rejected' }[market.status] || market.status);

const ManualResult = ({ market, busy, onConfirm }) => {
  const [result, setResult] = useState('SETTLED');
  const [winners, setWinners] = useState([]);
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const definition = market.template.definition;
  const exclusive = definition.outcomeMode === 'EXCLUSIVE';
  return <section className="market-group" aria-labelledby="manual-result-heading">
    <h3 className="h6" id="manual-result-heading">Record operator-declared result</h3>
    <p>{definition.terms}</p>
    <fieldset disabled={busy || Boolean(review)}>
      <label>Decision<select className="form-select" value={result} onChange={(event) => setResult(event.target.value)}>
        <option value="SETTLED">Declare winning outcomes</option><option value="VOID">Void this market</option>
      </select></label>
      {result === 'SETTLED' ? <div className="market-result-options" role="group" aria-label="Winning outcomes">
        {definition.outcomes.map((outcome) => <label key={outcome.key}>
          <input type={exclusive ? 'radio' : 'checkbox'} name="manual-winner" checked={winners.includes(outcome.key)}
            onChange={(event) => setWinners(exclusive ? [outcome.key]
              : event.target.checked ? [...winners, outcome.key] : winners.filter((key) => key !== outcome.key))} />
          {outcome.label}
        </label>)}
        {definition.coverage === 'PARTIAL' ? <button type="button" className="btn btn-shell" onClick={() => setWinners([])}>
          No listed outcome won
        </button> : null}
      </div> : null}
      <button type="button" className="btn btn-shell mt-2"
        disabled={result === 'SETTLED' && definition.coverage === 'COMPLETE' && !winners.length}
        onClick={() => {
          setError('');
          try {
            setReview({ revision: market.revision, result, winningOutcomeKeys: result === 'VOID' ? [] : winners,
              requestId: createMarketRequestId() });
          } catch (failure) { setError(marketError(failure)); }
        }}>Review final decision</button>
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    {review ? <div className="market-result-review">
      <p><strong>{review.result === 'VOID' ? 'Void all selections in this market.'
        : review.winningOutcomeKeys.length ? `Winners: ${definition.outcomes.filter((outcome) => review.winningOutcomeKeys.includes(outcome.key)).map((outcome) => outcome.label).join(', ')}.`
          : 'None of the listed outcomes won.'}</strong> This decision cannot be changed.</p>
      <div className="market-form-actions">
        <button type="button" className="btn btn-primary"
          disabled={busy} onClick={() => onConfirm(review)}>Confirm final decision</button>
        <button type="button" className="btn btn-shell" disabled={busy} onClick={() => setReview(null)}>Back to result</button>
      </div>
    </div> : null}
  </section>;
};

const MarketEditor = ({ market, writable, busy, onUpdate, onPreview, onResult, onReload }) => {
  const definition = market.template.definition;
  const [parameters, setParameters] = useState(market.parameters);
  const [pricing, setPricing] = useState(market.pricing || {
    method: 'OPERATOR', odds: Object.fromEntries(definition.outcomes.map((outcome) => [outcome.key, ''])),
  });
  const [availability, setAvailability] = useState(market.availability);
  const [generation, setGeneration] = useState(market.pricing?.generatedFrom || {
    method: definition.settlementMode === 'FINAL_SCORE' ? 'SCORE_MODEL'
      : definition.outcomeMode === 'INDEPENDENT' ? 'PROBABILITIES' : 'EQUAL_CHANCE',
    values: {},
  });
  const [preview, setPreview] = useState(null);
  const [reviewedRevision, setReviewedRevision] = useState(market.revision);
  const stale = reviewedRevision !== market.revision;
  const locked = !writable || busy || stale || market.status === 'PUBLISHING' || Boolean(market.decision);
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
    const saved = await onUpdate(() => ({
      revision: reviewedRevision, parameters: numericMarketValues(parameters), availability, publish,
      pricing: pricing.method === 'SCORE_MODEL' ? pricing : { ...pricing, odds: numericMarketValues(pricing.odds) },
    }));
    if (saved) setReviewedRevision(saved.revision);
  };
  const odds = pricing.method === 'OPERATOR' ? pricing.odds : preview?.odds;
  return <section className="market-editor" aria-labelledby="event-market-editor-heading">
    <h2 className="h5" id="event-market-editor-heading">{definition.name}</h2>
    <p className="market-help">Template version {market.template.version} · {statusLabel(market)}</p>
    {stale ? <div className="market-feedback" role="alert">
      This market changed. Your unsaved inputs are still shown.
      <button type="button" className="btn btn-shell" disabled={busy} onClick={onReload}>Discard edits and reload market</button>
    </div> : null}
    {market.publicationError ? <p role="alert" className="text-danger">{market.publicationError}</p> : null}
    {market.publishedConfiguration && market.status !== 'PUBLISHED' && market.status !== 'PUBLISHING' && !market.decision
      ? <p className="market-help">The previous published configuration is still active. Saving a draft does not replace it.</p> : null}
    <fieldset disabled={locked}>
      <legend>Event bindings and prices</legend>
      <div className="market-form-grid">
        {definition.parameters.map((parameter) => <label key={parameter.key}>{parameter.label}
          <input className="form-control" type="number" step="any" min={parameter.minimum} max={parameter.maximum}
            required value={parameters[parameter.key]} disabled={Boolean(market.configuration)}
            onChange={(event) => { setParameters({ ...parameters, [parameter.key]: event.target.value }); setPreview(null); }} />
        </label>)}
        <label>Availability<select className="form-select" value={availability} onChange={(event) => setAvailability(event.target.value)}>
          <option value="OPEN">Open after publication</option><option value="SUSPENDED">Suspended after publication</option>
        </select></label>
      </div>
      <p className="market-help">{definition.settlementMode === 'MANUAL'
        ? 'Prices are operator-entered. Generating odds does not make this market automatically settled or Builder eligible.'
        : "Automatic prices use this event's retained score model. Overridden prices are excluded from Builders."}</p>
      <div className="market-toolbar">
        <label>Generation method<select className="form-select" value={generation.method} onChange={(event) => {
          setGeneration({ method: event.target.value, values: {} }); setPreview(null);
        }}>
          {definition.settlementMode === 'FINAL_SCORE' ? <option value="SCORE_MODEL">Retained score model</option> : <>
            <option value="EQUAL_CHANCE" disabled={definition.outcomeMode === 'INDEPENDENT'}>Equal-chance assumption</option>
            <option value="PROBABILITIES">Operator probabilities (0-1)</option>
            <option value="WEIGHTS" disabled={definition.outcomeMode === 'INDEPENDENT'}>Relative weights</option>
          </>}
        </select></label>
        <button className="btn btn-shell" type="button" onClick={generate}>Generate odds</button>
      </div>
      {generation.method === 'EQUAL_CHANCE' ? <p className="market-help">Equal chance is a starting assumption, not a prediction.
        {definition.coverage === 'PARTIAL' ? ' An unlisted outcome is included in that assumption.' : ''}</p> : null}
      {['PROBABILITIES', 'WEIGHTS'].includes(generation.method) ? <div className="market-form-grid">
        {definition.outcomes.map((outcome) => <label key={outcome.key}>
          {outcome.label}: {generation.method === 'PROBABILITIES' ? 'probability (0-1)' : 'relative weight'}
          <input className="form-control" type="number" step="any" min="0"
            max={generation.method === 'PROBABILITIES' ? '1' : undefined}
            value={generation.values?.[outcome.key] ?? ''} onChange={(event) => {
              setGeneration({ ...generation, values: { ...generation.values, [outcome.key]: event.target.value } }); setPreview(null);
            }} />
        </label>)}
        {generation.method === 'WEIGHTS' && definition.coverage === 'PARTIAL' ? <label>Unlisted-outcome weight
          <input className="form-control" type="number" step="any" min="0" value={generation.unlistedWeight ?? ''}
            onChange={(event) => { setGeneration({ ...generation, unlistedWeight: event.target.value }); setPreview(null); }} />
        </label> : null}
      </div> : null}
      {definition.settlementMode === 'FINAL_SCORE' && preview ? <label className="market-check-label market-help mt-3">
        <input type="checkbox" checked={pricing.method === 'OPERATOR'} onChange={(event) => setPricing(event.target.checked
          ? { method: 'OPERATOR', odds: preview.odds } : { method: 'SCORE_MODEL' })} />
        Override generated odds (not Builder eligible)
      </label> : null}
      <div className="market-form-grid mt-3">
        {definition.outcomes.map((outcome) => <label key={outcome.key}>{outcome.label}: decimal odds
          {odds ? <input className="form-control market-price-input" type="number" step="0.01" min="1.01" max="1000"
            readOnly={pricing.method === 'SCORE_MODEL'} value={odds[outcome.key] ?? ''} onChange={(event) => setPricing({
              method: 'OPERATOR', odds: { ...odds, [outcome.key]: event.target.value },
            })} /> : <p className="market-help">Generate a preview to inspect prices.</p>}
          {outcome.rule ? <small className="market-help">{describeMarketRule(outcome.rule)}</small> : null}
        </label>)}
      </div>
      {preview ? <p role="status" className="market-help">Price preview. Save as a draft or publish changes to this event.</p> : null}
      <div className="market-form-actions">
        <button type="button" className="btn btn-primary"
          disabled={pricing.method === 'SCORE_MODEL' && !preview && !market.configuration} onClick={() => save(true)}>Publish market</button>
        <button type="button" className="btn btn-shell" onClick={() => save(false)}>Save draft</button>
      </div>
    </fieldset>
    {market.decision ? <p role="status">Locked result: {market.decision.result === 'VOID' ? 'Void'
      : definition.outcomes.filter((outcome) => market.decision.winningOutcomeKeys.includes(outcome.key)).map((outcome) => outcome.label).join(', ') || 'No listed winner'}.
      {market.resultPublicationPending ? ' Result publication is pending; it will be retried automatically.' : ''}</p>
      : definition.settlementMode === 'MANUAL' && market.publishedConfiguration && market.status !== 'PUBLISHING'
        ? <ManualResult market={market} busy={busy || stale} onConfirm={onResult} /> : null}
  </section>;
};

const BackofficeMarketView = ({ eventId }) => {
  const [data, setData] = useState(null);
  const [library, setLibrary] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [editorVersion, setEditorVersion] = useState(0);
  const [applyVersion, setApplyVersion] = useState('');
  const [manageId, setManageId] = useState('');
  const [starterId, setStarterId] = useState('');
  const [definitionDraft, setDefinitionDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const active = useRef(true);
  const acting = useRef(false);
  const sequence = useRef(0);
  const templateRequest = useRef(null);
  const marketRequest = useRef(null);
  const feedback = useRef(null);
  const definitionSequence = useRef(0);
  const now = useNow();
  const path = `/api/backoffice/events/${encodeURIComponent(eventId)}/markets`;
  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setRefreshing(true);
    try {
      const [eventResponse, templates] = await Promise.all([axios.get(path), axios.get('/api/backoffice/market-templates')]);
      if (active.current && current === sequence.current) {
        setData(eventResponse.data); setLibrary(templates.data); setLoadError('');
      }
    } catch (failure) {
      if (active.current && current === sequence.current) setLoadError(marketError(failure));
    } finally { if (active.current && current === sequence.current) setRefreshing(false); }
  }, [path]);
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
      if (active.current) setError(marketError(failure));
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
  const versions = templates.filter((template) => !template.archived).flatMap((template) => template.versions.map((version) => ({
    key: `${template.templateId}:${version.version}`, templateId: template.templateId, ...version,
  })));
  const selectedTemplate = templates.find((template) => template.templateId === manageId);
  const market = data?.markets.find((item) => item.marketId === selectedId);
  const enabled = data?.enabled && library?.enabled && !loadError;
  const writable = enabled && data.event.status !== 'RESULTED' && Date.parse(data.event.time) > now;
  const apply = () => run(async () => {
    const version = versions.find((item) => item.key === applyVersion);
    if (!version) throw new Error('Choose a reusable template version.');
    const body = {
      templateId: version.templateId, templateVersion: version.version,
      parameters: Object.fromEntries(version.definition.parameters.map((parameter) => [parameter.key, parameter.defaultValue])),
    };
    const response = await axios.post(path, { ...body, requestId: requestIdentity(marketRequest, body) });
    marketRequest.current = null;
    if (active.current) setSelectedId(response.data.marketId);
    return response.data;
  }, 'Draft created. Review its parameters and prices before publication.');
  const saveTemplate = async (definition) => {
    const saved = await run(async () => {
      if (definitionDraft.templateId) return (await axios.put(`/api/backoffice/market-templates/${definitionDraft.templateId}`, {
        revision: definitionDraft.revision, definition,
      })).data;
      return (await axios.post('/api/backoffice/market-templates', {
        definition, requestId: requestIdentity(templateRequest, definition),
      })).data;
    }, 'Template saved. Apply its version to this event to configure prices.');
    if (saved && active.current) {
      templateRequest.current = null;
      setDefinitionDraft(null);
      setManageId(saved.templateId);
      setApplyVersion(`${saved.templateId}:${saved.versions[saved.versions.length - 1].version}`);
    }
  };
  return <section className="markets-page">
    <header className="market-page-heading">
      <a className="inline-control-target" href={`/backoffice${window.location.search}`}>Back to Backoffice</a>
      <h1 className="h3">{data?.event.name || 'Event'}: Markets</h1>
      <p>Reuse a template, review event prices, then publish.</p>
    </header>
    <button className="btn btn-shell" type="button" disabled={busy || refreshing} onClick={reload}>Refresh status</button>
    {loadError ? <div className="alert alert-danger mt-2" role="alert">{loadError}</div> : null}
    {error ? <div className="alert alert-danger mt-2" role="alert">{error}</div> : null}
    <div ref={feedback} tabIndex={-1} role="status" className={message ? 'market-feedback' : undefined}>{message}</div>
    {!data && !loadError ? <p role="status">Loading event markets...</p> : null}
    {data && !writable ? <p role="status">New market authoring is unavailable or this event has started. Published manual markets can still receive their final result.</p> : null}
    {data ? <>
      <div className="market-toolbar">
        <label>Reusable template version<select className="form-select" disabled={busy || !writable} value={applyVersion}
          onChange={(event) => setApplyVersion(event.target.value)}>
          <option value="">Choose a template</option>
          {versions.map((version) => <option key={version.key} value={version.key}>{version.definition.name} · v{version.version}</option>)}
        </select></label>
        <button type="button" className="btn btn-primary" disabled={busy || !writable || !applyVersion}
          onClick={apply}>Add market draft</button>
      </div>
      <h2 className="h5">Event markets</h2>
      {!data.markets.length ? <p>No markets yet. Create a reusable template below, then add a draft to this event.</p> : null}
      <ul className="market-list">{data.markets.map((item) => <li key={item.marketId}>
        <button type="button" className="btn btn-shell" disabled={busy} aria-pressed={selectedId === item.marketId}
          onClick={() => { setSelectedId(item.marketId); setError(''); setMessage(''); }}>
          <strong>{item.template.definition.name}{Object.values(item.parameters).length ? ` · ${Object.values(item.parameters).join(' / ')}` : ''}</strong>
          <span>{statusLabel(item)} · v{item.template.version}</span>
        </button>
      </li>)}</ul>
      {market ? <MarketEditor key={`${market.marketId}:${editorVersion}`} market={market} writable={writable} busy={busy}
        onReload={() => setEditorVersion((version) => version + 1)}
        onUpdate={(body) => run(async () => (await axios.put(`${path}/${market.marketId}`, body())).data,
          'Configuration saved. A publishing market becomes available after pricing confirmation.')}
        onPreview={(body) => run(async () => (await axios.post(`/api/event/events/${encodeURIComponent(eventId)}/markets/preview`, body())).data)}
        onResult={(body) => run(async () => (await axios.post(`${path}/${market.marketId}/result`, body)).data,
          'Final decision recorded. Its publication status is shown on the market.')} /> : null}
      <details className="market-template-library">
        <summary>Reusable template library</summary>
        <p className="market-help">Versions are immutable. Archiving prevents new instances without removing published rules or bet history.</p>
        <div className="market-toolbar">
          <button type="button" className="btn btn-shell" disabled={busy || !enabled}
            onClick={() => setDefinitionDraft({ key: ++definitionSequence.current, definition: blankMarketDefinition() })}>Create custom template</button>
          <label>Starter definition<select className="form-select" disabled={busy || !enabled} value={starterId}
            onChange={(event) => setStarterId(event.target.value)}>
            <option value="">Choose a starter</option>
            {(library?.starters ?? []).map((starter) => <option key={starter.id} value={starter.id}>{starter.definition.name}</option>)}
          </select></label>
          <button type="button" className="btn btn-shell" disabled={busy || !enabled || !starterId} onClick={() => {
            const starter = library.starters.find((item) => item.id === starterId);
            setDefinitionDraft({ key: ++definitionSequence.current, definition: starter.definition });
          }}>Customize starter</button>
        </div>
        <div className="market-toolbar">
          <label>Manage template<select className="form-select" disabled={busy} value={manageId} onChange={(event) => setManageId(event.target.value)}>
            <option value="">Choose a saved template</option>
            {templates.map((template) => <option key={template.templateId} value={template.templateId}>
              {template.versions[template.versions.length - 1].definition.name}{template.archived ? ' (archived)' : ''}
            </option>)}
          </select></label>
          <button type="button" className="btn btn-shell" disabled={busy || !enabled || !selectedTemplate || selectedTemplate.archived}
            onClick={() => setDefinitionDraft({
              key: ++definitionSequence.current, templateId: selectedTemplate.templateId, revision: selectedTemplate.revision,
              definition: selectedTemplate.versions[selectedTemplate.versions.length - 1].definition,
            })}>Edit new version</button>
          <button type="button" className="btn btn-shell" disabled={busy || !enabled || !selectedTemplate} onClick={() => run(async () => (
            await axios.put(`/api/backoffice/market-templates/${selectedTemplate.templateId}`, {
              revision: selectedTemplate.revision, archived: !selectedTemplate.archived,
            })
          ).data, 'Template availability updated. Existing markets and history are unchanged.')}>
            {selectedTemplate?.archived ? 'Restore template' : 'Archive template'}
          </button>
        </div>
        {definitionDraft ? <MarketDefinitionEditor key={definitionDraft.key} initial={definitionDraft.definition}
          disabled={busy || !enabled} versioned={Boolean(definitionDraft.templateId)}
          onSave={saveTemplate} onCancel={() => setDefinitionDraft(null)} /> : null}
      </details>
    </> : null}
  </section>;
};

const BackofficeMarkets = () => {
  const { eventId } = useParams();
  return <BackofficeMarketView key={eventId} eventId={eventId} />;
};
export default BackofficeMarkets;
