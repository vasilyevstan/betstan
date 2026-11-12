import React from 'react';
import Product1X2 from './Product1X2';
import ProductCS from './ProductCS';

const HandleProducts = ({
  away,
  eventId,
  eventName,
  home,
  onSelectionPlaced,
  products,
  resulted,
  selectedSelectionKeys,
  uiVariant,
}) => (
  <>{(products ?? []).map((product) => {
    if (product.type === '1X2') {
      return <Product1X2
        away={away}
        eventId={eventId}
        eventName={eventName}
        home={home}
        key={product.id}
        onSelectionPlaced={onSelectionPlaced}
        product={product}
        resulted={resulted}
        selectedSelectionKeys={selectedSelectionKeys}
        uiVariant={uiVariant}
      />;
    }

    if (product.type === 'CS') {
      return <ProductCS
        eventId={eventId}
        key={product.id}
        onSelectionPlaced={onSelectionPlaced}
        product={product}
        resulted={resulted}
        selectedSelectionKeys={selectedSelectionKeys}
        uiVariant={uiVariant}
      />;
    }

    return null;
  })}
  {!resulted && eventId ? <a className="btn btn-shell inline-control-target"
    href={`/events/${encodeURIComponent(eventId)}/markets${window.location.search}`}>
    Markets &amp; Bet Builder
  </a> : null}</>
);

export default HandleProducts;
