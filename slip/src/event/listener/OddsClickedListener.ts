import { ConsumeMessage } from "amqplib";
import {
  AListener,
  BetKind,
  IAmqpConnection,
  IEventOddsSelectedEvent,
  QueueNames,
} from "@betstan/common";
import { Types } from "mongoose";
import {
  PlainSlipRow,
  upsertDraftSlipRow,
  normalizeBetKind,
} from "../../model/slipSupport";
import {
  GUEST_DRAFT_ROW_CAP,
  GUEST_PRINCIPAL_PREFIX,
  isGuestPrincipal,
  nextGuestExpiry,
} from "../../service/guestIdentity";
import {
  DraftTelemetryReporter,
  SlipTelemetryReporter,
} from "../../service/TelemetryReporter";

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
    ...(event.data.marketBet === undefined ? {} : { marketBet: event.data.marketBet }),
  };
};

class OddsClickedListener extends AListener<IEventOddsSelectedEvent> {
  serviceName: string = "slip_odds_clicked";
  queue: QueueNames.EVENT_ODDS_SELECTED = QueueNames.EVENT_ODDS_SELECTED;

  constructor(
    connection: IAmqpConnection,
    private readonly telemetry: DraftTelemetryReporter =
      new SlipTelemetryReporter(connection)
  ) {
    super(connection);
  }

  async init(): Promise<void> {
    await super.init();
    void Promise.resolve()
      .then(() => this.telemetry.initialize())
      .catch(() => {
        console.error("slip_telemetry_disabled");
      });
  }

  async onMessage(event: IEventOddsSelectedEvent, msg: ConsumeMessage) {
    const userId = event.data.userId;
    const betKind = normalizeBetKind(event.data.betKind);

    if (!userId) {
      this.ack(msg);
      return;
    }

    const isGuest =
      typeof userId === "string" && userId.startsWith(GUEST_PRINCIPAL_PREFIX);

    // Custom-market quotes are user-only: a guest row would later be merged into
    // a user draft without the authoritative quote validation.
    if (
      isGuest
      && (!isGuestPrincipal(userId) || event.data.marketBet !== undefined)
    ) {
      console.warn("slip_guest_selection_dropped");
      this.ack(msg);
      return;
    }

    const { wasInserted, accepted } = await upsertDraftSlipRow(
      userId,
      betKind,
      buildSlipRow(event, betKind),
      undefined,
      isGuest
        ? { maxRows: GUEST_DRAFT_ROW_CAP, expiresAt: nextGuestExpiry() }
        : undefined
    );
    if (!accepted) console.warn("slip_selection_not_applied_review_current_board");
    // SLIP_CREATED keeps meaning "authenticated draft created".
    if (wasInserted && !isGuest) {
      try {
        this.telemetry.reportSlipCreated();
      } catch {
        console.error("slip_telemetry_publish_failed");
      }
    }
    this.ack(msg);
  }
}

export default OddsClickedListener;
