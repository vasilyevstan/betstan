import React, { useRef, useState } from 'react';
import axios from 'axios';
import { getPreMatchSelectionKey } from '../../../liveBettingUtils';

const PLACEMENT_ERROR = 'Selection could not be added to your slip. Please try again.';

const HandleCS = ({ eventId, onSelectionPlaced, product, resulted, selectedSelectionKeys, uiVariant }) => {
  const [placementError, setPlacementError] = useState('');
  const placementAttemptSequence = useRef(0);

  const handleClick = async (productId, oddsId) => {
    const attemptSequence = ++placementAttemptSequence.current;
    setPlacementError('');
    try {
      await axios.post('/api/event/odds', { eventId, productId, oddsId });
      if (attemptSequence === placementAttemptSequence.current) {
        setPlacementError('');
      }
      onSelectionPlaced?.();
    } catch {
      if (attemptSequence === placementAttemptSequence.current) {
        setPlacementError(PLACEMENT_ERROR);
      }
    }
  };

  return <div className="product-block product-block--cs">
    <h4 className="fw-semibold mb-2 product-block__title">{product.name}</h4>
    <div className="product-cs-grid">
      {(product.odds ?? []).map((option) => {
        const selectionKey = getPreMatchSelectionKey({ eventId, productId: product.id, oddsId: option.id });
        const isSelected = selectionKey ? selectedSelectionKeys?.has(selectionKey) : false;
        const selectedClass = isSelected ? ' product-button--selected' : '';

        return <button
          key={option.id}
          aria-label={`Select ${product.name} ${option.name} at ${option.value}`}
          aria-pressed={Boolean(isSelected)}
          className={`btn product-button product-button--${uiVariant ?? 'v1'} product-button--labelled${selectedClass}${resulted ? ' disabled' : ''}`}
          disabled={resulted}
          type="button"
          onClick={() => handleClick(product.id, option.id)}
        >
          {isSelected ? <span className="state-mark" aria-hidden="true" /> : null}
          <span className="product-button__label">{option.name}</span>
          <strong className="product-button__value">{option.value}</strong>
        </button>;
      })}
    </div>
    {placementError ? (
      <p className="selection-feedback" role="alert">{placementError}</p>
    ) : null}
  </div>;
};

export default HandleCS;
