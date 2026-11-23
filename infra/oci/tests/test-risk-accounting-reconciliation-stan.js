"use strict";
const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");
const { reconcile, preflightLegacy, applyLegacy, execute, localMongo, assertPublicReadiness, writeEvidence, forward, stopChildren } = require("../scripts/risk-accounting-reconciliation-stan");

function legacyFixture() {
  const packet = { schemaVersion: 1, sourceSha: "a".repeat(40), sourceDigest: "b".repeat(64),
    positions: [], candidates: [{ slipId: "PRIVATE_TICKET" }] };
  const enriched = { ...packet, originals: [{ slipId: "PRIVATE_TICKET" }] };
  const plan = { ...enriched, planHash: "c".repeat(64) };
  return { packet, enriched, plan, calls: [] };
}

test("legacy preflight is read-only and requires current original authority and exact native intake echo", async () => {
  const value = legacyFixture();
  const source = async (stage) => {
    value.calls.push(stage);
    return stage === "prepare" ? value.packet : value.plan;
  };
  const receiver = async (stage) => {
    value.calls.push(stage);
    return stage === "originals" ? value.enriched : {
      schemaVersion: 1, sourceSha: value.plan.sourceSha, planHash: value.plan.planHash, intakeVerified: true,
    };
  };
  assert.deepEqual(await preflightLegacy(source, receiver, value.plan.sourceSha), value.plan);
  assert.deepEqual(value.calls, ["prepare", "originals", "plan", "preflight"]);
  await assert.rejects(preflightLegacy(source, async (stage) => stage === "originals" ? value.enriched
    : { schemaVersion: 1, sourceSha: value.plan.sourceSha, planHash: "d".repeat(64), intakeVerified: true },
  value.plan.sourceSha), /LEGACY_RECEIVER_PREFLIGHT_INVALID/);
  assert.equal(value.calls.includes("apply"), false);
});

test("a metadata commit is UNKNOWN until exact acknowledgement, including a lost or changed reply", async () => {
  const { plan } = legacyFixture();
  for (const lost of [true, false]) {
    const states = [];
    await assert.rejects(applyLegacy(async stage => {
      assert.equal(stage, "apply");
      assert.equal(states[0].outcome, "UNKNOWN");
      if (lost) throw new Error("acknowledgement lost");
      return { schemaVersion: 1, sourceSha: plan.sourceSha, planHash: "d".repeat(64),
        applied: true, positions: 1, documents: 1 };
    }, plan, state => states.push(state)), /acknowledgement lost|LEGACY_WRITE_ACK_INVALID/);
    assert.deepEqual(states.map(state => state.outcome), ["UNKNOWN"]);
  }
  const states = [];
  await applyLegacy(async () => ({ schemaVersion: 1, sourceSha: plan.sourceSha, planHash: plan.planHash,
    applied: true, positions: 1, documents: 2 }), plan, state => states.push(state));
  assert.deepEqual(states.map(state => state.outcome), ["UNKNOWN", "CONFIRMED"]);
});

