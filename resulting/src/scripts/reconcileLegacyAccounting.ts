import mongoose, { ClientSession } from "mongoose";
import { BetKind } from "@betstan/common";
import { Bet, BetArchive } from "../model/Bet";
import { CashBackOperation } from "../model/CashBackOperation";
import { AccountingMovement } from "../service/accountingHistory";
import { AccountingSnapshotPosition, positionFor } from "../service/accountingSnapshot";
import { AccountingPlacementTerms, accountingPlacementBasis } from "../service/betAccounting";
import { cashBackHash } from "../service/cashBackIdentity";
import { canonicalOdds } from "../service/cashBackPricing";
import { verifyAccountingSnapshotFence } from "../service/accountingSnapshotFence";

const MAX_ITEMS = 10000, MAX_BYTES = 16 * 1024 * 1024, PAGE_BYTES = 512 * 1024;
type Raw = Record<string, unknown>;
type SourceRecord = Raw & { _id: mongoose.Types.ObjectId; __v?: number };
type Terms = AccountingPlacementTerms;
interface Candidate {
  slipId: string; userId: string; sourceStatus: string; sourceFingerprint: string;
  sourceRowIds: string[];
}
interface Packet {
  schemaVersion: 1; sourceSha: string; sourceDigest: string;
  candidates: Candidate[]; positions: AccountingSnapshotPosition[];
}
interface Original extends Candidate {
  terms: Terms; placementFingerprint: string; originalModerationFingerprint: string;
  identityOrigin: "RECORDED_PLACEMENT" | "LEGACY_RECONCILIATION";
  rowIdentityOrigin: "MODERATION_ROW_IDS" | "SOURCE_PLACEMENT_ROW_IDS";
}
interface Plan extends Packet { originals: Original[]; planHash: string }
class LegacyAccountingError extends Error {}
function requireProof(value: unknown, code: string): asserts value {
  if (!value) throw new LegacyAccountingError(code);
}
const object = (value: unknown): value is Raw => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const validRowIds = (value: unknown): value is string[] => Array.isArray(value)
  && value.length > 0 && value.length <= MAX_ITEMS && value.every(text) && new Set(value).size === value.length;
