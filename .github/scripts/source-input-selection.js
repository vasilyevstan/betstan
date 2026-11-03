"use strict";

const crypto = require("node:crypto");

const PACKAGES = Object.freeze([
  "auth", "backoffice", "bet", "client", "common", "event",
  "gamemaster", "moderation", "resulting", "slip", "telemetry",
]);
const CONTROL_INPUTS = [
  ".github/scripts/", ".github/workflows/source-quality.yml",
];
const CONTRACT_SUITES = [
  ["manifest", "manifest"],
  ["ingress", "ingress"],
  ["workflow", "workflow"],
  ["runtime-contracts", "runtime-contracts"],
  ["azure-contracts", "azure-contracts"],
  ...["core", "live", "provenance", "rollback"].map((shard) => [`oci-${shard}`, `oci-${shard}`]),
];
const CONTRACT_SELECTION_ROOTS = {
  manifest: ["infra/k8s/", "infra/k8s-prod/", "infra/k8s-stage/"],
  ingress: ["infra/", ".github/workflows/", ".gitignore", "artifacts/"],
  workflow: [".github/", "infra/azure/agents/"],
  "runtime-contracts": ["infra/", ".github/"],
  "azure-contracts": ["infra/", ".github/"],
  "oci-core": [
    "infra/", ".github/", "docs/", "README.md", "CONTRIBUTING.md", "LEARNINGS.md",
    ".gitmodules", "common", "common/README.md", "backoffice/src/",
    "client/src/styles/ui.css", "client/src/pages/account/Backoffice.js",
    "client/src/pages/event/EventList.js", "client/tests/e2e/live-betting-regression.spec.js",
    "moderation/src/event/listener/LiveEventUpdateListener.ts",
    "moderation/src/runtime/ModerationRuntime.ts",
    "moderation/src/event/listener/__test__/LiveEventUpdateConsumption.test.ts",
    "moderation/src/runtime/__test__/ModerationRuntime.test.ts",
    "gamemaster/src/event/listener/CashBackSourceListener.ts",
    "bet/src/event/listener/CashBackOutcomeListener.ts",
    "resulting/src/event/listener/CashBackRequestListener.ts",
    "resulting/src/event/listener/CashBackSourceReplyListener.ts",
    "event/src/scripts/", "event/package.json",
  ],
  "oci-live": ["infra/", ".github/", "telemetry/src/event/TelemetryConsumer.ts"],
  "oci-provenance": ["infra/", ".github/", "docs/wiki/Release-Orchestration.md", "auth/src/index.ts"],
  "oci-rollback": ["infra/", ".github/"],
};
const LISTENER_PATTERN =
  "^(auth|backoffice|bet|event|gamemaster|moderation|resulting|slip)/src/(?:.*/)?[^/]*Listener\\.ts$";
