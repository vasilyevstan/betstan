import express, { NextFunction, Request, Response } from "express";
import { Event } from "../model/Event";
import {
  BadRequestError,
  BetKind,
  BettingStatus,
  EventPhase,
  EventVisibility,
  LiveMarketStatus,
  LiveMarketType,
  TeamSide,
  messengerWrapper,
} from "@betstan/common";
import EventOddsSelectedPublisher from "../messaging/publisher/EventOddsSelectedPublisher";
import { verifyAdminRequest } from "../service/VerifyAdminSession";

const router = express.Router();

const LIVE_MARKET_NAMES: Record<LiveMarketType, string> = {
  [LiveMarketType.NEXT_YELLOW_CARD]: "Next Yellow Card",
  [LiveMarketType.NEXT_RED_CARD]: "Next Red Card",
  [LiveMarketType.NEXT_CORNER]: "Next Corner",
  [LiveMarketType.NEXT_PENALTY]: "Next Penalty",
  [LiveMarketType.HALF_TIME_RESULT]: "Half Time Result",
};

let _publisher: EventOddsSelectedPublisher | null = null;
const getPublisher = async (): Promise<EventOddsSelectedPublisher> => {
  if (!_publisher) {
    _publisher = new EventOddsSelectedPublisher(messengerWrapper.connection);
    await _publisher.init();
  }
  return _publisher;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const parseInteger = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return null;
};

const isLiveSelectionPhase = (phase: EventPhase | undefined): boolean =>
  phase !== undefined &&
  phase !== EventPhase.PRE_MATCH &&
  phase !== EventPhase.FULL_TIME;

const getSelectionName = (
  side: TeamSide,
  event: { home?: string | null; away?: string | null }
): string => {
  if (side === TeamSide.HOME) {
    return event.home || TeamSide.HOME;
  }
  if (side === TeamSide.AWAY) {
    return event.away || TeamSide.AWAY;
  }
  if (side === TeamSide.DRAW) {
    return "Draw";
  }
  return "None";
};

const getEventTime = (event: {
  time?: Date | string;
  live?: { kickoffAt?: string | null } | null;
}): string => {
  if (event.time instanceof Date) {
    return event.time.toISOString();
  }
  if (typeof event.time === "string") {
    return event.time;
  }
  return event.live?.kickoffAt || new Date().toISOString();
};

const hasPrematchStarted = (event: {
  time?: Date | string;
  live?: { phase?: EventPhase; kickoffAt?: string | null } | null;
}): boolean => {
  if (event.live && isLiveSelectionPhase(event.live.phase)) {
    return true;
  }

  const kickoffSource =
    event.live?.kickoffAt || (event.time instanceof Date ? event.time : event.time);
  if (!kickoffSource) {
    return false;
  }

  const kickoffAt = new Date(kickoffSource);
  return !Number.isNaN(kickoffAt.getTime()) && Date.now() >= kickoffAt.getTime();
};

const isLiveSelectionRequest = (body: Record<string, unknown>): boolean =>
  [
    body.marketId,
    body.marketVersion,
    body.quoteVersion,
    body.selectionId,
  ].some((value) => value !== undefined);

