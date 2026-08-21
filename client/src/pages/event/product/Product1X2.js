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
  const oddButtonBaseClass = `btn w-100 product-button product-button--${uiVariant ?? 'v1'}`;

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
      {odd.value}
    </button>;
  };

  return <div className="text-center product-block">
    <div className="row fw-semibold mb-2">{product.name}</div>
    <div className="row small text-secondary mb-1">
      <div className="col">Home</div>
      <div className="col">Draw</div>
      <div className="col">Away</div>
    </div>
    <div className="row" key={product.id}>
      <div className="col-4 pe-1">{renderOdd(0)}</div>
      <div className="col-4 px-1">{renderOdd(1)}</div>
      <div className="col-4 ps-1">{renderOdd(2)}</div>
    </div>
    <hr></hr>
  </div>;
};

export default Handle1X2;
