import mongoose from "mongoose";
import { BetKind, IPlaceBetEvent, ModerationStatus } from "@betstan/common";
import { Bet } from "../model/Bet";
import { placementFingerprint } from "../risk/Gateway";
import { facts, money } from "../risk/Evaluation";
import { fingerprint, RiskError } from "../risk/Policy";
import { SnapshotPosition } from "../risk/SnapshotContract";
import { verifySnapshotIntake } from "../risk/SnapshotImport";
import { RiskAccountingInbox, RiskBaseline, RiskMovement, RiskPosition } from "../risk/Store";

const MAX_ITEMS = 10000, MAX_BYTES = 16 * 1024 * 1024;
type Raw = Record<string, unknown>;
type Terms = Pick<IPlaceBetEvent["data"], "wager" | "betKind"> & {
  rows: Pick<IPlaceBetEvent["data"]["rows"][number],
    "id" | "eventId" | "productId" | "oddsId" | "oddsValue" | "betKind"
    | "marketId" | "marketType" | "marketVersion" | "quoteVersion" | "selectionId"
    | "side" | "selectedAt" | "quoteValidUntil" | "marketBet">[];
};
interface Candidate {
  slipId: string; userId: string; sourceStatus: string; sourceFingerprint: string;
}
interface Packet {
  schemaVersion: 1; sourceSha: string; sourceDigest: string;
  candidates: Candidate[]; positions: SnapshotPosition[];
}
interface Original extends Candidate {
  terms: Terms; placementFingerprint: string; originalModerationFingerprint: string;
  identityOrigin: "RECORDED_PLACEMENT" | "LEGACY_RECONCILIATION";
}
interface Plan extends Packet { originals: Original[]; planHash: string }
class LegacyAccountingError extends Error {}
function requireProof(value: unknown, code: string): asserts value {
  if (!value) throw new LegacyAccountingError(code);
}
const object = (value: unknown): value is Raw => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const hash = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
function bounded(value: unknown): void {
  requireProof(Buffer.byteLength(JSON.stringify(value) ?? "") <= MAX_BYTES, "LEGACY_ACCOUNTING_BYTE_BUDGET");
}
function assertPacket(value: unknown): asserts value is Packet {
  bounded(value);
  const packet = value as Packet;
  requireProof(packet?.schemaVersion === 1 && /^[0-9a-f]{40}$/.test(packet.sourceSha)
    && hash(packet.sourceDigest) && Array.isArray(packet.candidates) && Array.isArray(packet.positions)
    && packet.candidates.length <= MAX_ITEMS && packet.positions.length <= MAX_ITEMS
    && new Set(packet.candidates.map(item => item?.slipId)).size === packet.candidates.length
    && new Set(packet.positions.map(item => item?.slipId)).size === packet.positions.length
    && packet.candidates.every(item => item && text(item.slipId) && text(item.userId)
      && hash(item.sourceFingerprint) && ["BET_PENDING", "BET_APPROVED"].includes(item.sourceStatus)),
  "LEGACY_PACKET_INVALID");
}
function originalTerms(stored: Raw): Terms {
  requireProof(typeof stored.wager === "number" && Array.isArray(stored.rows)
    && stored.rows.length > 0 && stored.rows.length <= MAX_ITEMS
    && (stored.betKind == null || stored.betKind === BetKind.PRE_MATCH || stored.betKind === BetKind.LIVE),
  "LEGACY_ORIGINAL_TERMS_INVALID");
  const betKind = stored.betKind ?? BetKind.PRE_MATCH;
  const fields = ["id", "eventId", "productId", "oddsId", "oddsValue", "marketId", "marketType",
    "marketVersion", "quoteVersion", "selectionId", "side", "selectedAt", "quoteValidUntil", "marketBet"] as const;
  const rows = stored.rows.map((row: unknown) => {
    requireProof(object(row), "LEGACY_ORIGINAL_ROW_INVALID");
    for (const [field, code] of [
      ["id", "LEGACY_ORIGINAL_ROW_ID_INVALID"],
      ["eventId", "LEGACY_ORIGINAL_ROW_EVENT_ID_INVALID"],
      ["productId", "LEGACY_ORIGINAL_ROW_PRODUCT_ID_INVALID"],
      ["oddsId", "LEGACY_ORIGINAL_ROW_ODDS_ID_INVALID"],
    ] as const) requireProof(text(row[field]), code);
    requireProof(typeof row.oddsValue === "number", "LEGACY_ORIGINAL_ROW_ODDS_VALUE_INVALID");
    requireProof(row.betKind == null || row.betKind === BetKind.PRE_MATCH || row.betKind === BetKind.LIVE,
      "LEGACY_ORIGINAL_ROW_BET_KIND_INVALID");
    return {
      ...Object.fromEntries(fields.filter(field => row[field] != null).map(field => [field, row[field]])),
      id: row.id,
      betKind: row.betKind ?? betKind,
    };
  });
  requireProof(new Set(rows.map(row => row.id)).size === rows.length, "LEGACY_ORIGINAL_ROW_CONFLICT");
  // Names and publisher metadata are not financial terms or reconstructed data.
  const terms = { wager: stored.wager, betKind, rows } as Terms;
  const amount = money(terms);
  requireProof(amount.moneyReady && amount.stakeMinor !== undefined && amount.stakeMinor > 0,
    "LEGACY_ORIGINAL_MONEY_UNAVAILABLE");
  return terms;
}
export async function readLegacyOriginals(value: unknown): Promise<Packet & { originals: Original[] }> {
  assertPacket(value);
  const originals: Original[] = [];
  for (const candidate of value.candidates) {
    const stored = await Bet.findOne({ slipId: candidate.slipId }).lean<Raw>();
    const status = candidate.sourceStatus === "BET_APPROVED" ? ModerationStatus.APPROVED : ModerationStatus.RECEIVED;
    requireProof(stored && stored.userId === candidate.userId && stored.status === status,
      "LEGACY_ORIGINAL_ADMISSION_UNAVAILABLE");
    const terms = originalTerms(stored), amount = money(terms);
    requireProof(!await RiskMovement.exists({ slipId: candidate.slipId })
      && !await RiskAccountingInbox.exists({ slipId: candidate.slipId })
      && !await RiskBaseline.exists({ _id: candidate.slipId }), "LEGACY_EXISTING_RECEIVER_ACCOUNTING");
    const receipt = await RiskPosition.findById(candidate.slipId).lean<Raw>();
    let identityOrigin: Original["identityOrigin"], accountingFingerprint: string;
    const originalModerationFingerprint = placementFingerprint(stored);
    if (receipt) {
      requireProof(hash(receipt.accountingFingerprint) && stored.placementFingerprint === receipt.accountingFingerprint
        && receipt.userId === candidate.userId && receipt.moneyReady === true
        && receipt.accountingRevision === 0 && receipt.stakeMinor === amount.stakeMinor
        && receipt.remainingStakeMinor === amount.stakeMinor && receipt.returnMinor === amount.returnMinor
        && receipt.state === (status === ModerationStatus.APPROVED ? "ACCEPTED" : "PENDING")
        && fingerprint(receipt.facts) === fingerprint(facts(terms))
        && receipt.fingerprint === originalModerationFingerprint,
      "LEGACY_RECEIPT_CONFLICT");
      identityOrigin = "RECORDED_PLACEMENT";
      accountingFingerprint = receipt.accountingFingerprint;
    } else {
      requireProof(stored.placementFingerprint == null && status === ModerationStatus.APPROVED,
        "LEGACY_RECORDED_RECEIPT_MISSING");
      identityOrigin = "LEGACY_RECONCILIATION";
      accountingFingerprint = fingerprint({
        schemaVersion: 1, kind: "LEGACY_ACCOUNTING_BASIS", userId: candidate.userId,
        slipId: candidate.slipId, originalModerationFingerprint,
      });
    }
    originals.push({ ...candidate, terms, placementFingerprint: accountingFingerprint,
      originalModerationFingerprint, identityOrigin });
  }
  const result = { ...value, originals };
  bounded(result);
  return result;
}
export async function preflightLegacyIntake(value: unknown) {
  assertPacket(value);
  const plan = value as Plan;
  requireProof(hash(plan.planHash) && Array.isArray(plan.originals)
    && fingerprint(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== "planHash"))) === plan.planHash,
  "LEGACY_PLAN_INVALID");
  const current = await readLegacyOriginals(plan);
  requireProof(fingerprint(current.originals) === fingerprint(plan.originals), "LEGACY_ORIGINAL_PROOF_CHANGED");
  const positions = new Map(plan.positions.map(position => [position.slipId, position]));
  await verifySnapshotIntake(positions);
  return { schemaVersion: 1, sourceSha: plan.sourceSha, planHash: plan.planHash, intakeVerified: true };
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
  requireProof(args.length === 1 && ["originals", "preflight"].includes(args[0]) && process.env.MONGO_URI,
    "LEGACY_COMMAND_INVALID");
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false });
    const result = args[0] === "originals" ? await readLegacyOriginals(await readInput()) : await preflightLegacyIntake(await readInput());
    bounded(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) {
  void runLegacyAccountingCli().catch(error => {
    console.error(error instanceof LegacyAccountingError ? error.message
      : error instanceof RiskError && error.code === "SNAPSHOT_INVALID"
        ? "LEGACY_RECEIVER_INTAKE_CONFLICT" : "LEGACY_ACCOUNTING_COMMAND_FAILED");
    process.exitCode = 1;
  });
}
