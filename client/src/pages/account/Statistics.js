
import React,  { useState, useEffect }  from "react";
import axios from "axios";

const HandleUserStatistics = ({ uiVariant }) => {

    const [betsForStats, setBetsForStats] = useState({});

    const fetchBets = async () => {
      try {
        const res = await axios.get('/api/bet/stats');
        const data = res.data;
        setBetsForStats(data && typeof data === 'object' ? data : {});
      } catch (error) {
        // ignore
      }
    }

    useEffect(() => {
        fetchBets();
    }, []);
    
    const stats = [];

    const statsSource = Object.values(betsForStats ?? {});

    statsSource.map(bet => {
      
      let userStat = stats.find(stat => stat.user === bet.userName);

      if (!userStat) {
        userStat = {user: bet.userName, userId: bet.userId, betamount: 0, wageramount: 0}
        stats.push(userStat)
      }

      userStat.betamount = userStat.betamount + 1;
      userStat.wageramount = userStat.wageramount + bet.wager;

      return userStat;
    });

    const renderedStats = stats.map(stat => {
      return <div className="card stat-card mb-2" key={stat.userId}>
        <div className="card-body row stat-row">
          <div className="col-6">{stat.user}</div>
          <div className="col-3 text-end">{stat.betamount}</div>
          <div className="col-3 text-end fw-semibold">{stat.wageramount}</div>
        </div>
      </div>
    })

    const statHeader = <div className="card stat-card mb-2" key="stat_header">
    <div className="card-body row stat-row stat-row--header text-secondary">
      <div className="col-6">User</div>
      <div className="col-3 text-end">Bets</div>
      <div className="col-3 text-end">Wager</div>
    </div>
  </div>
    

      // return <div className="card" style={{marginBottom: '5px'}} key={bet.id}>
      //     <div className="card-body">
      //         <h5 className="card-title d-flex justify-content-between">
      //           <div>{betTime}</div>
      //           <div className={betStatusColor}>{bet.status}</div>
      //         </h5>
      //         <div>{rowHeader}{renderedRows}</div>
      //     </div>
      // </div>

    return <div className={`flex-wrap scoreboard scoreboard--${uiVariant}`}> {statHeader}{renderedStats} </div>;
};

export default HandleUserStatistics;