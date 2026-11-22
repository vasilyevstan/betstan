"use strict";
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { reconcile, localMongo, assertPublicReadiness, forward, stopChildren } = require("../scripts/risk-accounting-reconciliation-stan");

function fixture({ unavailable = false, pageAck = true, finalized = true } = {}) {
  const calls = [];
  const snapshotId = "risk_123_1";
  const hash = "a".repeat(64);
  const manifestHash = "b".repeat(64);
  const manifest = {
    schemaVersion: 1, source: "RESULTING", status: "COMPLETE", snapshotId,
    sourceDigest: "c".repeat(64), lastPageHash: hash, positions: 1, movements: 0, pageCount: 1,
    cutAt: "2026-11-22T12:00:00.000Z",
    coverage: { openPositions: unavailable ? "UNAVAILABLE" : "COMPLETE",
      unavailableOpenPositions: unavailable ? 1 : 0, unavailableHistories: 1,
      realisedCompleteSince: "2026-11-22T12:00:00.001Z" },
  };
  const page = { schemaVersion: 1, snapshotId, page: 1, previousHash: "d".repeat(64),
    hash, entries: [{ kind: "POSITION", userId: "PRIVATE_OWNER", slipId: "PRIVATE_TICKET" }] };
  let acknowledged = false;
  const source = async (args) => {
    calls.push(`source:${args[0]}`);
    if (args[0] === "snapshot") return manifest;
    if (args[0] === "snapshot-read") return acknowledged ? null : page;
    if (args[0] === "snapshot-ack") {
      assert.deepEqual(args.slice(1), [snapshotId, "1", hash]);
      acknowledged = true;
      return { snapshotId, acknowledgedPage: 1 };
    }
    assert.deepEqual(args, ["snapshot-complete", snapshotId, manifestHash]);
    return { status: "SOURCE_HANDOFF_COMPLETE", snapshotId, manifestHash, pageCount: 1, lastPageHash: hash };
  };
  const receiver = async (stage) => {
    calls.push(`receiver:${stage}`);
    if (stage === "manifest") return { snapshotId, manifestHash };
    if (stage === "page") return { snapshotId, page: 1, hash: pageAck ? hash : "e".repeat(64) };
    return { snapshotId, manifestHash, finalized };
  };
  return { source, receiver, snapshotId, calls, manifest, page };
}

test("persists each receiver page before source ACK and finalizes only the exact complete handoff", async () => {
  const value = fixture();
  const result = await reconcile(value.source, value.receiver, value.snapshotId);
  assert.deepEqual(value.calls, [
    "source:snapshot", "receiver:manifest", "source:snapshot-read", "receiver:page",
    "source:snapshot-ack", "source:snapshot-read", "source:snapshot-complete", "receiver:complete",
  ]);
  assert.equal(result.receiverFinalized, true);
  assert.equal(result.unavailableHistories, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_OWNER|PRIVATE_TICKET/);
});

test("unavailable source open positions never start receiver import", async () => {
  const value = fixture({ unavailable: true });
  await assert.rejects(reconcile(value.source, value.receiver, value.snapshotId), /SOURCE_OPEN_POSITIONS_UNAVAILABLE/);
  assert.deepEqual(value.calls, ["source:snapshot"]);
});

test("a changed receiver page acknowledgement never advances the source cursor", async () => {
  const value = fixture({ pageAck: false });
  await assert.rejects(reconcile(value.source, value.receiver, value.snapshotId), /RECEIVER_PAGE_ACK_INVALID/);
  assert.equal(value.calls.some((call) => call === "source:snapshot-ack" || call === "receiver:complete"), false);
});

test("oversized or unordered private pages are rejected before receiver application", async () => {
  for (const change of [
    (page) => { page.page = 2; },
    (page) => { page.entries[0].privateValue = "x".repeat(512 * 1024); },
  ]) {
    const value = fixture();
    change(value.page);
    await assert.rejects(reconcile(value.source, value.receiver, value.snapshotId), /SOURCE_PAGE_INVALID|SNAPSHOT_BYTE_BUDGET_EXCEEDED/);
    assert.equal(value.calls.includes("receiver:page"), false);
  }
});

