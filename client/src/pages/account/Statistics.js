
import React,  { useState, useEffect }  from "react";
import axios from "axios";

const HandleUserStatistics = () => {

    const [betsForStats, setBetsForStats] = useState({});

    const fetchBets = async () => {
        const res = await axios.get('/api/bet/stats');

        setBetsForStats(res.data);
    }

    useEffect(() => {
        fetchBets();
    }, []);
    
    const stats = [];

    Object.values(betsForStats).map(bet => {
      
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
      return <div className="card" key={stat.userId}>
        <div className="card-body row">
          <div className="col">{stat.user}</div>
          <div className="col">{stat.betamount}</div>
          <div className="col">{stat.wageramount}</div>
        </div>
      </div>
    })

    const statHeader = <div className="card" key="stat_header">
    <div className="card-body row">
      <div className="col">User</div>
      <div className="col">Bets</div>
      <div className="col">Wager</div>
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

    return <div className="flex-wrap"> {statHeader}{renderedStats} </div>;
};

export default HandleUserStatistics;