const DEFINITIONS = [
  {
    suiteId: "source-policy", runnerId: "source-policy",
    inputRoots: [
      ".github/scripts/", ".github/workflows/branch-policy.yml",
      "infra/azure/agents/pr-validation-stan.sh", "infra/azure/agents/test-pr-validation-stan.sh",
    ], sharedInputPaths: CONTROL_INPUTS,
    executionProfile: "node-policy", reuseAllowed: true,
  },
  ...PACKAGES.map((name) => ({
    suiteId: `package-${name}`, runnerId: `package-${name}`,
    inputRoots: [`${name}/`, "common/"], sharedInputPaths: CONTROL_INPUTS,
    executionProfile: "package", reuseAllowed: false,
  })),
  {
    suiteId: "auth-image", runnerId: "auth-image",
    inputRoots: ["auth/"], sharedInputPaths: CONTROL_INPUTS,
    executionProfile: "docker", reuseAllowed: false,
  },
  ...CONTRACT_SUITES.map(([suiteId, runnerId]) => ({
    suiteId, runnerId, inputRoots: [""], sharedInputPaths: [],
    selectionRoots: CONTRACT_SELECTION_ROOTS[suiteId],
    selectionPatterns: suiteId === "oci-live" ? [LISTENER_PATTERN] : [],
    executionProfile: "contracts", reuseAllowed: false,
  })),
].map((suite) => Object.freeze({ ...suite, jobName: `quality (${suite.suiteId})` }));

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !value.startsWith("/") && !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function normalizeRecords(records) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("Complete candidate Git input records are required");
  }
  const paths = new Set();
  for (const record of records) {
    if (
      !record || !validPath(record.path) || paths.has(record.path) ||
      !["100644", "100755"].includes(record.mode) ||
      !/^[0-9a-f]{40}$/.test(record.blobSha)
    ) {
      throw new Error("Unsupported, duplicated or incomplete candidate Git input");
    }
    paths.add(record.path);
    const packageMatch = /^([^/]+)\/package\.json$/.exec(record.path);
    if (packageMatch && !PACKAGES.includes(packageMatch[1])) {
      throw new Error(`No quality runner covers package ${packageMatch[1]}`);
    }
  }
  return records.map(({ path, mode, blobSha }) => ({ path, mode, blobSha }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function under(file, root) {
  return root === "" || (root.endsWith("/") ? file.startsWith(root) : file === root);
}

function selectSuiteIds(changedPaths) {
  const selected = new Set();
  let conservative = false;
  for (const file of changedPaths) {
    for (const suite of DEFINITIONS) {
      if (
        [...(suite.selectionRoots ?? suite.inputRoots), ...suite.sharedInputPaths]
          .some((root) => under(file, root)) ||
        suite.selectionPatterns?.some((pattern) => new RegExp(pattern).test(file))
      ) {
        selected.add(suite.suiteId);
      }
    }
    const root = file.split("/")[0];
    if (PACKAGES.includes(root)) {
      selected.add(`package-${root}`);
      if (root === "auth") selected.add("auth-image");
      if (root === "common") {
        for (const name of PACKAGES) selected.add(`package-${name}`);
        selected.add("auth-image");
      }
    } else if (!(
      file.startsWith("infra/") || file.startsWith("docs/") ||
      file.startsWith("artifacts/") ||
      ["CONTRIBUTING.md", "LEARNINGS.md", "README.md", ".gitignore", ".gitmodules"].includes(file)
    )) {
      conservative = true;
    }
    selected.add("source-policy");
  }
  return {
    suiteIds: DEFINITIONS.filter((suite) => conservative || selected.has(suite.suiteId))
      .map((suite) => suite.suiteId),
    conservative,
  };
}

function selectSourceInputs({ records, changedPaths, executionProfiles }) {
  const normalized = normalizeRecords(records);
  if (
    !Array.isArray(changedPaths) || changedPaths.some((file) => !validPath(file)) ||
    new Set(changedPaths).size !== changedPaths.length
  ) {
    throw new Error("Changed paths must include a complete, distinct Git diff");
  }
  const selection = selectSuiteIds(changedPaths);
  const suites = DEFINITIONS.filter((suite) => selection.suiteIds.includes(suite.suiteId)).map((suite) => {
    const profile = executionProfiles?.[suite.executionProfile];
    if (
      !profile || typeof profile.identity !== "string" ||
      !/^[0-9a-f]{64}$/.test(profile.identity) ||
      typeof profile.immutable !== "boolean"
    ) {
      throw new Error(`Missing execution profile for ${suite.suiteId}`);
    }
    if (suite.runnerId.startsWith("package-")) {
      const name = suite.runnerId.slice("package-".length);
      for (const filename of ["package.json", "package-lock.json"]) {
        if (!normalized.some((record) => record.path === `${name}/${filename}`)) {
          throw new Error(`Required package input is missing: ${name}/${filename}`);
        }
      }
    }
    const inputs = normalized.filter((record) =>
      [...suite.inputRoots, ...suite.sharedInputPaths].some((root) => under(record.path, root)),
    );
    if (inputs.length === 0) throw new Error(`No captured inputs for ${suite.suiteId}`);
    const runnerContract = [
      suite.runnerId, suite.inputRoots, suite.sharedInputPaths,
      suite.selectionRoots ?? suite.inputRoots, suite.selectionPatterns ?? [],
      suite.executionProfile, profile.identity, profile.immutable,
    ];
    return {
      suiteId: suite.suiteId,
      jobName: suite.jobName,
      runnerId: suite.runnerId,
      executionProfile: suite.executionProfile,
      profileIdentity: profile.identity,
      reuseAllowed: suite.reuseAllowed && profile.immutable && !selection.conservative,
      inputClosureSha256: digest(["betstan.suite-inputs.v1", suite.suiteId, runnerContract, inputs]),
    };
  });
  const selectionDigest = digest([
    "betstan.source-selection.v1", [...changedPaths].sort(),
    selection.conservative, suites,
  ]);
  return {
    suites,
    noWork: suites.length === 0,
    conservative: selection.conservative,
    selectionDigest,
    inputClosureSha256: digest([
      "betstan.selected-inputs.v1",
      suites.map(({ suiteId, inputClosureSha256 }) => [suiteId, inputClosureSha256]),
    ]),
  };
}

module.exports = { PACKAGES, selectSourceInputs };
