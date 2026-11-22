#!/usr/bin/env node
"use strict";

const { execFile, spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");
const PAGE_BYTES = 512 * 1024;
const IMPORT_BYTES = 16 * 1024 * 1024;
const children = new Set();
let expiresAt = Infinity;
const digest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function requireProof(condition, code) {
  if (!condition) {
    const error = new Error(code);
    error.safeCode = code;
    throw error;
  }
}

async function reconcile(source, receiver, snapshotId) {
  const manifest = await source(["snapshot", snapshotId, "1970-01-01T00:00:00.000Z"]);
  requireProof(manifest?.schemaVersion === 1 && manifest.source === "RESULTING"
    && manifest.status === "COMPLETE" && manifest.snapshotId === snapshotId
    && digest(manifest.sourceDigest) && digest(manifest.lastPageHash)
    && count(manifest.positions, 10000) && count(manifest.movements, 10000)
    && count(manifest.pageCount, manifest.positions + manifest.movements), "SOURCE_MANIFEST_INVALID");
  requireProof(manifest.coverage?.openPositions === "COMPLETE"
    && manifest.coverage.unavailableOpenPositions === 0, "SOURCE_OPEN_POSITIONS_UNAVAILABLE");
  const accepted = await receiver("manifest", manifest);
  requireProof(accepted?.snapshotId === snapshotId && digest(accepted.manifestHash), "RECEIVER_MANIFEST_ACK_INVALID");
  let bytes = 0;
  let predecessor;
  for (let pageNumber = 1; pageNumber <= manifest.pageCount; pageNumber += 1) {
    const page = await source(["snapshot-read", snapshotId]);
    requireProof(page?.schemaVersion === 1 && page.snapshotId === snapshotId
      && page.page === pageNumber && digest(page.hash) && digest(page.previousHash)
      && (predecessor === undefined || page.previousHash === predecessor)
      && Array.isArray(page.entries) && page.entries.length > 0 && page.entries.length <= 50,
    "SOURCE_PAGE_INVALID");
    const size = Buffer.byteLength(JSON.stringify(page));
    bytes += size;
    requireProof(size <= PAGE_BYTES && bytes <= IMPORT_BYTES, "SNAPSHOT_BYTE_BUDGET_EXCEEDED");
    const ack = await receiver("page", page);
    requireProof(ack?.snapshotId === snapshotId && ack.page === pageNumber && ack.hash === page.hash,
      "RECEIVER_PAGE_ACK_INVALID");
    const sourceAck = await source(["snapshot-ack", snapshotId, String(pageNumber), page.hash]);
    requireProof(sourceAck?.snapshotId === snapshotId && sourceAck.acknowledgedPage === pageNumber,
      "SOURCE_PAGE_ACK_INVALID");
    predecessor = page.hash;
  }
  requireProof(await source(["snapshot-read", snapshotId]) === null
    && (manifest.pageCount === 0 || predecessor === manifest.lastPageHash), "SOURCE_PAGE_COUNT_MISMATCH");
  const completion = await source(["snapshot-complete", snapshotId, accepted.manifestHash]);
  requireProof(completion?.status === "SOURCE_HANDOFF_COMPLETE"
    && completion.snapshotId === snapshotId && completion.manifestHash === accepted.manifestHash
    && completion.pageCount === manifest.pageCount && completion.lastPageHash === manifest.lastPageHash,
  "SOURCE_COMPLETION_INVALID");
  const finalized = await receiver("complete", completion);
  requireProof(finalized?.finalized === true && finalized.snapshotId === snapshotId
    && finalized.manifestHash === accepted.manifestHash, "RECEIVER_FINAL_ACK_INVALID");
  return {
    snapshotId, manifestHash: accepted.manifestHash, sourceDigest: manifest.sourceDigest,
    lastPageHash: manifest.lastPageHash, pageCount: manifest.pageCount,
    positions: manifest.positions, movements: manifest.movements,
    unavailableHistories: manifest.coverage.unavailableHistories,
    realisedCompleteSince: manifest.coverage.realisedCompleteSince,
    cutAt: manifest.cutAt, receiverFinalized: true,
  };
}

function execute(file, args, options = {}) {
  const { input, timeout = 180000, ...settings } = options;
  requireProof(Date.now() < expiresAt, "RECONCILIATION_DEADLINE_EXCEEDED");
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      cwd: ROOT, maxBuffer: PAGE_BYTES + 1, ...settings,
      timeout: Math.max(1, Math.min(timeout, expiresAt - Date.now())),
    }, (error, stdout) => {
      children.delete(child);
      if (error) {
        const safe = new Error("PRIVATE_COMMAND_FAILED");
        safe.safeCode = "PRIVATE_COMMAND_FAILED";
        reject(safe);
      } else resolve(stdout.trim());
    });
    children.add(child);
    child.stdin.once("error", () => {
      child.kill("SIGTERM");
      const error = new Error("PRIVATE_INPUT_FAILED");
      error.safeCode = "PRIVATE_INPUT_FAILED";
      reject(error);
    });
    child.stdin.end(input);
  });
}

