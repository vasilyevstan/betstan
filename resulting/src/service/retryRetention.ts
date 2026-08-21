import {
  BetKind,
  IEventResultEvent,
  ILiveEventUpdateEvent,
  IModerationResultEvent,
  IPlaceBetEvent,
} from "@betstan/common";
import { createHash } from "node:crypto";
import { RetryRecordKind } from "../model/RetryRecord";

export const MAX_RETRY_ERROR_NAME_BYTES = 128;
export const MAX_RETRY_ERROR_MESSAGE_BYTES = 512;
export const MAX_RETRY_ERROR_STACK_BYTES = 2048;
export const MAX_RETRY_ERROR_STACK_FRAMES = 20;
export const MAX_RETRY_ID_BYTES = 128;
export const MAX_RETRY_PAYLOAD_BYTES = 256 * 1024;
export const MAX_RETRY_SUMMARY_EVENT_IDS = 5;

export interface RetryPayloadSummary {
  affectedRowCount?: number;
  betKind?: BetKind;
  eventCount?: number;
  eventId?: string;
  eventIds?: string[];
  kind: RetryRecordKind;
  marketCount?: number;
  result?: string;
  rowCount?: number;
  sequence?: number;
  settlementCount?: number;
  slipId?: string;
}

export interface RetryPayloadDescriptor<TPayload = unknown> {
  kind: RetryRecordKind;
  payload: TPayload;
}

