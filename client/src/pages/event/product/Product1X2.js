import React from 'react';
import axios from 'axios';
import { getPreMatchSelectionKey } from '../../../liveBettingUtils';

const normalizeSelectionName = (value) => (
  typeof value === 'string' ? value.trim().toLocaleLowerCase() : ''
);

const resolveSemanticSelections = (odds, home, away) => {
  const normalizedHome = normalizeSelectionName(home);
  const normalizedAway = normalizeSelectionName(away);
  if (
    odds.length !== 3
    || !normalizedHome
    || !normalizedAway
    || normalizedHome === normalizedAway
    || normalizedHome === 'draw'
    || normalizedAway === 'draw'
    || new Set(odds.map((odd) => odd?.id).filter(Boolean)).size !== 3
  ) {
    return null;
  }

  const findUnique = (selectionName) => {
    const matches = odds.filter(
      (odd) => normalizeSelectionName(odd?.name) === selectionName,
    );
    return matches.length === 1 ? matches[0] : null;
  };
  const homeOdd = findUnique(normalizedHome);
  const drawOdd = findUnique('draw');
  const awayOdd = findUnique(normalizedAway);

  if (!homeOdd || !drawOdd || !awayOdd) {
    return null;
  }

  return [
    { odd: homeOdd, token: '1' },
    { odd: drawOdd, token: 'X' },
    { odd: awayOdd, token: '2' },
  ];
};

const Handle1X2 = ({
  away,
  eventId,
  eventName,
  home,
  onSelectionPlaced,
  product,
  resulted,
  selectedSelectionKeys,
  uiVariant,
}) => {
  const handleClick = async (productId, oddsId) => {
    try {
      await axios.post('/api/event/odds', { eventId, productId, oddsId });
      onSelectionPlaced?.();
    } catch (error) {
      // ignore
    }
  };

  const odds = product.odds ?? [];
  const semanticSelections = resolveSemanticSelections(odds, home, away);
  const displayedSelections = semanticSelections ?? [0, 1, 2].map((index) => {
    const odd = odds[index];
    return odd ? { odd, token: odd.name } : null;
  });
  const oddButtonBaseClass = `btn w-100 product-button product-button--${uiVariant ?? 'v1'} product-button--labelled`;

  const renderOdd = (selection) => {
    if (!selection) {
      return <button
        aria-label={`Unavailable ${product.name} selection`}
        className={`${oddButtonBaseClass} disabled`}
        disabled
        type="button"
      >
        -
      </button>;
    }

    const { odd, token } = selection;
    const selectionKey = getPreMatchSelectionKey({ eventId, productId: product.id, oddsId: odd.id });
    const isSelected = selectionKey ? selectedSelectionKeys?.has(selectionKey) : false;
    const selectedClass = isSelected ? ' product-button--selected' : '';
    const accessibleLabel = semanticSelections
      ? `Select ${product.name} ${token}: ${odd.name} in ${eventName ?? `${home} - ${away}`} at ${odd.value}`
      : `Select ${product.name} ${odd.name} at ${odd.value}`;

    return <button
      key={odd.id}
      aria-label={accessibleLabel}
      className={`${oddButtonBaseClass}${selectedClass}${resulted ? ' disabled' : ''}`}
      disabled={resulted}
      type="button"
      onClick={() => handleClick(product.id, odd.id)}
    >
      <span className="product-button__label">{token}</span>
      <strong className="product-button__value">{odd.value}</strong>
    </button>;
  };

  return <div className="text-center product-block product-block--1x2">
    <div className="fw-semibold mb-2 product-block__title">{product.name}</div>
    <div className="product-1x2-grid" key={product.id}>
      {displayedSelections.map((selection, index) => (
        <div key={`${selection?.odd?.id ?? 'unavailable'}-${index}`}>{renderOdd(selection)}</div>
      ))}
    </div>
  </div>;
};

export default Handle1X2;
