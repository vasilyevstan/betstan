"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { QUALITY_EVENTS } = require("./pr-source-snapshot.js");

const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const MAX_MANIFEST_BYTES = 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function verifyQualityManifest({ content, expected }, execute = execFileSync) {
  if (
    typeof content !== "string" || Buffer.byteLength(content) > MAX_MANIFEST_BYTES ||
    !expected || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository) ||
    !Number.isSafeInteger(expected.repositoryId) || expected.repositoryId < 1 ||
    !Number.isSafeInteger(expected.runId) || expected.runId < 1 ||
    !Number.isSafeInteger(expected.attempt) || expected.attempt < 1 ||
    !QUALITY_EVENTS.includes(expected.event) ||
    !expected.validator ||
    !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(expected.validator.workflowPath) ||
    !/^[0-9a-f]{40}$/.test(expected.validator.executingCommitSha) ||
    !["refs/heads/dev", "refs/heads/master"].includes(expected.validator.executingRef)
  ) {
    throw new Error("Invalid trusted quality attestation identity or manifest size");
  }

  const contentSha256 = sha256(content);
  const repositoryURI = `https://github.com/${expected.repository}`;
  const signerURI = `${repositoryURI}/${expected.validator.workflowPath}@${expected.validator.executingRef}`;
  const invocationURI = `${repositoryURI}/actions/runs/${expected.runId}/attempts/${expected.attempt}`;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betstan-quality-"));
  const filename = path.join(directory, "quality-manifest.json");
  try {
    fs.writeFileSync(filename, content, { flag: "wx", mode: 0o600 });
    let output;
    try {
      output = execute("gh", [
        "attestation", "verify", filename,
        "--hostname", "github.com",
        "--repo", expected.repository,
        "--signer-workflow", `${expected.repository}/${expected.validator.workflowPath}`,
        "--signer-digest", expected.validator.executingCommitSha,
        "--source-digest", expected.validator.executingCommitSha,
        "--source-ref", expected.validator.executingRef,
        "--predicate-type", PREDICATE_TYPE,
        "--deny-self-hosted-runners",
        "--format", "json",
      ], {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 4 * MAX_MANIFEST_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error("Native quality attestation verification failed", { cause: error });
    }
    if (sha256(fs.readFileSync(filename)) !== contentSha256) {
      throw new Error("Quality manifest changed during native verification");
    }
    const results = JSON.parse(output);
    if (!Array.isArray(results) || results.length === 0) {
      throw new Error("Native verifier returned no verified attestations");
    }

    // These certificate fields come from GitHub OIDC, not the signed predicate.
    const verified = results.find((result) => {
      const verification = result?.verificationResult;
      const certificate = verification?.signature?.certificate;
      const statement = verification?.statement;
      return certificate &&
        certificate.issuer === "https://token.actions.githubusercontent.com" &&
        certificate.subjectAlternativeName === signerURI &&
        certificate.buildSignerURI === signerURI &&
        certificate.buildSignerDigest === expected.validator.executingCommitSha &&
        certificate.sourceRepositoryURI === repositoryURI &&
        certificate.sourceRepositoryIdentifier === String(expected.repositoryId) &&
        certificate.sourceRepositoryDigest === expected.validator.executingCommitSha &&
        certificate.sourceRepositoryRef === expected.validator.executingRef &&
        certificate.buildConfigURI === signerURI &&
        certificate.buildConfigDigest === expected.validator.executingCommitSha &&
        certificate.buildTrigger === expected.event &&
        certificate.runInvocationURI === invocationURI &&
        certificate.runnerEnvironment === "github-hosted" &&
        Array.isArray(verification.verifiedTimestamps) &&
        verification.verifiedTimestamps.length > 0 &&
        statement?._type === "https://in-toto.io/Statement/v1" &&
        statement.predicateType === PREDICATE_TYPE &&
        Array.isArray(statement.subject) &&
        statement.subject.some((subject) => subject?.digest?.sha256 === contentSha256);
    });
    if (!verified) {
      throw new Error("Verified attestation does not bind the expected quality execution");
    }
    return Object.freeze({
      contentSha256,
      repository: expected.repository,
      repositoryId: expected.repositoryId,
      runId: expected.runId,
      attempt: expected.attempt,
      event: expected.event,
      controlSha: expected.validator.executingCommitSha,
      sourceRef: expected.validator.executingRef,
      workflowPath: expected.validator.workflowPath,
    });
  } finally {
    fs.rmSync(filename, { force: true });
    fs.rmdirSync(directory);
  }
}

module.exports = { verifyQualityManifest };
