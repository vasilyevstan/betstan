import { BetKind, ModerationStatus } from "@betstan/common";
import mongoose from "mongoose";
import { Bet } from "../../model/Bet";
import { createPlaceBetEvent } from "../../event/listener/__test__/helpers";
import { readLegacyOriginals } from "../../scripts/reconcileLegacyAccounting";
import { placementFingerprint, receiveRisk, terminalRisk } from "../Gateway";
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
      sourceStatus: pending ? "BET_PENDING" : "BET_APPROVED", sourceFingerprint: "c".repeat(64),
      sourceRowIds: input.data.rows.map(row => row.id) }] };
}

async function historicalOriginal(input: ReturnType<typeof event>) {
  const rows = input.data.rows.map(row => ({
    _id: new mongoose.Types.ObjectId(),
    eventId: row.eventId, eventName: row.eventName, productId: row.productId, productName: row.productName,
    oddsId: row.oddsId, oddsName: row.oddsName, oddsValue: row.oddsValue, timestamp: row.timestamp,
  }));
  const stored = { userId: input.data.userId, slipId: input.data.slipId, wager: input.data.wager,
    status: ModerationStatus.APPROVED, timestamp: "2020-01-01T00:00:00.000Z", rows, __v: 0 };
  const inserted = await Bet.collection.insertOne(stored);
  return { ...stored, _id: inserted.insertedId };
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

it("binds existing Source IDs to unique predecessor financial rows without substituting native IDs or changing originals", async () => {
  const input = event();
  input.data.rows.push({ ...input.data.rows[0], id: "second-row", eventId: "second-event", oddsValue: 3 });
  const stored = await historicalOriginal(input);
  const before = await Bet.findById(stored._id).lean();
  const original = (await readLegacyOriginals(packet(input))).originals[0];
  expect(original).toMatchObject({
    rowIdentityOrigin: "SOURCE_PLACEMENT_ROW_IDS", identityOrigin: "LEGACY_RECONCILIATION",
    originalModerationFingerprint: placementFingerprint(before),
  });
  expect(original.terms.rows.map(row => row.id)).toEqual(input.data.rows.map(row => row.id));
  expect(original.terms.rows.map(row => row.id)).not.toEqual(stored.rows.map(row => row._id.toHexString()));
  expect(original.terms.rows.map(row => row.oddsValue)).toEqual([input.data.rows[0].oddsValue, 3]);
  expect(await Bet.findById(stored._id).lean()).toEqual(before);
  expect(await RiskPosition.countDocuments()).toBe(0);
  expect(await RiskMovement.countDocuments()).toBe(0);
  expect(await RiskBaseline.countDocuments()).toBe(0);
});

it.each(["ambiguous", "duplicate-native-id", "mixed-explicit-id"])(
  "refuses %s predecessor row binding without changing the original",
  async mode => {
    const input = event();
    input.data.rows.push({ ...input.data.rows[0], id: "second-row",
      eventId: mode === "ambiguous" ? input.data.rows[0].eventId : "second-event" });
    const stored = await historicalOriginal(input);
    if (mode === "duplicate-native-id") {
      await Bet.collection.updateOne({ _id: stored._id }, { $set: { "rows.1._id": stored.rows[0]._id } });
    } else if (mode === "mixed-explicit-id") {
      await Bet.collection.updateOne({ _id: stored._id }, { $set: { "rows.0.id": input.data.rows[0].id } });
    }
    const before = await Bet.findById(stored._id).lean();
    await expect(readLegacyOriginals(packet(input))).rejects.toThrow(mode === "mixed-explicit-id"
      ? "LEGACY_ORIGINAL_ROW_ID_INVALID" : "LEGACY_ORIGINAL_ROW_CONFLICT");
    expect(await Bet.findById(stored._id).lean()).toEqual(before);
    expect(await RiskMovement.countDocuments()).toBe(0);
    expect(await RiskBaseline.countDocuments()).toBe(0);
  },
);

it.each(["pending", "receipt", "quote", "invalid-native-id"])(
  "does not use Source bindings for an ineligible %s predecessor",
  async mode => {
    const input = event();
    const stored = await historicalOriginal(input);
    if (mode === "pending") {
      await Bet.collection.updateOne({ _id: stored._id }, { $set: { status: ModerationStatus.RECEIVED } });
    } else if (mode === "receipt") {
      await mongoose.connection.db.collection<{ _id: string }>(RiskPosition.collection.collectionName)
        .insertOne({ _id: input.data.slipId });
    } else {
      await Bet.collection.updateOne({ _id: stored._id }, { $set: mode === "quote"
        ? { "rows.0.marketId": "quoted-market" } : { "rows.0._id": new mongoose.Types.ObjectId().toHexString() } });
    }
    const before = await Bet.findById(stored._id).lean();
    await expect(readLegacyOriginals(packet(input, mode === "pending"))).rejects.toThrow("LEGACY_ORIGINAL_ROW_ID_INVALID");
    expect(await Bet.findById(stored._id).lean()).toEqual(before);
    expect(await RiskMovement.countDocuments()).toBe(0);
    expect(await RiskBaseline.countDocuments()).toBe(0);
  },
);
