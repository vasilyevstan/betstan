#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const engine = require("./test-coverage-matrix");

const REPOSITORY_ROOT = path.resolve(__dirname, "../..");
const CURRENT_ENTRIES = [
  ["auth", "jest-typescript"],
  ["backoffice", "jest-typescript"],
  ["bet", "jest-typescript"],
  ["client", "react-scripts"],
  ["common", "node-typescript-c8"],
  ["event", "jest-typescript"],
  ["gamemaster", "jest-typescript"],
  ["moderation", "jest-typescript"],
  ["resulting", "jest-typescript"],
  ["slip", "jest-typescript"],
];
const temporaryDirectories = new Set();

function temporaryDirectory() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "betstan-coverage-matrix-"),
  );
  temporaryDirectories.add(directory);
  return directory;
}

test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

test("excludes compound test and spec filenames without excluding production names", () => {
  const typescriptEntry = { id: "telemetry", profile: "jest-typescript" };
  const reactEntry = { id: "client", profile: "react-scripts" };
  assert.equal(
    engine.isEligibleSourcePath(
      typescriptEntry,
      "telemetry/src/worker.test.integration.ts",
    ),
    false,
  );
  assert.equal(
    engine.isEligibleSourcePath(
      typescriptEntry,
      "telemetry/src/worker.spec.contract.tsx",
    ),
    false,
  );
  assert.equal(
    engine.isEligibleSourcePath(
      reactEntry,
      "client/src/component.test.integration.js",
    ),
    false,
  );
  assert.equal(
    engine.isEligibleSourcePath(
      reactEntry,
      "client/src/component.spec.browser.jsx",
    ),
    false,
  );
  assert.equal(
    engine.isEligibleSourcePath(
      typescriptEntry,
      "telemetry/src/testingSupport.ts",
    ),
    true,
  );
  assert.equal(
    engine.isEligibleSourcePath(
      reactEntry,
      "client/src/spectrum.js",
    ),
    true,
  );
  for (const [entry, repoPath] of [
    [typescriptEntry, "telemetry/src/__tests__/regression.ts"],
    [typescriptEntry, "telemetry/src/test.ts"],
    [typescriptEntry, "telemetry/src/spec.tsx"],
    [reactEntry, "client/src/__tests__/regression.js"],
    [reactEntry, "client/src/test.jsx"],
  ]) {
    assert.equal(engine.isTestSourcePath(entry, repoPath), true);
    assert.equal(engine.isEligibleSourcePath(entry, repoPath), false);
  }
});

function writeFile(root, relativePath, contents) {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  return filePath;
}

function writeJson(root, relativePath, value) {
  return writeFile(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function copyFile(sourceRoot, targetRoot, relativePath) {
  const source = path.join(sourceRoot, ...relativePath.split("/"));
  const target = path.join(targetRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function command(cwd, executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Coverage Matrix Test",
      GIT_AUTHOR_EMAIL: "coverage-matrix@example.invalid",
      GIT_COMMITTER_NAME: "Coverage Matrix Test",
      GIT_COMMITTER_EMAIL: "coverage-matrix@example.invalid",
    },
  });
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${executable} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function git(root, ...args) {
  return command(root, "git", args).stdout.trim();
}

function descriptor(entries = CURRENT_ENTRIES) {
  return {
    schemaVersion: 1,
    runtime: { node: "20.19.5" },
    thresholds: { lines: 80, branches: 80 },
    entries: entries.map(([id, profile]) => ({ id, profile })),
  };
}

function packageDefinition(id, profile) {
  const name = id === "common" ? "@betstan/common" : id;
  const manifest = {
    name,
    version: "1.0.0",
    scripts: {},
    dependencies: {},
    devDependencies: {},
  };
  const lockPackages = {
    "": { name, version: "1.0.0" },
  };
  const registryRecord = (packageName, version, bin) => ({
    version,
    resolved:
      `https://registry.npmjs.org/${packageName}/-/` +
      `${packageName.split("/").pop()}-${version}.tgz`,
    integrity: "sha512-AAAA",
    ...(bin ? { bin } : {}),
  });
  if (profile === "jest-typescript") {
    manifest.scripts["test:ci"] = "jest";
    manifest.jest = {
      preset: "ts-jest",
      testEnvironment: "node",
      setupFilesAfterEnv: ["./src/test/setup.ts"],
    };
    manifest.dependencies.typescript = "5.9.2";
    manifest.devDependencies.jest = "29.7.0";
    manifest.devDependencies["ts-jest"] = "29.2.5";
    lockPackages["node_modules/jest"] = registryRecord(
      "jest",
      "29.7.0",
      { jest: "bin/jest.js" },
    );
    lockPackages["node_modules/ts-jest"] = registryRecord(
      "ts-jest",
      "29.2.5",
    );
    lockPackages["node_modules/typescript"] = registryRecord(
      "typescript",
      "5.9.2",
      { tsc: "bin/tsc", tsserver: "bin/tsserver" },
    );
  } else if (profile === "react-scripts") {
    manifest.scripts.test = "react-scripts test";
    manifest.scripts.build = "react-scripts build";
    manifest.dependencies["react-scripts"] = "5.0.1";
    lockPackages["node_modules/react-scripts"] = registryRecord(
      "react-scripts",
      "5.0.1",
      { "react-scripts": "bin/react-scripts.js" },
    );
  } else {
    manifest.scripts.clean = "del ./build/*";
    manifest.dependencies.typescript = "5.9.2";
    manifest.devDependencies["del-cli"] = "5.1.0";
    lockPackages["node_modules/typescript"] = registryRecord(
      "typescript",
      "5.9.2",
      { tsc: "bin/tsc", tsserver: "bin/tsserver" },
    );
    lockPackages["node_modules/del-cli"] = registryRecord(
      "del-cli",
      "5.1.0",
      { del: "cli.js", "del-cli": "cli.js" },
    );
  }
  const lock = {
    name,
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: lockPackages,
  };
  return { manifest, lock };
}

function writePackage(root, id, profile) {
  const { manifest, lock } = packageDefinition(id, profile);
  writeJson(root, `${id}/package.json`, manifest);
  writeJson(root, `${id}/package-lock.json`, lock);
  const extension = profile === "react-scripts" ? "js" : "ts";
  writeFile(root, `${id}/src/index.${extension}`, "export const value = 1;\n");
  if (profile === "jest-typescript") {
    writeFile(root, `${id}/src/index.test.ts`, "test('fixture', () => {});\n");
    writeFile(root, `${id}/src/test/setup.ts`, "\n");
    writeJson(root, `${id}/tsconfig.json`, { compilerOptions: {} });
  }
  if (profile === "react-scripts") {
    writeFile(root, `${id}/src/index.test.js`, "test('fixture', () => {});\n");
  }
  if (profile === "node-typescript-c8") {
    writeJson(root, `${id}/tsconfig.json`, { compilerOptions: {} });
    writeJson(root, `${id}/tsconfig.test.json`, { compilerOptions: {} });
    writeJson(root, `${id}/tsconfig.legacy-amqp.json`, { compilerOptions: {} });
    writeFile(
      root,
      `${id}/tests/common.test.js`,
      'require("node:test")("common", () => {});\n',
    );
  }
}

function commitAll(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function createFixture(options = {}) {
  const root = temporaryDirectory();
  command(root, "git", ["init", "--quiet"]);
  const entries = [...CURRENT_ENTRIES];
  if (options.telemetry) {
    entries.push(["telemetry", "jest-typescript"]);
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  }
  for (const [id, profile] of entries) {
    writePackage(root, id, profile);
  }
  copyFile(REPOSITORY_ROOT, root, engine.ENGINE_PATH);
  copyFile(REPOSITORY_ROOT, root, engine.TOOL_PACKAGE_PATH);
  copyFile(REPOSITORY_ROOT, root, engine.TOOL_LOCK_PATH);
  writeJson(root, engine.DESCRIPTOR_PATH, descriptor(entries));
  writeFile(
    root,
    engine.WORKFLOW_PATH,
    "name: production-build\non:\n  push:\n    branches: [master]\n",
  );
  const baseSha = commitAll(root, "fixture base");
  writeFile(root, "common/src/index.ts", "export const value = 2;\n");
  if (options.telemetry) {
    writeFile(root, "telemetry/src/index.ts", "export const value = 2;\n");
  }
  const headSha = commitAll(root, "fixture head");
  const tree = git(root, "rev-parse", `${headSha}^{tree}`);
  const mergeSnapshotSha = git(
    root,
    "commit-tree",
    tree,
    "-p",
    baseSha,
    "-p",
    headSha,
    "-m",
    "fixture merge",
  );
  const workflowBlob = git(
    root,
    "rev-parse",
    `${mergeSnapshotSha}:${engine.WORKFLOW_PATH}`,
  );
  const context = {
    schemaVersion: 1,
    repository: {
      name: engine.CANONICAL_REPOSITORY,
      event: "pull_request",
      baseSha,
      headSha,
      mergeSnapshotSha,
      checkoutSha: mergeSnapshotSha,
      runId: "123456",
      runAttempt: 1,
    },
    workflow: {
      id: "98765",
      path: engine.WORKFLOW_PATH,
      blob: workflowBlob,
      runHeadSha: mergeSnapshotSha,
    },
    engine: {
      trustedDefaultSha: baseSha,
    },
  };
  return { root, baseSha, headSha, mergeSnapshotSha, context, entries };
}

function mutateDescriptor(root, mutate) {
  const filePath = path.join(root, ...engine.DESCRIPTOR_PATH.split("/"));
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(value);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function expectFailure(callback, pattern) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof engine.CoverageMatrixError, true);
    assert.match(error.message, pattern);
    return true;
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function assertProcessIdsGone(pids, timeoutMs = 2000) {
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && pids.some(processExists)) {
    Atomics.wait(waitArray, 0, 0, 25);
  }
  assert.deepEqual(pids.filter(processExists), []);
}

function coverageRecord(lines = [1], branches = [1, 1]) {
  const statementMap = {};
  const statements = {};
  lines.forEach((hits, index) => {
    statementMap[String(index)] = {
      start: { line: index + 1, column: 0 },
      end: { line: index + 1, column: 1 },
    };
    statements[String(index)] = hits;
  });
  return {
    path: "ignored",
    statementMap,
    branchMap:
      branches.length === 0
        ? {}
        : {
            0: {
              locations: branches.map(() => ({})),
            },
          },
    s: statements,
    b: branches.length === 0 ? {} : { 0: branches },
  };
}

function summaryMetric(covered, total) {
  return {
    total,
    covered,
    skipped: 0,
    pct: total === 0 ? "Unknown" : (covered * 100) / total,
  };
}

function writeCoverageReports(root, directory, files, options = {}) {
  const final = {};
  const summary = {};
  let lineCovered = 0;
  let lineTotal = 0;
  let branchCovered = 0;
  let branchTotal = 0;
  files.forEach((repoPath, index) => {
    const lines =
      index === 0 && options.lines ? options.lines : [1];
    const branches =
      index === 0 && options.branches ? options.branches : [1, 1];
    const key = options.relativePaths
      ? repoPath
      : path.join(root, ...repoPath.split("/"));
    final[key] = { ...coverageRecord(lines, branches), path: key };
    const currentLines = {
      covered: lines.filter((hits) => hits > 0).length,
      total: lines.length,
    };
    const currentBranches = {
      covered: branches.filter((hits) => hits > 0).length,
      total: branches.length,
    };
    lineCovered += currentLines.covered;
    lineTotal += currentLines.total;
    branchCovered += currentBranches.covered;
    branchTotal += currentBranches.total;
    summary[key] = {
      lines: summaryMetric(currentLines.covered, currentLines.total),
      branches: summaryMetric(
        currentBranches.covered,
        currentBranches.total,
      ),
      statements: summaryMetric(currentLines.covered, currentLines.total),
      functions: summaryMetric(0, 0),
    };
  });
  summary.total = {
    lines: summaryMetric(lineCovered, lineTotal),
    branches: summaryMetric(branchCovered, branchTotal),
    statements: summaryMetric(lineCovered, lineTotal),
    functions: summaryMetric(0, 0),
  };
  const coverageFinal = writeJson(root, `${directory}/coverage-final.json`, final);
  const coverageSummary = writeJson(
    root,
    `${directory}/coverage-summary.json`,
    summary,
  );
  return {
    coverageFinal,
    coverageSummary,
    totals: {
      lines: { covered: lineCovered, total: lineTotal },
      branches: { covered: branchCovered, total: branchTotal },
    },
  };
}

function serializedCoverageReports(root, fullyCovered) {
  const sourcePath = path.join(root, "fixture.js");
  const hits = fullyCovered ? [1, 1] : [1, 0];
  const metric = {
    lines: summaryMetric(fullyCovered ? 2 : 1, 2),
    branches: summaryMetric(fullyCovered ? 2 : 1, 2),
    statements: summaryMetric(fullyCovered ? 2 : 1, 2),
    functions: summaryMetric(0, 0),
  };
  return {
    final: JSON.stringify({
      [sourcePath]: {
        ...coverageRecord(hits, hits),
        path: sourcePath,
      },
    }),
    summary: JSON.stringify({
      [sourcePath]: metric,
      total: metric,
    }),
  };
}

function mutateCoverageFinal(reports, mutate) {
  const final = JSON.parse(fs.readFileSync(reports.coverageFinal, "utf8"));
  const firstKey = Object.keys(final)[0];
  mutate(final, final[firstKey], firstKey);
  fs.writeFileSync(reports.coverageFinal, JSON.stringify(final));
}

function expectCoverageFailure(fixture, entry, eligible, reports, pattern) {
  expectFailure(
    () => engine.validateCoverageReports(
      fixture.root, entry, eligible, eligible, reports,
    ),
    pattern,
  );
}

function writeTestResults(
  root,
  directory,
  profile,
  counts = {},
  expectedTestFiles = [],
) {
  const values = {
    total: counts.total ?? 2,
    passed: counts.passed ?? 2,
    failed: counts.failed ?? 0,
    skipped: counts.skipped ?? 0,
    todo: counts.todo ?? 0,
  };
  if (profile === "node-typescript-c8") {
    return writeFile(
      root,
      `${directory}/test-results.tap`,
      [
        "TAP version 13",
        `1..${values.total}`,
        `# tests ${values.total}`,
        "# suites 0",
        `# pass ${values.passed}`,
        `# fail ${values.failed}`,
        "# cancelled 0",
        `# skipped ${values.skipped}`,
        `# todo ${values.todo}`,
        "# duration_ms 1",
        "",
      ].join("\n"),
    );
  }
  return writeJson(root, `${directory}/test-results.json`, {
    success: values.failed === 0,
    wasInterrupted: false,
    numTotalTests: values.total,
    numPassedTests: values.passed,
    numFailedTests: values.failed,
    numPendingTests: values.skipped,
    numTodoTests: values.todo,
    numTotalTestSuites: expectedTestFiles.length,
    numPassedTestSuites: expectedTestFiles.length,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numRuntimeErrorTestSuites: 0,
    testResults: expectedTestFiles.map((repoPath, index) => ({
      name: path.join(root, ...repoPath.split("/")),
      status: "passed",
      assertionResults:
        index === 0
          ? Array.from({ length: values.passed }, () => ({ status: "passed" }))
          : [{ status: "passed" }],
    })),
  });
}

function toolchainFor(entry) {
  if (entry.profile === "jest-typescript") {
    return {
      node: engine.REQUIRED_NODE_VERSION,
      npm: "10.8.2",
      testRunner: { name: "jest", version: "29.7.0" },
      coverageRunner: { name: "jest", version: "29.7.0" },
    };
  }
  if (entry.profile === "react-scripts") {
    return {
      node: engine.REQUIRED_NODE_VERSION,
      npm: "10.8.2",
      testRunner: { name: "react-scripts", version: "5.0.1" },
      coverageRunner: { name: "react-scripts", version: "5.0.1" },
    };
  }
  return {
    node: engine.REQUIRED_NODE_VERSION,
    npm: "10.8.2",
    testRunner: { name: "node", version: engine.REQUIRED_NODE_VERSION },
    coverageRunner: { name: "c8", version: "12.0.0" },
  };
}

function createEvidenceArtifact(fixture, id, destination = null) {
  const prepared = engine.prepareEntry(
    fixture.root,
    fixture.root,
    fixture.context,
    id,
  );
  const directory =
    destination || `${engine.ARTIFACT_ROOT}/${id}`;
  const reports = writeCoverageReports(
    fixture.root,
    directory,
    prepared.eligible,
  );
  const testResults = writeTestResults(
    fixture.root,
    directory,
    prepared.entry.profile,
    {},
    prepared.testFiles,
  );
  const coverageResult = engine.validateCoverageReports(
    fixture.root,
    prepared.entry,
    prepared.eligible,
    prepared.changedEligible,
    {
      coverageFinal: reports.coverageFinal,
      coverageSummary: reports.coverageSummary,
    },
  );
  const tests =
    prepared.entry.profile === "node-typescript-c8"
      ? engine.parseTapTestResults(testResults, id)
      : engine.parseJestTestResults(
        testResults,
        id,
        prepared.testFiles,
        fixture.root,
      );
  const commands = prepared.commands.map(({ workingDirectory, argv }) => ({
    workingDirectory,
    argv,
    exitCode: 0,
  }));
  const evidence = engine.buildEvidence({
    repoRoot: fixture.root,
    context: fixture.context,
    prepared,
    commands,
    toolchain: toolchainFor(prepared.entry),
    reportFiles: {
      coverageFinal: reports.coverageFinal,
      coverageSummary: reports.coverageSummary,
      testResults,
    },
    coverageResult,
    tests,
    status: "success",
    failures: [],
  });
  const evidencePath = writeJson(
    fixture.root,
    `${directory}/evidence.json`,
    evidence,
  );
  return { evidence, evidencePath, prepared };
}

function assertRepositoryRegistration(root) {
  const validated = engine.validateRepository(root);
  assert.deepEqual(
    validated.descriptor.entries.map(({ id }) => id),
    validated.inventory,
  );
  const registeredProfiles = new Map(
    validated.descriptor.entries.map(({ id, profile }) => [id, profile]),
  );
  for (const [id, profile] of CURRENT_ENTRIES) {
    assert.equal(registeredProfiles.get(id), profile);
  }
  return validated;
}

test("validates the repository descriptor and emits only safe matrix ids", () => {
  assertRepositoryRegistration(REPOSITORY_ROOT);
});

test("exposes only the retained public CLI commands", () => {
  const enginePath = path.join(REPOSITORY_ROOT, engine.ENGINE_PATH);
  const cliOptions = { cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false };
  const help = spawnSync(process.execPath, [enginePath, "--help"], cliOptions);
  assert.equal(help.status, 0, help.stderr);
  for (const commandName of ["validate", "matrix", "run", "aggregate", "dry-run"]) {
    assert.match(help.stdout, new RegExp(`  ${commandName}(?: |$)`, "m"));
  }
  assert.doesNotMatch(help.stdout, /^  prepare(?: |$)/m);
  assert.doesNotMatch(help.stdout, /^  validate-evidence(?: |$)/m);

  for (const commandName of ["prepare", "validate-evidence"]) {
    const rejected = spawnSync(process.execPath, [enginePath, commandName], cliOptions);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(`unknown command ${commandName}`));
  }
});

test("rejects closed-schema, unsafe-id, threshold, profile, and ordering drift", () => {
  const valid = descriptor();
  assert.equal(engine.validateDescriptorObject(valid), valid);

  expectFailure(
    () => engine.validateDescriptorObject({ ...valid, command: "npm test" }),
    /fields must be exactly/,
  );
  expectFailure(
    () =>
      engine.validateDescriptorObject({
        ...valid,
        thresholds: { lines: 79, branches: 80 },
      }),
    /thresholds\.lines must equal 80/,
  );
  expectFailure(
    () =>
      engine.validateDescriptorObject({
        ...valid,
        entries: [{ id: "auth;touch-pwned", profile: "jest-typescript" }],
      }),
    /id is unsafe/,
  );
  expectFailure(
    () =>
      engine.validateDescriptorObject({
        ...valid,
        entries: [{ id: "auth", profile: "shell-command" }],
      }),
    /profile is unknown/,
  );
  expectFailure(
    () =>
      engine.validateDescriptorObject({
        ...valid,
        entries: [
          { id: "bet", profile: "jest-typescript" },
          { id: "auth", profile: "jest-typescript" },
        ],
      }),
    /lexicographically sorted/,
  );
  expectFailure(
    () =>
      engine.validateDescriptorObject({
        ...valid,
        entries: [
          { id: "auth", profile: "jest-typescript" },
          { id: "auth", profile: "jest-typescript" },
        ],
      }),
    /duplicate id/,
  );
});

test("rejects descriptor and independent package inventory mismatches", () => {
  const fixture = createFixture();
  mutateDescriptor(fixture.root, (value) => value.entries.pop());
  expectFailure(
    () => engine.validateRepository(fixture.root),
    /descriptor\/package inventory mismatch/,
  );
});

test("rejects repository npm configuration and fixes the registry environment", () => {
  const fixture = createFixture();
  writeFile(
    fixture.root,
    "auth/.npmrc",
    "registry=http://127.0.0.1:9/\n",
  );
  expectFailure(
    () => engine.validateRepository(fixture.root),
    /repository npm configuration is forbidden/,
  );

  const root = temporaryDirectory();
  fs.mkdirSync(path.join(root, "fixture"), { recursive: true });
  const inheritedConfig = writeFile(
    root,
    "hostile-npmrc",
    "registry=http://127.0.0.1:9/\nstrict-ssl=false\n",
  );
  const originalRegistry = process.env.npm_config_registry;
  const originalUserConfig = process.env.NPM_CONFIG_USERCONFIG;
  process.env.npm_config_registry = "http://127.0.0.1:9/";
  process.env.NPM_CONFIG_USERCONFIG = inheritedConfig;
  try {
    engine.executeCommands(
      root,
      [
        {
          workingDirectory: "fixture",
          argv: ["npm", "config", "get", "registry"],
          captureStdout: "fixture/registry.txt",
          timeoutMs: 5000,
        },
      ],
      { id: "fixture", profile: "jest-typescript" },
    );
  } finally {
    if (originalRegistry === undefined) {
      delete process.env.npm_config_registry;
    } else {
      process.env.npm_config_registry = originalRegistry;
    }
    if (originalUserConfig === undefined) {
      delete process.env.NPM_CONFIG_USERCONFIG;
    } else {
      process.env.NPM_CONFIG_USERCONFIG = originalUserConfig;
    }
  }
  assert.equal(
    fs.readFileSync(path.join(root, "fixture/registry.txt"), "utf8").trim(),
    "https://registry.npmjs.org/",
  );
});

test("rejects package lifecycle hooks that could replace installed runners", () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.root, "auth/package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.scripts.postinstall = "node replace-runner.js";
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  commitAll(fixture.root, "add malicious lifecycle hook");
  expectFailure(
    () => engine.validateRepository(fixture.root),
    /forbidden lifecycle hook postinstall/,
  );
});

