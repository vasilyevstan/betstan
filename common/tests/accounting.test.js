const assert = require("node:assert/strict");
const test = require("node:test");
const common = require("../build");
const predecessor = require("predecessor-common");
const { assertBetAccountingEvidence: validate, fixedOddsReturnMinor: payout, nominalStakeMinor: stake } = common;

const movement = (changes = {}) => ({
  schemaVersion: 1, movementId: "ticket:1", slipId: "ticket", userId: "owner",
  revision: 1, occurredAt: "2026-01-01T00:00:00.000Z", closedStakeMinor: 400,
  returnMinor: 600, remainingStakeMinor: 600, originalStakeMinor: 1000,
  source: "CASH_BACK", placementFingerprint: "immutable-placement", ...changes,
});
const evidence = (...movements) => ({ schemaVersion: 1, status: "COMPLETE", movements });

test("nominal cents reject high precision history rather than round into eligibility", () => {
  assert.equal(stake(0.01), 1);
  assert.equal(stake(12.34), 1234);
  for (const value of [0, -1, 1.001, NaN, Infinity, 1e-7, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => stake(value));
  }
});

test("fixed odds floor once; Builder consumes one composite, not internal selections", () => {
  assert.equal(payout(1, ["1.5", "1.5"]), 2);
  assert.equal(payout(1000, ["3.75"]), 3750);
  assert.equal(payout(600, []), 600); // whole exposure void / all factors void
  assert.equal(payout(Number.MAX_SAFE_INTEGER, ["1"]), Number.MAX_SAFE_INTEGER);
  assert.throws(() => payout(Number.MAX_SAFE_INTEGER, ["1.01"]));
  for (const odds of ["1e2", "NaN", "0.9", "01", "1.50"]) assert.throws(() => payout(1, [odds]));
  assert.throws(() => payout(0.1, ["2"]));
});

test("complete prefixes recover reordered partial closure followed by terminal win/loss/void", () => {
  for (const terminalReturn of [1200, 0, 600]) {
    const first = movement();
    const last = movement({
      movementId: "ticket:2", revision: 2, source: "SETTLEMENT",
      occurredAt: "2026-01-02T00:00:00.000Z",
      closedStakeMinor: 600, returnMinor: terminalReturn, remainingStakeMinor: 0,
    });

    validate(evidence(first, last));
    const applied = new Map();
    for (const batch of [evidence(first, last), evidence(first), evidence(first, last)]) {
      validate(batch);
      for (const item of batch.movements) applied.set(item.movementId, item);
    }
    const loss = [...applied.values()].reduce((sum, item) =>
      sum + common.realisedLossMinor(item.closedStakeMinor, item.returnMinor), 0n);
    assert.equal(loss, 1000n - 600n - BigInt(terminalReturn));
    assert.equal(applied.size, 2);
  }
});

test("zero stake still bounds denominator growth and validates every odds factor", () => {
  const nearOne = `1.${"0".repeat(253)}1`;
  assert.equal(payout(0, Array(16).fill(nearOne)), 0);
  assert.throws(() => payout(0, Array(17).fill(nearOne)), /AMOUNT_UNSUPPORTED/);
  assert.throws(() => payout(0, ["1.5", "not-odds"]), /AUTHORITY_UNAVAILABLE/);
});

test("gaps, duplicate identities, repeated principal, unsafe amounts and invalid domain time fail closed", () => {
  const first = movement();
  for (const bad of [
    evidence(first, first), evidence(movement({ revision: 2 })),
    evidence(movement({ closedStakeMinor: 1000 })), evidence(movement({ returnMinor: 1.1 })),
    evidence(movement({ returnMinor: Number.MAX_SAFE_INTEGER + 1 })),
    evidence(movement({ occurredAt: "not-a-time" })), evidence(movement({ source: "ROW" })),
    evidence(movement({ source: "SETTLEMENT" })),
    evidence(first, movement({ revision: 2, movementId: "ticket:2", userId: "other" })),
  ]) assert.throws(() => validate(bad));
  validate(evidence());
  validate({ schemaVersion: 1, status: "UNAVAILABLE", reason: "HISTORY_MISSING" });
  assert.throws(() => validate(undefined));
});

test("rc.3 readers preserve legacy fields and ignore additive accounting JSON", () => {
  assert.equal(require("predecessor-common/package.json").version, "1.1.0-rc.3");
  assert.equal(predecessor.ResultingStatus.BET_WIN, common.ResultingStatus.BET_WIN);
  const old = { slipId: "ticket", result: predecessor.ResultingStatus.BET_WIN };
  const next = JSON.parse(JSON.stringify({ ...old, accounting: evidence(movement()) }));
  const oldReader = ({ slipId, result }) => ({ slipId, result });
  assert.deepEqual(oldReader(next), old);
  assert.deepEqual(oldReader(old), old);
  validate(next.accounting);
});
