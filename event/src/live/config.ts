export interface PublicEventConfig {
  historyMinutes: number;
  horizonMinutes: number;
  maxIncidents: number;
  maxMarkets: number;
  sseHeartbeatMs: number;
}

const DEFAULT_PUBLIC_EVENT_CONFIG: PublicEventConfig = {
  historyMinutes: 240,
  horizonMinutes: 1440,
  maxIncidents: 25,
  maxMarkets: 20,
  sseHeartbeatMs: 15000,
};

const readPositiveInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number
): number => {
  if (value === undefined || !/^\d+$/.test(value)) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, parsed) : fallback;
};

export const getPublicEventConfig = (
  env: NodeJS.ProcessEnv = process.env
): PublicEventConfig => ({
  historyMinutes: readPositiveInteger(
    env.EVENT_PUBLIC_LIST_HISTORY_MINUTES,
    DEFAULT_PUBLIC_EVENT_CONFIG.historyMinutes,
    1
  ),
  horizonMinutes: readPositiveInteger(
    env.EVENT_PUBLIC_LIST_HORIZON_MINUTES,
    DEFAULT_PUBLIC_EVENT_CONFIG.horizonMinutes,
    1
  ),
  maxIncidents: readPositiveInteger(
    env.EVENT_PUBLIC_MAX_INCIDENTS,
    DEFAULT_PUBLIC_EVENT_CONFIG.maxIncidents,
    1
  ),
  maxMarkets: readPositiveInteger(
    env.EVENT_PUBLIC_MAX_MARKETS,
    DEFAULT_PUBLIC_EVENT_CONFIG.maxMarkets,
    1
  ),
  sseHeartbeatMs: readPositiveInteger(
    env.EVENT_PUBLIC_SSE_HEARTBEAT_MS,
    DEFAULT_PUBLIC_EVENT_CONFIG.sseHeartbeatMs,
    1000
  ),
});
