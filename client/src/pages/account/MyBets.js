
import React,  { useState, useEffect }  from "react";
import { format } from "date-fns";
import axios from "axios";

const HandleMyBetsList = () => {

    const [bets, setBets] = useState({});

    const fetchBets = async () => {
      try {
        const res = await axios.get('/api/bet');

        setBets(res.data);
      } catch (error) {
        // ignore
      }
    }

    useEffect(() => {
        fetchBets();
    }, []);
    
    const renderedBets = Object.values(bets).map(bet => {
      let totalOdds = 1;

      const rowHeader = <div className="card-subtitle row" key={bet._id + '_row_header'}>
        <div className="col">Event</div>
        <div className="col">Product</div>
        <div className="col">Selection</div>
        <div className="col">Odds</div>
      </div>

      const renderedRows = bet.rows.map(row => {
        totalOdds = totalOdds * row.oddsValue;
        const rowColor = row.status === 'WIN' ? ' text-success' : row.status === 'LOSS' ? ' text-danger' : ''

        return <div className="row" key={row._id}>
          <div className={"col" + rowColor}>{row.eventName}</div>
          <div className={"col" + rowColor}>{row.productName}</div>
          <div className={"col" + rowColor}>{row.oddsName}</div>
          <div className={"col" + rowColor}>{row.oddsValue}</div>
        </div>
      });

      const betFooter = <div className="card-body" key={bet._id + '_footer'}>Wager: {bet.wager} Total odds: {totalOdds.toFixed(2)} Possible win: {(totalOdds * bet.wager).toFixed(2)} Stanbucks</div>

      const betTime = format(bet.timestamp, "MMMM do, yyyy H:mm");

      let betStatusColor = 'text-success';

      switch (bet.status) {

        case 'PENDING':
          betStatusColor = 'text-warning';
          break;
        case 'CONFIRMED':
          betStatusColor = 'text-info';
          break;
        case 'DECLINED':
          betStatusColor = 'text-danger';
          break;
        case 'WIN':
          betStatusColor = 'text-success';
          break;
        case 'LOSS':
          betStatusColor = 'text-danger';
          break;
        default:
          betStatusColor = 'text-success';
      }

      // const betStatusColor = bet.status === 'PENDING' ? 'text-warning' : bet.status === 'CONFIRMED' ? 'text-info' : bet.status === 'DECLINED' ? 'text-danger' : 'text-success'

      return <div className="card" style={{marginBottom: '5px'}} key={bet._id}>
              <div className="card-body">
                  <h5 className="card-title d-flex justify-content-between">
                    <div>{betTime}</div>
                    <div className={betStatusColor}>{bet.status}</div>
                  </h5>
                  <div>{rowHeader}{renderedRows}</div>
              </div>
              {betFooter}
      </div>
    });

    return <div className="flex-wrap"> {renderedBets} </div>;
};

export default HandleMyBetsList;