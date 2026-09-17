export const PRE_SEPTEMBER_CLEANUP_CUTOFF =
  "2026-09-01T00:00:00Z" as const;

export const PRE_SEPTEMBER_CLEANUP_CUTOFF_MS =
  Date.UTC(2026, 8, 1, 0, 0, 0, 0);

const EXPLICIT_ZONE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

const isLeapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

/**
 * Parses the deliberately narrow timestamp grammar shared by the listener and
 * the one-off cleanup. A timezone is mandatory so host-local time can never
 * move an event across the fixed UTC boundary.
 */
export const parseExplicitZoneTimestamp = (
  value: unknown
): number | null => {
  if (typeof value !== "string") {
    return null;
  }

  const match = EXPLICIT_ZONE_TIMESTAMP.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8];
  const offsetHour = zone === "Z" ? 0 : Number(match[10]);
  const offsetMinute = zone === "Z" ? 0 : Number(match[11]);

  if (
    zone === "-00:00" || year === 0
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }

  const millisecond = Number((fraction + "000").slice(0, 3));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);

  const offset =
    (offsetHour * 60 + offsetMinute) * 60_000
    * (match[9] === "-" ? -1 : 1);
  const epochMs = local.getTime() - offset;

  return Number.isFinite(epochMs) ? epochMs : null;
};

export const isBeforePreSeptemberCleanupCutoff = (
  value: unknown
): boolean => {
  const parsed = parseExplicitZoneTimestamp(value);
  return parsed !== null && parsed < PRE_SEPTEMBER_CLEANUP_CUTOFF_MS;
};
