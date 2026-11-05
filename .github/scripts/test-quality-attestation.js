"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const {
  verifyQualityManifest, verifyHistoricalQualityManifest, readQualityArtifact, verifyNativeDispatchManifest,
} = require("./quality-attestation.js");
const { QualityEvidenceError } = require("./pr-source-snapshot.js");

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

async function testHistoricalQualityAttestation() {
  const original = fixture();
  original.input.expected.validator = { workflowPath: ".github/workflows/source-quality.yml" };
  let approvals = 0;
  const historical = await verifyHistoricalQualityManifest({
    ...original.input,
    approveController: async (certificate) => {
      approvals += 1;
      assert.equal(certificate.controlSha, "1".repeat(40));
      assert.equal(certificate.sourceRef, "refs/heads/dev");
      assert.equal(certificate.runId, 102);
      return true;
    },
  }, (_command, args) => {
    assert.ok(!args.includes("--signer-digest"));
    assert.ok(!args.includes("--source-digest"));
    assert.ok(args.includes("--signer-workflow"));
    return JSON.stringify([original.result]);
  });
  assert.equal(approvals, 1);
  assert.equal(historical.contentSha256, verified.contentSha256);

  for (const approval of [false, undefined, { approved: true }]) {
    await assert.rejects(verifyHistoricalQualityManifest({
      ...original.input, approveController: async () => approval,
    }, () => JSON.stringify([original.result])), /not independently approved/);
  }
  await assert.rejects(verifyHistoricalQualityManifest({
    ...original.input, approveController: async () => { throw new Error("closure mismatch"); },
  }, () => JSON.stringify([original.result])), /closure mismatch/);
  await assert.rejects(verifyHistoricalQualityManifest(original.input, () => {
    assert.fail("missing approval contract must fail before invoking native verification");
  }), /independent controller approval/);

  for (const field of Object.keys(original.certificate)) {
    const invalid = structuredClone(original);
    invalid.certificate[field] = "untrusted";
    invalid.result.verificationResult.signature.certificate = invalid.certificate;
    await assert.rejects(verifyHistoricalQualityManifest({
      ...invalid.input,
      approveController: async () => assert.fail("invalid native identity must not reach closure approval"),
    }, () => JSON.stringify([invalid.result])), /does not bind/);
  }
  const other = structuredClone(original.result);
  for (const field of ["buildSignerDigest", "sourceRepositoryDigest", "buildConfigDigest"]) {
    other.verificationResult.signature.certificate[field] = "2".repeat(40);
  }
  await assert.rejects(verifyHistoricalQualityManifest({
    ...original.input, approveController: async () => true,
  }, () => JSON.stringify([original.result, other])), /disagree/);
  testArtifactDownload();
  console.log("historical_quality_attestation_tests=PASS");
}

function testArtifactDownload() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quality-download-test-"));
  const document = path.join(directory, "quality-manifest.json");
  const archive = path.join(directory, "fixture.zip");
  const downloaded = [];
  try {
    fs.writeFileSync(document, '{"schemaVersion":2}\n');
    execFileSync("zip", ["-q", "-j", archive, document]);
    const bytes = fs.readFileSync(archive);
    const execute = (command, args, options) => {
      if (command === "gh") {
        assert.deepEqual(args, ["api", "repos/example/repo/actions/artifacts/71/zip"]);
        assert.equal(options.maxBuffer, 2 * 1024 * 1024);
        return bytes;
      }
      assert.equal(command, "unzip");
      assert.equal(args[0], "-p");
      assert.equal(args[2], "quality-manifest.json");
      assert.equal(options.maxBuffer, 1024 * 1024);
      downloaded.push(args[1]);
      return execFileSync(command, args, options);
    };
    assert.equal(readQualityArtifact({ repository: "example/repo", artifactId: 71 }, execute),
      '{"schemaVersion":2}\n');
    assert.throws(() => readQualityArtifact({ repository: "../outside", artifactId: 71 }, execute),
      QualityEvidenceError);
    assert.throws(() => readQualityArtifact({ repository: "example/repo", artifactId: 71 }, (command, args, options) => {
      if (command === "gh") return Buffer.from("invalid archive");
      downloaded.push(args[1]);
      return execFileSync(command, args, options);
    }), QualityEvidenceError);
    assert.throws(() => readQualityArtifact({ repository: "example/repo", artifactId: 71 }, () => {
      throw new TypeError("adapter bug");
    }), TypeError);
  } finally {
    fs.rmSync(document, { force: true });
    fs.rmSync(archive, { force: true });
    fs.rmdirSync(directory);
  }
  for (const filename of downloaded) {
    assert.equal(fs.existsSync(filename), false);
    assert.equal(fs.existsSync(path.dirname(filename)), false);
  }
}

function testNativeDispatchCertificate() {
  function nativeFixture() {
    const value = fixture();
    value.input.expected.attempt = 1;
    value.input.expected.event = "pull_request";
    value.input.expected.validator = { workflowPath: ".github/workflows/oci-validate.yml" };
    const uri = "https://github.com/example/repo/.github/workflows/oci-validate.yml@refs/pull/63/merge";
    Object.assign(value.certificate, {
      subjectAlternativeName: uri, buildSignerURI: uri, buildConfigURI: uri,
      sourceRepositoryRef: "refs/pull/63/merge", buildTrigger: "pull_request",
      runInvocationURI: "https://github.com/example/repo/actions/runs/102/attempts/1",
    });
    return value;
  }
  const valid = nativeFixture();
  const verified = verifyNativeDispatchManifest(valid.input, () => JSON.stringify([valid.result]));
  assert.equal(verified.sourceSha, valid.certificate.sourceRepositoryDigest);
  assert.equal(verified.callerSha, verified.sourceSha);
  assert.equal(verified.signerSha, verified.sourceSha);
  assert.throws(() => verifyNativeDispatchManifest(valid.input, () => { throw new TypeError("native verifier bug"); }), TypeError);
  assert.throws(() => verifyQualityManifest(valid.input, () => JSON.stringify([valid.result])));
  for (const mutate of [
    (value) => { value.certificate.buildSignerURI = value.certificate.buildSignerURI.replace("oci-validate", "reusable-signer"); },
    (value) => { value.certificate.buildConfigDigest = "2".repeat(40); },
    (value) => { value.certificate.sourceRepositoryDigest = "2".repeat(40); },
    (value) => { value.certificate.sourceRepositoryRef = "refs/heads/dev"; },
    (value) => { value.certificate.runnerEnvironment = "self-hosted"; },
    (value) => { value.certificate.runInvocationURI += "/other"; },
    (value) => { value.input.expected.attempt = 2; },
    (value) => { value.input.expected.validator.workflowPath = ".github/workflows/source-quality.yml"; },
    (value) => { value.input.expected.event = "pull_request_target"; },
    (value) => { value.result.verificationResult.statement.subject[0].digest.sha256 = "0".repeat(64); },
  ]) {
    const invalid = nativeFixture();
    mutate(invalid);
    assert.throws(() => verifyNativeDispatchManifest(invalid.input, () => JSON.stringify([invalid.result])));
  }
  assert.throws(() => verifyNativeDispatchManifest(fixture().input, () => JSON.stringify([fixture().result])));
  console.log("native_dispatch_certificate_shape_tests=PASS (synthetic; not native qualification)");
}
testNativeDispatchCertificate();

if (require.main === module) {
  testHistoricalQualityAttestation().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
module.exports = testHistoricalQualityAttestation;
