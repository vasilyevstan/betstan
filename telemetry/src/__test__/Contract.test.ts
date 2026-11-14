import { METRICS, METRICS_V1, SERVICES } from "../domain/metrics";
import { EXCHANGES } from "../event/validator";

it("literal-pins the complete exchange, metric, and service order contracts", () => {
  const expectedExchanges = [
    "slip:bet",
    "resulting:slip:settle",
    "gamemaster:event:live",
    "telemetry:event:v1",
  ];
  const expectedMetrics = [
    "MAIN_PAGE_VISIT",
    "ADMIN_PAGE_VISIT",
    "SLIP_CREATED",
    "BET_PLACED",
    "RESULTING_SETTLED",
    "GAMECENTER_EVENT_EMITTED",
    "USER_CREATED",
    "USER_LOGGED_IN",
  ];
  const expectedServices = [
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
  ];

  expect([...EXCHANGES]).toEqual(expectedExchanges);
  expect(EXCHANGES).toHaveLength(4);
  expect([...METRICS_V1]).toEqual(expectedMetrics);
  expect(METRICS_V1).toHaveLength(8);
  expect([...METRICS]).toEqual([...expectedMetrics, "MARKET_TEMPLATE_PAGE_VISIT", "RISK_CENTRE_PAGE_VISIT"]);
  expect([...SERVICES]).toEqual(expectedServices);
  expect(SERVICES).toHaveLength(10);
});