router.post(
  "/api/event/odds",
  async (req: Request, res: Response, next: NextFunction) => {
    const body = req.body as Record<string, unknown>;
    const { eventId, productId, oddsId, marketId, selectionId } = body;
    const marketVersion = parseInteger(body.marketVersion);
    const quoteVersion = parseInteger(body.quoteVersion);

    if (!isNonEmptyString(eventId)) {
      return next(new BadRequestError("eventId must be provided"));
    }

    const event = await Event.findOne({ eventId }).lean();

    if (!event) {
      return next(new BadRequestError("Event not found"));
    }

    if (event.visibility === EventVisibility.OFFLINE) {
      try {
        const adminStatus = await verifyAdminRequest(req);
        if (adminStatus !== 204) {
          return res.status(adminStatus).send({
            errors: [{
              message:
                adminStatus === 401
                  ? "Authentication required"
                  : "Administrator role required",
            }],
          });
        }
      } catch (_error) {
        console.error("Offline event authorization failed");
        return res.status(503).send({
          errors: [{ message: "Authorization service unavailable" }],
        });
      }
    }

    if (isLiveSelectionRequest(body)) {
      if (
        !isNonEmptyString(marketId) ||
        !isNonEmptyString(selectionId) ||
        marketVersion === null ||
        quoteVersion === null
      ) {
        return next(
          new BadRequestError(
            "Live selections require marketId, selectionId, marketVersion and quoteVersion"
          )
        );
      }

      const live = event.live;
      if (
        !live ||
        !isLiveSelectionPhase(live.phase) ||
        live.bettingStatus !== BettingStatus.OPEN
      ) {
        return next(new BadRequestError("Live betting is not open for this event"));
      }

      const selectedMarket = Array.isArray(live.currentMarkets)
        ? live.currentMarkets.find((market) => market.marketId === marketId)
        : undefined;

      if (!selectedMarket) {
        return next(new BadRequestError("Market does not exist"));
      }

      if (selectedMarket.status !== LiveMarketStatus.OPEN) {
        return next(new BadRequestError("Market is not open"));
      }

      if (
        selectedMarket.marketVersion !== marketVersion ||
        selectedMarket.quoteVersion !== quoteVersion
      ) {
        return next(new BadRequestError("Market version mismatch"));
      }

      const selectedSelection = selectedMarket.selections.find(
        (marketSelection) => marketSelection.selectionId === selectionId
      );

      if (!selectedSelection) {
        return next(new BadRequestError("Selection does not exist"));
      }

      const publisher = await getPublisher();

      publisher.publish({
        data: {
          userId: req.currentUser ? req.currentUser.id : "",
          eventId: event.eventId,
          eventName: event.name,
          oddsId: `${selectedMarket.marketId}:${selectedSelection.selectionId}`,
          oddsValue: selectedSelection.odds,
          oddsName: getSelectionName(selectedSelection.side, event),
          productName:
            LIVE_MARKET_NAMES[selectedMarket.marketType] ||
            selectedMarket.marketType,
          productId: selectedMarket.marketId,
          eventTime: getEventTime(event),
          betKind: BetKind.LIVE,
          marketId: selectedMarket.marketId,
          marketType: selectedMarket.marketType,
          marketVersion: selectedMarket.marketVersion,
          quoteVersion: selectedMarket.quoteVersion,
          selectionId: selectedSelection.selectionId,
          side: selectedSelection.side,
          selectedAt: new Date().toISOString(),
          quoteValidUntil: selectedMarket.quoteValidUntil || undefined,
        },
      });

      res.sendStatus(200);
      return;
    }

    if (!isNonEmptyString(productId) || !isNonEmptyString(oddsId)) {
      return next(new BadRequestError("productId and oddsId must be provided"));
    }

    if (hasPrematchStarted(event)) {
      return next(new BadRequestError("Pre-match selections close at kickoff"));
    }

    const selectedProduct = Array.isArray(event.products)
      ? event.products.find((eventProduct) => eventProduct.id === productId)
      : undefined;

    if (!selectedProduct) {
      return next(new BadRequestError("Product does not exist"));
    }

    const selectedOdds = Array.isArray(selectedProduct.odds)
      ? selectedProduct.odds.find((eventOdds) => eventOdds.id === oddsId)
      : undefined;

    if (!selectedOdds) {
      return next(new BadRequestError("Odds does not exist"));
    }

    const publisher = await getPublisher();

    const eventPayload = {
      data: {
        userId: req.currentUser ? req.currentUser.id : "",
        eventId: event.eventId,
        eventName: event.name,
        oddsId: selectedOdds.id,
        oddsValue: selectedOdds.value as number,
        oddsName: selectedOdds.name as string,
        productName: selectedProduct.name,
        productId: selectedProduct.id,
        eventTime: getEventTime(event),
        betKind: BetKind.PRE_MATCH,
        selectedAt: new Date().toISOString(),
      },
    };

    publisher.publish(eventPayload);

    res.sendStatus(200);
  }
);

export { router as EventOddsClicked };
