import { BetKind, ModerationStatus } from "@betstan/common";
import { Bet } from "../../model/Bet";
import { createPlaceBetEvent } from "../../event/listener/__test__/helpers";
import { readLegacyOriginals } from "../../scripts/reconcileLegacyAccounting";
import { receiveRisk, terminalRisk } from "../Gateway";
import { fingerprint } from "../Policy";
import { initializeRisk, RiskBaseline, RiskMovement, RiskPosition } from "../Store";

beforeEach(async () => { process.env.RISK_CENTRE_ENABLED = "true"; await initializeRisk(); });
afterEach(() => { delete process.env.RISK_CENTRE_ENABLED; });
const event = () => createPlaceBetEvent({
  data: { betKind: BetKind.PRE_MATCH }, row: { betKind: BetKind.PRE_MATCH },
});
function packet(input: ReturnType<typeof event>, pending = false) {
  return { schemaVersion: 1, sourceSha: "a".repeat(40), sourceDigest: "b".repeat(64), positions: [],
    candidates: [{ slipId: input.data.slipId, userId: input.data.userId,
      sourceStatus: pending ? "BET_PENDING" : "BET_APPROVED", sourceFingerprint: "c".repeat(64) }] };
}

it("uses immutable financial originals read-only and assigns a tagged new identity, not guessed raw publisher data", async () => {
  const input = event();
  const stored = await Bet.create({ ...input.data, timestamp: "2020-01-01T00:00:00.000Z",
    status: ModerationStatus.APPROVED });
  const result = await readLegacyOriginals(packet(input));
  const original = result.originals[0];
  expect(original.identityOrigin).toBe("LEGACY_RECONCILIATION");
  expect(original.placementFingerprint).toBe(fingerprint({
    schemaVersion: 1, kind: "LEGACY_ACCOUNTING_BASIS", userId: input.data.userId,
    slipId: input.data.slipId, originalModerationFingerprint: original.originalModerationFingerprint,
  }));
  expect(original.placementFingerprint).not.toBe(fingerprint({ ...input.data, userName: "" }));
  expect(JSON.stringify(original.terms)).not.toMatch(/userName|eventName|productName|oddsName/);
  expect((await Bet.findById(stored._id))?.toObject()).toEqual(stored.toObject());
  expect(await RiskMovement.countDocuments()).toBe(0);
  expect(await RiskBaseline.countDocuments()).toBe(0);
  expect(await RiskPosition.countDocuments()).toBe(0);
});

it("preserves a consistent immutable receipt's original accounting fingerprint", async () => {
  const input = event();
  const receipt = await receiveRisk(input, new Date());
  await terminalRisk(input.data.slipId, { status: ModerationStatus.APPROVED,
    moderationTimestamp: new Date().toISOString(), affectedRows: [] }, new Date());
  const original = (await readLegacyOriginals(packet(input))).originals[0];
  expect(original.identityOrigin).toBe("RECORDED_PLACEMENT");
  expect(original.placementFingerprint).toBe(receipt.accountingFingerprint);
});

it("rejects missing admission, unsupported precision and pending originals without their original raw receipt", async () => {
  const input = event();
  await expect(readLegacyOriginals(packet(input))).rejects.toThrow("LEGACY_ORIGINAL_ADMISSION_UNAVAILABLE");
  const stored = await Bet.create({ ...input.data, timestamp: "2020-01-01T00:00:00.000Z",
    wager: 0.015, status: ModerationStatus.APPROVED });
  await expect(readLegacyOriginals(packet(input))).rejects.toThrow("LEGACY_ORIGINAL_MONEY_UNAVAILABLE");
  await Bet.updateOne({ _id: stored._id }, { $set: { wager: 10, status: ModerationStatus.RECEIVED } });
  await expect(readLegacyOriginals(packet(input, true))).rejects.toThrow("LEGACY_RECORDED_RECEIPT_MISSING");
});

it.each([
  { field: "id", value: null, code: "LEGACY_ORIGINAL_ROW_ID_INVALID" },
  { field: "eventId", value: 123, code: "LEGACY_ORIGINAL_ROW_EVENT_ID_INVALID" },
  { field: "productId", value: "", code: "LEGACY_ORIGINAL_ROW_PRODUCT_ID_INVALID" },
  { field: "oddsId", value: { privateValue: "PRIVATE_ORIGINAL_ROW" }, code: "LEGACY_ORIGINAL_ROW_ODDS_ID_INVALID" },
  { field: "oddsValue", value: "2", code: "LEGACY_ORIGINAL_ROW_ODDS_VALUE_INVALID" },
  { field: "betKind", value: "UNKNOWN", code: "LEGACY_ORIGINAL_ROW_BET_KIND_INVALID" },
])("identifies invalid legacy $field without exposing or modifying its stored value", async ({ field, value, code }) => {
  const input = event();
  const stored = await Bet.create({ ...input.data, timestamp: "2020-01-01T00:00:00.000Z",
    status: ModerationStatus.APPROVED });
  await Bet.collection.updateOne({ _id: stored._id }, { $set: { [`rows.0.${field}`]: value } });
  const before = await Bet.findById(stored._id).lean();
  await expect(readLegacyOriginals(packet(input))).rejects.toThrow(new Error(code));
  expect(await Bet.findById(stored._id).lean()).toEqual(before);
  expect(await RiskMovement.countDocuments()).toBe(0);
  expect(await RiskBaseline.countDocuments()).toBe(0);
  expect(await RiskPosition.countDocuments()).toBe(0);
});

it("refuses existing receiver accounting instead of replacing its reserve or past movements", async () => {
  const input = event();
  await Bet.create({ ...input.data, timestamp: "2020-01-01T00:00:00.000Z", status: ModerationStatus.APPROVED });
  await RiskMovement.collection.insertOne({ slipId: input.data.slipId });
  await expect(readLegacyOriginals(packet(input))).rejects.toThrow("LEGACY_EXISTING_RECEIVER_ACCOUNTING");
  expect(await RiskMovement.countDocuments()).toBe(1);
});
