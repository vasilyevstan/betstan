import { messengerWrapper } from "@betstan/common";
import { RiskCashBackListener, RiskSettlementListener } from "../RiskAccountingListeners";
import { RiskAccountingInbox } from "../../../risk/Store";
import { createMessage } from "./helpers";

it("durably receives settlement evidence with risk admission off, independently of Resulting", async () => {
  delete process.env.RISK_CENTRE_ENABLED;
  const listener = new RiskSettlementListener(messengerWrapper.connection);
  await listener.init();
  const message = createMessage();
  const accounting = { schemaVersion: 1, status: "COMPLETE", movements: [{
    schemaVersion: 1, movementId: "movement-one", slipId: "slip-one", userId: "synthetic-user", revision: 1,
    occurredAt: "2026-11-01T00:00:00.000Z", closedStakeMinor: 100, returnMinor: 200,
    remainingStakeMinor: 0, originalStakeMinor: 100, source: "SETTLEMENT", placementFingerprint: "fingerprint",
  }] };
  await listener.onMessage({ sender: "resulting_settle_slip", data: { slipId: "slip-one", result: "BET_WIN", accounting } } as any, message);
  expect(listener.ack).toHaveBeenCalledWith(message);
  expect(await RiskAccountingInbox.countDocuments()).toBe(1);
  await listener.onMessage({ sender: "resulting_settle_slip", data: { slipId: "slip-one", result: "BET_WIN", accounting } } as any, message);
  expect(await RiskAccountingInbox.countDocuments()).toBe(1);
  expect(Reflect.get(listener, "channel").prefetch).toHaveBeenCalledWith(1);
});

it("never credits rejected cash-back or untrusted settlement senders and closes safely before init", async () => {
  const listener = new RiskCashBackListener(messengerWrapper.connection);
  await listener.init();
  await listener.onMessage({ sender: "resulting_cash_back_outcome", data: {
    outcome: "REJECTED", operation: { slipId: "slip-one" },
  } } as any, createMessage());
  expect(await RiskAccountingInbox.countDocuments()).toBe(0);
  const settlement = new RiskSettlementListener(messengerWrapper.connection);
  await settlement.init();
  const message = createMessage();
  await settlement.onMessage({ sender: "untrusted", data: { slipId: "slip-one", result: "BET_WIN" } }, message);
  expect(Reflect.get(settlement, "channel").nack).toHaveBeenCalledWith(message, false, false);
  await expect(new RiskSettlementListener(messengerWrapper.connection).close()).resolves.toBeUndefined();
  await expect(new RiskCashBackListener(messengerWrapper.connection).close()).resolves.toBeUndefined();
});
