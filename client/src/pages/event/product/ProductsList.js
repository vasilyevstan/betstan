import React from 'react';
import Product1X2 from './Product1X2';
import ProductCS from './ProductCS';
import ProductCustomMarkets from './ProductCustomMarkets';

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
  <ProductCustomMarkets
    eventId={eventId}
    eventName={eventName}
    onSelectionPlaced={onSelectionPlaced}
    resulted={resulted}
    selectedSelectionKeys={selectedSelectionKeys}
    uiVariant={uiVariant}
  /></>
);

export default HandleProducts;