test("rejects candidate-controlled Jest result processors and runners", () => {
  for (const field of ["testResultsProcessor", "runner", "testRunner", "reporters"]) {
    const fixture = createFixture();
    const manifestPath = path.join(fixture.root, "auth/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.jest[field] = "./rewrite-results.js";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    commitAll(fixture.root, `add malicious Jest ${field}`);
    expectFailure(
      () => engine.validateRepository(fixture.root),
      /Jest configuration fields must be exactly/,
    );
  }

  const standalone = createFixture();
  writeFile(
    standalone.root,
    "auth/jest.config.js",
    "module.exports = { testResultsProcessor: './rewrite-results.js' };\n",
  );
  commitAll(standalone.root, "add standalone Jest config");
  expectFailure(
    () => engine.validateRepository(standalone.root),
    /standalone Jest configuration/,
  );
});

test("rejects local or aliased coverage runner artifacts before installation", () => {
  const fixture = createFixture();
  const manifestPath = path.join(fixture.root, "auth/package.json");
  const lockPath = path.join(fixture.root, "auth/package-lock.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  manifest.devDependencies.jest = "file:./malicious-jest.tgz";
  lock.packages[""].devDependencies = {
    ...(lock.packages[""].devDependencies || {}),
    jest: "file:./malicious-jest.tgz",
  };
  lock.packages["node_modules/jest"] = {
    name: "malicious-jest",
    version: "29.7.0",
    resolved: "file:malicious-jest.tgz",
    integrity: "sha512-AAAA",
    bin: { jest: "bin/jest.js" },
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  writeFile(fixture.root, "auth/malicious-jest.tgz", "not a trusted runner");
  commitAll(fixture.root, "replace jest with local artifact");

  expectFailure(
    () => engine.validateRepository(fixture.root),
    /canonical npm artifact|registry semver specification|package identity/,
  );
});

test("rejects competing providers for protected runner bin names", () => {
  const fixture = createFixture();
  const lockPath = path.join(fixture.root, "auth/package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/a-runner"] = {
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/a-runner/-/a-runner-1.0.0.tgz",
    integrity: "sha512-AAAA",
    bin: { jest: "bin/fake-jest.js" },
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  commitAll(fixture.root, "add competing Jest bin provider");

  expectFailure(
    () => engine.validateRepository(fixture.root),
    /invalid jest provider/,
  );
});

test("rejects an aliased package at the reviewed Jest CLI provider path", () => {
  const fixture = createFixture();
  const lockPath = path.join(fixture.root, "auth/package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  lock.packages["node_modules/jest-cli"] = {
    name: "attacker-jest-cli",
    version: "29.7.0",
    resolved:
      "https://registry.npmjs.org/attacker-jest-cli/-/" +
      "attacker-jest-cli-29.7.0.tgz",
    integrity: "sha512-AAAA",
    bin: { jest: "bin/jest.js" },
  };
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  commitAll(fixture.root, "alias the Jest CLI provider");

  expectFailure(
    () => engine.validateRepository(fixture.root),
    /invalid jest provider node_modules\/jest-cli/,
  );
});

test("rejects missing locks, missing source roots, and zero eligible source files", () => {
  const missingLock = createFixture();
  fs.rmSync(path.join(missingLock.root, "auth/package-lock.json"));
  commitAll(missingLock.root, "remove lock");
  expectFailure(
    () => engine.validateRepository(missingLock.root),
    /must contain both package\.json and package-lock\.json/,
  );

  const missingSource = createFixture();
  fs.rmSync(path.join(missingSource.root, "auth/src"), {
    recursive: true,
    force: true,
  });
  commitAll(missingSource.root, "remove source");
  expectFailure(
    () => engine.validateRepository(missingSource.root),
    /source root is missing/,
  );

  const testsOnly = createFixture();
  fs.renameSync(
    path.join(testsOnly.root, "auth/src/index.ts"),
    path.join(testsOnly.root, "auth/src/index.test.ts"),
  );
  commitAll(testsOnly.root, "tests only");
  expectFailure(
    () => engine.validateRepository(testsOnly.root),
    /zero eligible source files/,
  );
});

test("rejects source symlinks, traversal, duplicates, and case collisions", () => {
  const fixture = createFixture();
  fs.symlinkSync("index.ts", path.join(fixture.root, "auth/src/link.ts"));
  commitAll(fixture.root, "add source symlink");
  expectFailure(
    () => engine.validateRepository(fixture.root),
    /source tree contains symlink/,
  );

  expectFailure(
    () => engine.normalizeRepoPath("../auth/src/index.ts", "path"),
    /not canonical|unsafe/,
  );
  expectFailure(
    () => engine.normalizeRepoPath("auth\\src\\index.ts", "path"),
    /unsafe/,
  );
  expectFailure(
    () =>
      engine.assertSortedUniquePaths(
        ["auth/src/A.ts", "auth/src/a.ts"].sort(),
        "paths",
      ),
    /collision/,
  );
  expectFailure(
    () =>
      engine.assertSortedUniquePaths(
        ["auth/src/index.ts", "auth/src/index.ts"],
        "paths",
      ),
    /duplicate/,
  );
});

test("rejects symlinked ancestors for generated mutation paths", () => {
  const root = temporaryDirectory();
  const outside = temporaryDirectory();
  fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
  fs.symlinkSync(
    outside,
    path.join(root, "artifacts", "test-coverage"),
    "dir",
  );
  expectFailure(
    () =>
      engine.ensureSafeMutationPath(
        root,
        "artifacts/test-coverage/auth/evidence.json",
        "artifact path",
      ),
    /symlinked path component/,
  );

  fs.mkdirSync(path.join(root, "auth"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "auth", "coverage"), "dir");
  expectFailure(
    () =>
      engine.ensureSafeMutationPath(
        root,
        "auth/coverage/coverage-final.json",
        "coverage path",
      ),
    /symlinked path component/,
  );
});

test("protects React build output and ignores inherited BUILD_PATH", () => {
  const root = temporaryDirectory();
  const outside = temporaryDirectory();
  const sentinel = writeFile(outside, "sentinel", "keep");
  fs.mkdirSync(path.join(root, "client"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "client", "build"), "dir");

  expectFailure(
    () =>
      engine.executeCommands(
        root,
        [
          {
            workingDirectory: "client",
            argv: ["./node_modules/.bin/react-scripts", "build"],
            timeoutMs: 5000,
          },
        ],
        { id: "client", profile: "react-scripts" },
      ),
    /build directory contains symlinked path component/,
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");

  fs.rmSync(path.join(root, "client", "build"));
  const originalBuildPath = process.env.BUILD_PATH;
  process.env.BUILD_PATH = outside;
  try {
    const records = [];
    engine.executeCommands(
      root,
      [
        {
          workingDirectory: "client",
          argv: [
            process.execPath,
            "-e",
            "process.exit(process.env.BUILD_PATH ? 9 : 0)",
          ],
          timeoutMs: 5000,
        },
      ],
      { id: "client", profile: "react-scripts" },
      records,
    );
    assert.equal(records[0].exitCode, 0);
  } finally {
    if (originalBuildPath === undefined) {
      delete process.env.BUILD_PATH;
    } else {
      process.env.BUILD_PATH = originalBuildPath;
    }
  }
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");

  const fakeReactScripts = writeFile(
    root,
    "client/node_modules/.bin/react-scripts",
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const configured = fs.readFileSync(".env.production", "utf8")',
      '  .trim()',
      '  .split("=")',
      '  .slice(1)',
      '  .join("=");',
      'const buildPath = process.env.BUILD_PATH || configured;',
      'const destination = path.resolve(buildPath);',
      'fs.mkdirSync(destination, { recursive: true });',
      'fs.writeFileSync(path.join(destination, "output"), "built");',
      "",
    ].join("\n"),
  );
  fs.chmodSync(fakeReactScripts, 0o755);
  writeFile(root, "client/.env.production", `BUILD_PATH=${outside}\n`);
  engine.executeCommands(
    root,
    [
      {
        workingDirectory: "client",
        argv: ["./node_modules/.bin/react-scripts", "build"],
        timeoutMs: 5000,
      },
    ],
    { id: "client", profile: "react-scripts" },
  );
  assert.equal(
    fs.readFileSync(path.join(root, "client/build/output"), "utf8"),
    "built",
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
});

test("authoritative command execution fails closed outside Linux containment", () => {
  if (process.platform === "linux") {
    assert.match(
      fs.readFileSync(path.join(REPOSITORY_ROOT, engine.ENGINE_PATH), "utf8"),
      /authoritative coverage execution requires Linux process containment/,
    );
    return;
  }
  expectFailure(
    () =>
      engine.executeCommands(
        temporaryDirectory(),
        [],
        { id: "fixture", profile: "jest-typescript" },
        [],
        { requireLinux: true },
      ),
    /requires Linux process containment/,
  );
});

test("maps an outer bootstrap exec failure to exit 127", () => {
  assert.match(
    engine.COMMAND_SUBREAPER_BOOTSTRAP,
    /except OSError:\n    raise SystemExit\(127\)/,
  );
  if (process.platform !== "linux") {
    return;
  }
  const root = temporaryDirectory();
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-c",
      engine.COMMAND_SUBREAPER_BOOTSTRAP,
      path.join(root, "missing-node"),
    ],
    {
      cwd: root,
      env: engine.sanitizedChildEnvironment(),
      encoding: "utf8",
      shell: false,
      timeout: 5000,
    },
  );
  assert.equal(result.status, 127, result.stderr);
  assert.equal(result.stderr, "");
});

test("maps a supervised payload exec failure to exit 127", () => {
  assert.match(
    engine.COMMAND_SUPERVISOR_SOURCE,
    /"except OSError:",\n  "    raise SystemExit\(127\)",/,
  );
  if (process.platform !== "linux") {
    return;
  }
  const root = temporaryDirectory();
  const payload = JSON.stringify({
    executable: path.join(root, "missing-payload"),
    args: [],
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    inputFiles: [],
    protectedRoots: [],
    watchRoot: null,
    captureStdout: false,
  });
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-c",
      engine.COMMAND_SUBREAPER_BOOTSTRAP,
      process.execPath,
      "-e",
      engine.COMMAND_SUPERVISOR_SOURCE,
      payload,
    ],
    {
      cwd: root,
      env: engine.sanitizedChildEnvironment(),
      encoding: "utf8",
      shell: false,
      timeout: 7000,
    },
  );
  assert.equal(result.status, 127, result.stderr);
  assert.equal(result.stderr, "");
});

test("maps subreaper establishment failure to exit 127", () => {
  const needle = "libc.prctl(36, 1, 0, 0, 0)";
  assert.equal(engine.COMMAND_SUBREAPER_BOOTSTRAP.split(needle).length - 1, 1);
  if (process.platform !== "linux") {
    return;
  }
  const forcedFailureBootstrap = engine.COMMAND_SUBREAPER_BOOTSTRAP.replace(
    needle,
    "libc.prctl(-1, 1, 0, 0, 0)",
  );
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-c",
      forcedFailureBootstrap,
      process.execPath,
      "-e",
      "process.exit(0)",
    ],
    {
      cwd: temporaryDirectory(),
      env: engine.sanitizedChildEnvironment(),
      encoding: "utf8",
      shell: false,
      timeout: 5000,
    },
  );
  assert.equal(result.status, 127, result.stderr);
  assert.match(
    result.stderr,
    /^coverage command supervisor could not enable the Linux subreaper: /,
  );
});

