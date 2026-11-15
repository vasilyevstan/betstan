import { AListener, ICashBackOutcomeEvent, ISettleSlipEvent, QueueNames } from "@betstan/common";
import { ConsumeMessage } from "amqplib";
import { receiveAccounting } from "../../risk/Accounting";
import { RiskError } from "../../risk/Policy";

export class RiskSettlementListener extends AListener<ISettleSlipEvent> {
  serviceName = "moderation_risk_settle_slip";
  queue = QueueNames.SETTLE_SLIP;
  async init() { await super.init(); await this.channel.prefetch(1); }
  async onMessage(event: ISettleSlipEvent, msg: ConsumeMessage) {
    if (event.sender !== "resulting_settle_slip") { this.channel.nack(msg, false, false); return; }
    try {
      await receiveAccounting(event.data.slipId, (event.data as ISettleSlipEvent["data"] & { accounting?: unknown }).accounting);
      this.ack(msg);
    } catch (error) { this.channel.nack(msg, false, !(error instanceof RiskError)); }
  }
  async close() { await (Reflect.get(this, "_channel") as { close?: () => Promise<void> } | undefined)?.close?.(); }
}
export class RiskCashBackListener extends AListener<ICashBackOutcomeEvent> {
  serviceName = "moderation_risk_cash_back_outcome";
  queue = QueueNames.CASH_BACK_OUTCOME;
  async init() { await super.init(); await this.channel.prefetch(1); }
  async onMessage(event: ICashBackOutcomeEvent, msg: ConsumeMessage) {
    if (event.sender !== "resulting_cash_back_outcome") { this.channel.nack(msg, false, false); return; }
    try {
      if (event.data.outcome === "ACCEPTED") {
        await receiveAccounting(event.data.operation.slipId, (event.data as ICashBackOutcomeEvent["data"] & { accounting?: unknown }).accounting);
      }
      this.ack(msg);
    } catch (error) { this.channel.nack(msg, false, !(error instanceof RiskError)); }
  }
  async close() { await (Reflect.get(this, "_channel") as { close?: () => Promise<void> } | undefined)?.close?.(); }
}
