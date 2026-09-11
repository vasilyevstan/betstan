export const METRICS = [
  "MAIN_PAGE_VISIT",
  "ADMIN_PAGE_VISIT",
  "SLIP_CREATED",
  "BET_PLACED",
  "RESULTING_SETTLED",
  "GAMECENTER_EVENT_EMITTED",
  "USER_CREATED",
  "USER_LOGGED_IN",
] as const;

export type MetricName = (typeof METRICS)[number];

export const SERVICES = [
  "auth",
  "backoffice",
  "bet",
  "client",
  "event",
  "gamemaster",
  "moderation",
  "resulting",
  "slip",
  "telemetry",
] as const;

export type ServiceName = (typeof SERVICES)[number];