test("rejects coverage-ignore directives in every eligible source profile", () => {
  for (const [id, directive] of [
    ["auth", "/* istanbul ignore next */"],
    ["client", "/* istanbul ignore file */"],
    ["common", "/* c8 ignore next */"],
  ]) {
    const fixture = createFixture();
    const extension = id === "client" ? "js" : "ts";
    writeFile(
      fixture.root,
      `${id}/src/index.${extension}`,
      `${directive}\nexport const value = 1;\n`,
    );
    commitAll(fixture.root, `add ${id} ignore directive`);
    expectFailure(
      () => engine.validateRepository(fixture.root),
      /forbidden coverage-ignore directive/,
    );
  }
});

test("binds authoritative commands to complete package inputs and rejects extras", () => {
  const fixture = createFixture();
  const prepared = engine.prepareEntry(
    fixture.root,
    fixture.root,
    fixture.context,
    "common",
  );
  assert.equal(prepared.packageInputs.includes("common/tests/common.test.js"), true);
  assert.equal(prepared.packageInputs.includes("common/tsconfig.test.json"), true);
  assert.equal(prepared.packageInputs.includes("common/package-lock.json"), true);

  writeFile(fixture.root, "common/node_modules/generated", "allowed\n");
  writeFile(fixture.root, "common/coverage/generated", "allowed\n");
  writeFile(fixture.root, "common/build/generated", "allowed\n");
  assert.doesNotThrow(() =>
    engine.rejectUnexpectedPackageFiles(
      fixture.root,
      prepared.entry,
      prepared.packageInputs,
    ),
  );

  writeFile(fixture.root, "common/.env", "UNTRACKED_INPUT=true\n");
  expectFailure(
    () => engine.prepareEntry(
      fixture.root,
      fixture.root,
      fixture.context,
      "common",
    ),
    /untracked or ignored command input/,
  );
});

test("verifies exact package inputs and generated-root boundaries without Git", () => {
  const scenarios = [
    {
      label: "modified file",
      mutate(fixture) {
        writeFile(fixture.root, "common/src/index.ts", "export const value = 3;\n");
      },
      verify(fixture, prepared) {
        engine.ensurePackageSnapshot(
          fixture.root,
          prepared.packageInputSnapshot,
          prepared.entry,
        );
      },
      pattern: /differs from the exact checkout snapshot/,
    },
    {
      label: "deleted file",
      mutate(fixture) {
        fs.unlinkSync(path.join(fixture.root, "common/src/index.ts"));
      },
      verify(fixture, prepared) {
        engine.ensurePackageSnapshot(
          fixture.root,
          prepared.packageInputSnapshot,
          prepared.entry,
        );
      },
      pattern: /is missing/,
    },
    {
      label: "executable mode",
      mutate(fixture) {
        fs.chmodSync(path.join(fixture.root, "common/src/index.ts"), 0o755);
      },
      verify(fixture, prepared) {
        engine.ensurePackageSnapshot(
          fixture.root,
          prepared.packageInputSnapshot,
          prepared.entry,
        );
      },
      pattern: /executable mode differs/,
    },
    {
      label: "symlink replacement",
      mutate(fixture) {
        const target = path.join(fixture.root, "common/src/index.ts");
        fs.unlinkSync(target);
        fs.symlinkSync("other.ts", target);
      },
      verify(fixture, prepared) {
        engine.ensurePackageSnapshot(
          fixture.root,
          prepared.packageInputSnapshot,
          prepared.entry,
        );
      },
      pattern: /must be a regular file/,
    },
    {
      label: "hardlink replacement",
      mutate(fixture) {
        const target = path.join(fixture.root, "common/src/index.ts");
        const alias = writeFile(
          fixture.root,
          "hardlink-source",
          fs.readFileSync(target),
        );
        fs.unlinkSync(target);
        fs.linkSync(alias, target);
      },
      verify(fixture, prepared) {
        engine.ensurePackageSnapshot(
          fixture.root,
          prepared.packageInputSnapshot,
          prepared.entry,
        );
      },
      pattern: /non-hardlinked regular file/,
    },
    {
      label: "unexpected ignored file",
      mutate(fixture) {
        writeFile(fixture.root, "common/.env", "UNTRACKED_INPUT=true\n");
      },
      verify(fixture, prepared) {
        engine.rejectUnexpectedPackageFiles(
          fixture.root,
          prepared.entry,
          prepared.packageInputs,
        );
      },
      pattern: /untracked or ignored command input/,
    },
    {
      label: "generated-root symlink",
      mutate(fixture) {
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "generated-root-"));
        temporaryDirectories.add(outside);
        fs.symlinkSync(outside, path.join(fixture.root, "common/build"), "dir");
      },
      verify(fixture, prepared) {
        engine.rejectUnexpectedPackageFiles(
          fixture.root,
          prepared.entry,
          prepared.packageInputs,
        );
      },
      pattern: /generated root must be a regular directory/,
    },
    {
      label: "protected-input hardlink",
      mutate(fixture) {
        fs.mkdirSync(path.join(fixture.root, "common/coverage"), {
          recursive: true,
        });
        fs.linkSync(
          path.join(fixture.root, engine.ENGINE_PATH),
          path.join(fixture.root, "common/coverage/engine-alias"),
        );
      },
      verify(fixture, prepared) {
        engine.verifyPreparedFilesystemState(fixture.root, prepared);
      },
      pattern: /protected input .*non-hardlinked regular file/,
    },
  ];

  for (const scenario of scenarios) {
    const fixture = createFixture();
    const prepared = engine.prepareEntry(
      fixture.root,
      fixture.root,
      fixture.context,
      "common",
    );
    scenario.mutate(fixture);
    expectFailure(
      () => scenario.verify(fixture, prepared),
      scenario.pattern,
    );
  }
});

