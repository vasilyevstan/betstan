const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const isSessionTimestampFresh = (timestamp: unknown, nowMs = Date.now()): boolean => {
  if (typeof timestamp !== "string" && !(timestamp instanceof Date)) return false;
  const timestampMs = new Date(timestamp).getTime();
  return Number.isFinite(timestampMs)
    && timestampMs <= nowMs + MAX_CLOCK_SKEW_MS
    && nowMs <= timestampMs + SESSION_MAX_AGE_MS;
};
