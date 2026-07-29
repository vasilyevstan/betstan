import React  from "react";
import axios from "axios";

const HandleCS = ({ eventId, product, sliprefresh, resulted, uiVariant, selectedOdds, onOddsPlaced }) => {

  const handleClick = async (productId,oddsId,) => {
    try {
      await axios.post('/api/event/odds', {productId, oddsId, eventId});

      sliprefresh();
      onOddsPlaced?.();
    } catch (error) {
      // ignore
    }
  }


const renderedProducts = (product.odds ?? []).map(option => {
  const isSelected = selectedOdds?.has(`${eventId}:${product.id}:${option.id}`);
  const selectedClass = isSelected ? ' product-button--selected' : '';
  return <div className="row" key={option.id}>
          <div className="col small">{option.name}</div>
          <div className="col">
            <button key={option.id} className={`btn w-100 product-button product-button--${uiVariant ?? 'v1'} mb-2${selectedClass}` + (resulted ? ' disabled' : '')} onClick={() => handleClick(product.id, option.id)}>{option.value}</button>
          </div>
        </div>
});

return <div className="product-block"><div className="row fw-semibold mb-2">{product.name}</div>{renderedProducts}</div>;
};

export default HandleCS;