test("safe parent writes reject hardlinks to protected inputs", () => {
  const fixture = createFixture();
  const protectedPath = path.join(fixture.root, engine.ENGINE_PATH);
  const before = fs.readFileSync(protectedPath);
  const destination = path.join(
    fixture.root,
    "common/coverage/test-results.tap",
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.linkSync(protectedPath, destination);

  assert.throws(
    () =>
      engine.writeFileSafely(
        destination,
        Buffer.from("forged report\n", "utf8"),
        "captured test result",
      ),
    /destination must be a non-hardlinked regular file/,
  );
  assert.deepEqual(fs.readFileSync(protectedPath), before);
});

test("fails a command that mutates and restores a watched tracked input", () => {
  const root = temporaryDirectory();
  writeFile(root, "fixture/input.js", "original\n");
  const records = [];
  expectFailure(
    () =>
      engine.executeCommands(
        root,
        [
          {
            workingDirectory: "fixture",
            argv: [
              process.execPath,
              "-e",
              [
                'const fs = require("node:fs");',
                'fs.writeFileSync("input.js", "changed\\n");',
                'fs.writeFileSync("input.js", "original\\n");',
              ].join("\n"),
            ],
            timeoutMs: 5000,
          },
        ],
        { id: "fixture", profile: "jest-typescript" },
        records,
        {
          inputPaths: ["fixture/input.js"],
          watchRoot: "fixture",
        },
      ),
    /command failed with exit 126/,
  );
  assert.equal(records[0].exitCode, 126);
});

test("fails a command that mutates the protected central coverage toolchain", () => {
  const root = temporaryDirectory();
  const toolRoot = path.join(root, "central-toolchain");
  const toolFile = writeFile(root, "central-toolchain/c8.js", "trusted\n");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      engine.COMMAND_SUPERVISOR_SOURCE,
      JSON.stringify({
        executable: process.execPath,
        args: [
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(toolFile)}, "replaced\\n")`,
        ],
        timeoutMs: 5000,
        maxOutputBytes: 1024,
        inputFiles: [],
        protectedRoots: [{ root: toolRoot, allowedTopLevel: [] }],
        watchRoot: null,
        captureStdout: true,
      }),
    ],
    {
      encoding: null,
      maxBuffer: 1024 * 1024,
      shell: false,
      timeout: 10_000,
    },
  );
  assert.equal(result.status, 126);
});

test("isolates Python bootstraps from package startup customization", () => {
  const root = temporaryDirectory();
  const sentinel = path.join(root, "python-customization-ran");
  const environmentCapture = path.join(root, "child-environment.json");
  writeFile(
    root,
    "fixture/sitecustomize.py",
    `open(${JSON.stringify(sentinel)}, "w").write("site")\n`,
  );
  writeFile(
    root,
    "fixture/usercustomize.py",
    `open(${JSON.stringify(sentinel)}, "w").write("user")\n`,
  );
  const nodeHook = writeFile(
    root,
    "fixture/node-hook.js",
    `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "node");\n`,
  );
  const original = {};
  for (const name of [
    "PYTHONPATH",
    "PYTHONSTARTUP",
    "PYTHONINSPECT",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REPL_EXTERNAL_MODULE",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_DIR",
    "GIT_EXEC_PATH",
    "GIT_EXTERNAL_DIFF",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PAGER",
    "GIT_TRACE",
    "GIT_WORK_TREE",
  ]) {
    original[name] = process.env[name];
  }
  process.env.PYTHONPATH = path.join(root, "fixture");
  process.env.PYTHONSTARTUP = path.join(root, "fixture/sitecustomize.py");
  process.env.PYTHONINSPECT = "1";
  process.env.NODE_OPTIONS = `--require=${nodeHook}`;
  process.env.NODE_PATH = path.join(root, "fixture");
  process.env.NODE_REPL_EXTERNAL_MODULE = nodeHook;
  process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES = path.join(root, "objects");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
  process.env.GIT_CONFIG_VALUE_0 = nodeHook;
  process.env.GIT_DIR = path.join(root, ".git");
  process.env.GIT_EXEC_PATH = path.join(root, "git-exec");
  process.env.GIT_EXTERNAL_DIFF = nodeHook;
  process.env.GIT_INDEX_FILE = path.join(root, "index");
  process.env.GIT_OBJECT_DIRECTORY = path.join(root, "objects");
  process.env.GIT_PAGER = nodeHook;
  process.env.GIT_TRACE = path.join(root, "git-trace");
  process.env.GIT_WORK_TREE = root;
  try {
    engine.executeCommands(
      root,
      [
        {
          workingDirectory: "fixture",
          argv: [
            process.execPath,
            "-e",
            [
              'const fs = require("node:fs");',
              `fs.writeFileSync(${JSON.stringify(environmentCapture)}, JSON.stringify({`,
              "  PYTHONPATH: process.env.PYTHONPATH,",
              "  PYTHONSTARTUP: process.env.PYTHONSTARTUP,",
              "  PYTHONINSPECT: process.env.PYTHONINSPECT,",
              "  NODE_OPTIONS: process.env.NODE_OPTIONS,",
              "  NODE_PATH: process.env.NODE_PATH,",
              "  NODE_REPL_EXTERNAL_MODULE: process.env.NODE_REPL_EXTERNAL_MODULE,",
              "  GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES,",
              "  GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT,",
              "  GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,",
              "  GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,",
              "  GIT_DIR: process.env.GIT_DIR,",
              "  GIT_EXEC_PATH: process.env.GIT_EXEC_PATH,",
              "  GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,",
              "  GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,",
              "  GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY,",
              "  GIT_PAGER: process.env.GIT_PAGER,",
              "  GIT_TRACE: process.env.GIT_TRACE,",
              "  GIT_WORK_TREE: process.env.GIT_WORK_TREE,",
              "}));",
            ].join("\n"),
          ],
          timeoutMs: 5000,
        },
      ],
      { id: "fixture", profile: "jest-typescript" },
    );
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  assert.equal(fs.existsSync(sentinel), false);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(environmentCapture, "utf8")),
    {},
  );
});

test("hardens Git against fsmonitor and inherited configuration injection", () => {
  const fixture = createFixture();
  const sentinel = path.join(fixture.root, "git-helper-ran");
  const hook = writeFile(
    fixture.root,
    ".git/fsmonitor-hook",
    [
      "#!/usr/bin/env bash",
      `: >${JSON.stringify(sentinel)}`,
      "exit 1",
      "",
    ].join("\n"),
  );
  fs.chmodSync(hook, 0o755);
  git(fixture.root, "config", "core.fsmonitor", hook);

  const original = {};
  for (const name of [
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_KEY_0",
    "GIT_CONFIG_VALUE_0",
    "GIT_DIR",
    "GIT_EXTERNAL_DIFF",
    "GIT_WORK_TREE",
  ]) {
    original[name] = process.env[name];
  }
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
  process.env.GIT_CONFIG_VALUE_0 = hook;
  process.env.GIT_DIR = path.join(fixture.root, ".git");
  process.env.GIT_EXTERNAL_DIFF = hook;
  process.env.GIT_WORK_TREE = fixture.root;
  try {
    assert.equal(
      engine.runGit(fixture.root, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--quiet",
        "HEAD",
        "--",
        "common",
      ]),
      "",
    );
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
  assert.equal(fs.existsSync(sentinel), false);

  const environment = engine.sanitizedGitEnvironment({
    PATH: process.env.PATH,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor",
    GIT_CONFIG_VALUE_0: hook,
    GIT_EXTERNAL_DIFF: hook,
    GIT_TRACE: sentinel,
  });
  assert.equal(environment.GIT_CONFIG_COUNT, undefined);
  assert.equal(environment.GIT_CONFIG_KEY_0, undefined);
  assert.equal(environment.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(environment.GIT_TRACE, undefined);
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.GIT_CONFIG_GLOBAL, os.devNull);
  assert.equal(environment.GIT_NO_REPLACE_OBJECTS, "1");
  assert.equal(environment.GIT_EXTERNAL_DIFF, "");
});

test("seals Git before hostile commands and validates evidence from prepared state", () => {
  if (process.platform !== "linux") {
    const source = fs.readFileSync(
      path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
      "utf8",
    );
    const executeEntryStart = source.indexOf("function executeEntry(");
    const executeEntryEnd = source.indexOf(
      "\nfunction assertCoverageMetric(",
      executeEntryStart,
    );
    assert.ok(executeEntryStart >= 0);
    assert.ok(executeEntryEnd > executeEntryStart);
    const executeEntrySource = source.slice(executeEntryStart, executeEntryEnd);
    const prepareIndex = executeEntrySource.indexOf(
      "const prepared = prepareEntry(",
    );
    const sealIndex = executeEntrySource.indexOf("sealGitAccess();");
    const executeIndex = executeEntrySource.indexOf("executeCommands(");
    const verifyIndex = executeEntrySource.indexOf(
      "verifyPreparedFilesystemState(repoRoot, prepared);",
      executeIndex,
    );
    const evidenceIndex = executeEntrySource.indexOf(
      "validateEvidenceAgainstPrepared(repoRoot, context, evidence, prepared);",
      executeIndex,
    );
    assert.ok(prepareIndex >= 0);
    assert.ok(sealIndex > prepareIndex);
    assert.ok(executeIndex > sealIndex);
    assert.ok(verifyIndex > executeIndex);
    assert.ok(evidenceIndex > verifyIndex);
    assert.match(
      source,
      /if \(gitAccessSealed\) \{\n    fail\("Git access is sealed after package execution begins"\);/,
    );
    return;
  }
  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "common");
  const contextPath = writeJson(
    fixture.root,
    "context.json",
    fixture.context,
  );
  const sentinel = path.join(fixture.root, "fsmonitor-ran");
  const reportDirectory = path.dirname(artifact.evidencePath);
  const reportPaths = [
    path.join(reportDirectory, "coverage-final.json"),
    path.join(reportDirectory, "coverage-summary.json"),
  ];
  const reportHashes = reportPaths.map((reportPath) =>
    crypto.createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex"),
  );
  const hook = writeFile(
    fixture.root,
    ".git/fsmonitor-hook",
    [
      "#!/usr/bin/env node",
      '"use strict";',
      'const fs = require("node:fs");',
      `fs.writeFileSync(${JSON.stringify(sentinel)}, "ran");`,
      ...reportPaths.map(
        (reportPath) =>
          `fs.writeFileSync(${JSON.stringify(reportPath)}, "{\\"forged\\":true}\\n");`,
      ),
      "process.exit(1);",
      "",
    ].join("\n"),
  );
  fs.chmodSync(hook, 0o755);
  const childScript = [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const { spawnSync } = require("node:child_process");',
    "const [enginePath, root, contextPath, evidencePath, hook] = process.argv.slice(1);",
    "const engine = require(enginePath);",
    'const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));',
    'const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));',
    'const prepared = engine.prepareEntry(root, root, context, "common");',
    "engine.sealGitAccess();",
    "const records = [];",
    "engine.executeCommands(root, [{",
    '  workingDirectory: "common",',
    "  argv: [process.execPath, \"-e\", [",
    '    "const { spawnSync } = require(\\\"node:child_process\\\");",',
    '    `const result = spawnSync(\\\"/usr/bin/git\\\", [\\\"config\\\", \\\"core.fsmonitor\\\", ${JSON.stringify(hook)}], { cwd: ${JSON.stringify(root)}, shell: false, stdio: \\\"inherit\\\" });`,',
    '    "process.exit(Number.isInteger(result.status) ? result.status : 1);",',
    '  ].join("\\n")],',
    "  timeoutMs: 5000,",
    "}], prepared.entry, records, {",
    "  requireLinux: true,",
    "  inputPaths: prepared.packageInputs,",
    '  watchRoot: "common",',
    "  packageInputSnapshot: prepared.packageInputSnapshot,",
    "  protectedFileSnapshots: prepared.protectedFileSnapshots,",
    "});",
    'if (records.length !== 1 || records[0].exitCode !== 0) process.exit(2);',
    'if (!fs.readFileSync(path.join(root, ".git/config"), "utf8").includes("fsmonitor")) process.exit(3);',
    "engine.validateEvidenceAgainstPrepared(root, context, evidence, prepared);",
    "let sealed = false;",
    "try { engine.runGit(root, [\"rev-parse\", \"HEAD\"]); } catch (error) {",
    '  sealed = /Git access is sealed/.test(error.message);',
    "}",
    "if (!sealed) process.exit(4);",
    "",
  ].join("\n");
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      childScript,
      path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
      fixture.root,
      contextPath,
      artifact.evidencePath,
      hook,
    ],
    {
      cwd: fixture.root,
      env: engine.sanitizedChildEnvironment(),
      encoding: "utf8",
      shell: false,
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(sentinel), false);
  assert.deepEqual(
    reportPaths.map((reportPath) =>
      crypto.createHash("sha256").update(fs.readFileSync(reportPath)).digest("hex"),
    ),
    reportHashes,
  );
});

test("trusted engine entrypoints unset Node preload variables", () => {
  const root = temporaryDirectory();
  const sentinel = path.join(root, "node-preload-ran");
  const hook = writeFile(
    root,
    "preload.js",
    `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran");\n`,
  );
  const result = spawnSync(
    "/usr/bin/env",
    [
      "-u",
      "NODE_OPTIONS",
      "-u",
      "NODE_PATH",
      "-u",
      "NODE_REPL_EXTERNAL_MODULE",
      process.execPath,
      path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
      "validate",
      "--repo-root",
      REPOSITORY_ROOT,
    ],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      shell: false,
      env: {
        ...process.env,
        NODE_OPTIONS: `--require=${hook}`,
        NODE_PATH: root,
        NODE_REPL_EXTERNAL_MODULE: hook,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(sentinel), false);
  const guard = fs.readFileSync(
    path.join(
      REPOSITORY_ROOT,
      "infra/azure/agents/workflow-trigger-guard-stan.sh",
    ),
    "utf8",
  );
  assert.match(
    guard,
    /\[\[ -f "\$file" && ! -L "\$file" \]\]/,
  );
  assert.match(
    guard,
    /require_literal "\$coverage_engine" 'const REQUIRED_NODE_VERSION = "20\.19\.5"'/,
  );
  assert.doesNotMatch(guard, /\bcoverage_node\b/);
  assert.doesNotMatch(guard, /process\.versions\.node/);

  for (const name of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REPL_EXTERNAL_MODULE",
  ]) {
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    delete environment.NODE_PATH;
    delete environment.NODE_REPL_EXTERNAL_MODULE;
    environment[name] = "";
    const rejected = spawnSync(
      process.execPath,
      [path.join(REPOSITORY_ROOT, engine.ENGINE_PATH), "validate"],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
        shell: false,
        env: environment,
      },
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, new RegExp(`${name} must be unset`));
  }
});

test("derives add, copy, modify, rename, and delete source changes from Git objects", () => {
  const fixture = createFixture({ telemetry: true });
  const entry = { id: "telemetry", profile: "jest-typescript" };
  writeFile(
    fixture.root,
    "telemetry/src/added.ts",
    "export const added = true;\n",
  );
  fs.copyFileSync(
    path.join(fixture.root, "telemetry/src/index.ts"),
    path.join(fixture.root, "telemetry/src/copied.ts"),
  );
  fs.renameSync(
    path.join(fixture.root, "telemetry/src/index.ts"),
    path.join(fixture.root, "telemetry/src/renamed.ts"),
  );
  writeFile(
    fixture.root,
    "telemetry/src/delete.ts",
    "export const removed = true;\n",
  );
  const beforeDelete = commitAll(fixture.root, "prepare change fixture");
  fs.rmSync(path.join(fixture.root, "telemetry/src/delete.ts"));
  writeFile(
    fixture.root,
    "telemetry/src/renamed.ts",
    "export const value = 3;\n",
  );
  const afterDelete = commitAll(fixture.root, "apply changes");
  const eligible = engine.deriveEligibleSources(
    fixture.root,
    afterDelete,
    entry,
  );
  const changes = engine.deriveChangedSources(
    fixture.root,
    beforeDelete,
    afterDelete,
    entry,
    eligible,
  );
  assert.deepEqual(changes.changedEligible, ["telemetry/src/renamed.ts"]);
  assert.deepEqual(changes.deletedEligible, ["telemetry/src/delete.ts"]);
});

test("handles a future package added after the base without weakening inventory", () => {
  const fixture = createFixture();
  const baseSha = fixture.headSha;
  writePackage(fixture.root, "telemetry", "jest-typescript");
  mutateDescriptor(fixture.root, (value) => {
    value.entries.push({ id: "telemetry", profile: "jest-typescript" });
  });
  const headSha = commitAll(fixture.root, "add telemetry package");
  const entry = { id: "telemetry", profile: "jest-typescript" };
  const eligible = engine.deriveEligibleSources(fixture.root, headSha, entry);
  const changes = engine.deriveChangedSources(
    fixture.root,
    baseSha,
    headSha,
    entry,
    eligible,
  );
  assert.deepEqual(changes.changedEligible, ["telemetry/src/index.ts"]);
  assert.deepEqual(changes.deletedEligible, []);
  assert.equal(
    engine.validateRepository(fixture.root).inventory.includes("telemetry"),
    true,
  );
});

test("authoritative preparation accepts one-entry future package registration", () => {
  const fixture = createFixture();
  const pullBaseSha = fixture.headSha;
  writePackage(fixture.root, "telemetry", "jest-typescript");
  mutateDescriptor(fixture.root, (value) => {
    value.entries.push({ id: "telemetry", profile: "jest-typescript" });
  });
  const headSha = commitAll(fixture.root, "register telemetry");
  const tree = git(fixture.root, "rev-parse", `${headSha}^{tree}`);
  const mergeSnapshotSha = git(
    fixture.root,
    "commit-tree",
    tree,
    "-p",
    pullBaseSha,
    "-p",
    headSha,
    "-m",
    "telemetry registration merge",
  );
  const context = structuredClone(fixture.context);
  context.repository.baseSha = pullBaseSha;
  context.repository.headSha = headSha;
  context.repository.mergeSnapshotSha = mergeSnapshotSha;
  context.repository.checkoutSha = mergeSnapshotSha;
  context.workflow.runHeadSha = mergeSnapshotSha;
  context.workflow.blob = git(
    fixture.root,
    "rev-parse",
    `${mergeSnapshotSha}:${engine.WORKFLOW_PATH}`,
  );

  const prepared = engine.prepareEntry(
    fixture.root,
    fixture.root,
    context,
    "telemetry",
  );
  assert.equal(prepared.entry.profile, "jest-typescript");
  assert.deepEqual(prepared.changedEligible, ["telemetry/src/index.ts"]);
  assert.equal(
    assertRepositoryRegistration(fixture.root).inventory.includes("telemetry"),
    true,
  );
});

test("rejects forbidden tests-telemetry workflow files and names", () => {
  const fileFixture = createFixture();
  writeFile(
    fileFixture.root,
    ".github/workflows/tests-telemetry.yml",
    "name: anything\non: pull_request\n",
  );
  commitAll(fileFixture.root, "add forbidden workflow file");
  expectFailure(
    () => engine.validateRepository(fileFixture.root),
    /forbidden tests-telemetry workflow file/,
  );

  const nameFixture = createFixture();
  writeFile(
    nameFixture.root,
    ".github/workflows/other.yml",
    "name: tests-telemetry\non: pull_request\n",
  );
  commitAll(nameFixture.root, "add forbidden workflow name");
  expectFailure(
    () => engine.validateRepository(nameFixture.root),
    /forbidden tests-telemetry workflow name/,
  );
});

test("validates exact workflow, run, SHA, and unique two-parent merge identity", () => {
  const fixture = createFixture();
  assert.equal(
    engine.validateRunContext(fixture.root, fixture.context),
    fixture.context,
  );

  const wrongBlob = structuredClone(fixture.context);
  wrongBlob.workflow.blob = "a".repeat(40);
  expectFailure(
    () => engine.validateRunContext(fixture.root, wrongBlob),
    /workflow blob does not match/,
  );

  const wrongRunHead = structuredClone(fixture.context);
  wrongRunHead.workflow.runHeadSha = wrongRunHead.repository.headSha;
  expectFailure(
    () => engine.validateRunContext(fixture.root, wrongRunHead),
    /run head SHA must equal checkout SHA/,
  );

  const oneParent = structuredClone(fixture.context);
  oneParent.repository.mergeSnapshotSha = fixture.headSha;
  oneParent.repository.checkoutSha = fixture.headSha;
  oneParent.workflow.runHeadSha = fixture.headSha;
  oneParent.workflow.blob = git(
    fixture.root,
    "rev-parse",
    `${fixture.headSha}:${engine.WORKFLOW_PATH}`,
  );
  expectFailure(
    () => engine.validateRunContext(fixture.root, oneParent),
    /merge snapshot must differ|exactly base then head/,
  );

  const reversed = structuredClone(fixture.context);
  const tree = git(fixture.root, "rev-parse", `${fixture.headSha}^{tree}`);
  const reversedMerge = git(
    fixture.root,
    "commit-tree",
    tree,
    "-p",
    fixture.headSha,
    "-p",
    fixture.baseSha,
    "-m",
    "wrong parent order",
  );
  reversed.repository.mergeSnapshotSha = reversedMerge;
  reversed.repository.checkoutSha = reversedMerge;
  reversed.workflow.runHeadSha = reversedMerge;
  reversed.workflow.blob = git(
    fixture.root,
    "rev-parse",
    `${reversedMerge}:${engine.WORKFLOW_PATH}`,
  );
  expectFailure(
    () => engine.validateRunContext(fixture.root, reversed),
    /exactly base then head/,
  );
});

test("validates push identity with a null merge snapshot", () => {
  const fixture = createFixture();
  const context = structuredClone(fixture.context);
  context.repository.event = "push";
  context.repository.mergeSnapshotSha = null;
  context.repository.checkoutSha = fixture.headSha;
  context.workflow.runHeadSha = fixture.headSha;
  context.workflow.blob = git(
    fixture.root,
    "rev-parse",
    `${fixture.headSha}:${engine.WORKFLOW_PATH}`,
  );
  assert.equal(engine.validateRunContext(fixture.root, context), context);
  context.repository.mergeSnapshotSha = fixture.mergeSnapshotSha;
  expectFailure(
    () => engine.validateRunContext(fixture.root, context),
    /must set mergeSnapshotSha to null/,
  );
});

test("rejects candidate engine, descriptor, and tool bytes that differ from trusted Git", () => {
  for (const relativePath of [
    engine.ENGINE_PATH,
    engine.DESCRIPTOR_PATH,
    engine.TOOL_PACKAGE_PATH,
    engine.TOOL_LOCK_PATH,
  ]) {
    const fixture = createFixture();
    fs.appendFileSync(
      path.join(fixture.root, ...relativePath.split("/")),
      "\n ",
    );
    expectFailure(
      () =>
        engine.verifyTrustedAssets(
          fixture.root,
          fixture.root,
          fixture.context,
        ),
      /differs from the trusted default copy|Git blob does not match trusted default|differs across working, head, or checkout snapshots/,
    );
  }
});

test("builds fixed argv-only command profiles and rejects command injection data", () => {
  const fixture = createFixture();
  let commonCommands;
  for (const [id] of CURRENT_ENTRIES) {
    const prepared = engine.prepareEntry(
      fixture.root,
      fixture.root,
      fixture.context,
      id,
    );
    for (const commandRecord of prepared.commands) {
      assert.equal(typeof commandRecord.argv[0], "string");
      assert.equal(Array.isArray(commandRecord.argv), true);
      assert.equal(Object.hasOwn(commandRecord, "shell"), false);
      assert.equal(Number.isSafeInteger(commandRecord.timeoutMs), true);
      assert.equal(commandRecord.timeoutMs > 0, true);
      assert.equal(
        commandRecord.timeoutMs <= engine.COMMAND_TIMEOUTS.test,
        true,
      );
      assert.equal(
        commandRecord.argv.some((argument) => /[;\n\r]/.test(argument)),
        false,
      );
    }
    if (id === "common") {
      commonCommands = prepared.commands.map((commandRecord) => ({
        workingDirectory: commandRecord.workingDirectory,
        argv: commandRecord.argv,
      }));
    }
  }
  assert.deepEqual(commonCommands.slice(0, 4), [
    {
      workingDirectory: ".github/coverage",
      argv: ["npm", ...engine.NPM_CI_ARGUMENTS],
    },
    {
      workingDirectory: "common",
      argv: ["npm", ...engine.NPM_CI_ARGUMENTS],
    },
    { workingDirectory: "common", argv: ["npm", "run", "clean"] },
    {
      workingDirectory: "common",
      argv: [
        "./node_modules/.bin/tsc",
        "-p",
        "tsconfig.json",
        "--sourceMap",
        "--inlineSources",
      ],
    },
  ]);
  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.match(
    source,
    /const \{ spawnSync \} = require\("node:child_process"\);/,
  );
  assert.doesNotMatch(source, /\bexecSync\b/);
  assert.match(source, /shell:\s*false/);
  assert.match(
    source,
    /identity\.startTime !== expectedStartTime/,
  );
  assert.match(source, /for \(const target of \[-pid, pid\]\)/);
  assert.match(source, /signalCurrentTracked\("SIGKILL"\)/);
  assert.match(engine.COMMAND_SUBREAPER_BOOTSTRAP, /libc\.prctl\(36, 1/);
  assert.match(
    engine.COMMAND_SUPERVISOR_SOURCE,
    /process\.kill\(-child\.pid, signal\)/,
  );
  assert.doesNotMatch(engine.COMMAND_SUPERVISOR_SOURCE, /spawnSync|ps",/);
  assert.equal((source.match(/snapshotInstalledToolchain\(/g) || []).length, 3);
  assert.equal((source.match(/hashDirectoryTree\(/g) || []).length, 2);
  assert.equal((source.match(/validateInstalledBins\(/g) || []).length, 2);
  const workflowGuard = fs.readFileSync(
    path.join(REPOSITORY_ROOT, "infra/azure/agents/workflow-trigger-guard-stan.sh"),
    "utf8",
  );
  assert.doesNotMatch(workflowGuard, /\bnode\s+--check\b/);
  assert.doesNotMatch(workflowGuard, /"\$coverage_engine"\s+validate/);
  assert.doesNotMatch(
    workflowGuard,
    /^[ \t]*"\$coverage_engine_tests"[ \t]*$/m,
  );
  assert.doesNotMatch(workflowGuard, /<<'NODE'/);

  const injected = descriptor();
  injected.entries[0].command = "touch /tmp/pwned";
  expectFailure(
    () => engine.validateDescriptorObject(injected),
    /fields must be exactly/,
  );
});

test("revalidates process identity before every group and PID signal", () => {
  const sent = [];
  let removed = false;
  let identityFailed = false;
  let signalFailed = false;
  const identities = [
    { state: "S", startTime: "100" },
    { state: "S", startTime: "200" },
  ];

  engine.signalIdentityTargets({
    pid: 42,
    expectedStartTime: "100",
    signal: "SIGKILL",
    readIdentity: () => identities.shift(),
    sendSignal: (target, signal) => sent.push([target, signal]),
    removeTracked: () => {
      removed = true;
    },
    markIdentityFailure: () => {
      identityFailed = true;
    },
    reportSignalFailure: () => {
      signalFailed = true;
    },
  });

  assert.deepEqual(sent, [[-42, "SIGKILL"]]);
  assert.equal(removed, true);
  assert.equal(identityFailed, false);
  assert.equal(signalFailed, false);

  sent.length = 0;
  removed = false;
  engine.signalIdentityTargets({
    pid: 42,
    expectedStartTime: "100",
    signal: "SIGKILL",
    readIdentity: () => ({ state: "S", startTime: "200" }),
    sendSignal: (target, signal) => sent.push([target, signal]),
    removeTracked: () => {
      removed = true;
    },
    markIdentityFailure: () => {
      identityFailed = true;
    },
    reportSignalFailure: () => {
      signalFailed = true;
    },
  });
  assert.deepEqual(sent, []);
  assert.equal(removed, true);
});

test("terminates a stalled child command at its fixed deadline", () => {
  const root = temporaryDirectory();
  const processExists = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") {
        return false;
      }
      throw error;
    }
  };
  for (const parentIgnoresSigterm of [false, true]) {
    const pidFile = path.join(
      root,
      parentIgnoresSigterm ? "pids-ignore.json" : "pids-default.json",
    );
    const hangingProcess = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      ...(parentIgnoresSigterm
        ? ['process.on("SIGTERM", () => {});']
        : []),
      "const descendant = spawn(",
      "  process.execPath,",
      '  ["-e", \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\'],',
      `  { detached: ${process.platform === "linux"}, stdio: "ignore" },`,
      ");",
      "fs.writeFileSync(process.argv[1], JSON.stringify({",
      "  parent: process.pid,",
      "  descendant: descendant.pid,",
      "}));",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const records = [];
    const startedAt = Date.now();
    expectFailure(
      () =>
        engine.executeCommands(
          root,
          [
            {
              workingDirectory: ".",
              argv: [
                process.execPath,
                "-e",
                hangingProcess,
                pidFile,
              ],
              timeoutMs: 250,
            },
          ],
          { id: "fixture", profile: "jest-typescript" },
          records,
        ),
      /timed out after 250ms/,
    );
    assert.deepEqual(records, [
      {
        workingDirectory: ".",
        argv: [
          process.execPath,
          "-e",
          hangingProcess,
          pidFile,
        ],
        exitCode: 124,
      },
    ]);
    assert.equal(Date.now() - startedAt < 5000, true);
    const pids = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 1000;
    while (
      Date.now() < deadline &&
      (processExists(pids.parent) || processExists(pids.descendant))
    ) {
      Atomics.wait(waitArray, 0, 0, 25);
    }
    assert.equal(processExists(pids.parent), false);
    assert.equal(processExists(pids.descendant), false);
  }
});

test("bounds combined command stdout and stderr at the exact byte limit", () => {
  const runSupervisor = (args) => {
    const payload = JSON.stringify({
      executable: process.execPath,
      args,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
      inputFiles: [],
      protectedRoots: [],
      watchRoot: null,
      captureStdout: true,
    });
    const linuxSupervisor = process.platform === "linux";
    return spawnSync(
      linuxSupervisor ? "/usr/bin/python3" : process.execPath,
      linuxSupervisor
        ? [
            "-I",
            "-S",
            "-c",
            engine.COMMAND_SUBREAPER_BOOTSTRAP,
            process.execPath,
            "-e",
            engine.COMMAND_SUPERVISOR_SOURCE,
            payload,
          ]
        : ["-e", engine.COMMAND_SUPERVISOR_SOURCE, payload],
      {
        encoding: null,
        maxBuffer: 1024 * 1024,
        shell: false,
        timeout: 10_000,
      },
    );
  };
  const runOutputSupervisor = (stdoutBytes, stderrBytes) =>
    runSupervisor([
      "-e",
      [
        `process.stdout.write(Buffer.alloc(${stdoutBytes}, 97));`,
        `process.stderr.write(Buffer.alloc(${stderrBytes}, 98));`,
      ].join("\n"),
    ]);

  const exact = runOutputSupervisor(512, 512);
  assert.equal(exact.status, 0);
  assert.equal(exact.stdout.length + exact.stderr.length, 1024);

  const overflow = runOutputSupervisor(1025, 1025);
  assert.equal(overflow.status, 125);
  assert.equal(overflow.stdout.length + overflow.stderr.length <= 1024, true);

  const root = temporaryDirectory();
  const descendantPidFile = path.join(root, "late-overflow-descendant.pid");
  const lateOverflowScript = [
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    "const descendant = spawn(",
    "  process.execPath,",
    "  [",
    '    "-e",',
    '    \'process.on("SIGTERM", () => {}); setTimeout(() => process.stdout.write(Buffer.alloc(2048, 97)), 250); setInterval(() => {}, 1000)\',',
    "  ],",
    `  { detached: ${process.platform === "linux"}, stdio: "inherit" },`,
    ");",
    "fs.writeFileSync(process.argv[1], String(descendant.pid));",
    "setTimeout(() => process.exit(0), 100);",
  ].join("\n");
  const lateOverflow = runSupervisor([
    "-e",
    lateOverflowScript,
    descendantPidFile,
  ]);
  assert.equal(lateOverflow.status, 125);
  assert.equal(
    lateOverflow.stdout.length + lateOverflow.stderr.length <= 1024,
    true,
  );
  const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
  assertProcessIdsGone([descendantPid]);
});

test(
  "rejects a detached descendant that poisons reports during TERM cleanup",
  () => {
    if (process.platform !== "linux") {
      assert.match(
        engine.COMMAND_SUPERVISOR_SOURCE,
        /adoptedDescendantObserved/,
      );
      return;
    }
    const root = temporaryDirectory();
    const coverageFinalPath = path.join(root, "coverage-final.json");
    const coverageSummaryPath = path.join(root, "coverage-summary.json");
    const poisonMarker = path.join(root, "term-poisoned");
    const readyMarker = path.join(root, "term-ready");
    const pidFile = path.join(root, "term-pids.json");
    const lowCoverage = serializedCoverageReports(root, false);
    const poisonedCoverage = serializedCoverageReports(root, true);
    const descendantSource = [
      '"use strict";',
      'const fs = require("node:fs");',
      "const [coverageFinalPath, coverageSummaryPath, poisonMarker, readyMarker, coverageFinal, coverageSummary] = process.argv.slice(1);",
      'process.on("SIGTERM", () => {',
      "  fs.writeFileSync(coverageFinalPath, coverageFinal);",
      "  fs.writeFileSync(coverageSummaryPath, coverageSummary);",
      '  fs.writeFileSync(poisonMarker, "poisoned");',
      "  process.exit(0);",
      "});",
      'fs.writeFileSync(readyMarker, "ready");',
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentSource = [
      '"use strict";',
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      "const [coverageFinalPath, coverageSummaryPath, poisonMarker, readyMarker, pidFile, lowFinal, lowSummary, poisonedFinal, poisonedSummary] = process.argv.slice(1);",
      "fs.writeFileSync(coverageFinalPath, lowFinal);",
      "fs.writeFileSync(coverageSummaryPath, lowSummary);",
      `const descendantSource = ${JSON.stringify(descendantSource)};`,
      "const descendant = spawn(",
      "  process.execPath,",
      "  [",
      '    "-e",',
      "    descendantSource,",
      "    coverageFinalPath,",
      "    coverageSummaryPath,",
      "    poisonMarker,",
      "    readyMarker,",
      "    poisonedFinal,",
      "    poisonedSummary,",
      "  ],",
      '  { detached: true, stdio: "ignore" },',
      ");",
      "fs.writeFileSync(pidFile, JSON.stringify([process.pid, descendant.pid]));",
      "const waitArray = new Int32Array(new SharedArrayBuffer(4));",
      "const deadline = Date.now() + 3000;",
      "while (!fs.existsSync(readyMarker) && Date.now() < deadline) {",
      "  Atomics.wait(waitArray, 0, 0, 5);",
      "}",
      'if (!fs.existsSync(readyMarker)) throw new Error("descendant was not ready");',
      "process.exit(0);",
    ].join("\n");
    const records = [];
    expectFailure(
      () =>
        engine.executeCommands(
          root,
          [
            {
              workingDirectory: ".",
              argv: [
                process.execPath,
                "-e",
                parentSource,
                coverageFinalPath,
                coverageSummaryPath,
                poisonMarker,
                readyMarker,
                pidFile,
                lowCoverage.final,
                lowCoverage.summary,
                poisonedCoverage.final,
                poisonedCoverage.summary,
              ],
              timeoutMs: 5000,
            },
          ],
          { id: "fixture", profile: "jest-typescript" },
          records,
        ),
      /command failed with exit 126/,
    );
    assert.equal(records[0].exitCode, 126);
    assert.equal(fs.readFileSync(poisonMarker, "utf8"), "poisoned");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(coverageFinalPath, "utf8")),
      JSON.parse(poisonedCoverage.final),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(coverageSummaryPath, "utf8")),
      JSON.parse(poisonedCoverage.summary),
    );
    assertProcessIdsGone(JSON.parse(fs.readFileSync(pidFile, "utf8")));
  },
);

test(
  "detects a detached descendant that exits immediately after adoption",
  () => {
    if (process.platform !== "linux") {
      assert.match(
        engine.COMMAND_SUPERVISOR_SOURCE,
        /identity\.state !== "Z"/,
      );
      return;
    }
    const root = temporaryDirectory();
    const coverageFinalPath = path.join(root, "coverage-final.json");
    const coverageSummaryPath = path.join(root, "coverage-summary.json");
    const poisonMarker = path.join(root, "quick-poisoned");
    const readyMarker = path.join(root, "quick-ready");
    const pidFile = path.join(root, "quick-pids.json");
    const lowCoverage = serializedCoverageReports(root, false);
    const poisonedCoverage = serializedCoverageReports(root, true);
    const descendantSource = [
      '"use strict";',
      'const fs = require("node:fs");',
      "const [originalParent, coverageFinalPath, coverageSummaryPath, poisonMarker, readyMarker, coverageFinal, coverageSummary] = process.argv.slice(1);",
      'process.on("SIGTERM", () => {});',
      'fs.writeFileSync(readyMarker, "ready");',
      "const detectAdoption = () => {",
      "  if (process.ppid !== Number(originalParent)) {",
      "    fs.writeFileSync(coverageFinalPath, coverageFinal);",
      "    fs.writeFileSync(coverageSummaryPath, coverageSummary);",
      '    fs.writeFileSync(poisonMarker, "poisoned");',
      "    process.exit(0);",
      "  }",
      "  setImmediate(detectAdoption);",
      "};",
      "detectAdoption();",
    ].join("\n");
    const parentSource = [
      '"use strict";',
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      "const [coverageFinalPath, coverageSummaryPath, poisonMarker, readyMarker, pidFile, lowFinal, lowSummary, poisonedFinal, poisonedSummary] = process.argv.slice(1);",
      "fs.writeFileSync(coverageFinalPath, lowFinal);",
      "fs.writeFileSync(coverageSummaryPath, lowSummary);",
      `const descendantSource = ${JSON.stringify(descendantSource)};`,
      "const descendant = spawn(",
      "  process.execPath,",
      "  [",
      '    "-e",',
      "    descendantSource,",
      "    String(process.pid),",
      "    coverageFinalPath,",
      "    coverageSummaryPath,",
      "    poisonMarker,",
      "    readyMarker,",
      "    poisonedFinal,",
      "    poisonedSummary,",
      "  ],",
      '  { detached: true, stdio: "ignore" },',
      ");",
      "fs.writeFileSync(pidFile, JSON.stringify([process.pid, descendant.pid]));",
      "const waitArray = new Int32Array(new SharedArrayBuffer(4));",
      "const deadline = Date.now() + 3000;",
      "while (!fs.existsSync(readyMarker) && Date.now() < deadline) {",
      "  Atomics.wait(waitArray, 0, 0, 5);",
      "}",
      'if (!fs.existsSync(readyMarker)) throw new Error("descendant was not ready");',
      "process.exit(0);",
    ].join("\n");
    const records = [];
    expectFailure(
      () =>
        engine.executeCommands(
          root,
          [
            {
              workingDirectory: ".",
              argv: [
                process.execPath,
                "-e",
                parentSource,
                coverageFinalPath,
                coverageSummaryPath,
                poisonMarker,
                readyMarker,
                pidFile,
                lowCoverage.final,
                lowCoverage.summary,
                poisonedCoverage.final,
                poisonedCoverage.summary,
              ],
              timeoutMs: 5000,
            },
          ],
          { id: "fixture", profile: "jest-typescript" },
          records,
        ),
      /command failed with exit 126/,
    );
    assert.equal(records[0].exitCode, 126);
    assert.equal(fs.readFileSync(poisonMarker, "utf8"), "poisoned");
    assert.deepEqual(
      JSON.parse(fs.readFileSync(coverageFinalPath, "utf8")),
      JSON.parse(poisonedCoverage.final),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(coverageSummaryPath, "utf8")),
      JSON.parse(poisonedCoverage.summary),
    );
    assertProcessIdsGone(JSON.parse(fs.readFileSync(pidFile, "utf8")));
  },
);

test("allows a nested worker reaped before its parent exits zero", () => {
  if (process.platform !== "linux") {
    assert.match(
      engine.COMMAND_SUPERVISOR_SOURCE,
      /adoptedDescendantObserved = false/,
    );
    return;
  }
  const root = temporaryDirectory();
  const pidFile = path.join(root, "reaped-worker.pid");
  const script = [
    '"use strict";',
    'const fs = require("node:fs");',
    'const { spawn } = require("node:child_process");',
    "const worker = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.argv[1], String(worker.pid));",
    "worker.once('close', () => setTimeout(() => process.exit(0), 50));",
  ].join("\n");
  const records = [];
  engine.executeCommands(
    root,
    [
      {
        workingDirectory: ".",
        argv: [process.execPath, "-e", script, pidFile],
        timeoutMs: 5000,
      },
    ],
    { id: "fixture", profile: "jest-typescript" },
    records,
  );
  assert.equal(records[0].exitCode, 0);
  assertProcessIdsGone([Number(fs.readFileSync(pidFile, "utf8"))]);
});

test("fails closed when the first post-zero procfs refresh fails", () => {
  const needle = [
    "  const postExitScanSucceeded =",
    '    process.platform !== "linux" || refreshDescendants();',
  ].join("\n");
  assert.equal(engine.COMMAND_SUPERVISOR_SOURCE.split(needle).length - 1, 1);
  if (process.platform !== "linux") {
    return;
  }
  const transformedSupervisor = engine.COMMAND_SUPERVISOR_SOURCE.replace(
    needle,
    [
      "  const postExitScanSucceeded =",
      '    process.platform !== "linux" || (containmentFailed = true, false);',
    ].join("\n"),
  );
  const payload = JSON.stringify({
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 5000,
    maxOutputBytes: 1024,
    inputFiles: [],
    protectedRoots: [],
    watchRoot: null,
    captureStdout: false,
  });
  const startedAt = Date.now();
  const result = spawnSync(
    "/usr/bin/python3",
    [
      "-I",
      "-S",
      "-c",
      engine.COMMAND_SUBREAPER_BOOTSTRAP,
      process.execPath,
      "-e",
      transformedSupervisor,
      payload,
    ],
    {
      cwd: temporaryDirectory(),
      encoding: "utf8",
      shell: false,
      timeout: 7000,
    },
  );
  assert.equal(result.status, 126, result.stderr);
  assert.equal(Date.now() - startedAt < 5000, true);
});

test(
  "Linux subreaper kills a detached leaf spawned during SIGTERM handling",
  () => {
    if (process.platform !== "linux") {
      assert.match(engine.COMMAND_SUBREAPER_BOOTSTRAP, /libc\.prctl\(36, 1/);
      assert.match(
        engine.COMMAND_SUPERVISOR_SOURCE,
        /\/proc\/" \+ parentPid \+ "\/task\/" \+ parentPid \+ "\/children"/,
      );
      return;
    }
    const root = temporaryDirectory();
    const parentPidFile = path.join(root, "parent.pid");
    const leafPidFile = path.join(root, "leaf.pid");
    const script = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      "fs.writeFileSync(process.argv[1], String(process.pid));",
      'process.on("SIGTERM", () => {',
      "  const leaf = spawn(",
      "    process.execPath,",
      '    ["-e", \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\'],',
      '    { detached: true, stdio: "ignore" },',
      "  );",
      "  fs.writeFileSync(process.argv[2], String(leaf.pid));",
      "  process.exit(0);",
      "});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    expectFailure(
      () =>
        engine.executeCommands(
          root,
          [
            {
              workingDirectory: ".",
              argv: [
                process.execPath,
                "-e",
                script,
                parentPidFile,
                leafPidFile,
              ],
              timeoutMs: 250,
            },
          ],
          { id: "fixture", profile: "jest-typescript" },
        ),
      /timed out after 250ms/,
    );

    const processExists = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") {
          return false;
        }
        throw error;
      }
    };
    const pids = [
      Number(fs.readFileSync(parentPidFile, "utf8")),
      Number(fs.readFileSync(leafPidFile, "utf8")),
    ];
    const waitArray = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline && pids.some(processExists)) {
      Atomics.wait(waitArray, 0, 0, 25);
    }
    assert.equal(pids.some(processExists), false);
  },
);

