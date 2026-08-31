import React from 'react';
import axios from 'axios';
import { getPreMatchSelectionKey } from '../../../liveBettingUtils';

const Handle1X2 = ({ eventId, onSelectionPlaced, product, resulted, selectedSelectionKeys, uiVariant }) => {
  const handleClick = async (productId, oddsId) => {
    try {
      await axios.post('/api/event/odds', { eventId, productId, oddsId });
      onSelectionPlaced?.();
    } catch (error) {
      // ignore
    }
  };

  const odds = product.odds ?? [];
  const oddButtonBaseClass = `btn w-100 product-button product-button--${uiVariant ?? 'v1'} product-button--labelled`;

  // Each control renders the actual selection name (the home team, "Draw", or the away team) as
  // its visible label, stacked above the price, so the visible text is never a generic positional
  // placeholder that diverges from the accessible name (label-in-name) built below.
  const renderOdd = (index) => {
    const odd = odds[index];

    if (!odd) {
      return <button className={`${oddButtonBaseClass} disabled`} disabled type="button">-</button>;
    }

    const selectionKey = getPreMatchSelectionKey({ eventId, productId: product.id, oddsId: odd.id });
    const isSelected = selectionKey ? selectedSelectionKeys?.has(selectionKey) : false;
    const selectedClass = isSelected ? ' product-button--selected' : '';

    return <button
      key={odd.id}
      aria-label={`Select ${product.name} ${odd.name} at ${odd.value}`}
      className={`${oddButtonBaseClass}${selectedClass}${resulted ? ' disabled' : ''}`}
      disabled={resulted}
      type="button"
      onClick={() => handleClick(product.id, odd.id)}
    >
      <span className="product-button__label">{odd.name}</span>
      <strong>{odd.value}</strong>
    </button>;
  };

  return <div className="text-center product-block product-block--1x2">
    <div className="fw-semibold mb-2">{product.name}</div>
    <div className="product-1x2-grid" key={product.id}>
      <div>{renderOdd(0)}</div>
      <div>{renderOdd(1)}</div>
      <div>{renderOdd(2)}</div>
    </div>
    <hr></hr>
  </div>;
};

export default Handle1X2;
