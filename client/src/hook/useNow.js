import { useEffect, useState } from 'react';

const DEFAULT_INTERVAL_MS = 1000;

/**
 * Ticks a re-render every `intervalMs` and returns the current epoch millisecond
 * timestamp. Used to drive accessible countdowns and countdown-window bucketing
 * without ever trusting the client clock as an authorization boundary (see
 * `isInCountdownWindow`/`isLiveMarketSelectable` in `liveBettingUtils.js`).
 */
const useNow = (intervalMs = DEFAULT_INTERVAL_MS) => {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timerId = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);

    return () => clearInterval(timerId);
  }, [intervalMs]);

  return now;
};

export default useNow;