const missing = (value: unknown) => value === undefined || value === null;
function bounded(value: unknown, maximum = MAX_BYTES): void {
  requireProof(Buffer.byteLength(JSON.stringify(value) ?? "") <= maximum, "LEGACY_ACCOUNTING_BYTE_BUDGET");
}
function sourceFingerprint(record: Raw): string {
  const economic: Raw = JSON.parse(JSON.stringify({ ...record, __v: record.__v ?? 0 }));
  delete economic._id;
  delete economic.cashBackArchiving;
  bounded(economic, PAGE_BYTES);
  return cashBackHash(economic);
}
function economicTerms(value: { wager: unknown; betKind?: unknown; rows: unknown }): string {
  requireProof(typeof value.wager === "number" && Array.isArray(value.rows), "LEGACY_ORIGINAL_TERMS_INVALID");
  const fields = ["id", "eventId", "productId", "oddsId", "marketId", "marketType", "marketVersion",
    "quoteVersion", "selectionId", "side", "selectedAt", "quoteValidUntil", "marketBet"] as const;
  const rows = value.rows.map((row: unknown) => {
    requireProof(object(row) && typeof row.oddsValue === "number", "LEGACY_ORIGINAL_ROW_INVALID");
    return {
      ...Object.fromEntries(fields.map(field => [field, row[field] ?? null])),
      betKind: row.betKind ?? value.betKind ?? BetKind.PRE_MATCH,
      odds: canonicalOdds(row.oddsValue),
    };
  }).sort((a, b) => cashBackHash(a).localeCompare(cashBackHash(b)));
  return cashBackHash({ wager: value.wager, betKind: value.betKind ?? BetKind.PRE_MATCH, rows });
}
async function noPriorClosures(record: Raw, session?: ClientSession): Promise<void> {
  const absent = ["accounting", "accountingBasis", "accountingScope", "accountingPayoutBound",
    "accountingRevision", "accountingCumulativeReturnMinor", "accountingLastMovement",
    "cashBackFinancial", "cashBackOriginalManifest", "cashBackPending"];
  requireProof(absent.every(field => missing(record[field]))
    && (missing(record.accountingPrefixTruncated) || record.accountingPrefixTruncated === false)
    && (missing(record.cashBackArchiving) || record.cashBackArchiving === false)
    && (missing(record.accountingRemovedVoidRowIds)
      || (Array.isArray(record.accountingRemovedVoidRowIds) && record.accountingRemovedVoidRowIds.length === 0))
    && (missing(record.resultingTimestamp) || record.resultingTimestamp === "")
    && (missing(record.terminalPublicationState) || record.terminalPublicationState === ""),
  "LEGACY_EXISTING_FINANCIAL_AUTHORITY");
  requireProof(!await AccountingMovement.exists({ slipId: record.slipId }).session(session ?? null),
    "LEGACY_RETAINED_MOVEMENT_EXISTS");
  const operations = await CashBackOperation.find({ "operation.slipId": record.slipId })
    .limit(MAX_ITEMS + 1).session(session ?? null).lean<Raw[]>();
  requireProof(operations.length <= MAX_ITEMS, "LEGACY_CASH_BACK_HISTORY_BUDGET");
  bounded(operations);
  for (const operation of operations) {
    requireProof(missing(operation.outcome) || object(operation.outcome), "LEGACY_CASH_BACK_HISTORY_INVALID");
    const outcome = object(operation.outcome) ? operation.outcome : undefined;
    requireProof(missing(outcome?.receipt) || object(outcome?.receipt), "LEGACY_CASH_BACK_HISTORY_INVALID");
    const receipt = outcome && object(outcome.receipt) ? outcome.receipt : undefined;
    requireProof(missing(receipt?.financial) || object(receipt?.financial), "LEGACY_CASH_BACK_HISTORY_INVALID");
    const financial = receipt && object(receipt.financial) ? receipt.financial : undefined;
    const rejected = operation.stage === "TERMINAL"
      && outcome?.outcome === "REJECTED" && receipt?.outcome === "REJECTED";
    const consistent = outcome === undefined
      || (operation.stage === "QUOTED" && outcome.outcome === "QUOTED" && receipt === undefined)
      || (operation.stage === "UNAVAILABLE" && outcome.outcome === "UNAVAILABLE" && receipt === undefined)
      || rejected;
    requireProof(consistent
      && (missing(operation.confirmRequested) || typeof operation.confirmRequested === "boolean")
      && (rejected || ["SNAPSHOTS", "QUOTED", "UNAVAILABLE"].includes(String(operation.stage)))
      && (!operation.confirmRequested || rejected)
      && (receipt === undefined || receipt.outcome === "REJECTED")
      && missing(outcome?.accounting)
      && (financial === undefined || (financial.cumulativeClosedStakeMinor === 0 && financial.cumulativeReturnMinor === 0)),
    "LEGACY_CASH_BACK_AUTHORITY_UNAVAILABLE");
  }
}
async function collect(sourceSha: string, session?: ClientSession) {
  requireProof(/^[0-9a-f]{40}$/.test(sourceSha), "LEGACY_SOURCE_IDENTITY_INVALID");
  const copies = new Map<string, Array<{ model: typeof Bet; record: SourceRecord }>>();
  let bytes = 0;
  for (const model of [Bet, BetArchive]) {
    const records = await model.find({}).sort({ slipId: 1, _id: 1 }).limit(MAX_ITEMS + 1)
      .session(session ?? null).lean<SourceRecord[]>();
    requireProof(records.length <= MAX_ITEMS, "LEGACY_SOURCE_POSITION_BUDGET");
    for (const record of records) {
      requireProof(text(record.slipId) && text(record.userId), "LEGACY_SOURCE_OWNER_INVALID");
      bytes += Buffer.byteLength(JSON.stringify(record));
      requireProof(bytes <= MAX_BYTES, "LEGACY_SOURCE_BYTE_BUDGET");
      const group = copies.get(record.slipId) ?? [];
      requireProof(!group.some(copy => copy.model === model), "LEGACY_DUPLICATE_SOURCE_IDENTITY");
      group.push({ model, record });
      copies.set(record.slipId, group);
    }
  }
  requireProof(copies.size <= MAX_ITEMS, "LEGACY_SOURCE_POSITION_BUDGET");
  const candidates: Candidate[] = [], positions: AccountingSnapshotPosition[] = [], digest: unknown[] = [];
  for (const [slipId, group] of [...copies].sort(([a], [b]) => a.localeCompare(b))) {
    const record = group[0].record, fingerprint = sourceFingerprint(record);
    requireProof(group.every(copy => sourceFingerprint(copy.record) === fingerprint), "LEGACY_SOURCE_COPY_CONFLICT");
    const position = positionFor(record).data;
    positions.push(position);
    digest.push([slipId, fingerprint, group.length]);
    if (position.openExposure !== "UNAVAILABLE") continue;
    for (const copy of group) await noPriorClosures(copy.record, session);
    requireProof(Array.isArray(record.rows), "LEGACY_ORIGINAL_SOURCE_CONFLICT");
    const sourceRowIds = record.rows.map(row => object(row) ? row.id : undefined);
    requireProof(validRowIds(sourceRowIds), "LEGACY_ORIGINAL_SOURCE_CONFLICT");
    candidates.push({ slipId, userId: position.userId, sourceStatus: position.sourceStatus,
      sourceFingerprint: fingerprint, sourceRowIds });
  }
  const packet: Packet = { schemaVersion: 1, sourceSha, sourceDigest: cashBackHash(digest), candidates, positions };
  bounded(packet);
  return { packet, copies };
}
function assertPacket(value: unknown): asserts value is Packet {
  bounded(value);
  const packet = value as Packet;
  requireProof(packet?.schemaVersion === 1 && /^[0-9a-f]{40}$/.test(packet.sourceSha)
    && hash(packet.sourceDigest) && Array.isArray(packet.candidates) && Array.isArray(packet.positions)
    && packet.candidates.length <= MAX_ITEMS && packet.positions.length <= MAX_ITEMS
    && new Set(packet.candidates.map(item => item?.slipId)).size === packet.candidates.length
    && packet.candidates.every(item => item && text(item.slipId) && text(item.userId)
      && hash(item.sourceFingerprint) && validRowIds(item.sourceRowIds)
      && ["BET_PENDING", "BET_APPROVED"].includes(item.sourceStatus)),
  "LEGACY_PACKET_INVALID");
}
function assertOriginals(value: unknown): asserts value is Original[] {
  bounded(value);
  requireProof(Array.isArray(value) && value.length <= MAX_ITEMS
    && value.every(item => object(item) && text(item.slipId) && text(item.userId) && hash(item.sourceFingerprint)
      && validRowIds(item.sourceRowIds)
      && hash(item.placementFingerprint) && hash(item.originalModerationFingerprint)
      && ["RECORDED_PLACEMENT", "LEGACY_RECONCILIATION"].includes(String(item.identityOrigin))
      && ["MODERATION_ROW_IDS", "SOURCE_PLACEMENT_ROW_IDS"].includes(String(item.rowIdentityOrigin))
      && object(item.terms) && typeof item.terms.wager === "number" && Array.isArray(item.terms.rows)),
  "LEGACY_ORIGINAL_PROOF_INVALID");
}
function fieldsFor(record: Raw, original: Original) {
  requireProof(record.userId === original.userId && record.slipId === original.slipId
    && record.status === original.sourceStatus && sourceFingerprint(record) === original.sourceFingerprint
    && record.wager === original.terms.wager
    && economicTerms({ wager: record.wager, betKind: record.betKind, rows: record.rows }) === economicTerms(original.terms),
  "LEGACY_ORIGINAL_SOURCE_CONFLICT");
  requireProof(original.rowIdentityOrigin !== "SOURCE_PLACEMENT_ROW_IDS"
    || original.identityOrigin === "LEGACY_RECONCILIATION", "LEGACY_RECONCILIATION_IDENTITY_INVALID");
  if (original.identityOrigin === "LEGACY_RECONCILIATION") {
    // This is a new accounting identity, never a recovered raw-message hash.
    requireProof(original.placementFingerprint === cashBackHash({
      schemaVersion: 1, kind: "LEGACY_ACCOUNTING_BASIS", userId: original.userId,
      slipId: original.slipId, originalModerationFingerprint: original.originalModerationFingerprint,
    }), "LEGACY_RECONCILIATION_IDENTITY_INVALID");
  }
  const fields = accountingPlacementBasis(original.terms, original.placementFingerprint);
  requireProof(fields.accountingBasis.originalStakeMinor > 0 && fields.accountingScope,
    "LEGACY_ORIGINAL_FINANCIAL_TERMS_UNAVAILABLE");
  return { ...fields, accounting: { schemaVersion: 1, status: "COMPLETE", movements: [] } };
}
function planFor(packet: Packet, copies: Awaited<ReturnType<typeof collect>>["copies"], originals: Original[]): Plan {
  requireProof(originals.length === packet.candidates.length
    && new Set(originals.map(item => item.slipId)).size === originals.length
    && originals.every(original => packet.candidates.some(candidate => cashBackHash(candidate) === cashBackHash({
      slipId: original.slipId, userId: original.userId, sourceStatus: original.sourceStatus,
      sourceFingerprint: original.sourceFingerprint, sourceRowIds: original.sourceRowIds,
    }))), "LEGACY_ORIGINAL_COVERAGE_INVALID");
  const positions = packet.positions.map(position => {
    const original = originals.find(item => item.slipId === position.slipId);
    if (!original) return position;
    const record = copies.get(position.slipId)![0].record;
    const prospective = positionFor({ ...record, ...fieldsFor(record, original) }).data;
    requireProof(prospective.openExposure === "COMPLETE", "LEGACY_PROSPECTIVE_EXPOSURE_UNAVAILABLE");
    return prospective;
  });
  const payload = { ...packet, positions, originals };
  bounded(payload);
  return { ...payload, planHash: cashBackHash(payload) };
}
export async function prepareLegacyAccounting(sourceSha: string): Promise<Packet> {
  return (await collect(sourceSha)).packet;
}
export async function planLegacyAccounting(value: unknown): Promise<Plan> {
  assertPacket(value);
  const input = value as Packet & { originals: unknown };
  assertOriginals(input.originals);
  const fresh = await collect(input.sourceSha);
  requireProof(fresh.packet.sourceDigest === input.sourceDigest
    && cashBackHash(fresh.packet.candidates) === cashBackHash(input.candidates), "LEGACY_SOURCE_CHANGED");
  return planFor(fresh.packet, fresh.copies, input.originals);
}
export async function applyLegacyAccounting(value: unknown) {
  assertPacket(value);
  const input = value as Plan;
  assertOriginals(input.originals);
  requireProof(hash(input.planHash) && process.env.GITHUB_ACTIONS === "true"
    && process.env.PHASE === "reconcile-risk-accounting"
    && process.env.OPERATION_ID === "live-data-reconcile-risk-accounting"
    && process.env.SOURCE_SHA === input.sourceSha, "LEGACY_PROTECTED_WRITE_AUTHORITY_REQUIRED");
  const before = await verifyAccountingSnapshotFence();
  const session = await mongoose.startSession();
  let documents = 0;
  try {
    await session.withTransaction(async () => {
      documents = 0;
      const fresh = await collect(input.sourceSha, session);
      requireProof(fresh.packet.sourceDigest === input.sourceDigest, "LEGACY_SOURCE_CHANGED");
      const expected = planFor(fresh.packet, fresh.copies, input.originals);
      requireProof(expected.planHash === input.planHash, "LEGACY_PLAN_CHANGED");
      for (const original of input.originals) {
        for (const copy of fresh.copies.get(original.slipId)!) {
          const fields = fieldsFor(copy.record, original);
          const result = await copy.model.updateOne({
            _id: copy.record._id,
            __v: copy.record.__v === undefined ? { $exists: false } : copy.record.__v,
          }, { $set: {
            ...fields,
            accountingBasis: { ...fields.accountingBasis, legacyReconciliation: {
              schemaVersion: 1, sourceSha: input.sourceSha, planHash: input.planHash,
              identityOrigin: original.identityOrigin, rowIdentityOrigin: original.rowIdentityOrigin,
              sourceFingerprint: original.sourceFingerprint,
              originalModerationFingerprint: original.originalModerationFingerprint,
            } },
          }, $inc: { __v: 1 } }, { session });
          requireProof(result.matchedCount === 1 && result.modifiedCount === 1, "LEGACY_SOURCE_WRITE_CONFLICT");
          documents++;
        }
      }
      requireProof((await verifyAccountingSnapshotFence()).identityHash === before.identityHash,
        "LEGACY_FENCE_CHANGED");
    });
  } finally { await session.endSession(); }
  requireProof((await verifyAccountingSnapshotFence()).identityHash === before.identityHash, "LEGACY_FENCE_CHANGED");
  return { schemaVersion: 1, sourceSha: input.sourceSha, planHash: input.planHash,
    applied: true, positions: input.originals.length, documents };
}
async function readInput(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    requireProof(bytes <= MAX_BYTES, "LEGACY_ACCOUNTING_BYTE_BUDGET");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function runLegacyAccountingCli(args = process.argv.slice(2)): Promise<void> {
  requireProof(args.length === 1 && ["prepare", "plan", "apply"].includes(args[0])
    && process.env.MONGO_URI && process.env.SOURCE_SHA, "LEGACY_COMMAND_INVALID");
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    const result = args[0] === "prepare" ? await prepareLegacyAccounting(process.env.SOURCE_SHA)
      : args[0] === "plan" ? await planLegacyAccounting(await readInput()) : await applyLegacyAccounting(await readInput());
    bounded(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) {
  void runLegacyAccountingCli().catch(error => {
    console.error(error instanceof LegacyAccountingError ? error.message : "LEGACY_ACCOUNTING_COMMAND_FAILED");
    process.exitCode = 1;
  });
}