test(
  "Linux subreaper drains descendants that spawn leaves during force cleanup",
  () => {
    if (process.platform !== "linux") {
      assert.match(
        engine.COMMAND_SUPERVISOR_SOURCE,
        /emptyScans >= 2/,
      );
      assert.match(
        engine.COMMAND_SUPERVISOR_SOURCE,
        /forceKillTimer = setTimeout\(drain, 25\)/,
      );
      return;
    }
    const root = temporaryDirectory();
    const pidFile = path.join(root, "spawned-pids");
    const script = [
      'const fs = require("node:fs");',
      'const { spawn } = require("node:child_process");',
      "const daemon = spawn(",
      "  process.execPath,",
      "  [",
      '    "-e",',
      "    [",
      '      \'const fs = require("node:fs");\',',
      '      \'const { spawn } = require("node:child_process");\',',
      '      \'process.on("SIGTERM", () => {});\',',
      '      \'setInterval(() => {\',',
      '      \'  const leaf = spawn(process.execPath, ["-e", "process.on(\\\\\\"SIGTERM\\\\\\", () => {}); setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });\',',
      '      \'  fs.appendFileSync(process.argv[1], String(leaf.pid) + "\\\\n");\',',
      '      \'}, 10);\',',
      "    ].join(\"\\n\"),",
      `    ${JSON.stringify(pidFile)},`,
      "  ],",
      '  { detached: true, stdio: "ignore" },',
      ");",
      "fs.appendFileSync(process.argv[1], String(daemon.pid) + \"\\n\");",
      "process.exit(0);",
    ].join("\n");
    const records = [];
    expectFailure(
      () =>
        engine.executeCommands(
          root,
          [
            {
              workingDirectory: ".",
              argv: [process.execPath, "-e", script, pidFile],
              timeoutMs: 5000,
            },
          ],
          { id: "fixture", profile: "jest-typescript" },
          records,
        ),
      /command failed with exit 126/,
    );
    assert.equal(records[0].exitCode, 126);

    const pids = fs
      .readFileSync(pidFile, "utf8")
      .trim()
      .split("\n")
      .map(Number);
    const live = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") {
          return false;
        }
        throw error;
      }
    });
    assert.deepEqual(live, []);
  },
);