function forward(namespace, service, ports, spawnChild = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnChild("kubectl", [
      "port-forward", "-n", namespace, `service/${service}`, "--address=127.0.0.1",
      ...ports.map((port) => `:${port}`),
    ], { stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    const mapped = {};
    let output = "";
    let ready = false;
    const deadline = setTimeout(() => fail(), 30000);
    const fail = () => {
      clearTimeout(deadline);
      child.kill("SIGTERM");
      const error = new Error("PRIVATE_FORWARD_UNAVAILABLE");
      error.safeCode = "PRIVATE_FORWARD_UNAVAILABLE";
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", fail);
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      if (ready) return;
      output += chunk.toString();
      if (output.length > 16384) return fail();
      for (const match of output.matchAll(/Forwarding from 127\.0\.0\.1:(\d+) -> (\d+)/g)) {
        mapped[match[2]] = match[1];
      }
      if (ports.every((port) => mapped[port])) {
        ready = true;
        output = "";
        clearTimeout(deadline);
        resolve(mapped);
      }
    });
  });
}

async function stopChildren() {
  await Promise.all([...children].map((child) => new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return resolve();
    const deadline = setTimeout(() => child.kill("SIGKILL"), 3000);
    child.once("close", () => { clearTimeout(deadline); children.delete(child); resolve(); });
    child.kill("SIGTERM");
  })));
}

function deploymentValue(deployment, service, name) {
  const containers = deployment?.spec?.template?.spec?.containers;
  const selected = Array.isArray(containers) ? containers.filter((entry) => entry.name === `gaming-${service}`) : [];
  const values = selected.length === 1 ? selected[0].env?.filter((entry) => entry.name === name) : [];
  requireProof(values?.length === 1 && typeof values[0].value === "string", "DEPLOYED_CONNECTION_UNAVAILABLE");
  return values[0].value;
}

function localMongo(uri, service, port) {
  const parsed = new URL(uri);
  requireProof(parsed.protocol === "mongodb:" && parsed.hostname === "gaming-shared-mongo-srv"
    && parsed.pathname === `/gaming_${service}` && parsed.port === "27017", "DEPLOYED_DATABASE_MISMATCH");
  parsed.hostname = "127.0.0.1";
  parsed.port = port;
  parsed.searchParams.set("directConnection", "true");
  return parsed.toString();
}

function assertPublicReadiness(policy, catalogue) {
  requireProof(policy?.readiness?.transactions === "READY"
    && policy.readiness.accounting?.openPositionsReady === true
    && catalogue?.analysis?.ready === true && catalogue.analysis.code === "READY",
  "PUBLIC_ACCOUNTING_NOT_READY");
  return {
    transactions: "READY", openPositionsReady: true, analysisReady: true,
    readyLossWindows: policy.readiness.accounting.readyLossWindows,
    accountingCode: policy.readiness.accounting.code,
  };
}

