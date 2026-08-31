import React from 'react';
import axios from 'axios';
import { getPreMatchSelectionKey } from '../../../liveBettingUtils';

const HandleCS = ({ eventId, onSelectionPlaced, product, resulted, selectedSelectionKeys, uiVariant }) => {
  const handleClick = async (productId, oddsId) => {
    try {
      await axios.post('/api/event/odds', { eventId, productId, oddsId });
      onSelectionPlaced?.();
    } catch (error) {
      // ignore
    }
  };

  return <div className="product-block product-block--cs">
    <div className="fw-semibold mb-2">{product.name}</div>
    <div className="product-cs-grid">
      {(product.odds ?? []).map((option) => {
        const selectionKey = getPreMatchSelectionKey({ eventId, productId: product.id, oddsId: option.id });
        const isSelected = selectionKey ? selectedSelectionKeys?.has(selectionKey) : false;
        const selectedClass = isSelected ? ' product-button--selected' : '';

        return <button
          key={option.id}
          aria-label={`Select ${product.name} ${option.name} at ${option.value}`}
          className={`btn product-button product-button--${uiVariant ?? 'v1'} product-button--labelled${selectedClass}${resulted ? ' disabled' : ''}`}
          disabled={resulted}
          type="button"
          onClick={() => handleClick(product.id, option.id)}
        >
          <span className="product-button__label">{option.name}</span>
          <strong className="product-button__value">{option.value}</strong>
        </button>;
      })}
    </div>
  </div>;
};

export default HandleCS;
