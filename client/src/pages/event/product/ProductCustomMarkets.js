import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import { getCustomMarketSelectionKey } from '../../../liveBettingUtils';
import { createMarketRequestId, formatMarketOdds, marketError, marketTitle } from '../../../marketUi';
import MarketOutcomeGrid from '../../../components/MarketOutcomeGrid';
import { layoutError } from '../../../marketLayout';

const SIGN_IN_MESSAGE = 'Log in to add this selection to your slip.';
const BOARD_BUSY_MESSAGE = 'Your pre-match slip is being reviewed. Wait for it to finish before adding a selection.';

const isSameSelection = (row, marketId, outcomeKey) => row.marketBet?.kind === 'SINGLE'
  && row.marketBet.selections?.length === 1
  && row.marketBet.selections[0].marketId === marketId
  && row.marketBet.selections[0].outcomeKey === outcomeKey;

const isOpenCatalog = (catalog) => Boolean(catalog?.enabled && catalog.event?.visibility === 'ONLINE'
  && catalog.event.status !== 'RESULTED' && Date.parse(catalog.event.time) > Date.now());

// Published Backoffice markets, shown on the match card like 1X2 and Correct Score.
const ProductCustomMarkets = ({
  eventId, eventName, onSelectionPlaced, resulted, selectedSelectionKeys, uiVariant,
}) => {
  const [markets, setMarkets] = useState([]);
  const [layouts, setLayouts] = useState({});
  const [layoutNotice, setLayoutNotice] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [replacement, setReplacement] = useState(null);
  const mounted = useRef(true);
  const acting = useRef(false);
  const replaceButton = useRef(null);
  const path = `/api/event/events/${encodeURIComponent(eventId ?? '')}`;

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    setMarkets([]);
    setLayouts({});
    setLayoutNotice('');
    if (resulted || !eventId) return undefined;
    axios.get(`${path}/markets`).then(async ({ data }) => {
      if (!current) return;
      const available = isOpenCatalog(data) ? data.markets ?? [] : [];
      setMarkets(available);
      if (!available.length) return;
      try {
        const { data: presentation } = await axios.get(`/api/backoffice/events/${encodeURIComponent(eventId)}/markets`);
        if (!current) return;
        const found = {};
        for (const { configuration } of available) {
          const source = presentation.markets?.find((market) => market.marketId === configuration.marketId
            && market.template.id === configuration.template.id && market.template.version === configuration.template.version);
          if (!source?.layout) continue;
          if (layoutError(source.layout, configuration.template.definition.outcomes)) {
            setLayoutNotice('A saved layout is invalid. That market is shown in the standard layout.');
          } else found[configuration.marketId] = source.layout;
        }
        setLayouts(found);
      } catch (failure) {
        if (current) setLayoutNotice(`Custom layouts could not be loaded. Markets use the standard layout. ${marketError(failure)}`);
      }
    }, (failure) => { if (current) setError(marketError(failure)); });
    return () => { current = false; };
  }, [eventId, path, resulted]);

  useEffect(() => { if (replacement) replaceButton.current?.focus(); }, [replacement]);

  const choose = async (configuration, outcome, confirmedReplace = false) => {
    if (acting.current) return;
    acting.current = true;
    setBusyKey(`${configuration.marketId}:${outcome.key}`);
    setError('');
    setReplacement(null);
    try {
      const { data: boards } = await axios.get('/api/slip/boards');
      const board = boards?.PRE_MATCH ?? null;
      if (board && (board.status !== 'DRAFT' || !Number.isSafeInteger(board.boardRevision) || !board.boardFingerprint)) {
        throw new Error(BOARD_BUSY_MESSAGE);
      }
      const sameEvent = (board?.rows ?? []).filter((row) => row.eventId === eventId);
      if (!confirmedReplace && sameEvent.some((row) => !isSameSelection(row, configuration.marketId, outcome.key))) {
        if (mounted.current) setReplacement({ configuration, outcome });
        return;
      }
      const { data: quote } = await axios.post(`${path}/market-quotes`, {
        requestId: createMarketRequestId(),
        kind: 'SINGLE',
        selections: [{
          origin: 'TEMPLATE', marketId: configuration.marketId, outcomeKey: outcome.key, quoteRevision: configuration.revision,
        }],
      });
      await axios.post('/api/slip/market-selection', {
        quoteId: quote.quoteId,
        expectedBoardRevision: board?.boardRevision ?? null,
        expectedBoardFingerprint: board?.boardFingerprint ?? null,
        replaceEventSelections: sameEvent.length > 0,
      });
      onSelectionPlaced?.();
    } catch (failure) {
      if (mounted.current) setError(failure.response?.status === 401 ? SIGN_IN_MESSAGE : marketError(failure));
      if (failure.response?.status === 409) onSelectionPlaced?.();
    } finally {
      acting.current = false;
      if (mounted.current) setBusyKey('');
    }
  };

  if (!markets.length) return error ? <p className="selection-feedback" role="alert">{error}</p> : null;
  const buttonClass = `btn w-100 product-button product-button--${uiVariant ?? 'v1'} product-button--labelled`;
  return <>
    {markets.map(({ configuration, preview }) => {
      const { definition } = configuration.template;
      const title = marketTitle(definition, configuration.parameters);
      const suspended = configuration.availability !== 'OPEN';
      return <div className="text-center product-block product-block--custom" key={configuration.marketId}>
        <h4 className="fw-semibold mb-2 product-block__title">{title}</h4>
        <MarketOutcomeGrid outcomes={definition.outcomes} layout={layouts[configuration.marketId]}>
          {(outcome) => {
            const key = getCustomMarketSelectionKey({ eventId, marketId: configuration.marketId, outcomeKey: outcome.key });
            const selected = Boolean(key && selectedSelectionKeys?.has(key));
            const odds = formatMarketOdds(preview?.odds?.[outcome.key]);
            return <button key={outcome.key} type="button"
              aria-label={suspended ? `${title} ${outcome.label} is suspended`
                : `Select ${title} ${outcome.label}${eventName ? ` in ${eventName}` : ''} at ${odds}`}
              aria-pressed={selected}
              aria-busy={busyKey === `${configuration.marketId}:${outcome.key}` || undefined}
              className={`${buttonClass}${selected ? ' product-button--selected' : ''}${suspended ? ' disabled' : ''}`}
              disabled={suspended || Boolean(busyKey)}
              onClick={() => choose(configuration, outcome)}>
              {selected ? <span className="state-mark" aria-hidden="true" /> : null}
              <span className="product-button__label">{outcome.label}</span>
              <strong className="product-button__value">{odds}</strong>
            </button>;
          }}
        </MarketOutcomeGrid>
      </div>;
    })}
    {layoutNotice ? <p className="selection-feedback" role="status">{layoutNotice}</p> : null}
    {replacement ? <div className="custom-market-replace" role="group" aria-label="Replace selection from this match">
      <p>This match already has a selection in your slip. Extra markets can't be combined with it.</p>
      <div className="custom-market-replace__actions">
        <button ref={replaceButton} type="button" className={`btn btn-sm product-button product-button--${uiVariant ?? 'v1'}`}
          onClick={() => choose(replacement.configuration, replacement.outcome, true)}>
          Replace with {replacement.outcome.label}
        </button>
        <button type="button" className="btn btn-sm btn-shell" onClick={() => setReplacement(null)}>Keep current</button>
      </div>
    </div> : null}
    {error ? <p className="selection-feedback" role="alert">{error}</p> : null}
  </>;
};

export default ProductCustomMarkets;
