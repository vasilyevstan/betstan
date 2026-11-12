import express from "express";
import axios from "axios";
import { Types } from "mongoose";
import {
  BetKind, BUILDER_PRODUCT_NAME, CUSTOM_MARKET_PRODUCT_NAME, marketDomainTime, marketKey,
  marketObject, marketText, MarketValidationError, parseMarketBet,
} from "@betstan/common";
import {
  parseExpectedBoardFingerprint, parseExpectedBoardRevision, PlainSlipRow, upsertDraftSlipRow,
} from "../model/slipSupport";

const router = express.Router();

async function loadSelection(ownerId: string, quoteId: string, cookie: string): Promise<PlainSlipRow> {
  const serviceUrl = process.env.EVENT_SERVICE_URL;
  if (!serviceUrl) throw new Error("EVENT_SERVICE_URL is not configured");
  const url = new URL(`/api/event/market-quotes/${encodeURIComponent(quoteId)}`, serviceUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("EVENT_SERVICE_URL must use HTTP or HTTPS");
  const response = await axios.get<unknown>(url.toString(), {
    headers: { Cookie: cookie }, timeout: 5000, maxContentLength: 262144, maxRedirects: 0,
  });
  const data = marketObject(response.data, [
    "userId", "eventId", "eventName", "eventTime", "oddsId", "oddsValue", "oddsName", "productName", "productId",
    "betKind", "selectedAt", "quoteValidUntil", "marketBet",
  ], "Quoted selection");
  const quote = parseMarketBet(data.marketBet);
  if (data.userId !== ownerId || quote.quoteId !== quoteId || data.eventId !== quote.eventId
    || data.oddsValue !== quote.odds || data.betKind !== BetKind.PRE_MATCH
    || Date.now() >= Date.parse(quote.expiresAt)) {
    throw new MarketValidationError("Quote identity, owner or price does not match");
  }
  const eventTime = marketDomainTime(data.eventTime, "Kickoff time");
  return {
    _id: new Types.ObjectId(), eventId: quote.eventId,
    eventName: marketText(data.eventName, "Event name", 240), eventTime, timestamp: eventTime,
    oddsId: marketKey(data.oddsId, "Odds id"), oddsValue: quote.odds,
    oddsName: quote.selections.map(selection => selection.label).join(" + "),
    productName: quote.kind === "BUILDER" ? BUILDER_PRODUCT_NAME : CUSTOM_MARKET_PRODUCT_NAME,
    productId: marketKey(data.productId, "Product id"), betKind: BetKind.PRE_MATCH,
    selectedAt: quote.issuedAt, quoteValidUntil: quote.expiresAt, marketBet: quote,
  };
}

router.post("/api/slip/market-selection", (req, res, next) => {
  void (async () => {
    if (!req.currentUser) { res.status(401).send({ message: "Sign in to add a market selection" }); return; }
    if (process.env.EXTENSIBLE_MARKETS_ENABLED !== "true") {
      res.status(503).send({ message: "New custom markets are not enabled" }); return;
    }
    const body = marketObject(req.body, [
      "quoteId", "expectedBoardRevision", "expectedBoardFingerprint", "replaceEventSelections",
    ], "Add market selection");
    const quoteId = marketKey(body.quoteId, "Quote id");
    const emptyBoard = body.expectedBoardRevision === null && body.expectedBoardFingerprint === null;
    const revision = parseExpectedBoardRevision(body.expectedBoardRevision);
    const fingerprint = parseExpectedBoardFingerprint(body.expectedBoardFingerprint);
    if ((!emptyBoard && (!revision || !fingerprint))
      || (body.replaceEventSelections !== undefined && typeof body.replaceEventSelections !== "boolean")) {
      throw new MarketValidationError("Confirm the current board before adding a selection");
    }
    let row: PlainSlipRow;
    try { row = await loadSelection(req.currentUser.id, quoteId, req.headers.cookie ?? ""); }
    catch (error) {
      if (axios.isAxiosError(error) && [400, 401, 409].includes(error.response?.status ?? 0)) {
        res.status(409).send({ message: "Quote unavailable; generate a new price and review your board" }); return;
      }
      console.error("market_selection_authority_failed", error instanceof Error ? error.message : "Invalid quote response");
      res.status(503).send({ message: "The selection could not be verified; try again" }); return;
    }
    const result = await upsertDraftSlipRow(req.currentUser.id, BetKind.PRE_MATCH, row, {
      expectedBoardRevision: emptyBoard ? null : revision,
      expectedBoardFingerprint: emptyBoard ? null : fingerprint,
      replaceEventSelections: body.replaceEventSelections === true,
    });
    if (!result.accepted) {
      res.status(409).send({
        message: "Board changed or contains another selection for this match. Review it before explicitly replacing that match's selections.",
        reload: { required: true, reason: "board-mismatch" },
      }); return;
    }
    res.send({ accepted: true, quoteId });
  })().catch(error => {
    if (error instanceof MarketValidationError) res.status(400).send({ message: error.message });
    else next(error);
  });
});

export { router as MarketSelection };