function writeEvidence(directory, name, value) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const files = fs.readdirSync(directory).filter((file) => file.startsWith("risk-accounting-") && file.endsWith(".json")).sort();
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), files.map((file) =>
    `${createHash("sha256").update(fs.readFileSync(path.join(directory, file))).digest("hex")}  ${file}\n`).join(""),
  { mode: 0o600 });
}

async function main() {
  const env = process.env;
  expiresAt = Date.now() + 1800000;
  const directory = path.resolve(ROOT, env.OUTPUT_DIR ?? "");
  requireProof(directory === path.join(ROOT, "artifacts/oci-live-data-rollout/evidence"), "EVIDENCE_DIRECTORY_INVALID");
  try {
    if (process.argv[2] === "--verify-public") {
      const base = new URL(env.OCI_PUBLIC_URL);
      requireProof(base.protocol === "https:" && !base.username && !base.password, "PUBLIC_ENDPOINT_INVALID");
      const read = async (endpoint) => {
        const response = await fetch(new URL(endpoint, base), { signal: AbortSignal.timeout(10000), redirect: "error" });
        requireProof(response.ok, "PUBLIC_ACCOUNTING_UNAVAILABLE");
        let bytes = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          bytes += chunk.length;
          requireProof(bytes <= 2 * 1024 * 1024, "PUBLIC_RESPONSE_BUDGET_EXCEEDED");
          chunks.push(Buffer.from(chunk));
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      };
      const [policy, catalogue] = await Promise.all([
        read("/api/backoffice/risk-centre"), read("/api/backoffice/risk-centre/events"),
      ]);
      writeEvidence(directory, "risk-accounting-public-readiness.json", assertPublicReadiness(policy, catalogue));
      console.log("risk_accounting_public_readiness=PASS");
      return;
    }
    requireProof(process.argv.length === 2 && /^[0-9a-f]{40}$/.test(env.SOURCE_SHA ?? "")
      && /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") && env.GITHUB_RUN_ATTEMPT === "1"
      && env.GITHUB_ACTIONS === "true" && env.PHASE === "reconcile-risk-accounting"
      && env.NAMESPACE === env.OCI_K8S_NAMESPACE && /^[a-z0-9-]+$/.test(env.NAMESPACE ?? "")
      && env.LOCK_TOKEN === `live-data-${env.GITHUB_RUN_ID}-1`
      && env.OPERATION_ID === "live-data-reconcile-risk-accounting" && env.STATE_FILE && !env.NOW_EPOCH,
    "EXACT_SOURCE_AUTHORITY_REQUIRED");
    requireProof(await execute("git", ["rev-parse", "HEAD"]) === env.SOURCE_SHA
      && await execute("git", ["status", "--porcelain", "--untracked-files=no"]) === "", "SOURCE_CHECKOUT_CHANGED");
    const baseline = fs.readFileSync(path.join(ROOT, "artifacts/oci-data-baseline-before/baseline-provenance.env"), "utf8");
    const reader = baseline.split("\n").filter((line) => line.startsWith("baseline_source_sha="));
    requireProof(reader.length === 1 && /^baseline_source_sha=[0-9a-f]{40}$/.test(reader[0]), "DEPLOYED_READER_UNPROVEN");
    const readerSha = reader[0].split("=")[1];
    for (const file of [
      "resulting/src/service/accountingSnapshot.ts", "resulting/src/service/accountingSnapshotFence.ts",
      "resulting/src/scripts/exportAccounting.ts", "moderation/src/risk/SnapshotContract.ts",
      "moderation/src/risk/SnapshotImport.ts", "moderation/src/risk/SnapshotFence.ts",
      "moderation/src/scripts/importRiskSnapshot.ts",
    ]) {
      requireProof(await execute("git", ["rev-parse", `${readerSha}:${file}`])
        === await execute("git", ["rev-parse", `${env.SOURCE_SHA}:${file}`]), "DEPLOYED_SNAPSHOT_READER_INCOMPATIBLE");
    }
    await execute("bash", ["infra/oci/scripts/shared-mongo-operation-lock-stan.sh", "verify"]);
    await execute("bash", ["infra/oci/scripts/live-data-maintenance-stan.sh", "verify-held"]);
    const deployments = {};
    for (const service of ["resulting", "moderation"]) {
      deployments[service] = JSON.parse(await execute("kubectl", [
        "get", "deployment", `gaming-${service}-depl`, "-n", env.NAMESPACE, "-o", "json",
      ]));
    }
    requireProof(deploymentValue(deployments.moderation, "moderation", "RISK_CENTRE_ENABLED") === "true",
      "DEPLOYED_RISK_INTAKE_DISABLED");
    const broker = new URL(deploymentValue(deployments.resulting, "resulting", "RABBITMQ_URI"));
    requireProof(broker.protocol === "amqp:" && broker.hostname === "gaming-rabbitmq-srv"
      && new URL(deploymentValue(deployments.moderation, "moderation", "RABBITMQ_URI")).toString() === broker.toString(),
    "DEPLOYED_BROKER_MISMATCH");
    const mongo = await forward(env.NAMESPACE, "gaming-shared-mongo-srv", [27017]);
    const rabbit = await forward(env.NAMESPACE, "gaming-rabbitmq-srv", [5672, 15672]);
    const management = new URL("http://127.0.0.1");
    management.port = rabbit[15672];
    // AMQP's omitted credentials use the broker client's guest defaults.
    management.username = broker.username || "guest";
    management.password = broker.password || "guest";
    broker.hostname = "127.0.0.1";
    broker.port = rabbit[5672];
    const command = async (service, args, input) => JSON.parse(await execute(process.execPath, [
      "-r", path.join(ROOT, service, "node_modules/ts-node/register/transpile-only"),
      `src/scripts/${service === "resulting" ? "exportAccounting" : "importRiskSnapshot"}.ts`, ...args,
    ], {
      cwd: path.join(ROOT, service), timeout: 1800000, input: input === undefined ? undefined : JSON.stringify(input),
      env: { ...env, RISK_CENTRE_ENABLED: "true", RABBITMQ_URI: broker.toString(),
        RABBITMQ_MANAGEMENT_URI: management.toString(),
        MONGO_URI: localMongo(deploymentValue(deployments[service], service, "MONGO_URI"), service, mongo[27017]) },
    }));
    const result = await reconcile(
      (args) => command("resulting", args), (stage, value) => command("moderation", [stage], value),
      `risk_${env.GITHUB_RUN_ID}_1`,
    );
    await execute("bash", ["infra/oci/scripts/shared-mongo-operation-lock-stan.sh", "verify"]);
    await execute("bash", ["infra/oci/scripts/live-data-maintenance-stan.sh", "verify-held"]);
    writeEvidence(directory, "risk-accounting-reconciliation.json", {
      schemaVersion: "risk-accounting-reconciliation.v1", status: "PASS",
      phase: "reconcile-risk-accounting", controlSha: env.SOURCE_SHA, deployedReaderSha: readerSha,
      workflowRunId: env.GITHUB_RUN_ID, workflowRunAttempt: 1, ...result,
    });
    console.log("risk_accounting_reconciliation=PASS receiver_finalized=true");
  } catch (error) {
    const code = error.safeCode ?? "RISK_ACCOUNTING_RECONCILIATION_FAILED";
    writeEvidence(directory, "risk-accounting-failure.json", { status: "FAIL", code });
    console.error(`risk_accounting_reconciliation=FAIL code=${code}`);
    process.exitCode = 1;
  } finally {
    await stopChildren();
  }
}

module.exports = { reconcile, localMongo, assertPublicReadiness, forward, stopChildren };
if (require.main === module) void main().catch(() => {
  console.error("risk_accounting_reconciliation=FAIL code=EVIDENCE_UNAVAILABLE");
  process.exitCode = 1;
});