test("an incomplete final receiver acknowledgement cannot report success", async () => {
  const value = fixture({ finalized: false });
  await assert.rejects(reconcile(value.source, value.receiver, value.snapshotId), /RECEIVER_FINAL_ACK_INVALID/);
});

test("a non-durable source acknowledgement cannot reach final handoff", async () => {
  const value = fixture();
  const source = async (args) => args[0] === "snapshot-ack"
    ? { snapshotId: value.snapshotId, acknowledgedPage: 0 } : value.source(args);
  await assert.rejects(reconcile(source, value.receiver, value.snapshotId), /SOURCE_PAGE_ACK_INVALID/);
  assert.equal(value.calls.includes("source:snapshot-complete"), false);
});

test("a proven empty source book still requires both exact completion acknowledgements", async () => {
  const value = fixture();
  value.manifest.positions = 0;
  value.manifest.pageCount = 0;
  const source = async (args) => {
    if (args[0] === "snapshot-read") return null;
    if (args[0] === "snapshot-complete") return {
      status: "SOURCE_HANDOFF_COMPLETE", snapshotId: value.snapshotId,
      manifestHash: "b".repeat(64), pageCount: 0, lastPageHash: value.manifest.lastPageHash,
    };
    return value.source(args);
  };
  const result = await reconcile(source, value.receiver, value.snapshotId);
  assert.equal(result.positions, 0);
  assert.equal(result.receiverFinalized, true);
  assert.deepEqual(value.calls, ["source:snapshot", "receiver:manifest", "receiver:complete"]);
});

test("the Mongo proxy retains exact source ownership and never substitutes another database", () => {
  const uri = new URL(localMongo("mongodb://gaming-shared-mongo-srv:27017/gaming_resulting", "resulting", "32768"));
  assert.equal(uri.hostname, "127.0.0.1");
  assert.equal(uri.pathname, "/gaming_resulting");
  assert.equal(uri.searchParams.get("directConnection"), "true");
  assert.throws(() => localMongo("mongodb://other-host:27017/gaming_resulting", "resulting", "32768"), /DEPLOYED_DATABASE_MISMATCH/);
  assert.throws(() => localMongo("mongodb://gaming-shared-mongo-srv:27017/gaming_moderation", "resulting", "32768"), /DEPLOYED_DATABASE_MISMATCH/);
});

test("public acceptance requires usable exposure, not complete older loss windows or HTTP alone", () => {
  const policy = { readiness: { transactions: "READY",
    accounting: { ready: false, openPositionsReady: true, readyLossWindows: [], code: "HISTORY_WINDOW_UNAVAILABLE" } } };
  const catalogue = { analysis: { ready: true, code: "READY" } };
  assert.equal(assertPublicReadiness(policy, catalogue).openPositionsReady, true);
  assert.throws(() => assertPublicReadiness(policy, { analysis: { ready: false } }), /PUBLIC_ACCOUNTING_NOT_READY/);
  policy.readiness.accounting.openPositionsReady = false;
  assert.throws(() => assertPublicReadiness(policy, catalogue), /PUBLIC_ACCOUNTING_NOT_READY/);
});

test("a ready forwarding process survives sustained ordinary connection messages", async () => {
  let child;
  try {
    const ports = await forward("test", "test", [27017], () => {
      child = spawn(process.execPath, ["-e", `
        process.stdout.write("Forwarding from 127.0.0.1:32768 -> 27017\\n");
        setTimeout(() => process.stdout.write("Handling connection for 27017\\n".repeat(1000)), 40);
        setInterval(() => {}, 1000);
      `], { stdio: ["ignore", "pipe", "pipe"] });
      return child;
    });
    assert.equal(ports[27017], "32768");
    await new Promise((resolve) => setTimeout(resolve, 160));
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    await stopChildren();
  }
  assert.notEqual(child.signalCode, null);
});

