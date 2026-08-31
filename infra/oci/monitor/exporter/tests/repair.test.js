const assert = require("node:assert/strict");
const test = require("node:test");

const { operationDocument, terminalOperation } = require("../dist/repair");

const previous = {
  schema: "betstan.production-operation.v1",
  environment: "oci-production",
  generation: 4,
  operation_id: "deploy-20-1",
  repair_id: "",
  workflow_path: ".github/workflows/oci-production-deploy.yml",
  run_id: 20,
  run_attempt: 1,
  control_sha: "a".repeat(40),
  target_sha: "a".repeat(40),
  phase: "succeeded",
  expected_transient_codes: [],
  heartbeat_at: "2026-09-01T11:55:00Z",
  expires_at: "2026-09-01T12:00:00Z",
  state: "succeeded",
};

test("creates an exact self-heal operation from terminal state", () => {
  const operation = operationDocument(
    previous,
    { run_id: "41", run_attempt: "1", sha: "c".repeat(40) },
    "incident-7-repair-1",
    "b".repeat(40),
    "restarting",
    new Date("2026-09-01T12:05:00Z"),
  );

  assert.equal(operation.generation, 5);
  assert.equal(operation.operation_id, "self-heal-41-1");
  assert.equal(operation.repair_id, "incident-7-repair-1");
  assert.equal(operation.control_sha, "c".repeat(40));
  assert.equal(operation.target_sha, "b".repeat(40));
  assert.equal(operation.state, "active");
  assert.deepEqual(operation.expected_transient_codes, [
    "workload-not-ready",
    "service-endpoint-empty",
    "public-api-failed",
    "public-home-failed",
  ]);
});

test("rejects an overlapping active operation", () => {
  assert.throws(
    () =>
      operationDocument(
        {
          ...previous,
          state: "active",
          phase: "deploying",
          expires_at: "2026-09-01T12:20:00Z",
        },
        { run_id: "41", run_attempt: "1", sha: "c".repeat(40) },
        "incident-7-repair-1",
        "b".repeat(40),
        "restarting",
        new Date("2026-09-01T12:05:00Z"),
      ),
    /another-production-operation-active/,
  );
});

test("finishes only an active operation", () => {
  const active = {
    ...previous,
    state: "active",
    phase: "validating",
  };
  const completed = terminalOperation(
    active,
    "succeeded",
    new Date("2026-09-01T12:10:00Z"),
  );
  assert.equal(completed.generation, 5);
  assert.equal(completed.state, "succeeded");
  assert.deepEqual(completed.expected_transient_codes, []);
  assert.throws(
    () =>
      terminalOperation(
        completed,
        "failed",
        new Date("2026-09-01T12:11:00Z"),
      ),
    /operation-already-terminal/,
  );
});
