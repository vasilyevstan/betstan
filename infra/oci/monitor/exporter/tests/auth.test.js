const assert = require("node:assert/strict");
const {
  generateKeyPairSync,
  sign,
} = require("node:crypto");
const test = require("node:test");

const {
  resetReplayCacheForTests,
  verifyGithubOidc,
} = require("../dist/auth.js");

const repository = "vasilyevstan/betstan";
const workflowPath = ".github/workflows/oci-production-monitor.yml";
const ref = "refs/heads/master";
const sha = "a".repeat(40);
const now = 1_788_192_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = publicKey.export({ format: "jwk" });
jwk.alg = "RS256";
jwk.kid = "monitor-test-key";
jwk.use = "sig";

function token(overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://token.actions.githubusercontent.com",
      aud: "betstan-production-monitor",
      repository,
      ref,
      sha,
      workflow_sha: sha,
      workflow_ref: `${repository}/${workflowPath}@${ref}`,
      sub: `repo:${repository}:ref:${ref}`,
      event_name: "schedule",
      jti: "jti-1",
      iat: now - 5,
      nbf: now - 5,
      exp: now + 300,
      ...overrides,
    }),
  ).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function policy() {
  return {
    audience: "betstan-production-monitor",
    repository,
    workflowPath,
    ref,
    subject: `repo:${repository}:ref:${ref}`,
    expectedSha: sha,
    eventNames: ["schedule", "workflow_dispatch"],
    nowSeconds: now,
  };
}

const keys = async () => ({ keys: [jwk] });

test.beforeEach(() => {
  resetReplayCacheForTests();
});

test("accepts an exact GitHub Actions OIDC identity", async () => {
  const payload = await verifyGithubOidc(token(), policy(), keys);
  assert.equal(payload.repository, repository);
});

test("rejects a token replay", async () => {
  const value = token();
  await verifyGithubOidc(value, policy(), keys);
  await assert.rejects(
    verifyGithubOidc(value, policy(), keys),
    /replay/,
  );
});

test("rejects a different workflow source SHA", async () => {
  await assert.rejects(
    verifyGithubOidc(
      token({ workflow_sha: "b".repeat(40), jti: "jti-2" }),
      policy(),
      keys,
    ),
    /workflow SHA/,
  );
});

test("rejects a different subject or event", async () => {
  await assert.rejects(
    verifyGithubOidc(
      token({ sub: `repo:${repository}:environment:production`, jti: "jti-3" }),
      policy(),
      keys,
    ),
    /subject/,
  );
  await assert.rejects(
    verifyGithubOidc(
      token({ event_name: "pull_request", jti: "jti-4" }),
      policy(),
      keys,
    ),
    /event/,
  );
});
