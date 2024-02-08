import React,  { useState, useEffect }  from "react";
import axios from "axios";

const HandleSlip = ({sliprefresh, statsrefresh, currentUser}) => {

    const [slip, setSlip] = useState({});
    const [wager, setWager] = useState({});

    const fetchSlip = async () => {
        try {
            const res = await axios.get('/api/slip');

            setSlip(res.data);
        } catch (error) {
            // ignore
          }
    }

    useEffect(() => {
        fetchSlip();
    }, []);

    if (Object.keys(slip).length === 0) {
        return currentUser ? <div className="d-flex flex-row flex-wrap justify-content-between card card-body">Make your slip!</div> : 
        <div className="d-flex flex-row flex-wrap justify-content-between card card-body">Login and bet!</div>;
    }

    const deleteSlipRow = async (event) => {
        event.preventDefault();
        const slipId = event.currentTarget.getAttribute("slipid");
        const slipRowId = event.currentTarget.getAttribute("sliprowid");
        
        try {
            await axios.post('/api/slip/row', { slipId, slipRowId });

            sliprefresh();
        } catch (error) {
            // ignore
        }
    }

    const cleanSlip = async (event) => {

        event.preventDefault();
        const slipId = event.currentTarget.getAttribute("slipid");

        try {
            await axios.post('/api/slip/row/clean', { slipId });

            sliprefresh();
        } catch (error) {
            // ignore
        }
    }

    const placeBet = async (event) => {

        event.preventDefault();
        const slipId = event.currentTarget.getAttribute("slipid");
        const wager = event.currentTarget.getAttribute("wager");

        if (wager > 0) {

            try {
                await axios.post('/api/slip/bet', { slipId, wager });

                sliprefresh();
                statsrefresh();
            } catch (error) {
                // ignore
            }
        }
    }

    let totalOdds = 1;
    const renderedSlip = Object.values(slip.rows).map(slipRow => {
        totalOdds = totalOdds * slipRow.oddsValue;
        return <div className="card padding-left" style={{marginTop: '5px'}} key={slipRow._id}>
               {/* {(e) => deleteSlipRow(e.currentTarget.getAttribute('value'))} */}
                <small className="card-subtitle text-muted d-flex justify-content-between" style={{marginLeft: '5px', marginTop: '2px', marginRight: '5px'}}><div >{slipRow.eventName}</div><button sliprowid={slipRow._id} slipid={slip._id} type="button" onClick={(e) => deleteSlipRow(e)} className="btn-close btn-close-white" aria-label="Close"></button></small>
                <div  className="card-text d-flex justify-content-between" style={{marginLeft: '5px', marginTop: '2px', marginRight: '5px'}}><div >{slipRow.productName} - ({slipRow.oddsName})</div><div>{slipRow.oddsValue}</div></div>

        </div>
    });


    const oddAndPossibleWin = <div className="d-flex justify-content-between" style={{marginLeft: '5px', marginTop: '2px', marginRight: '5px'}}>
        <small>Odds: {Number((totalOdds).toFixed(2))}</small>
        <small>{isNaN(wager) ? ' ' : 'Win'} {isNaN(wager) ? ' ' : Number((wager * totalOdds).toFixed(2))}</small>
    </div>

    const wagerAndBet = <div key={slip._id} className="card form-inline">
        <div  className="form-group mb-2">
            <input value={wager} type="number" className="form-control" id="inputPassword2" placeholder="Wager" onChange={(e) => setWager(e.target.value)} />
        </div>
        <button slipid={slip._id} wager={wager} type="button" className="btn btn-success mx-sm-3" onClick={(e) => placeBet(e)}>BET!</button>
        <button slipid={slip._id} type="button" className="btn btn-warning mx-sm-3" style={{marginTop: '2px'}} onClick={(e) => cleanSlip(e)}>CLEAN</button>
    </div>

    return <div> {renderedSlip} {oddAndPossibleWin} {wagerAndBet}</div>;
}

export default HandleSlip;