test("adding accounting evidence preserves and updates the existing full checksum inventory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betstan-risk-evidence-"));
  try {
    const prior = `${"a".repeat(64)}  reports/original.json\n`;
    fs.writeFileSync(path.join(directory, "SHA256SUMS"), prior);
    writeEvidence(directory, "risk-accounting-legacy-preflight.json", { status: "PASS" });
    writeEvidence(directory, "risk-accounting-legacy-preflight.json", { status: "FAIL" });
    const lines = fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trim().split("\n");
    assert.equal(lines.filter(line => line.endsWith("  reports/original.json")).length, 1);
    assert.equal(lines.filter(line => line.endsWith("  risk-accounting-legacy-preflight.json")).length, 1);
    const actual = require("node:crypto").createHash("sha256")
      .update(fs.readFileSync(path.join(directory, "risk-accounting-legacy-preflight.json"))).digest("hex");
    assert.equal(lines.includes(`${actual}  risk-accounting-legacy-preflight.json`), true);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("ordinary Node warnings do not turn a known financial block into a private transport failure", async () => {
  await assert.rejects(execute(process.execPath, ["-e", `
    process.emitWarning("ordinary dependency warning", "DeprecationWarning", "DEP0040");
    setImmediate(() => {
      console.error("LEGACY_ORIGINAL_ADMISSION_UNAVAILABLE");
      process.exitCode = 1;
    });
  `], { legacyErrors: true }), error => error.safeCode === "LEGACY_ORIGINAL_ADMISSION_UNAVAILABLE");
});

test("unknown or ambiguous private error codes are never published as trusted financial blocks", async () => {
  for (const message of ["LEGACY_NOT_REVIEWED", ["LEGACY_SOURCE_CHANGED", "LEGACY_ORIGINAL_ADMISSION_UNAVAILABLE"].join("\n")]) {
    await assert.rejects(execute(process.execPath, ["-e",
      `console.error(${JSON.stringify(message)}); process.exitCode = 1;`], { legacyErrors: true }),
    error => error.safeCode === "PRIVATE_COMMAND_FAILED");
  }
});
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
  const catalogue = { analysis: { ready: true, code: "READY" },
    events: [{ metrics: { openTickets: 1, pendingTickets: 0, exposureMinor: "2000" } }] };
  assert.equal(assertPublicReadiness(policy, catalogue).openPositionsReady, true);
  assert.throws(() => assertPublicReadiness(policy, { ...catalogue, events: [{ metrics: null }] }), /PUBLIC_EVENT_METRICS_UNAVAILABLE/);
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

function workflowFixture(restore = false) {
  const workflow = path.resolve(__dirname, `../../../.github/workflows/${restore ? "oci-restore-held-runtime" : "oci-live-data-rollout"}.yml`);
  const steps = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e",
    `puts JSON.generate(YAML.load_file(ARGV[0]).fetch("jobs").fetch("${restore ? "restore" : "rollout"}").fetch("steps"))`, workflow], { encoding: "utf8" }));
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
      FAILED_PHASE: "reconcile-risk-accounting",
      DATA_OUTCOME: outcome, FAILED_DEPLOY_RUN_ID: "0", RESUME_MAINTENANCE_MODE: "none",
      OCI_K8S_NAMESPACE: "test", SHARED_MONGO_LOCK_TOKEN: "test",
      SHARED_MONGO_LOCK_OPERATION: "test", SHARED_MONGO_LOCK_LEASE_SECONDS: "14400", SOURCE_SHA: "a".repeat(40) },
  });
  const allows = (step, outcomes, failed = false, cancelled = false) => vm.runInNewContext(step.if, {
    inputs: { phase: "reconcile-risk-accounting" },
    env: { FAILED_PHASE: "reconcile-risk-accounting" },
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

test("read-only preflight failure before maintenance releases only the owned lock, never a physical fence", () => {
  const value = workflowFixture();
  try {
    const outcomes = { operation_lock: "success", accounting_preflight: "failure", maintenance_enter: "skipped",
      data: "skipped", maintenance: "skipped", risk_readiness: "skipped", operation_lock_release: "success" };
    const release = value.selected("Release database operation lock unless handed to deploy");
    const fence = value.selected("Release accounting HTTP fence after verified lock release");
    assert.equal(value.allows(release, outcomes, true), true);
    assert.equal(value.allows(fence, outcomes, true), false);
    value.run(release, "skipped");
    assert.deepEqual(value.trace(), ["lock:release", "lock:verify-released"]);
    assert.equal(value.allows(release, { ...outcomes, maintenance_enter: "failure" }, true), false);
  } finally { value.cleanup(); }
});
function restoreAdmissionFixture({ legacy = false, code = "SOURCE_OPEN_POSITIONS_UNAVAILABLE" } = {}) {
  const root = path.resolve(__dirname, "../../..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betstan-pre-import-"));
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin);
  const failedRun = legacy ? "991" : "45049185347";
  const failedSha = legacy ? "b".repeat(40) : "4933dd8b98fd8ab4464c274a544693be05997a07";
  const phase = legacy ? "apply-slip-index" : "reconcile-risk-accounting";
  const run = { id: Number(failedRun), path: ".github/workflows/oci-live-data-rollout.yml",
    event: "workflow_dispatch", head_branch: "master", head_repository: { full_name: "vasilyevstan/betstan" },
    status: "completed", conclusion: "failure", run_attempt: 1, head_sha: failedSha,
    display_title: `oci-live-data ${phase} ${failedSha}` };
  const outcomes = {
    "Enter or re-establish live data maintenance": "success",
    "Delete exact orphaned live-acceptance slips": "skipped",
    "Execute exact-digest live data phase": legacy ? "skipped" : "failure",
    "Restore runtime or verify final deploy handoff": "success",
    "Restore runtime or retain hold if final handoff packaging failed": legacy ? "success" : "skipped",
    "Release database operation lock unless handed to deploy": "skipped",
    "Verify restored public accounting and event analysis": "skipped",
    "Release accounting HTTP fence after verified lock release": "skipped",
    "Capture post-phase runtime baseline": "skipped",
    "Upload exact sanitized data evidence": "success",
    "Upload protected rollout baselines": "success",
    "Close ephemeral OCI Bastion access": "success",
  };
  const jobs = () => ({ jobs: [{ name: "rollout", conclusion: "failure",
    steps: Object.entries(outcomes).map(([name, conclusion]) => ({ name, conclusion })) }] });
  const payload = path.join(directory, "payload");
  fs.mkdirSync(payload);
  const failure = `${JSON.stringify({ status: "FAIL", code })}\n`;
  fs.writeFileSync(path.join(payload, "risk-accounting-failure.json"), failure);
  fs.writeFileSync(path.join(payload, "SHA256SUMS"),
    `${require("node:crypto").createHash("sha256").update(failure).digest("hex")}  risk-accounting-failure.json\n`);
  const zip = path.join(directory, "artifact.zip");
  execFileSync("zip", ["-q", zip, "SHA256SUMS", "risk-accounting-failure.json"], { cwd: payload });
  const artifact = { id: 777, name: `oci-live-data-rollout-${failedRun}-1`, expired: false,
    workflow_run: { id: Number(failedRun), head_sha: failedSha },
    digest: `sha256:${require("node:crypto").createHash("sha256").update(fs.readFileSync(zip)).digest("hex")}` };
  // Git evidence is mocked independently of the runner's checkout depth.
  fs.writeFileSync(path.join(bin, "git"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == fetch ]]; then exit 0; fi
if [[ "$2" == HEAD || "$2" == origin/master ]]; then printf '%s\\n' "$SOURCE_SHA"; exit 0; fi
if [[ "\${BAD_BLOB:-false}" == true ]]; then printf '%040d\\n' 0; exit 0; fi
case "$2" in
  4933dd8b98fd8ab4464c274a544693be05997a07:.github/workflows/oci-live-data-rollout.yml)
    echo 608d3d55b7dac9e8b281a76e913d58c2718e4b9f ;;
  4933dd8b98fd8ab4464c274a544693be05997a07:infra/oci/scripts/risk-accounting-reconciliation-stan.js)
    echo 7404d4934ebdbc1ca667e2da2a4c06adb13dff82 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const endpoint = process.argv[3];
