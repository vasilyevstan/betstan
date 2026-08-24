import { getPublicEventConfig } from "../config";

it("reads explicit numeric overrides and enforces configured minimums", () => {
  expect(
    getPublicEventConfig({
      EVENT_PUBLIC_LIST_HISTORY_MINUTES: "10",
      EVENT_PUBLIC_LIST_HORIZON_MINUTES: "1",
      EVENT_PUBLIC_MAX_INCIDENTS: "2",
      EVENT_PUBLIC_MAX_MARKETS: "3",
      EVENT_PUBLIC_SSE_HEARTBEAT_MS: "999",
      EVENT_PUBLIC_SSE_MAX_CONNECTIONS: "0",
    } as NodeJS.ProcessEnv)
  ).toEqual({
    historyMinutes: 10,
    horizonMinutes: 1,
    maxIncidents: 2,
    maxMarkets: 3,
    sseHeartbeatMs: 1000,
    sseMaxConnections: 1,
  });
});

it("falls back for missing, invalid, or unsafe numeric overrides", () => {
  expect(
    getPublicEventConfig({
      EVENT_PUBLIC_LIST_HISTORY_MINUTES: "abc",
      EVENT_PUBLIC_LIST_HORIZON_MINUTES: "999999999999999999999",
      EVENT_PUBLIC_MAX_INCIDENTS: undefined,
      EVENT_PUBLIC_MAX_MARKETS: "-5",
      EVENT_PUBLIC_SSE_HEARTBEAT_MS: "",
      EVENT_PUBLIC_SSE_MAX_CONNECTIONS: "not-a-number",
    } as NodeJS.ProcessEnv)
  ).toEqual({
    historyMinutes: 240,
    horizonMinutes: 1440,
    maxIncidents: 25,
    maxMarkets: 20,
    sseHeartbeatMs: 15000,
    sseMaxConnections: 500,
  });
});
