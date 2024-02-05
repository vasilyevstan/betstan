import React  from "react";
import axios from "axios";

const HandleCS = ({ eventId, product, sliprefresh, resulted }) => {

  const handleClick = async (productId,oddsId,) => {
    await axios.post('/api/event/odds', {productId, oddsId, eventId});

    sliprefresh();
  }


const renderedProducts = product.odds.map(option => {
  return <div className="row" key={option.id}>
          <div className="col">{option.name}</div>
          <button key={option.id} className={"btn btn-secondary col" + (resulted ? ' disabled' : '')} style={{marginBottom: '5px'}} onClick={e => handleClick(product.id, option.id)}>{option.value}</button>
        </div>
});

return <div><div className="row">{product.name}</div>{renderedProducts}</div>;
};

export default HandleCS;