test(
  "Linux subreaper cleans detached leaves after ordinary command exits",
  () => {
    if (process.platform !== "linux") {
      assert.match(
        engine.COMMAND_SUPERVISOR_SOURCE,
        /child\.once\("exit", recordChildExit\)/,
      );
      assert.match(
        engine.COMMAND_SUPERVISOR_SOURCE,
        /beginCleanup\(null\)/,
      );
      return;
    }
    const root = temporaryDirectory();
    const processExists = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") {
          return false;
        }
        throw error;
      }
    };
    for (const exitCode of [0, 7]) {
      const leafPidFile = path.join(root, `leaf-${exitCode}.pid`);
      const script = [
        'const fs = require("node:fs");',
        'const { spawn } = require("node:child_process");',
        "const leaf = spawn(",
        "  process.execPath,",
        '  ["-e", \'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)\'],',
        '  { detached: true, stdio: "ignore" },',
        ");",
        "fs.writeFileSync(process.argv[1], String(leaf.pid));",
        `process.exit(${exitCode});`,
      ].join("\n");
      const records = [];
      const invoke = () =>
        engine.executeCommands(
          root,
          [
            {
              workingDirectory: ".",
              argv: [process.execPath, "-e", script, leafPidFile],
              timeoutMs: 5000,
            },
          ],
          { id: "fixture", profile: "jest-typescript" },
          records,
        );
      if (exitCode === 0) {
        expectFailure(invoke, /command failed with exit 126/);
      } else {
        expectFailure(invoke, /command failed with exit 7/);
      }
      assert.equal(records[0].exitCode, exitCode === 0 ? 126 : exitCode);
      const leafPid = Number(fs.readFileSync(leafPidFile, "utf8"));
      const waitArray = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && processExists(leafPid)) {
        Atomics.wait(waitArray, 0, 0, 25);
      }
      assert.equal(processExists(leafPid), false);
    }
  },
);

