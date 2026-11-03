"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { verifyQualityManifest } = require("./quality-attestation.js");

function fixture() {
  const content = '{"schemaVersion":1,"suites":[]}';
  const expected = {
    repository: "example/repo",
    repositoryId: 77,
    runId: 102,
    attempt: 2,
    event: "pull_request_target",
    validator: {
      workflowPath: ".github/workflows/source-quality.yml",
      executingCommitSha: "1".repeat(40),
      executingRef: "refs/heads/dev",
    },
  };
  const signerURI = "https://github.com/example/repo/.github/workflows/source-quality.yml@refs/heads/dev";
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    subjectAlternativeName: signerURI,
    buildSignerURI: signerURI,
    buildSignerDigest: expected.validator.executingCommitSha,
    sourceRepositoryURI: "https://github.com/example/repo",
    sourceRepositoryIdentifier: "77",
    sourceRepositoryDigest: expected.validator.executingCommitSha,
    sourceRepositoryRef: expected.validator.executingRef,
    buildConfigURI: signerURI,
    buildConfigDigest: expected.validator.executingCommitSha,
    buildTrigger: "pull_request_target",
    runInvocationURI: "https://github.com/example/repo/actions/runs/102/attempts/2",
    runnerEnvironment: "github-hosted",
  };
  const result = {
    verificationResult: {
      signature: { certificate },
      verifiedTimestamps: [{ type: "Tlog", timestamp: "2026-09-01T00:00:00Z" }],
      statement: {
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://slsa.dev/provenance/v1",
        subject: [{
          name: "quality-manifest.json",
          digest: { sha256: crypto.createHash("sha256").update(content).digest("hex") },
        }],
        predicate: {},
      },
    },
  };
  return { input: { content, expected }, certificate, result };
}

const paths = [];
const valid = fixture();
const verified = verifyQualityManifest(valid.input, (command, args, options) => {
  assert.equal(command, "gh");
  paths.push(args[2]);
  assert.equal(fs.readFileSync(args[2], "utf8"), valid.input.content);
  assert.deepEqual(args, [
    "attestation", "verify", args[2],
    "--hostname", "github.com",
    "--repo", "example/repo",
    "--signer-workflow", "example/repo/.github/workflows/source-quality.yml",
    "--signer-digest", "1".repeat(40),
    "--source-digest", "1".repeat(40),
    "--source-ref", "refs/heads/dev",
    "--predicate-type", "https://slsa.dev/provenance/v1",
    "--deny-self-hosted-runners",
    "--format", "json",
  ]);
  assert.equal(options.shell, undefined);
  return JSON.stringify([valid.result]);
});
assert.equal(verified.contentSha256, valid.result.verificationResult.statement.subject[0].digest.sha256);
assert.equal(verified.attempt, 2);

const dispatched = fixture();
dispatched.input.expected.event = "workflow_dispatch";
dispatched.certificate.buildTrigger = "workflow_dispatch";
assert.equal(
  verifyQualityManifest(dispatched.input, () => JSON.stringify([dispatched.result])).event,
  "workflow_dispatch",
);

for (const field of Object.keys(valid.certificate)) {
  const invalid = fixture();
  invalid.certificate[field] = "untrusted";
  invalid.result.verificationResult.statement.predicate = {
    certificate: valid.certificate,
    runId: 102,
    attempt: 2,
  };
  assert.throws(() => verifyQualityManifest(invalid.input, (_command, args) => {
    paths.push(args[2]);
    return JSON.stringify([invalid.result]);
  }), /does not bind/);
}

for (const mutate of [
  (result) => { result.verificationResult.verifiedTimestamps = []; },
  (result) => { result.verificationResult.statement.subject[0].digest.sha256 = "0".repeat(64); },
  (result) => { result.verificationResult.statement.predicateType = "custom"; },
  (result) => { result.verificationResult.statement._type = "custom"; },
  (result) => { result.attestation = result.verificationResult; delete result.verificationResult; },
]) {
  const invalid = fixture();
  mutate(invalid.result);
  assert.throws(() => verifyQualityManifest(invalid.input, () => JSON.stringify([invalid.result])), /does not bind/);
}

assert.throws(() => verifyQualityManifest(fixture().input, (_command, args) => {
  paths.push(args[2]);
  throw new Error("signature mismatch");
}), /Native quality attestation verification failed/);
assert.throws(() => verifyQualityManifest(fixture().input, () => "[]"), /no verified attestations/);
assert.throws(() => verifyQualityManifest(fixture().input, () => "{"), SyntaxError);
assert.throws(() => verifyQualityManifest(fixture().input, (_command, args) => {
  paths.push(args[2]);
  fs.writeFileSync(args[2], "replaced");
  return JSON.stringify([fixture().result]);
}), /changed during native verification/);

for (const mutate of [
  (input) => { input.expected.validator.executingRef = "refs/heads/feature"; },
  (input) => { input.expected.validator.executingCommitSha = "dev"; },
  (input) => { input.expected.validator.workflowPath = "../candidate.js"; },
  (input) => { input.expected.runId = 0; },
  (input) => { input.expected.attempt = 0; },
  (input) => { input.expected.event = "push"; },
  (input) => { input.expected.repositoryId = 0; },
  (input) => { input.content = "x".repeat(1024 * 1024 + 1); },
]) {
  const invalid = fixture().input;
  mutate(invalid);
  assert.throws(() => verifyQualityManifest(invalid, () => {
    assert.fail("invalid identity must not invoke the verifier");
  }), /Invalid trusted quality/);
}
for (const filename of paths) {
  assert.equal(fs.existsSync(filename), false);
  assert.equal(fs.existsSync(path.dirname(filename)), false);
}

console.log("quality_attestation_tests=PASS");
