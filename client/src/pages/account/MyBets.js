
import React,  { useState, useEffect }  from "react";
import { format } from "date-fns";
import axios from "axios";

const HandleMyBetsList = () => {

    const [bets, setBets] = useState({});

    const fetchBets = async () => {
      try {
        const res = await axios.get('/api/bet');
        const data = res.data;
        setBets(data && typeof data === 'object' ? data : {});
      } catch (error) {
        // ignore
      }
    }

    useEffect(() => {
        fetchBets();
    }, []);
    
    const renderedBets = Object.values(bets ?? {}).map(bet => {
      let totalOdds = 1;

      const rowHeader = <div className="card-subtitle row my-bets-row my-bets-row--header" key={bet._id + '_row_header'}>
        <div className="col-5 col-md-4">Event</div>
        <div className="col-3 col-md-3">Product</div>
        <div className="col-2 col-md-3">Selection</div>
        <div className="col-2 col-md-2 text-end">Odds</div>
      </div>

      const renderedRows = (bet.rows ?? []).map(row => {
        totalOdds = totalOdds * row.oddsValue;
        const rowColor = row.status === 'WIN' ? ' text-success' : row.status === 'LOSS' ? ' text-danger' : '';

        return <div className="row my-bets-row" key={row._id}>
          <div className={"col-5 col-md-4" + rowColor}>{row.eventName}</div>
          <div className={"col-3 col-md-3" + rowColor}>{row.productName}</div>
          <div className={"col-2 col-md-3" + rowColor}>{row.oddsName}</div>
          <div className={"col-2 col-md-2 text-end" + rowColor}>{row.oddsValue}</div>
        </div>
      });

      const betFooter = <div className="card-body my-bets-footer" key={bet._id + '_footer'}>
        <span>Wager: {bet.wager}</span>
        <span>Total odds: {totalOdds.toFixed(2)}</span>
        <span>Possible win: {(totalOdds * bet.wager).toFixed(2)} Stanbucks</span>
      </div>

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

      return <div className="card mb-2 my-bets-card" key={bet._id}>
              <div className="card-body">
                  <h5 className="card-title d-flex justify-content-between align-items-start gap-2">
                    <div>{betTime}</div>
                    <div className={`my-bets-status ${betStatusColor}`}>{bet.status}</div>
                  </h5>
                  <div>{rowHeader}{renderedRows}</div>
              </div>
              {betFooter}
      </div>
    });

    return <div className="flex-wrap"> {renderedBets} </div>;
};

export default HandleMyBetsList;