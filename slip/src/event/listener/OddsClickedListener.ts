import { ConsumeMessage } from "amqplib";
import {
  AListener,
  BetKind,
  IEventOddsSelectedEvent,
  QueueNames,
} from "@betstan/common";
import { Types } from "mongoose";
import {
  PlainSlipRow,
  upsertDraftSlipRow,
  normalizeBetKind,
} from "../../model/slipSupport";

const buildSlipRow = (
  event: IEventOddsSelectedEvent,
  betKind: BetKind
): PlainSlipRow => {
  const rowTimestamp =
    event.data.eventTime || event.timestamp || new Date().toISOString();

  return {
    _id: new Types.ObjectId(),
    eventId: event.data.eventId,
    eventName: event.data.eventName,
    oddsId: event.data.oddsId,
    oddsValue: event.data.oddsValue,
    oddsName: event.data.oddsName,
    productName: event.data.productName,
    productId: event.data.productId,
    timestamp: rowTimestamp,
    eventTime: event.data.eventTime,
    betKind,
    marketId: event.data.marketId,
    marketType: event.data.marketType,
    marketVersion: event.data.marketVersion,
    quoteVersion: event.data.quoteVersion,
    selectionId: event.data.selectionId,
    side: event.data.side,
    selectedAt: event.data.selectedAt ?? event.timestamp ?? new Date().toISOString(),
    quoteValidUntil: event.data.quoteValidUntil,
  };
};

class OddsClickedListener extends AListener<IEventOddsSelectedEvent> {
  serviceName: string = "slip_odds_clicked";
  queue: QueueNames.EVENT_ODDS_SELECTED = QueueNames.EVENT_ODDS_SELECTED;

  async onMessage(event: IEventOddsSelectedEvent, msg: ConsumeMessage) {
    const userId = event.data.userId;
    const betKind = normalizeBetKind(event.data.betKind);

    if (!userId) {
      this.ack(msg);
      return;
    }

    await upsertDraftSlipRow(userId, betKind, buildSlipRow(event, betKind));
    this.ack(msg);
  }
}

export default OddsClickedListener;