export interface RetryPayloadStorage<TPayload = unknown> {
  byteCount: number;
  hash: string;
  isOversized: boolean;
  payload?: TPayload;
  summary: RetryPayloadSummary;
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || value === undefined) {
    return "null";
  }

  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry, seen)).join(",")}]`;
  }

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString());
    case "function":
    case "symbol":
      return JSON.stringify(String(value));
    case "object": {
      if (seen.has(value as object)) {
        return JSON.stringify("[Circular]");
      }

      seen.add(value as object);

      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(
          ([entryKey, entryValue]) =>
            `${JSON.stringify(entryKey)}:${stableSerialize(entryValue, seen)}`
        );

      seen.delete(value as object);
      return `{${entries.join(",")}}`;
    }
    default:
      return JSON.stringify(String(value));
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  let truncated = "";

  for (const symbol of Array.from(value)) {
    const next = truncated + symbol;

    if (Buffer.byteLength(next, "utf8") > maxBytes) {
      break;
    }

    truncated = next;
  }

  return truncated;
}

function normalizeWhitespace(value: string, preserveNewlines: boolean): string {
  const withNormalizedNewlines = value.replace(/\r\n?/g, "\n");
  const withoutUnsafeControls = withNormalizedNewlines.replace(
    preserveNewlines ? /[\x00-\x09\x0B-\x1F\x7F-\x9F]/g : /[\x00-\x1F\x7F-\x9F]/g,
    " "
  );

  return preserveNewlines
    ? withoutUnsafeControls.replace(/\t/g, " ").replace(/ +\n/g, "\n")
    : withoutUnsafeControls.replace(/\s+/g, " ");
}

function redactSecrets(value: string): string {
  return value
    .replace(
      /((?:access|refresh)?[_-]?token"\s*:\s*")([^"]+)(")/gi,
      `$1[REDACTED]$3`
    )
    .replace(
      /((?:api[_-]?key|password|passwd|secret|cookie|set-cookie|jwt)"\s*:\s*")([^"]+)(")/gi,
      `$1[REDACTED]$3`
    )
    .replace(
      /(authorization\s*[:=]\s*bearer\s+)([^\s,;]+)/gi,
      `$1[REDACTED]`
    )
    .replace(/(bearer\s+)([^\s,;]+)/gi, `$1[REDACTED]`)
    .replace(
      /((?:access|refresh)?[_-]?token\s*[:=]\s*)([^\s,;]+)/gi,
      `$1[REDACTED]`
    )
    .replace(
      /((?:api[_-]?key|password|passwd|secret|cookie|set-cookie|jwt)\s*[:=]\s*)([^\s,;]+)/gi,
      `$1[REDACTED]`
    );
}

export function sanitizeRetryText(
  value: unknown,
  {
    maxBytes,
    preserveNewlines = false,
  }: {
    maxBytes: number;
    preserveNewlines?: boolean;
  }
): string {
  const stringValue =
    typeof value === "string" ? value : stableSerialize(value ?? "");
  const redactedValue = redactSecrets(stringValue);
  const normalizedValue = normalizeWhitespace(redactedValue, preserveNewlines);
  const trimmedValue = preserveNewlines
    ? normalizedValue
        .split("\n")
        .map((line) => line.trim())
        .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
        .join("\n")
    : normalizedValue.trim();

  return truncateUtf8(trimmedValue, maxBytes);
}

export function sanitizeRetryStack(stack: unknown): string {
  const sanitizedStack = sanitizeRetryText(stack, {
    maxBytes: MAX_RETRY_ERROR_STACK_BYTES * 2,
    preserveNewlines: true,
  });

  if (!sanitizedStack) {
    return "";
  }

  const stackLines = sanitizedStack
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (stackLines.length === 0) {
    return "";
  }

  const boundedLines = [
    stackLines[0],
    ...stackLines.slice(1, MAX_RETRY_ERROR_STACK_FRAMES + 1),
  ];

  return truncateUtf8(
    boundedLines.join("\n"),
    MAX_RETRY_ERROR_STACK_BYTES
  );
}

function sanitizeId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") {
    return undefined;
  }

  const sanitizedValue = sanitizeRetryText(String(value), {
    maxBytes: MAX_RETRY_ID_BYTES,
  });

  return sanitizedValue || undefined;
}

function uniqueSortedIds(values: Array<unknown>): string[] | undefined {
  const uniqueValues = [...new Set(values.map((value) => sanitizeId(value)).filter(Boolean))]
    .sort()
    .slice(0, MAX_RETRY_SUMMARY_EVENT_IDS) as string[];

  return uniqueValues.length > 0 ? uniqueValues : undefined;
}

export function buildRetryPayloadSummary(
  descriptor: RetryPayloadDescriptor
): RetryPayloadSummary {
  switch (descriptor.kind) {
    case "PLACE_BET": {
      const payload = descriptor.payload as IPlaceBetEvent;
      const rows = payload?.data?.rows ?? [];

      return {
        betKind: payload?.data?.betKind,
        eventCount: new Set(rows.map((row) => row.eventId)).size,
        eventIds: uniqueSortedIds(rows.map((row) => row.eventId)),
        kind: descriptor.kind,
        rowCount: rows.length,
        slipId: sanitizeId(payload?.data?.slipId),
      };
    }
    case "MODERATION_RESULT": {
      const payload = descriptor.payload as IModerationResultEvent;

      return {
        affectedRowCount: payload?.data?.affectedRows?.length ?? 0,
        betKind: payload?.data?.betKind,
        kind: descriptor.kind,
        result: sanitizeId(payload?.data?.result),
        slipId: sanitizeId(payload?.data?.slipId),
      };
    }
    case "EVENT_RESULT": {
      const payload = descriptor.payload as IEventResultEvent;

      return {
        eventId: sanitizeId(payload?.data?.eventId),
        kind: descriptor.kind,
      };
    }
    case "LIVE_EVENT_UPDATE": {
      const payload = descriptor.payload as ILiveEventUpdateEvent;

      return {
        eventId: sanitizeId(payload?.data?.eventId),
        kind: descriptor.kind,
        marketCount: payload?.data?.markets?.length ?? 0,
        sequence:
          typeof payload?.data?.sequence === "number"
            ? payload.data.sequence
            : undefined,
        settlementCount: payload?.data?.settlements?.length ?? 0,
      };
    }
    default:
      return {
        kind: descriptor.kind,
      };
  }
}

export function buildRetryPayloadStorage<TPayload>(
  descriptor: RetryPayloadDescriptor<TPayload>
): RetryPayloadStorage<TPayload> {
  const serializedPayload = stableSerialize(descriptor.payload);
  const byteCount = Buffer.byteLength(serializedPayload, "utf8");

  return {
    byteCount,
    hash: createHash("sha256").update(serializedPayload).digest("hex"),
    isOversized: byteCount > MAX_RETRY_PAYLOAD_BYTES,
    payload:
      byteCount > MAX_RETRY_PAYLOAD_BYTES ? undefined : descriptor.payload,
    summary: buildRetryPayloadSummary(descriptor),
  };
}