if (endpoint.endsWith("/zip")) process.stdout.write(fs.readFileSync("artifact.zip"));
else if (endpoint.endsWith("/artifacts")) process.stdout.write(fs.readFileSync("artifacts.json"));
else if (endpoint.endsWith("/jobs")) process.stdout.write(fs.readFileSync("jobs.json"));
else process.stdout.write(fs.readFileSync("run.json"));
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "sha256sum"), '#!/usr/bin/env bash\nexec shasum -a 256 "$@"\n', { mode: 0o755 });
  const steps = JSON.parse(execFileSync("ruby", ["-ryaml", "-rjson", "-e",
    'puts JSON.generate(YAML.load_file(ARGV[0]).fetch("jobs").fetch("restore").fetch("steps"))',
    path.join(root, ".github/workflows/oci-restore-held-runtime.yml")], { encoding: "utf8" }));
  const execute = (name, overrides = {}) => {
    fs.writeFileSync(path.join(directory, "run.json"), JSON.stringify(run));
    fs.writeFileSync(path.join(directory, "jobs.json"), JSON.stringify(jobs()));
    fs.writeFileSync(path.join(directory, "artifacts.json"), JSON.stringify({ artifacts: [artifact] }));
    const envFile = path.join(directory, "github-env");
    fs.writeFileSync(envFile, "");
    try {
      execFileSync("bash", ["-euo", "pipefail", "-c", steps.find((step) => step.name === name).run], {
        cwd: directory, stdio: "pipe",
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          SOURCE_SHA: "a".repeat(40), GITHUB_SHA: "a".repeat(40), GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REF_NAME: "master", GITHUB_RUN_ATTEMPT: "1", OCI_RUNTIME_MODE: "k3s",
          CONFIRMATION: "RESTORE FAILED HOLD BASELINE", FAILED_RUN_ID: failedRun,
          FAILED_SOURCE_SHA: failedSha, GITHUB_REPOSITORY: "vasilyevstan/betstan", GITHUB_ENV: envFile,
          RUNNER_TEMP: directory, ...overrides },
      });
      return { passed: true, environment: fs.readFileSync(envFile, "utf8") };
    } catch (error) {
      assert.notEqual(error.status, null);
      return { passed: false, environment: fs.readFileSync(envFile, "utf8") };
    }
  };
  return { run, outcomes, artifact, execute,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}

