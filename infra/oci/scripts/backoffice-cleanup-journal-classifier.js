"use strict";

const CLEANUP_OPERATION_ID =
  "backoffice-events-before:2026-09-01T00:00:00Z";
const CLEANUP_SCHEMA_VERSION =
  "backoffice-pre-september-events-cleanup-v1";
const CLEANUP_JOURNAL_COLLECTION =
  "preseptembereventcleanupoperations";
const CLEANUP_CUTOFF = "2026-09-01T00:00:00Z";
const CLEANUP_CUTOFF_MS = Date.UTC(2026, 8, 1, 0, 0, 0, 0);
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const EXPLICIT_ZONE_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;
const VALID_STATES = new Set(["prepared", "applied"]);
const INVALID = "invalid";

const isLeapYear = (year) =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year, month) => {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

// Keep this grammar and calendar validation identical to
// backoffice/src/event/preSeptemberCleanupBoundary.ts.
const parseExplicitZoneTimestamp = (value) => {
  if (typeof value !== "string") {
    return null;
  }

  const match = EXPLICIT_ZONE_TIMESTAMP.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] || "";
  const zone = match[8];
  const offsetHour = zone === "Z" ? 0 : Number(match[10]);
  const offsetMinute = zone === "Z" ? 0 : Number(match[11]);

  if (
    zone === "-00:00"
    || year === 0
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth(year, month)
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 14
    || offsetMinute > 59
    || (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }

  const millisecond = Number((fraction + "000").slice(0, 3));
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);

  const offset =
    (offsetHour * 60 + offsetMinute) * 60_000
    * (match[9] === "-" ? -1 : 1);
  const epochMs = local.getTime() - offset;
  return Number.isFinite(epochMs) ? epochMs : null;
};

const compareIdentities = (left, right) =>
  left.eventId < right.eventId
    ? -1
    : left.eventId > right.eventId
      ? 1
      : left.time < right.time
        ? -1
        : left.time > right.time
          ? 1
          : 0;

const sameStringArray = (left, right) =>
  left.length === right.length
  && left.every((value, index) => value === right[index]);

const exactKeys = (value, expected) =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && sameStringArray(Object.keys(value).sort(), [...expected].sort());

const exactJournalKeys = (state) => [
  "_id",
  "candidateCount",
  "createdAt",
  "cutoff",
  "digest",
  "identities",
  "operation",
  "schemaVersion",
  "sourceSha",
  "state",
  ...(state === "applied" ? ["appliedAt"] : []),
];

const isValidDate = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime());

const canonicalIdentities = (identities) =>
  JSON.stringify(
    [...identities]
      .sort(compareIdentities)
      .map(({ eventId, time }) => ({ eventId, time })),
  );

const identityDigest = (identities) => {
  const crypto = require("crypto");
  if (!crypto || typeof crypto.createHash !== "function") {
    throw new Error("SHA-256 support is unavailable");
  }
  return crypto
    .createHash("sha256")
    .update(canonicalIdentities(identities))
    .digest("hex");
};

const classifyBackofficeCleanupJournal = (rows) => {
  try {
    if (!Array.isArray(rows)) {
      return INVALID;
    }
    if (rows.length === 0) {
      return "absent";
    }
    if (rows.length !== 1) {
      return INVALID;
    }

    const journal = rows[0];
    if (
      !journal
      || typeof journal !== "object"
      || Array.isArray(journal)
      || !VALID_STATES.has(journal.state)
      || !exactKeys(journal, exactJournalKeys(journal.state))
      || journal._id !== CLEANUP_OPERATION_ID
      || journal.schemaVersion !== CLEANUP_SCHEMA_VERSION
      || journal.operation !== "delete-backoffice-events-before-cutoff"
      || journal.cutoff !== CLEANUP_CUTOFF
      || typeof journal.sourceSha !== "string"
      || !SOURCE_SHA_PATTERN.test(journal.sourceSha)
      || !isValidDate(journal.createdAt)
      || (journal.state === "prepared"
        ? Object.prototype.hasOwnProperty.call(journal, "appliedAt")
        : !isValidDate(journal.appliedAt)
          || journal.appliedAt.getTime() < journal.createdAt.getTime())
      || !Number.isInteger(journal.candidateCount)
      || journal.candidateCount < 0
      || !Array.isArray(journal.identities)
      || journal.identities.length !== journal.candidateCount
      || typeof journal.digest !== "string"
      || !DIGEST_PATTERN.test(journal.digest)
    ) {
      return INVALID;
    }

    const eventIds = new Set();
    for (const identity of journal.identities) {
      if (
        !exactKeys(identity, ["eventId", "time"])
        || typeof identity.eventId !== "string"
        || identity.eventId.trim().length === 0
        || typeof identity.time !== "string"
      ) {
        return INVALID;
      }
      const parsedTime = parseExplicitZoneTimestamp(identity.time);
      if (
        parsedTime === null
        || parsedTime >= CLEANUP_CUTOFF_MS
        || eventIds.has(identity.eventId)
      ) {
        return INVALID;
      }
      eventIds.add(identity.eventId);
    }

    if (
      journal.identities.some(
        (identity, index) =>
          index > 0
          && compareIdentities(journal.identities[index - 1], identity) >= 0,
      )
      || identityDigest(journal.identities) !== journal.digest
    ) {
      return INVALID;
    }

    return journal.state;
  } catch (_error) {
    return INVALID;
  }
};

if (typeof module === "object" && module && module.exports) {
  module.exports = { classifyBackofficeCleanupJournal };
}

if (typeof db !== "undefined" && typeof print === "function") {
  let result = INVALID;
  try {
    const rows = db
      .getCollection(CLEANUP_JOURNAL_COLLECTION)
      .find({ _id: CLEANUP_OPERATION_ID })
      .limit(2)
      .toArray();
    result = classifyBackofficeCleanupJournal(rows);
  } catch (_error) {
    result = INVALID;
  }
  print(result);
}
