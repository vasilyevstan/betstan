import React  from "react";
import axios from "axios";

const Handle1X2 = ({eventId, product, sliprefresh, resulted }) => {

  const handleClick = async (productId, oddsId) => {
    try {
      await axios.post('/api/event/odds', {productId, oddsId, eventId});

      sliprefresh();
    } catch (error) {
      // ignore
    }
  }

// console.log('in 1x2', product);
const renderedProducts = <div className="row" key={product.id}>
          <button key={product.odds[0].id} className={"btn btn-light col" + (resulted ? ' disabled' : '')} style={{marginRight: '5px'}} onClick={e => handleClick(product.id, product.odds[0].id)}>{product.odds[0].value}</button>
          <button key={product.odds[1].id} className={"btn btn-light col" + (resulted ? ' disabled' : '')} onClick={e => handleClick(product.id, product.odds[1].id)}>{product.odds[1].value}</button>
          <button key={product.odds[2].id} className={"btn btn-light col" + (resulted ? ' disabled' : '')} style={{marginLeft: '5px'}} onClick={e => handleClick(product.id, product.odds[2].id)}>{product.odds[2].value}</button>

  </div>;

return <div className="text-center">
          <div className="row">{product.name}</div>
          <div className="row">
              <div className="col">Home</div>
              <div className="col">Draw</div>
              <div className="col">Away</div>
          </div>
          {renderedProducts}
          <hr></hr>
      </div>;
};

export default Handle1X2;