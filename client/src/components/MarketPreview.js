import React from 'react';
import { formatMarketOdds, marketTitle } from '../marketUi';

// A non-interactive copy of the player's match-card market block. Spans keep it valid inside labels.
const MarketPreview = ({ definition, parameters, odds, compact = false }) => {
  const outcomes = definition?.outcomes ?? [];
  return <span className={`market-preview${compact ? ' market-preview--compact' : ''}`} aria-hidden="true">
    <span className="product-block product-block--custom">
      <span className="product-block__title market-preview__title">{marketTitle(definition, parameters) || 'Market name'}</span>
      <span className="product-custom-grid">
        {outcomes.map((outcome, index) => <span key={outcome.key || index}
          className="btn product-button product-button--v1 product-button--labelled">
          <span className="product-button__label">{outcome.label?.trim() || `Outcome ${index + 1}`}</span>
          <strong className="product-button__value">{formatMarketOdds(odds?.[outcome.key])}</strong>
        </span>)}
      </span>
    </span>
  </span>;
};

export const PlayerPreview = ({ definition, parameters, odds, note }) => <div className="market-player-preview">
  <p className="market-player-preview__label">Player preview{note ? <span> · {note}</span> : null}</p>
  <MarketPreview definition={definition} parameters={parameters} odds={odds} />
</div>;

export default MarketPreview;
