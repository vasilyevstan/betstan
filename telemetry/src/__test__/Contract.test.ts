import { METRICS, SERVICES } from "../domain/metrics";
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
  expect([...METRICS]).toEqual(expectedMetrics);
  expect(METRICS).toHaveLength(8);
  expect([...SERVICES]).toEqual(expectedServices);
  expect(SERVICES).toHaveLength(10);
});
