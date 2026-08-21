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

  return <div className="product-block">
    <div className="row fw-semibold mb-2">{product.name}</div>
    {(product.odds ?? []).map((option) => {
      const selectionKey = getPreMatchSelectionKey({ eventId, productId: product.id, oddsId: option.id });
      const isSelected = selectionKey ? selectedSelectionKeys?.has(selectionKey) : false;
      const selectedClass = isSelected ? ' product-button--selected' : '';

      return <div className="row" key={option.id}>
        <div className="col small">{option.name}</div>
        <div className="col">
          <button
            aria-label={`Select ${product.name} ${option.name} at ${option.value}`}
            className={`btn w-100 product-button product-button--${uiVariant ?? 'v1'} mb-2${selectedClass}${resulted ? ' disabled' : ''}`}
            disabled={resulted}
            type="button"
            onClick={() => handleClick(product.id, option.id)}
          >
            {option.value}
          </button>
        </div>
      </div>;
    })}
  </div>;
};

export default HandleCS;
