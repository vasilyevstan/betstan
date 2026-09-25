import express, { Request, Response } from "express";
import { CashBackConfirmRequest, CashBackQuoteRequest, messengerWrapper } from "@betstan/common";
import { CashBackHttpError, cashBackOperationDto, getCashBackFacade } from "../service/CashBackFacade";

const router = express.Router();
const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pending = (state: string) => state === "QUOTE_PENDING" || state === "CONFIRM_PENDING";

// Match Auth's signed-timestamp policy without changing other Bet routes.
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const isSessionTimestampFresh = (timestamp: unknown, nowMs = Date.now()): boolean => {
  if (typeof timestamp !== "string" && !(timestamp instanceof Date)) return false;
  const timestampMs = new Date(timestamp).getTime();
  return Number.isFinite(timestampMs)
    && timestampMs <= nowMs + MAX_CLOCK_SKEW_MS
    && nowMs <= timestampMs + SESSION_MAX_AGE_MS;
};

const route = (handler: (request: Request, response: Response, userId: string) => Promise<void>) =>
  (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    if (!object(request.currentUser) || !isSessionTimestampFresh(request.currentUser.timestamp)) {
      response.status(401).send({ errors: [{ code: "AUTHENTICATION_REQUIRED", message: "Authentication required" }] });
      return;
    }
    void handler(request, response, request.currentUser.id).catch(error => {
      if (error instanceof CashBackHttpError) {
        response.status(error.status).send({ errors: [{ code: error.code, message: error.message }] });
        return;
      }
      console.error("bet_cash_back_http_failed", { error: error instanceof Error ? error.name : "unknown" });
      response.status(503).send({
        errors: [{ code: "CASH_BACK_UNAVAILABLE", message: "Cash-back request unavailable; retry with the same clientOperationId" }],
      });
    });
  };

router.post("/api/bet/:slipId/cash-back/quote", route(async (req, res, userId) => {
  const body: unknown = req.body;
  if (
    !identifier(req.params.slipId) || !object(body) || body.action !== "QUOTE"
    || !identifier(body.clientOperationId) || !object(body.portion)
    || !Object.keys(body).every(key => ["action", "clientOperationId", "portion"].includes(key))
  ) throw new CashBackHttpError(400, "INVALID_REQUEST");
  let request: CashBackQuoteRequest;
  if (body.portion.mode === "FULL" && Object.keys(body.portion).length === 1) {
    request = { action: "QUOTE", clientOperationId: body.clientOperationId, portion: { mode: "FULL" } };
  } else if (
    body.portion.mode === "PARTIAL" && Object.keys(body.portion).length === 2
    && typeof body.portion.stakeMinor === "number"
    && Number.isSafeInteger(body.portion.stakeMinor) && body.portion.stakeMinor >= 1
  ) {
    request = { action: "QUOTE", clientOperationId: body.clientOperationId,
      portion: { mode: "PARTIAL", stakeMinor: body.portion.stakeMinor } };
  } else throw new CashBackHttpError(400, "INVALID_AMOUNT");
  const operation = await getCashBackFacade(messengerWrapper.connection).quote(userId, req.params.slipId, request);
  res.status(pending(operation.state) ? 202 : 200).send(cashBackOperationDto(operation));
}));

router.post("/api/bet/:slipId/cash-back/accept", route(async (req, res, userId) => {
  const body: unknown = req.body;
  if (
    !identifier(req.params.slipId) || !object(body) || body.action !== "CONFIRM"
    || !identifier(body.clientOperationId) || !identifier(body.quoteId)
    || !Object.keys(body).every(key => ["action", "clientOperationId", "quoteId"].includes(key))
  ) throw new CashBackHttpError(400, "INVALID_REQUEST");
  const request: CashBackConfirmRequest = {
    action: "CONFIRM", clientOperationId: body.clientOperationId, quoteId: body.quoteId,
  };
  const operation = await getCashBackFacade(messengerWrapper.connection).confirm(userId, req.params.slipId, request);
  res.status(pending(operation.state) ? 202 : 200).send(cashBackOperationDto(operation));
}));

router.get("/api/bet/:slipId/cash-back/operations/:operationId", route(async (req, res, userId) => {
  if (!identifier(req.params.slipId) || !identifier(req.params.operationId)) throw new CashBackHttpError(400, "INVALID_REQUEST");
  const operation = await getCashBackFacade(messengerWrapper.connection).status(userId, req.params.slipId, req.params.operationId);
  res.status(pending(operation.state) ? 202 : 200).send(cashBackOperationDto(operation));
}));

router.get("/api/bet/:slipId/cash-back/history", route(async (req, res, userId) => {
  if (!identifier(req.params.slipId) || (req.query.cursor !== undefined
    && (typeof req.query.cursor !== "string" || req.query.cursor.length > 512))) {
    throw new CashBackHttpError(400, "INVALID_CURSOR");
  }
  res.send(await getCashBackFacade(messengerWrapper.connection).history(userId, req.params.slipId, req.query.cursor));
}));

export { router as CashBack };