test("pre-import recovery requires the frozen failed run and native no-receiver state", () => {
  const value = restoreAdmissionFixture();
  const name = "Authenticate exact master and failed pre-data hold";
  try {
    assert.equal(value.execute(name).passed, true);
    for (const overrides of [{ FAILED_RUN_ID: "45049185348" }, { BAD_BLOB: "true" }, { GITHUB_RUN_ATTEMPT: "2" }]) {
      assert.equal(value.execute(name, overrides).passed, false);
    }
    for (const step of [
      "Execute exact-digest live data phase", "Verify restored public accounting and event analysis",
      "Release database operation lock unless handed to deploy",
    ]) {
      const original = value.outcomes[step];
      value.outcomes[step] = "success";
      assert.equal(value.execute(name).passed, false);
      value.outcomes[step] = original;
    }
    value.run.head_sha = "f".repeat(40);
    assert.equal(value.execute(name).passed, false);
  } finally { value.cleanup(); }
  const legacy = restoreAdmissionFixture({ legacy: true });
  try {
    assert.equal(legacy.execute(name).passed, true);
    legacy.outcomes["Execute exact-digest live data phase"] = "success";
    assert.equal(legacy.execute(name).passed, false);
  } finally { legacy.cleanup(); }
});

test("only the immutable source-completeness rejection qualifies pre-import restoration", () => {
  const name = "Verify frozen accounting rejection before receiver import";
  for (const code of ["SOURCE_OPEN_POSITIONS_UNAVAILABLE", "RECEIVER_PAGE_ACK_INVALID", "PRIVATE_COMMAND_FAILED"]) {
    const value = restoreAdmissionFixture({ code });
    try {
      const result = value.execute(name);
      assert.equal(result.passed, code === "SOURCE_OPEN_POSITIONS_UNAVAILABLE");
      assert.equal(result.environment.includes("ACCOUNTING_REJECTION_VERIFIED=true"), result.passed);
      if (result.passed) {
        value.artifact.digest = `sha256:${"f".repeat(64)}`;
        assert.equal(value.execute(name).passed, false);
      }
    } finally { value.cleanup(); }
  }
});