test("accepts complete raw coverage and rejects selected-file denominators", () => {
  const fixture = createFixture();
  const entry = { id: "auth", profile: "jest-typescript" };
  const eligible = engine.deriveEligibleSources(
    fixture.root,
    fixture.headSha,
    entry,
  );
  writeFile(fixture.root, "auth/src/second.ts", "export const second = 2;\n");
  const head = commitAll(fixture.root, "add second source");
  const complete = engine.deriveEligibleSources(fixture.root, head, entry);
  const reports = writeCoverageReports(
    fixture.root,
    "artifacts/report-complete",
    complete,
  );
  const result = engine.validateCoverageReports(
    fixture.root,
    entry,
    complete,
    complete,
    reports,
  );
  assert.deepEqual(result.coverageFiles, complete);

  const selected = writeCoverageReports(
    fixture.root,
    "artifacts/report-selected",
    [complete[0]],
  );
  expectFailure(
    () =>
      engine.validateCoverageReports(
        fixture.root,
        entry,
        complete,
        [complete[1]],
        selected,
      ),
    /complete eligible source set/,
  );
  assert.equal(eligible.length, 1);
});

test("rejects empty totals and raw ratios rounded up to 80 percent", () => {
  const fixture = createFixture();
  const entry = { id: "auth", profile: "jest-typescript" };
  const eligible = engine.deriveEligibleSources(
    fixture.root,
    fixture.headSha,
    entry,
  );
  const empty = writeCoverageReports(
    fixture.root,
    "artifacts/report-empty",
    eligible,
    { lines: [], branches: [] },
  );
  expectFailure(
    () =>
      engine.validateCoverageReports(
        fixture.root,
        entry,
        eligible,
        [],
        empty,
      ),
    /lines\.total must be an integer >= 1/,
  );

  const rounded = writeCoverageReports(
    fixture.root,
    "artifacts/report-rounded",
    eligible,
    {
      lines: [...Array(799).fill(1), ...Array(201).fill(0)],
      branches: [1, 1, 1, 1, 0],
    },
  );
  expectFailure(
    () =>
      engine.validateCoverageReports(
        fixture.root,
        entry,
        eligible,
        [],
        rounded,
      ),
    /below 80%/,
  );
});

test("rejects source-map collisions, out-of-root paths, generated files, and changed omissions", () => {
  const fixture = createFixture({ telemetry: true });
  const entry = { id: "telemetry", profile: "jest-typescript" };
  const eligible = engine.deriveEligibleSources(
    fixture.root,
    fixture.headSha,
    entry,
  );
  const reports = writeCoverageReports(
    fixture.root,
    "artifacts/report-collision",
    eligible,
  );
  mutateCoverageFinal(reports, (final, record) => {
    final[eligible[0]] = record;
  });
  expectCoverageFailure(fixture, entry, eligible, reports, /source-map collision/);

  const istanbulSentinels = writeCoverageReports(
    fixture.root,
    "artifacts/report-istanbul-sentinels",
    eligible,
  );
  mutateCoverageFinal(istanbulSentinels, (_final, record) => {
    record.statementMap[0].end = null;
    record.fnMap = null;
    record.f = "ignored";
    record.branchMap[0].loc = null;
    record.branchMap[0].locations = [null, {}];
  });
  assert.deepEqual(
    engine.validateCoverageReports(
      fixture.root,
      entry,
      eligible,
      eligible,
      istanbulSentinels,
    ).coverageFiles,
    eligible,
  );

  const embeddedMismatch = writeCoverageReports(
    fixture.root,
    "artifacts/report-embedded-mismatch",
    eligible,
  );
  mutateCoverageFinal(embeddedMismatch, (_final, record) => {
    record.path = path.join(fixture.root, "common/src/index.ts");
  });
  expectCoverageFailure(
    fixture, entry, eligible, embeddedMismatch,
    /embedded coverage path does not match outer key/,
  );

  const orphanStatement = writeCoverageReports(
    fixture.root,
    "artifacts/report-orphan-statement",
    eligible,
  );
  mutateCoverageFinal(orphanStatement, (_final, record) => {
    record.s.orphan = 1;
  });
  expectCoverageFailure(
    fixture, entry, eligible, orphanStatement, /statement map and counters differ/,
  );

  const orphanBranch = writeCoverageReports(
    fixture.root,
    "artifacts/report-orphan-branch",
    eligible,
  );
  mutateCoverageFinal(orphanBranch, (_final, record) => {
    record.branchMap[0].locations.pop();
  });
  expectCoverageFailure(
    fixture, entry, eligible, orphanBranch, /locations and counters differ/,
  );

  const orphanBranchCounter = writeCoverageReports(
    fixture.root,
    "artifacts/report-orphan-branch-counter",
    eligible,
  );
  mutateCoverageFinal(orphanBranchCounter, (_final, record) => {
    record.b.orphan = [1];
  });
  expectCoverageFailure(
    fixture, entry, eligible, orphanBranchCounter, /branch map and counters differ/,
  );

  for (const [name, mutate, pattern] of [
    ["statement-line", (record) => {
      record.statementMap[0].start.line = 0;
    }, /statement 0 start line/],
    ["statement-hit", (record) => {
      record.s[0] = Number.MAX_SAFE_INTEGER + 1;
    }, /statement 0 hits/],
    ["branch-hit", (record) => {
      record.b[0][0] = -1;
    }, /branch 0 hit/],
  ]) {
    const invalid = writeCoverageReports(
      fixture.root,
      `artifacts/report-${name}`,
      eligible,
    );
    mutateCoverageFinal(invalid, (_final, record) => mutate(record));
    expectCoverageFailure(fixture, entry, eligible, invalid, pattern);
  }

  const outside = writeCoverageReports(
    fixture.root,
    "artifacts/report-outside",
    eligible,
  );
  mutateCoverageFinal(outside, (final, record, firstKey) => {
    delete final[firstKey];
    final[path.join(path.dirname(fixture.root), "outside.ts")] = record;
  });
  expectCoverageFailure(fixture, entry, eligible, outside, /outside the repository/);

  const generated = writeCoverageReports(
    fixture.root,
    "artifacts/report-generated",
    [...eligible, "telemetry/build/index.js"],
  );
  expectCoverageFailure(
    fixture, entry, eligible, generated, /complete eligible source set/,
  );

  const changed = engine.deriveChangedSources(
    fixture.root,
    fixture.baseSha,
    fixture.headSha,
    entry,
    eligible,
  );
  assert.deepEqual(changed.changedEligible, ["telemetry/src/index.ts"]);
  const omitted = writeCoverageReports(
    fixture.root,
    "artifacts/report-changed-omitted",
    [],
  );
  expectFailure(
    () =>
      engine.validateCoverageReports(
        fixture.root,
        entry,
        eligible,
        changed.changedEligible,
        omitted,
      ),
    /complete eligible source set/,
  );
});

test("rejects inconsistent Jest and TAP counts", () => {
  const root = temporaryDirectory();
  const jestPath = writeJson(root, "jest.json", {
    success: true,
    wasInterrupted: false,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
  });
  expectFailure(
    () => engine.parseJestTestResults(jestPath, "auth"),
    /counts are inconsistent/,
  );
  const tapPath = writeFile(
    root,
    "test.tap",
    [
      "TAP version 13",
      "1..2",
      "# tests 2",
      "# pass 1",
      "# fail 0",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      "",
    ].join("\n"),
  );
  expectFailure(
    () => engine.parseTapTestResults(tapPath, "common"),
    /counts are inconsistent/,
  );
});

test("rejects skipped and todo Jest and TAP tests", () => {
  const root = temporaryDirectory();
  for (const field of ["skipped", "todo"]) {
    const counts = { total: 2, passed: 1, [field]: 1 };
    const jestPath = writeTestResults(
      root,
      `jest-${field}`,
      "jest-typescript",
      counts,
    );
    expectFailure(
      () => engine.parseJestTestResults(jestPath, "auth"),
      /contain skipped or todo tests/,
    );

    const tapPath = writeTestResults(
      root,
      `tap-${field}`,
      "node-typescript-c8",
      counts,
    );
    expectFailure(
      () => engine.parseTapTestResults(tapPath, "common"),
      /contain skipped or todo tests/,
    );
  }
});

