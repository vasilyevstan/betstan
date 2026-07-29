import React  from "react";
import axios from "axios";

const Handle1X2 = ({eventId, product, sliprefresh, resulted, uiVariant, selectedOdds, onOddsPlaced }) => {

  const handleClick = async (productId, oddsId) => {
    try {
      await axios.post('/api/event/odds', {productId, oddsId, eventId});

      sliprefresh();
      onOddsPlaced?.();
    } catch (error) {
      // ignore
    }
  }

// console.log('in 1x2', product);
const odds = product.odds ?? [];
const renderOdd = (index) => {
  const odd = odds[index];
  const oddButtonBaseClass = `btn w-100 product-button product-button--${uiVariant ?? 'v1'}`;
  if (!odd) {
    return <button className={oddButtonBaseClass + " disabled"} disabled>-</button>;
  }
  const isSelected = selectedOdds?.has(`${eventId}:${product.id}:${odd.id}`);
  const selectedClass = isSelected ? ' product-button--selected' : '';
  return <button key={odd.id} className={oddButtonBaseClass + selectedClass + (resulted ? ' disabled' : '')} onClick={() => handleClick(product.id, odd.id)}>{odd.value}</button>;
};

const renderedProducts = <div className="row" key={product.id}>
          <div className="col-4 pe-1">
            {renderOdd(0)}
          </div>
          <div className="col-4 px-1">
            {renderOdd(1)}
          </div>
          <div className="col-4 ps-1">
            {renderOdd(2)}
          </div>

  </div>;

return <div className="text-center product-block">
          <div className="row fw-semibold mb-2">{product.name}</div>
          <div className="row small text-secondary mb-1">
              <div className="col">Home</div>
              <div className="col">Draw</div>
              <div className="col">Away</div>
          </div>
          {renderedProducts}
          <hr></hr>
      </div>;
};

export default Handle1X2;