function maintenanceFixture(body, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betstan-owned-restore-"));
  const state = path.join(directory, "state.tsv");
  const trace = path.join(directory, "trace");
  fs.writeFileSync(state, "state_version\t2\n");
  const lock = path.join(directory, "infra/azure/agents/shared-mongo-operation-lock-stan.sh");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '#!/usr/bin/env bash\nprintf "lock:%s\\n" "$1" >> "$TRACE_FILE"\n[[ "${VERIFY_FAIL:-false}" != true ]]\n', { mode: 0o755 });
  const script = path.resolve(__dirname, "../scripts/live-data-maintenance-stan.sh");
  try {
    let passed = true;
    let diagnostic = "";
    try {
      execFileSync("bash", ["-euo", "pipefail", "-c", `
source "$MAINTENANCE_SCRIPT"
OCI_ROOT_DIR="$FIXTURE_ROOT"
validate_state() { :; }
fence_config_status() { echo "$ACTUAL_FENCE"; }
runtime_fence_status() { echo "$ACTUAL_FENCE"; }
state_replicas() { echo 1; }
state_image() { echo digest; }
set_service_image() { echo "image:$1" >> "$TRACE_FILE"; }
scale_service() { echo "scale:$1" >> "$TRACE_FILE"; }
deployment_is_stable() { [[ "\${UNSTABLE:-false}" != true ]]; }
set_fence_config() { echo "fence:$1" >> "$TRACE_FILE"; }
wait_for_fence() { :; }
${body}`], { stdio: "pipe", env: { ...process.env, MAINTENANCE_SCRIPT: script, FIXTURE_ROOT: directory,
        STATE_FILE: state, READINESS_FILE: path.join(directory, "readiness.tsv"), TRACE_FILE: trace,
        GITHUB_ACTIONS: "true", GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", SOURCE_SHA: "a".repeat(40),
        FAILED_RUN_ID: "45049185347", ACCOUNTING_REJECTION_VERIFIED: "true",
        SHARED_MONGO_LOCK_OPERATION: "restore-held-45049185347",
        SHARED_MONGO_LOCK_TOKEN: "restore-held-123-1", ACTUAL_FENCE: "true", NOW_EPOCH: "", ...overrides } });
    } catch (error) {
      assert.notEqual(error.status, null);
      passed = false;
      diagnostic = error.stderr?.toString() ?? error.message;
    }
    return { passed, diagnostic, statePreserved: fs.existsSync(state), readiness: fs.existsSync(path.join(directory, "readiness.tsv")),
      trace: fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n") : [] };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("pre-import fenced restoration verifies its owned lease without incident credentials", () => {
  const body = "RESTORE_KEEP_FENCE=true\nrestore_runtime owned";
  const result = maintenanceFixture(body);
  assert.equal(result.passed, true, result.diagnostic);
  assert.equal(result.trace.filter((line) => line === "lock:verify").length, 2);
  assert.equal(result.trace.some((line) => line.startsWith("scale:")), true);
  assert.equal(result.trace.includes("fence:false"), false);
  assert.equal(result.statePreserved, true);
  for (const overrides of [
    { SHARED_MONGO_LOCK_TOKEN: "other-owner" }, { VERIFY_FAIL: "true" },
    { GITHUB_RUN_ATTEMPT: "2" }, { NOW_EPOCH: "1" }, { ACCOUNTING_REJECTION_VERIFIED: "false" },
  ]) {
    const rejected = maintenanceFixture(body, overrides);
    assert.equal(rejected.passed, false);
    assert.equal(rejected.trace.some((line) => line.startsWith("scale:") || line.startsWith("image:")), false);
  }
  assert.equal(maintenanceFixture("RESTORE_KEEP_FENCE=true\nrestore_runtime").passed, false);
});

test("held readiness proves matching fences and retains the baseline until release", () => {
  const held = maintenanceFixture("capture_readiness true");
  assert.equal(held.passed, true);
  assert.equal(held.readiness, true);
  assert.equal(held.statePreserved, true);
  assert.equal(maintenanceFixture("capture_readiness true", { ACTUAL_FENCE: "false" }).passed, false);
  assert.equal(maintenanceFixture("capture_readiness true", { UNSTABLE: "true" }).passed, false);
  const released = maintenanceFixture("capture_readiness", { ACTUAL_FENCE: "false" });
  assert.equal(released.passed, true);
  assert.equal(released.statePreserved, false);
  assert.equal(maintenanceFixture("capture_readiness").passed, false);
});

test("qualified pre-import recovery releases ownership before its HTTP fence", () => {
  const value = workflowFixture(true);
  try {
    const restore = value.selected("Restore authenticated baseline and lift the fence");
    const ready = value.selected("Verify restored readiness at the authenticated baseline");
    const release = value.selected("Release restore lock");
    const fence = value.selected("Release verified accounting pre-import restore fence");
    value.run(restore, "failure");
    value.run(ready, "failure");
    value.run(release, "failure");
    assert.equal(value.allows(fence, { lock_release: "success" }), true);
    value.run(fence, "failure");
    const trace = value.trace();
    assert.equal(trace.some((line) => line === "maintenance:restore-owned-fenced:false"), true);
    assert.equal(trace.some((line) => line === "maintenance:capture-held-readiness:false"), true);
    assert.equal(trace.indexOf("lock:release") < trace.indexOf("maintenance:release:false"), true);
    assert.equal(trace.slice(-2).join(","), "lock:verify-released,maintenance:release:false");
    for (const outcome of ["failure", "cancelled", "skipped", ""]) {
      assert.equal(value.allows(fence, { lock_release: outcome }), false);
    }
    assert.equal(value.allows(fence, { lock_release: "success" }, true), false);
  } finally { value.cleanup(); }
});
