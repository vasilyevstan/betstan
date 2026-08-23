import { UserRole } from "../model/User";

const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export const normalizeUserRole = (role: unknown): UserRole =>
  role === UserRole.ADMIN ? UserRole.ADMIN : UserRole.USER;

export const isSessionTimestampFresh = (
  timestamp: Date | string | undefined,
  nowMs = Date.now()
): boolean => {
  if (!timestamp) {
    return false;
  }

  const timestampMs = new Date(timestamp).getTime();
  return (
    Number.isFinite(timestampMs)
    && timestampMs <= nowMs + MAX_CLOCK_SKEW_MS
    && nowMs <= timestampMs + SESSION_MAX_AGE_MS
  );
};