test("binds Jest execution to every tracked suite despite discovery settings", () => {
  const fixture = createFixture();
  writeFile(
    fixture.root,
    "auth/src/second.test.ts",
    "test('second', () => {});\n",
  );
  writeFile(
    fixture.root,
    "auth/src/__tests__/regression.ts",
    "test('regression', () => {});\n",
  );
  writeFile(
    fixture.root,
    "auth/src/test.ts",
    "test('bare', () => {});\n",
  );
  const manifestPath = path.join(fixture.root, "auth/package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.jest = {
    testMatch: ["**/index.test.ts"],
    testPathIgnorePatterns: ["second.test.ts"],
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const headSha = commitAll(fixture.root, "narrow candidate Jest discovery");
  const entry = {
    id: "auth",
    profile: "jest-typescript",
    testFiles: engine.deriveTestFiles(
      fixture.root,
      headSha,
      { id: "auth", profile: "jest-typescript" },
    ),
  };
  const commands = engine.buildCommandPlan(
    entry,
    engine.deriveEligibleSources(fixture.root, headSha, entry),
    { repoRoot: fixture.root, treeish: headSha },
  );
  const testCommand = commands.find((command) =>
    command.argv[0].endsWith("/jest"),
  );
  const runTestsIndex = testCommand.argv.indexOf("--runTestsByPath");
  assert.notEqual(runTestsIndex, -1);
  assert.deepEqual(
    testCommand.argv.slice(runTestsIndex + 1),
    [
      "src/__tests__/regression.ts",
      "src/index.test.ts",
      "src/second.test.ts",
      "src/test.ts",
    ],
  );
});

test("rejects missing or wholly skipped Jest suites", () => {
  const fixture = createFixture();
  const entry = {
    id: "auth",
    profile: "jest-typescript",
  };
  const expected = engine.deriveTestFiles(
    fixture.root,
    fixture.headSha,
    entry,
  );
  const resultPath = writeTestResults(
    fixture.root,
    "artifacts/suite-results",
    entry.profile,
    {},
    expected,
  );
  assert.doesNotThrow(() =>
    engine.parseJestTestResults(
      resultPath,
      entry.id,
      expected,
      fixture.root,
    ),
  );

  const missing = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  missing.testResults = [];
  missing.numTotalTestSuites = 0;
  missing.numPassedTestSuites = 0;
  fs.writeFileSync(resultPath, JSON.stringify(missing));
  expectFailure(
    () =>
      engine.parseJestTestResults(
        resultPath,
        entry.id,
        expected,
        fixture.root,
      ),
    /tracked test inventory/,
  );

  const skippedPath = writeTestResults(
    fixture.root,
    "artifacts/skipped-suite",
    entry.profile,
    {},
    expected,
  );
  const skipped = JSON.parse(fs.readFileSync(skippedPath, "utf8"));
  skipped.testResults[0].status = "pending";
  skipped.testResults[0].assertionResults = [{ status: "pending" }];
  fs.writeFileSync(skippedPath, JSON.stringify(skipped));
  expectFailure(
    () =>
      engine.parseJestTestResults(
        skippedPath,
        entry.id,
        expected,
        fixture.root,
      ),
    /wholly skipped test suite/,
  );
});

test("validates positive evidence and rejects totals, tests, lock, toolchain, command, run, and attempt drift", () => {
  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "auth");
  assert.equal(
    engine.validateEvidenceArtifact(
      fixture.root,
      fixture.root,
      fixture.context,
      artifact.evidencePath,
    ).status,
    "success",
  );

  const mutations = [
    [
      (value) => {
        value.coverage.lines.total = 0;
        value.coverage.lines.covered = 0;
      },
      /lines\.total/,
    ],
    [
      (value) => {
        value.tests.total += 1;
      },
      /test counts/,
    ],
    [
      (value) => {
        value.tests.passed -= 1;
        value.tests.skipped = 1;
      },
      /skipped or todo tests/,
    ],
    [
      (value) => {
        value.locks[0].sha256 = "0".repeat(64);
      },
      /package lock identity/,
    ],
    [
      (value) => {
        value.toolchain.node = "20.19.4";
      },
      /Node version/,
    ],
    [
      (value) => {
        value.commands[0].argv.push("; touch pwned");
      },
      /command outside the fixed profile/,
    ],
    [
      (value) => {
        value.repository.runId = "999";
      },
      /repository identity/,
    ],
    [
      (value) => {
        value.repository.runAttempt = 2;
      },
      /repository identity/,
    ],
    [
      (value) => {
        value.commands[0].exitCode = 126;
      },
      /successful evidence contains a failed command/,
    ],
    [
      (value) => {
        value.status = "failure";
      },
      /success status/,
    ],
  ];
  for (const [mutate, pattern] of mutations) {
    const changed = structuredClone(artifact.evidence);
    mutate(changed);
    expectFailure(
      () =>
        engine.validateEvidenceObject(
          fixture.root,
          fixture.root,
          fixture.context,
          changed,
        ),
      pattern,
    );
  }
});

test("rejects raw report hash and source-set tampering", () => {
  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "client");
  fs.appendFileSync(
    path.join(path.dirname(artifact.evidencePath), "test-results.json"),
    " ",
  );
  expectFailure(
    () =>
      engine.validateEvidenceArtifact(
        fixture.root,
        fixture.root,
        fixture.context,
        artifact.evidencePath,
      ),
    /report hashes/,
  );
});

test("aggregates exactly one run-bound successful artifact per descriptor entry", () => {
  const fixture = createFixture();
  for (const [id] of CURRENT_ENTRIES) {
    createEvidenceArtifact(fixture, id);
  }
  const aggregate = engine.aggregateEvidence(
    fixture.root,
    fixture.root,
    fixture.context,
    path.join(fixture.root, ...engine.ARTIFACT_ROOT.split("/")),
  );
  assert.deepEqual(
    aggregate.expectedPackageIds,
    CURRENT_ENTRIES.map(([id]) => id),
  );
  assert.equal(aggregate.allPackagesSucceeded, true);
  assert.equal(aggregate.tests.total, CURRENT_ENTRIES.length * 2);

  fs.rmSync(
    path.join(
      fixture.root,
      ...engine.ARTIFACT_ROOT.split("/"),
      "auth",
      "evidence.json",
    ),
  );
  expectFailure(
    () =>
      engine.aggregateEvidence(
        fixture.root,
        fixture.root,
        fixture.context,
        path.join(fixture.root, ...engine.ARTIFACT_ROOT.split("/")),
      ),
    /package mismatch/,
  );
});

test("rejects duplicate, stale-run, and cross-attempt aggregate evidence", () => {
  const duplicateFixture = createFixture();
  for (const [id] of CURRENT_ENTRIES) {
    createEvidenceArtifact(duplicateFixture, id);
  }
  const duplicateSource = path.join(
    duplicateFixture.root,
    ...engine.ARTIFACT_ROOT.split("/"),
    "auth",
  );
  const duplicateTarget = path.join(
    duplicateFixture.root,
    ...engine.ARTIFACT_ROOT.split("/"),
    "duplicate",
  );
  fs.cpSync(duplicateSource, duplicateTarget, { recursive: true });
  expectFailure(
    () =>
      engine.aggregateEvidence(
        duplicateFixture.root,
        duplicateFixture.root,
        duplicateFixture.context,
        path.join(
          duplicateFixture.root,
          ...engine.ARTIFACT_ROOT.split("/"),
        ),
      ),
    /duplicate aggregate evidence/,
  );

  for (const [field, value] of [
    ["runId", "999999"],
    ["runAttempt", 2],
  ]) {
    const fixture = createFixture();
    for (const [id] of CURRENT_ENTRIES) {
      createEvidenceArtifact(fixture, id);
    }
    const evidencePath = path.join(
      fixture.root,
      ...engine.ARTIFACT_ROOT.split("/"),
      "auth",
      "evidence.json",
    );
    const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
    evidence.repository[field] = value;
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    expectFailure(
      () =>
        engine.aggregateEvidence(
          fixture.root,
          fixture.root,
          fixture.context,
          path.join(fixture.root, ...engine.ARTIFACT_ROOT.split("/")),
        ),
      /repository identity/,
    );
  }
});

test("enforces bounded descriptor, entry, source, evidence, and workflow sizes", () => {
  const oversizedDescriptorRoot = temporaryDirectory();
  writeFile(
    oversizedDescriptorRoot,
    engine.DESCRIPTOR_PATH,
    " ".repeat(engine.LIMITS.descriptorBytes + 1),
  );
  expectFailure(
    () => engine.readDescriptor(oversizedDescriptorRoot),
    /exceeds/,
  );

  const tooManyEntries = descriptor(
    Array.from({ length: engine.LIMITS.entries + 1 }, (_, index) => [
      `p${String(index).padStart(2, "0")}`,
      "jest-typescript",
    ]),
  );
  expectFailure(
    () => engine.validateDescriptorObject(tooManyEntries),
    /exceeds/,
  );
  expectFailure(
    () =>
      engine.assertPathSet(
        Array.from(
          { length: engine.LIMITS.sourceFilesPerEntry + 1 },
          (_, index) => `auth/src/file${String(index).padStart(5, "0")}.ts`,
        ),
        "sources",
      ),
    /exceeds/,
  );

  const evidenceRoot = temporaryDirectory();
  const evidencePath = writeFile(
    evidenceRoot,
    "evidence.json",
    " ".repeat(engine.LIMITS.evidenceBytes + 1),
  );
  expectFailure(
    () =>
      engine.readJsonFile(
        evidencePath,
        engine.LIMITS.evidenceBytes,
        "evidence",
      ),
    /exceeds/,
  );

  const workflowFixture = createFixture();
  writeFile(
    workflowFixture.root,
    ".github/workflows/large.yml",
    `name: large\n#${"x".repeat(engine.LIMITS.workflowBytes)}\n`,
  );
  commitAll(workflowFixture.root, "oversized workflow");
  expectFailure(
    () => engine.validateRepository(workflowFixture.root),
    /exceeds/,
  );
});

test("records Common and future Telemetry changes and rejects their omission", () => {
  const fixture = createFixture({ telemetry: true });
  for (const id of ["common", "telemetry"]) {
    const profile =
      id === "common" ? "node-typescript-c8" : "jest-typescript";
    const entry = { id, profile };
    const eligible = engine.deriveEligibleSources(
      fixture.root,
      fixture.headSha,
      entry,
    );
    const changes = engine.deriveChangedSources(
      fixture.root,
      fixture.baseSha,
      fixture.headSha,
      entry,
      eligible,
    );
    assert.deepEqual(changes.changedEligible, [`${id}/src/index.ts`]);
    const missing = writeCoverageReports(
      fixture.root,
      `artifacts/${id}-missing`,
      [],
    );
    expectFailure(
      () =>
        engine.validateCoverageReports(
          fixture.root,
          entry,
          eligible,
          changes.changedEligible,
          missing,
        ),
      /complete eligible source set/,
    );
  }
});

test("rejects report summary count drift independently of percentages", () => {
  const fixture = createFixture();
  const entry = { id: "auth", profile: "jest-typescript" };
  const eligible = engine.deriveEligibleSources(
    fixture.root,
    fixture.headSha,
    entry,
  );
  const reports = writeCoverageReports(
    fixture.root,
    "artifacts/summary-drift",
    eligible,
  );
  const summary = JSON.parse(fs.readFileSync(reports.coverageSummary, "utf8"));
  summary.total.lines.covered = 999;
  summary.total.lines.pct = 100;
  fs.writeFileSync(reports.coverageSummary, JSON.stringify(summary));
  expectFailure(
    () =>
      engine.validateCoverageReports(
        fixture.root,
        entry,
        eligible,
        [],
        reports,
      ),
    /summary total lines|summary totals differ/,
  );
});

test("keeps package execution and artifact paths repository-relative", () => {
  const fixture = createFixture();
  const prepared = engine.prepareEntry(
    fixture.root,
    fixture.root,
    fixture.context,
    "common",
  );
  for (const commandRecord of prepared.commands) {
    assert.equal(path.isAbsolute(commandRecord.workingDirectory), false);
    for (const argument of commandRecord.argv) {
      assert.equal(argument.includes(fixture.root), false);
    }
  }
  const artifact = createEvidenceArtifact(fixture, "common");
  assert.equal(JSON.stringify(artifact.evidence).includes(fixture.root), false);
});

test("requires raw nonzero branch totals for every supported profile", () => {
  const fixture = createFixture();
  for (const [id, profile] of CURRENT_ENTRIES) {
    const entry = { id, profile };
    const eligible = engine.deriveEligibleSources(
      fixture.root,
      fixture.headSha,
      entry,
    );
    const reports = writeCoverageReports(
      fixture.root,
      `artifacts/${id}-zero-branches`,
      eligible,
      { branches: [] },
    );
    expectFailure(
      () =>
        engine.validateCoverageReports(
          fixture.root,
          entry,
          eligible,
          [],
          reports,
        ),
      /branches\.total must be an integer >= 1/,
    );
  }
});

test("the exact central lock pins c8 and no speculative direct dependency", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(
      path.join(REPOSITORY_ROOT, ".github/coverage/package.json"),
      "utf8",
    ),
  );
  const lock = JSON.parse(
    fs.readFileSync(
      path.join(REPOSITORY_ROOT, ".github/coverage/package-lock.json"),
      "utf8",
    ),
  );
  assert.deepEqual(packageJson.devDependencies, { c8: "12.0.0" });
  assert.deepEqual(lock.packages[""].devDependencies, { c8: "12.0.0" });
  assert.equal(lock.packages["node_modules/c8"].version, "12.0.0");
  assert.equal(Object.keys(packageJson.devDependencies).length, 1);
});

test("changed-source parsing rejects unsupported or incomplete Git records", () => {
  expectFailure(
    () => engine.parseDiffNameStatus(Buffer.from("T\0auth/src/index.ts\0")),
    /unsupported status/,
  );
  expectFailure(
    () => engine.parseDiffNameStatus(Buffer.from("R100\0auth/src/index.ts\0")),
    /incomplete/,
  );
});

test("evidence JSON uses the exact required top-level fields", () => {
  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "auth");
  assert.deepEqual(Object.keys(artifact.evidence).sort(), [...engine.EVIDENCE_KEYS].sort());
  assert.equal(artifact.evidence.repository.name, undefined);
  assert.equal(artifact.evidence.workflow.path, engine.WORKFLOW_PATH);
  assert.equal(artifact.evidence.failures.length, 0);
  assert.match(
    crypto
      .createHash("sha256")
      .update(fs.readFileSync(artifact.evidencePath))
      .digest("hex"),
    /^[0-9a-f]{64}$/,
  );
});