function workflowFixture() {
  const workflow = path.resolve(__dirname, "../../../.github/workflows/oci-live-data-rollout.yml");
  const steps = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e",
    'puts JSON.generate(YAML.load_file(ARGV[0]).fetch("jobs").fetch("rollout").fetch("steps"))', workflow], { encoding: "utf8" }));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betstan-risk-workflow-"));
  const trace = path.join(directory, "trace");
  for (const [file, body] of [
    ["infra/oci/scripts/live-data-maintenance-stan.sh",
      'printf "maintenance:%s:%s\\n" "$1" "${RESTORE_KEEP_FENCE:-false}" >> "$TRACE_FILE"'],
    ["infra/azure/agents/shared-mongo-operation-lock-stan.sh",
      'printf "lock:%s\\n" "$1" >> "$TRACE_FILE"'],
  ]) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
  }
  const selected = (name) => steps.find((step) => step.name === name);
  const run = (step, outcome) => execFileSync("bash", ["-c", step.run], {
    cwd: directory, env: { ...process.env, TRACE_FILE: trace, PHASE: "reconcile-risk-accounting",
      DATA_OUTCOME: outcome, FAILED_DEPLOY_RUN_ID: "0", RESUME_MAINTENANCE_MODE: "none",
      OCI_K8S_NAMESPACE: "test", SHARED_MONGO_LOCK_TOKEN: "test",
      SHARED_MONGO_LOCK_OPERATION: "test", SHARED_MONGO_LOCK_LEASE_SECONDS: "14400", SOURCE_SHA: "a".repeat(40) },
  });
  const allows = (step, outcomes, failed = false, cancelled = false) => vm.runInNewContext(step.if, {
    inputs: { phase: "reconcile-risk-accounting" },
    steps: Object.fromEntries(Object.entries(outcomes).map(([key, value]) => [key, { outcome: value }])),
    always: () => true, failure: () => failed, cancelled: () => cancelled,
  }, { timeout: 100 });
  return { selected, run, allows, trace: () => fs.readFileSync(trace, "utf8").trim().split("\n"),
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("failed, cancelled and unknown handoffs retain quiescence and cannot release ownership", () => {
  const value = workflowFixture();
  try {
    const maintenance = value.selected("Restore runtime or verify final deploy handoff");
    const release = value.selected("Release database operation lock unless handed to deploy");
    const retain = value.selected("Restore runtime or retain hold if final handoff packaging failed");
    for (const outcome of ["failure", "cancelled", "skipped", ""]) {
      value.run(maintenance, outcome);
      assert.deepEqual(value.trace().slice(-4), [
        "maintenance:hold:false", "maintenance:verify-held:false", "lock:renew", "lock:verify",
      ]);
      assert.equal(value.allows(release, {
        operation_lock: "success", maintenance_enter: "success", maintenance: "success",
        data: outcome, risk_readiness: "skipped",
      }, outcome === "failure", outcome === "cancelled"), false);
    }
    assert.equal(value.trace().some((line) => line.startsWith("maintenance:restore") || line === "lock:release"), false);
    assert.equal(value.allows(retain, {
      operation_lock: "success", maintenance_enter: "failure", maintenance: "skipped", data: "skipped",
    }, true), true);
    assert.equal(value.allows(retain, {
      operation_lock: "success", maintenance_enter: "success", maintenance: "success", data: "success",
    }, true), true);
  } finally { value.cleanup(); }
});

test("proven success restores under the HTTP fence and releases the lock before that fence", () => {
  const value = workflowFixture();
  try {
    const maintenance = value.selected("Restore runtime or verify final deploy handoff");
    const release = value.selected("Release database operation lock unless handed to deploy");
    const fence = value.selected("Release accounting HTTP fence after verified lock release");
    const outcomes = { operation_lock: "success", maintenance_enter: "success", maintenance: "success",
      data: "success", risk_readiness: "success", operation_lock_release: "success" };
    assert.equal(value.allows(release, outcomes), true);
    assert.equal(value.allows(fence, outcomes), true);
    value.run(maintenance, "success");
    value.run(release, "success");
    value.run(fence, "success");
    assert.deepEqual(value.trace(), [
      "maintenance:restore:true", "lock:verify", "lock:release", "lock:verify-released",
      "lock:verify-released", "maintenance:release:false",
    ]);
    for (const outcome of ["failure", "cancelled", "skipped"]) {
      assert.equal(value.allows(release, { ...outcomes, risk_readiness: outcome }), false);
      assert.equal(value.allows(fence, { ...outcomes, operation_lock_release: outcome }), false);
    }
    assert.equal(value.allows(release, outcomes, true), false);
    assert.equal(value.allows(fence, outcomes, false, true), false);
  } finally { value.cleanup(); }
});
