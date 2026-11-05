"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { QUALITY_EVENTS, QualityEvidenceError } = require("./pr-source-snapshot.js");

const PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const MAX_MANIFEST_BYTES = 1024 * 1024;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readQualityAttestation({ content, expected }, execute, discoverController, nativeDispatch = false) {
  if (
    typeof content !== "string" || Buffer.byteLength(content) > MAX_MANIFEST_BYTES ||
    !expected || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository) ||
    !Number.isSafeInteger(expected.repositoryId) || expected.repositoryId < 1 ||
    !Number.isSafeInteger(expected.runId) || expected.runId < 1 ||
    !Number.isSafeInteger(expected.attempt) || expected.attempt < 1 ||
    !(nativeDispatch ? expected.event === "pull_request" : QUALITY_EVENTS.includes(expected.event)) ||
    !expected.validator ||
    !/^\.github\/workflows\/[A-Za-z0-9_-]+\.ya?ml$/.test(expected.validator.workflowPath) ||
    (nativeDispatch && expected.validator.workflowPath !== ".github/workflows/oci-validate.yml") ||
    (nativeDispatch && expected.attempt !== 1) ||
    (!discoverController && (
      !/^[0-9a-f]{40}$/.test(expected.validator.executingCommitSha) ||
      !["refs/heads/dev", "refs/heads/master"].includes(expected.validator.executingRef)
    ))
  ) {
    throw new QualityEvidenceError("Invalid trusted quality attestation identity or manifest size");
  }

  const contentSha256 = sha256(content);
  const repositoryURI = `https://github.com/${expected.repository}`;
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
        ...(discoverController ? [] : [
          "--signer-digest", expected.validator.executingCommitSha,
          "--source-digest", expected.validator.executingCommitSha,
          "--source-ref", expected.validator.executingRef,
        ]),
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
      if (nativeDispatch && !Number.isInteger(error?.status) &&
        !["ENOENT", "EACCES", "ETIMEDOUT", "ENOBUFS"].includes(error?.code)) throw error;
      throw new QualityEvidenceError("Native quality attestation verification failed", { cause: error });
    }
    if (sha256(fs.readFileSync(filename)) !== contentSha256) {
      throw new QualityEvidenceError("Quality manifest changed during native verification");
    }
    const results = JSON.parse(output);
    if (!Array.isArray(results) || results.length === 0) {
      throw new QualityEvidenceError("Native verifier returned no verified attestations");
    }

    // These certificate fields come from GitHub OIDC, not the signed predicate.
    const matches = results.filter((result) => {
      const verification = result?.verificationResult;
      const certificate = verification?.signature?.certificate;
      const statement = verification?.statement;
      const controlSha = discoverController
        ? certificate?.buildSignerDigest : expected.validator.executingCommitSha;
      const sourceRef = discoverController
        ? certificate?.sourceRepositoryRef : expected.validator.executingRef;
      const signerURI = `${repositoryURI}/${expected.validator.workflowPath}@${sourceRef}`;
      const supportedRef = nativeDispatch
        ? /^refs\/pull\/[1-9][0-9]*\/merge$/.test(sourceRef ?? "")
        : ["refs/heads/dev", "refs/heads/master"].includes(sourceRef);
      return certificate &&
        typeof controlSha === "string" && /^[0-9a-f]{40}$/.test(controlSha) &&
        supportedRef &&
        certificate.issuer === "https://token.actions.githubusercontent.com" &&
        certificate.subjectAlternativeName === signerURI &&
        certificate.buildSignerURI === signerURI &&
        certificate.buildSignerDigest === controlSha &&
        certificate.sourceRepositoryURI === repositoryURI &&
        certificate.sourceRepositoryIdentifier === String(expected.repositoryId) &&
        certificate.sourceRepositoryDigest === controlSha &&
        certificate.sourceRepositoryRef === sourceRef &&
        certificate.buildConfigURI === signerURI &&
        certificate.buildConfigDigest === controlSha &&
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
    if (matches.length === 0) {
      throw new QualityEvidenceError("Verified attestation does not bind the expected quality execution");
    }
    const identities = matches.map((match) => {
      const certificate = match.verificationResult.signature.certificate;
      return `${certificate.buildSignerDigest}|${certificate.sourceRepositoryRef}`;
    });
    if (new Set(identities).size !== 1) {
      throw new QualityEvidenceError("Verified attestations disagree on the controller identity");
    }
    const certificate = matches[0].verificationResult.signature.certificate;
    return Object.freeze({
      contentSha256,
      repository: expected.repository,
      repositoryId: expected.repositoryId,
      runId: expected.runId,
      attempt: expected.attempt,
      event: expected.event,
      controlSha: certificate.buildSignerDigest,
      sourceRef: certificate.sourceRepositoryRef,
      workflowPath: expected.validator.workflowPath,
      ...(nativeDispatch ? {
        signerSha: certificate.buildSignerDigest,
        callerSha: certificate.buildConfigDigest,
        sourceSha: certificate.sourceRepositoryDigest,
      } : {}),
    });
  } finally {
    fs.rmSync(filename, { force: true });
    fs.rmdirSync(directory);
  }
}

// Provisional inline-PR identity shape. In particular, none of these certified
// commits is replaced with Actions REST head_sha (the feature head for a PR).
// Native identity bring-up must verify this shape before caller adoption.
function verifyNativeDispatchManifest(input, execute = execFileSync) {
  return readQualityAttestation(input, execute, true, true);
}

function verifyQualityManifest(input, execute = execFileSync) {
  return readQualityAttestation(input, execute, false);
}

async function verifyHistoricalQualityManifest({ approveController, ...input }, execute = execFileSync) {
  if (typeof approveController !== "function") {
    throw new Error("Historical quality verification requires independent controller approval");
  }
  const certificate = readQualityAttestation(input, execute, true);
  const approved = await approveController(certificate);
  if (approved !== true) {
    throw new QualityEvidenceError("Historical quality controller closure is not independently approved");
  }
  return certificate;
}

function readQualityArtifact({ repository, artifactId }, execute = execFileSync) {
  if (
    typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !Number.isSafeInteger(artifactId) || artifactId < 1
  ) {
    throw new QualityEvidenceError("Invalid quality artifact download identity");
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "betstan-quality-artifact-"));
  const filename = path.join(directory, "artifact.zip");
  try {
    const archive = execute("gh", ["api", `repos/${repository}/actions/artifacts/${artifactId}/zip`], {
      timeout: 60_000, maxBuffer: 2 * MAX_MANIFEST_BYTES, stdio: ["ignore", "pipe", "pipe"],
    });
    fs.writeFileSync(filename, archive, { flag: "wx", mode: 0o600 });
    return execute("unzip", ["-p", filename, "quality-manifest.json"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: MAX_MANIFEST_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error?.code === undefined && error?.status === undefined) throw error;
    throw new QualityEvidenceError("Quality artifact download or bounded archive read failed", { cause: error });
  } finally {
    fs.rmSync(filename, { force: true });
    fs.rmdirSync(directory);
  }
}

module.exports = {
  verifyQualityManifest, verifyHistoricalQualityManifest, readQualityArtifact, verifyNativeDispatchManifest,
};
