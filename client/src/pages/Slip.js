import React,  { useState, useEffect }  from "react";
import axios from "axios";

const HandleSlip = ({ sliprefresh, statsrefresh, currentUser, uiVariant }) => {

    const [slip, setSlip] = useState({});
    const [wager, setWager] = useState('');

    const fetchSlip = async () => {
        try {
            const res = await axios.get('/api/slip');
            const data = res.data;
            setSlip(data && typeof data === 'object' && !Array.isArray(data) ? data : {});
        } catch (error) {
            // ignore
          }
    }

    useEffect(() => {
        fetchSlip();
    }, []);

    const slipRows = Array.isArray(slip?.rows) ? slip.rows : [];

    if (slipRows.length === 0) {
        return currentUser ? <div className={`card card-body empty-state-card slip-board slip-board--${uiVariant}`}>
            <div className="slip-board__title">BET SLIP</div>
            <small className="text-secondary">Pick odds from events to compose your slip.</small>
        </div> :
        <div className={`card card-body empty-state-card slip-board slip-board--${uiVariant}`}>
            <div className="slip-board__title">BET SLIP</div>
            <div className="slip-board__empty-main">Login and bet!</div>
            <small className="text-secondary">Sign in to track selections and place slips.</small>
        </div>;
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
    const renderedSlip = slipRows.map(slipRow => {
        totalOdds = totalOdds * slipRow.oddsValue;
        return <div className="card slip-row-card" key={slipRow._id}>
               {/* {(e) => deleteSlipRow(e.currentTarget.getAttribute('value'))} */}
                <small className="card-subtitle text-muted d-flex justify-content-between align-items-center px-2 pt-2"><div>{slipRow.eventName}</div><button sliprowid={slipRow._id} slipid={slip._id} type="button" onClick={(e) => deleteSlipRow(e)} className="btn-close slip-row-close" aria-label="Remove from slip"></button></small>
                <div className="card-text d-flex justify-content-between align-items-center px-2 pb-2"><div>{slipRow.productName} - ({slipRow.oddsName})</div><div className="slip-row-card__odds">{slipRow.oddsValue}</div></div>

        </div>
    });


    const oddAndPossibleWin = <div className="d-flex justify-content-between mt-2 px-1 slip-board__summary">
        <small>Odds: {Number((totalOdds).toFixed(2))}</small>
        <small>{isNaN(Number(wager)) ? ' ' : 'Win'} {isNaN(Number(wager)) ? ' ' : Number((Number(wager) * totalOdds).toFixed(2))}</small>
    </div>

    const wagerAndBet = <div key={slip._id ?? 'empty-slip'} className="card p-2 mt-2 slip-board__actions">
        <div className="form-group mb-2">
            <input value={wager} type="number" className="form-control" placeholder="Wager" onChange={(e) => setWager(e.target.value)} />
        </div>
        <button slipid={slip._id} wager={wager} type="button" className={`btn w-100 mb-2 slip-action-primary slip-action-primary--${uiVariant}`} onClick={(e) => placeBet(e)}>BET!</button>
        <button slipid={slip._id} type="button" className={`btn w-100 slip-action-secondary slip-action-secondary--${uiVariant}`} onClick={(e) => cleanSlip(e)}>CLEAN</button>
    </div>

    return <div className={`slip-board slip-board--${uiVariant}`}>
        <div className="slip-board__title">BET SLIP</div>
        {renderedSlip}
        {oddAndPossibleWin}
        {wagerAndBet}
    </div>;
}

export default HandleSlip;