
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

    stats.sort((a, b) => b.betamount - a.betamount);

    const displayName = (email) => {
      if (!email) return '—';
      const local = email.split('@')[0];
      return local.length > 16 ? local.slice(0, 16) + '…' : local;
    };

    const renderedStats = stats.map((stat, idx) => {
      return <div className="stat-row" key={stat.userId}>
        <div className="stat-row__rank text-secondary">{idx + 1}</div>
        <div className="stat-row__user" title={stat.user}>{displayName(stat.user)}</div>
        <div className="stat-row__count">{stat.betamount}</div>
        <div className="stat-row__wager fw-semibold">{stat.wageramount}</div>
      </div>
    });

    return (
      <div className={`flex-wrap scoreboard scoreboard--${uiVariant}`}>
        <div className="card scoreboard__table">
          <div className="stat-row stat-row--header text-secondary">
            <div className="stat-row__rank"></div>
            <div className="stat-row__user">User</div>
            <div className="stat-row__count">Bets</div>
            <div className="stat-row__wager">Wager</div>
          </div>
          {renderedStats}
        </div>
      </div>
    );
};

export default HandleUserStatistics;