import { createHash } from "crypto";
import { MetricName } from "../domain/metrics";
import { RecordMetric } from "../service/Recorder";

export const EXCHANGES = [
  "slip:bet",
  "resulting:slip:settle",
  "gamemaster:event:live",
  "telemetry:event:v1",
] as const;

export type TelemetryExchange = (typeof EXCHANGES)[number];

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (value: JsonObject, keys: string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
};

const parseIsoDate = (value: unknown): Date | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }

  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    return undefined;
  }
  return date;
};

const hashIdentity = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

const validateGeneric = (
  root: JsonObject,
  data: JsonObject
): RecordMetric | undefined => {
  if (
    !hasExactKeys(root, ["data", "timestamp", "sender"])
    || !hasExactKeys(data, ["metric", "eventId", "occurredAt"])
    || typeof root.sender !== "string"
    || typeof data.metric !== "string"
    || typeof data.eventId !== "string"
    || !UUID_PATTERN.test(data.eventId)
    || root.timestamp !== data.occurredAt
  ) {
    return undefined;
  }

  const allowed =
    root.sender === "auth"
      ? ["USER_CREATED", "USER_LOGGED_IN"]
      : root.sender === "slip"
        ? ["SLIP_CREATED"]
        : [];

  if (!allowed.includes(data.metric)) {
    return undefined;
  }

  const occurredAt = parseIsoDate(data.occurredAt);
  if (!occurredAt) {
    return undefined;
  }

  return {
    _id: data.eventId,
    metric: data.metric as MetricName,
    occurredAt,
  };
};

const validateEnvelopeTimestamp = (
  root: JsonObject,
  sender: string
): Date | undefined => {
  if (root.sender !== sender) {
    return undefined;
  }
  return parseIsoDate(root.timestamp);
};

const validateOccurrenceTime = (
  data: JsonObject,
  field: string,
  legacyEnvelopeTimestamp: Date
): Date | undefined =>
  Object.prototype.hasOwnProperty.call(data, field)
    ? parseIsoDate(data[field])
    : legacyEnvelopeTimestamp;

export const validateExchangeEvent = (
  exchange: string,
  value: unknown
): RecordMetric | undefined => {
  if (!isObject(value) || !isObject(value.data)) {
    return undefined;
  }

  const data = value.data;
  if (exchange === "telemetry:event:v1") {
    return validateGeneric(value, data);
  }

  if (exchange === "slip:bet") {
    const envelopeTimestamp = validateEnvelopeTimestamp(
      value,
      "slip_place_bet"
    );
    if (
      !envelopeTimestamp
      || typeof data.slipId !== "string"
      || !data.slipId
    ) {
      return undefined;
    }
    const occurredAt = validateOccurrenceTime(
      data,
      "submittedAt",
      envelopeTimestamp
    );
    if (!occurredAt) {
      return undefined;
    }
    return {
      _id: hashIdentity(["BET_PLACED", data.slipId]),
      metric: "BET_PLACED",
      occurredAt,
    };
  }

  if (exchange === "resulting:slip:settle") {
    const envelopeTimestamp = validateEnvelopeTimestamp(
      value,
      "resulting_settle_slip"
    );
    if (
      !envelopeTimestamp
      || typeof data.slipId !== "string"
      || !data.slipId
    ) {
      return undefined;
    }
    const occurredAt = validateOccurrenceTime(
      data,
      "occurredAt",
      envelopeTimestamp
    );
    if (!occurredAt) {
      return undefined;
    }
    return {
      _id: hashIdentity(["RESULTING_SETTLED", data.slipId]),
      metric: "RESULTING_SETTLED",
      occurredAt,
    };
  }

  if (exchange === "gamemaster:event:live") {
    if (
      value.sender !== "gamemaster_live_event_update"
      || typeof data.eventId !== "string"
      || !data.eventId
      || !Number.isInteger(data.sequence)
    ) {
      return undefined;
    }
    const occurredAt = parseIsoDate(data.occurredAt);
    if (!occurredAt) {
      return undefined;
    }
    return {
      _id: hashIdentity([
        "GAMECENTER_EVENT_EMITTED",
        data.eventId,
        data.sequence,
      ]),
      metric: "GAMECENTER_EVENT_EMITTED",
      occurredAt,
    };
  }

  return undefined;
};
