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

function restoreWritablePermissions(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    return;
  }
  if (stat.isSymbolicLink()) {
    return;
  }
  fs.chmodSync(target, stat.isDirectory() ? 0o700 : 0o600);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) {
      restoreWritablePermissions(path.join(target, name));
    }
  }
}

test.afterEach(() => {
  for (const directory of temporaryDirectories) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      restoreWritablePermissions(directory);
      fs.rmSync(directory, { recursive: true, force: true });
    }
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

function tapResultLines(values) {
  const names = [];
  for (let index = 0; index < values.total; index += 1) {
    names.push(`case ${index + 1}`);
  }
  const lines = [];
  const emit = (ok, directive) => {
    const position = lines.length / 2 + 1;
    const name = names[position - 1];
    lines.push(`# Subtest: ${name}`);
    lines.push(
      `${ok ? "ok" : "not ok"} ${position} - ${name}${directive ? ` # ${directive}` : ""}`,
    );
  };
  for (let index = 0; index < values.failed; index += 1) {
    emit(false, null);
  }
  for (let index = 0; index < values.skipped; index += 1) {
    emit(true, "SKIP");
  }
  for (let index = 0; index < values.todo; index += 1) {
    emit(true, "TODO");
  }
  while (lines.length / 2 < values.total) {
    emit(true, null);
  }
  return lines;
}

function tapNodeStyleDocument(lines, summary) {
  return `${["TAP version 13", ...lines,
    `# tests ${summary.tests}`,
    "# suites 0",
    `# pass ${summary.pass}`,
    `# fail ${summary.fail}`,
    "# cancelled 0",
    `# skipped ${summary.skipped}`,
    `# todo ${summary.todo}`,
    "# duration_ms 1",
  ].join("\n")}\n`;
}

function tapDocument(values, expectedTestFiles = [], options = {}) {
  const summary = [
    `# tests ${values.total}`,
    "# suites 0",
    `# pass ${values.passed}`,
    `# fail ${values.failed}`,
    "# cancelled 0",
    `# skipped ${values.skipped}`,
    `# todo ${values.todo}`,
    "# duration_ms 1",
  ];
  const lines = [
    "TAP version 13",
    ...(options.omitPlan ? [] : [`1..${options.plan ?? values.total}`]),
    ...tapResultLines(values),
  ];
  if (options.omitSummary) {
    return `${lines.join("\n")}\n`;
  }
  if (options.summaryBeforeResults) {
    return `${["TAP version 13", `1..${values.total}`, ...summary, ...tapResultLines(values)].join("\n")}\n`;
  }
  if (options.duplicateSummary) {
    return `${[...lines, ...summary, ...summary].join("\n")}\n`;
  }
  return `${[...lines, ...summary].join("\n")}\n`;
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
      tapDocument(values, expectedTestFiles),
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

function digestOf(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function observedIdentity(uid, gid, options = {}) {
  const controller = uid === 0;
  const owned = controller
    ? engine.CONTROLLER_CAPABILITY_MASK
    : engine.ZERO_CAPABILITY_MASK;
  return {
    source: options.source || "proc",
    uid,
    euid: uid,
    gid,
    egid: gid,
    supplementaryGroups: options.groups || [],
    noNewPrivs: options.noNewPrivs ?? 1,
    capEff: options.capEff || owned,
    capPrm: options.capPrm || owned,
    capAmb: options.capAmb || engine.ZERO_CAPABILITY_MASK,
    capBnd: options.capBnd || engine.CONTROLLER_CAPABILITY_MASK,
    capInh: options.capInh || engine.ZERO_CAPABILITY_MASK,
  };
}

function executionFor(coverageFinalPath, testResultsPath, prepared = null) {
  const rawBytes = Buffer.from('{"result":[]}\n', "utf8");
  const stdoutBytes = fs.readFileSync(testResultsPath);
  return {
    controllerIdentity: observedIdentity(0, 0),
    workerIdentity: observedIdentity(engine.WORKER_UID, engine.WORKER_GID),
    supplemental:
      prepared && prepared.supplementalSnapshot
        ? prepared.supplementalSnapshot.records.map((record) => ({
          path: record.path,
          gitBlob: record.gitBlob,
          bytes: record.byteLength,
          sha256: record.sha256,
        }))
        : [],
    rawFiles: [
      {
        name: "coverage-1024-1700000000000-0.json",
        bytes: rawBytes.length,
        sha256: crypto.createHash("sha256").update(rawBytes).digest("hex"),
      },
    ],
    stdout: {
      bytes: stdoutBytes.length,
      sha256: crypto.createHash("sha256").update(stdoutBytes).digest("hex"),
    },
    stderr: {
      bytes: 0,
      sha256: crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    },
    reportSha256: digestOf(coverageFinalPath),
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
  if (prepared.entry.profile === "node-typescript-c8") {
    writeFile(fixture.root, `${directory}/worker-stderr.log`, "");
  }
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
  const commands = prepared.commands.map(
    ({ role, uid, workingDirectory, argv }) => ({
      role,
      uid,
      workingDirectory,
      argv,
      exitCode: 0,
      identity:
        role === "worker"
          ? observedIdentity(engine.WORKER_UID, engine.WORKER_GID)
          : observedIdentity(0, 0),
    }),
  );
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
    execution: executionFor(reports.coverageFinal, testResults, prepared),
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
          captureStdout: true,
          timeoutMs: 5000,
        },
      ],
      { id: "fixture", profile: "jest-typescript" },
      [],
      {
        capture: { stdoutPath: path.join(root, "fixture", "registry.txt") },
      },
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
      env: engine.controllerEnvironment(engine.resolveExecutionLayout({ repoRoot: REPOSITORY_ROOT, entryId: "common", authoritative: false })),
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
    identity: { uid: -1, gid: -1, umask: 0o077 },
    identityReportPath: null,
    childEnvironment: {},
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
      env: engine.controllerEnvironment(engine.resolveExecutionLayout({ repoRoot: REPOSITORY_ROOT, entryId: "common", authoritative: false })),
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
      env: engine.controllerEnvironment(engine.resolveExecutionLayout({ repoRoot: REPOSITORY_ROOT, entryId: "common", authoritative: false })),
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
    /command 0 \(controller\) failed with exit 126/,
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
        identity: { uid: -1, gid: -1, umask: 0o077 },
        identityReportPath: null,
        childEnvironment: {},
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
    const runPreparedStart = source.indexOf("function runPreparedEntry(");
    const executeEntryStart = source.indexOf("function executeEntry(");
    const executeEntryEnd = source.indexOf(
      "\nfunction assertCoverageMetric(",
      executeEntryStart,
    );
    assert.ok(runPreparedStart >= 0);
    assert.ok(executeEntryStart > runPreparedStart);
    assert.ok(executeEntryEnd > executeEntryStart);
    const runPreparedSource = source.slice(runPreparedStart, executeEntryStart);
    const executeEntrySource = source.slice(executeEntryStart, executeEntryEnd);
    const stageIndex = runPreparedSource.indexOf("stageWorkerPackage(");
    const sealIndex = runPreparedSource.indexOf("sealGitAccess();");
    const executeIndex = runPreparedSource.indexOf("executeCommands(");
    const freezeIndex = runPreparedSource.indexOf("freezeRawCoverage(layout)");
    const verifyIndex = runPreparedSource.indexOf(
      "verifyPreparedFilesystemState(repoRoot, prepared);",
      executeIndex,
    );
    const containerIndex = executeEntrySource.indexOf(
      "assertAuthoritativeContainer(layout);",
    );
    const prepareIndex = executeEntrySource.indexOf(
      "const prepared = prepareEntry(",
    );
    const pipelineIndex = executeEntrySource.indexOf("runPreparedEntry({");
    const evidenceIndex = executeEntrySource.indexOf(
      "validateEvidenceAgainstPrepared(repoRoot, context, evidence, prepared, {",
      pipelineIndex,
    );
    const supplementalIndex = runPreparedSource.indexOf(
      "stageSupplementalInputs(repoRoot, prepared.supplementalSnapshot, layout);",
    );
    assert.ok(supplementalIndex > stageIndex);
    assert.ok(sealIndex > supplementalIndex);
    assert.ok(stageIndex >= 0);
    assert.ok(sealIndex > stageIndex);
    assert.ok(executeIndex > sealIndex);
    assert.ok(freezeIndex > executeIndex);
    assert.ok(verifyIndex > executeIndex);
    assert.ok(containerIndex >= 0);
    assert.ok(prepareIndex > containerIndex);
    assert.ok(pipelineIndex > prepareIndex);
    assert.ok(evidenceIndex > pipelineIndex);
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
      env: engine.controllerEnvironment(engine.resolveExecutionLayout({ repoRoot: REPOSITORY_ROOT, entryId: "common", authoritative: false })),
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
  // The descriptor is master-parity bound, so a registration lands on the
  // trusted default branch before any candidate run may use it.
  context.engine.trustedDefaultSha = headSha;

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
        role: commandRecord.role,
        uid: commandRecord.uid,
        workingDirectory: commandRecord.workingDirectory,
        argv: commandRecord.argv,
      }));
    }
  }
  assert.deepEqual(commonCommands.slice(0, 4), [
    {
      role: "controller",
      uid: 0,
      workingDirectory: "<TOOL>",
      argv: ["npm", ...engine.NPM_CI_ARGUMENTS],
    },
    {
      role: "worker",
      uid: 10001,
      workingDirectory: "<PKG>",
      argv: ["npm", ...engine.NPM_CI_ARGUMENTS],
    },
    {
      role: "worker",
      uid: 10001,
      workingDirectory: "<PKG>",
      argv: ["npm", "run", "clean"],
    },
    {
      role: "worker",
      uid: 10001,
      workingDirectory: "<PKG>",
      argv: [
        "<PKG_BIN>/tsc",
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
    assert.equal(records.length, 1);
    assert.deepEqual(
      {
        role: records[0].role,
        uid: records[0].uid,
        workingDirectory: records[0].workingDirectory,
        argv: records[0].argv,
        exitCode: records[0].exitCode,
      },
      {
        role: "controller",
        uid: process.getuid(),
        workingDirectory: ".",
        argv: [
          process.execPath,
          "-e",
          hangingProcess,
          pidFile,
        ],
        exitCode: 124,
      },
    );
    assert.equal(records[0].identity.uid, process.getuid());
    assert.notEqual(records[0].identity.uid, engine.WORKER_UID);
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
      identity: { uid: -1, gid: -1, umask: 0o077 },
      identityReportPath: null,
      childEnvironment: {},
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
      /command 0 \(controller\) failed with exit 126/,
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
      /command 0 \(controller\) failed with exit 126/,
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
    identity: { uid: -1, gid: -1, umask: 0o077 },
    identityReportPath: null,
    childEnvironment: {},
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
      /command 0 \(controller\) failed with exit 126/,
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
        expectFailure(invoke, /command 0 \(controller\) failed with exit 126/);
      } else {
        expectFailure(invoke, /command 0 \(controller\) failed with exit 7/);
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
      "# Subtest: case 1",
      "ok 1 - case 1",
      "# Subtest: case 2",
      "ok 2 - case 2",
      "1..2",
      "# tests 2",
      "# suites 0",
      "# pass 1",
      "# fail 0",
      "# cancelled 0",
      "# skipped 0",
      "# todo 0",
      "# duration_ms 1",
      "",
    ].join("\n"),
  );
  expectFailure(
    () => engine.parseTapTestResults(tapPath, "common"),
    /passing results do not match the reported counts/,
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

test("aggregates exactly the enforced Common evidence set", () => {
  const fixture = createFixture();
  createEvidenceArtifact(fixture, "common");
  const artifactsRoot = path.join(
    fixture.root,
    ...engine.ARTIFACT_ROOT.split("/"),
  );
  const aggregate = engine.aggregateEvidence(
    fixture.root,
    fixture.root,
    fixture.context,
    artifactsRoot,
  );
  assert.deepEqual(aggregate.expectedPackageIds, engine.ENFORCED_PACKAGE_IDS);
  assert.deepEqual(engine.ENFORCED_PACKAGE_IDS, ["common"]);
  assert.equal(aggregate.allPackagesSucceeded, true);
  assert.equal(aggregate.schemaVersion, engine.EVIDENCE_SCHEMA_VERSION);
  assert.equal(aggregate.tests.total, 2);

  createEvidenceArtifact(fixture, "auth");
  expectFailure(
    () =>
      engine.aggregateEvidence(
        fixture.root,
        fixture.root,
        fixture.context,
        artifactsRoot,
      ),
    /package mismatch: expected=common actual=auth,common/,
  );
  fs.rmSync(path.join(artifactsRoot, "auth"), { recursive: true, force: true });
  fs.rmSync(path.join(artifactsRoot, "common", "evidence.json"));
  expectFailure(
    () =>
      engine.aggregateEvidence(
        fixture.root,
        fixture.root,
        fixture.context,
        artifactsRoot,
      ),
    /package mismatch: expected=common actual=$/,
  );
});

test("rejects duplicate, stale-run, and cross-attempt aggregate evidence", () => {
  const duplicateFixture = createFixture();
  createEvidenceArtifact(duplicateFixture, "common");
  const duplicateRoot = path.join(
    duplicateFixture.root,
    ...engine.ARTIFACT_ROOT.split("/"),
  );
  fs.cpSync(
    path.join(duplicateRoot, "common"),
    path.join(duplicateRoot, "duplicate"),
    { recursive: true },
  );
  expectFailure(
    () =>
      engine.aggregateEvidence(
        duplicateFixture.root,
        duplicateFixture.root,
        duplicateFixture.context,
        duplicateRoot,
      ),
    /duplicate aggregate evidence/,
  );

  for (const [field, value] of [
    ["runId", "999999"],
    ["runAttempt", 2],
  ]) {
    const fixture = createFixture();
    createEvidenceArtifact(fixture, "common");
    const evidencePath = path.join(
      fixture.root,
      ...engine.ARTIFACT_ROOT.split("/"),
      "common",
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

function localLayout(repoRoot, entryId = "common") {
  const layout = engine.resolveExecutionLayout({
    repoRoot,
    entryId,
    authoritative: false,
  });
  temporaryDirectories.add(layout.temporaryRoot);
  return layout;
}

function preparedLayout(repoRoot, entryId = "common") {
  return engine.prepareControlledRoots(localLayout(repoRoot, entryId));
}

test("rejects tracked and working-tree coverage tool configuration files", () => {
  assert.deepEqual(
    [...engine.FORBIDDEN_COVERAGE_CONFIG_FILES],
    [
      ".c8rc",
      ".c8rc.cjs",
      ".c8rc.js",
      ".c8rc.json",
      ".c8rc.yaml",
      ".c8rc.yml",
      ".istanbul.yml",
      ".nycrc",
      ".nycrc.json",
      ".nycrc.yaml",
      ".nycrc.yml",
      "c8.config.cjs",
      "c8.config.js",
      "c8.config.mjs",
      "nyc.config.cjs",
      "nyc.config.js",
      "nyc.config.mjs",
    ],
  );
  for (const [directory, name, tracked] of [
    ["", ".c8rc", false],
    ["", "nyc.config.js", true],
    [".github/coverage", ".c8rc.json", false],
    [".github/coverage", ".nycrc.yml", true],
    ["common", ".c8rc.json", false],
    ["common", "c8.config.mjs", true],
    ["common", ".istanbul.yml", false],
    ["auth", ".nycrc", true],
  ]) {
    const fixture = createFixture();
    const repoPath = directory === "" ? name : `${directory}/${name}`;
    writeFile(fixture.root, repoPath, "{}\n");
    if (tracked) {
      commitAll(fixture.root, `add ${repoPath}`);
    }
    expectFailure(
      () => engine.validateRepository(fixture.root),
      new RegExp(
        `repository coverage tool configuration is forbidden: ${repoPath.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        )}`,
      ),
    );
  }
});

test("rejects c8, nyc, and istanbul keys in every governed manifest", () => {
  for (const key of [...engine.FORBIDDEN_COVERAGE_MANIFEST_KEYS]) {
    const fixture = createFixture();
    const manifestPath = path.join(fixture.root, "common/package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest[key] = key === "c8" ? { extends: "../evil.json" } : {};
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    commitAll(fixture.root, `add ${key} manifest key`);
    expectFailure(
      () => engine.validateRepository(fixture.root, { treeish: "HEAD" }),
      new RegExp(
        `common package manifest must not declare a ${key} coverage configuration key`,
      ),
    );
  }

  const toolFixture = createFixture();
  const toolPackagePath = path.join(
    toolFixture.root,
    ...engine.TOOL_PACKAGE_PATH.split("/"),
  );
  const toolPackage = JSON.parse(fs.readFileSync(toolPackagePath, "utf8"));
  toolPackage.c8 = { extends: "../evil.json" };
  fs.writeFileSync(toolPackagePath, `${JSON.stringify(toolPackage, null, 2)}\n`);
  expectFailure(
    () => engine.validateToolPackage(toolFixture.root),
    /coverage tool package fields must be exactly/,
  );
});

test("generates the trusted empty c8 configuration without following links", () => {
  const root = temporaryDirectory();
  const layout = preparedLayout(root);
  assert.equal(fs.readFileSync(layout.c8Config, "utf8"), "{}\n");
  const stat = fs.lstatSync(layout.c8Config);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(layout.c8Config.startsWith(layout.temporaryRoot), true);

  const outside = path.join(root, "hostile-c8-config.json");
  fs.writeFileSync(outside, '{"extends":"../evil.json"}\n');
  fs.rmSync(layout.c8Config);
  fs.symlinkSync(outside, layout.c8Config);
  engine.writeGeneratedC8Configuration(layout);
  assert.equal(fs.lstatSync(layout.c8Config).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(layout.c8Config, "utf8"), "{}\n");
  assert.equal(
    fs.readFileSync(outside, "utf8"),
    '{"extends":"../evil.json"}\n',
  );

  fs.rmSync(layout.c8Config);
  fs.mkdirSync(layout.c8Config);
  writeFile(layout.c8Config, "nested", "unreachable\n");
  expectFailure(
    () => engine.writeGeneratedC8Configuration(layout),
    /generated c8 configuration could not be created exclusively/,
  );
});

test("pins the exact offline c8 report argv without inert threshold flags", () => {
  const fixture = createFixture();
  const prepared = engine.prepareEntry(
    fixture.root,
    fixture.root,
    fixture.context,
    "common",
  );
  const report = prepared.commands[prepared.commands.length - 1];
  assert.equal(report.role, "controller");
  assert.equal(report.uid, engine.CONTROLLER_UID);
  assert.equal(report.workingDirectory, "<PKG>");
  assert.deepEqual(report.argv, [
    "<TOOL_BIN>/c8",
    "report",
    "--config=<C8_CONFIG>",
    "--temp-directory=<FROZEN>",
    "--reports-dir=<REPORT>",
    "--reporter=json",
    "--reporter=json-summary",
    "--all",
    "--src=<PKG>",
    "--include=build/index.js",
    "--exclude=**/node_modules/**",
    "--extension=.js",
    "--exclude-after-remap=false",
    "--exclude-node-modules=true",
    "--skip-full=false",
    "--check-coverage=false",
    "--clean=false",
    "--resolve=",
    "--omit-relative=true",
    "--allowExternal=false",
    "--merge-async=false",
    "--experimental-monocart=false",
  ]);
  for (const flag of [
    "--branches=0",
    "--functions=0",
    "--lines=0",
    "--statements=0",
    "--per-file=false",
    "--100=false",
    "--wrapper-length",
  ]) {
    assert.equal(
      report.argv.some((argument) => argument.startsWith(flag)),
      false,
      flag,
    );
  }
  const testCommand = prepared.commands[prepared.commands.length - 2];
  assert.equal(testCommand.role, "worker");
  assert.equal(testCommand.rawSink, true);
  assert.deepEqual(testCommand.argv, [
    "<NODE>",
    "--test",
    "--test-reporter=tap",
    "tests/common.test.js",
  ]);
  assert.equal(
    prepared.commands.some((record) => record.argv[0].endsWith("/c8") &&
      record.argv[1] !== "report"),
    false,
  );
});

test("builds controller and worker environments from a closed allowlist", () => {
  const root = temporaryDirectory();
  const layout = preparedLayout(root);
  const hostile = {
    GITHUB_TOKEN: "t",
    GITHUB_ENV: "/github/env",
    ACTIONS_RUNTIME_TOKEN: "t",
    RUNNER_TEMP: "/tmp/runner",
    INPUT_ANYTHING: "1",
    GH_TOKEN: "t",
    NODE_OPTIONS: "--require /evil.js",
    NODE_EXTRA_CA_CERTS: "/evil.pem",
    EXPERIMENTAL_MONOCART: "1",
    HTTPS_PROXY: "http://evil",
    npm_config_registry: "http://evil",
    npm_config_hostile: "1",
  };
  const restore = new Map();
  for (const [name, value] of Object.entries(hostile)) {
    restore.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    const controller = engine.controllerEnvironment(layout);
    const worker = engine.workerEnvironment(layout, { rawSink: true });
    assert.equal(Object.getPrototypeOf(controller), null);
    assert.equal(Object.getPrototypeOf(worker), null);
    for (const environment of [controller, worker]) {
      for (const name of Object.keys(hostile)) {
        assert.equal(
          Object.prototype.hasOwnProperty.call(environment, name),
          name === "npm_config_registry",
        );
      }
      assert.equal(environment.npm_config_registry, "https://registry.npmjs.org/");
      assert.equal(environment.npm_config_ignore_scripts, "true");
      assert.equal(environment.PATH, "/usr/local/bin:/usr/bin:/bin");
    }
    assert.equal(
      Object.prototype.hasOwnProperty.call(controller, "NODE_V8_COVERAGE"),
      false,
    );
    assert.equal(worker.NODE_V8_COVERAGE, layout.raw);
    assert.equal(worker.HOME, layout.workerHome);
    assert.equal(controller.HOME, layout.controllerHome);
    assert.deepEqual(
      Object.keys(engine.workerEnvironment(layout)).sort(),
      Object.keys(controller).sort(),
    );
  } finally {
    for (const [name, value] of restore) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test("authoritative container preconditions fail closed off the trusted runtime", () => {
  const layout = engine.resolveExecutionLayout({
    repoRoot: REPOSITORY_ROOT,
    entryId: "common",
    authoritative: true,
    outputRoot: engine.CONTAINER_ROOTS.output,
  });
  assert.equal(layout.pkg, "/betstan/home/common");
  assert.equal(layout.raw, "/betstan/raw");
  assert.equal(layout.frozen, "/betstan/frozen");
  assert.equal(layout.tool, "/betstan/tool");
  assert.equal(layout.report, "/betstan/out/test-coverage/common/report");
  assert.equal(layout.coverageRoot, "/betstan/home");

  expectFailure(
    () =>
      engine.resolveExecutionLayout({
        repoRoot: REPOSITORY_ROOT,
        entryId: "common",
        authoritative: true,
        outputRoot: "/betstan/elsewhere",
      }),
    /authoritative output root must equal \/betstan\/out/,
  );

  const marker = process.env[engine.CONTAINER_MARKER_VARIABLE];
  delete process.env[engine.CONTAINER_MARKER_VARIABLE];
  try {
    expectFailure(
      () => engine.assertAuthoritativeContainer(layout),
      process.platform === "linux"
        ? /(requires a root controller identity|requires BETSTAN_COVERAGE_CONTAINER=1)/
        : /requires Linux process containment/,
    );
  } finally {
    if (marker === undefined) {
      delete process.env[engine.CONTAINER_MARKER_VARIABLE];
    } else {
      process.env[engine.CONTAINER_MARKER_VARIABLE] = marker;
    }
  }

  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  for (const guard of [
    '"/var/run/docker.sock"',
    '"/run/docker.sock"',
    '"/home/runner/work"',
    '"/github/home"',
    '"/github/workflow/event.json"',
    '"GITHUB_STEP_SUMMARY"',
  ]) {
    assert.equal(source.includes(guard), true, guard);
  }
});

test("drops the worker to uid 10001 and cannot regain root", () => {
  for (const fragment of [
    "libc.prctl(38, 1, 0, 0, 0)",
    "coverage worker could not set no_new_privs",
    "os.setgroups([])",
    "os.setgid(target_gid)",
    "os.setuid(target_uid)",
    "os.umask(target_umask)",
    "coverage worker regained uid 0",
    "coverage worker retained supplementary groups",
    "coverage worker retained capabilities",
    "coverage worker could not read /proc/self/status",
    "coverage worker no_new_privs is not set",
  ]) {
    assert.equal(
      engine.COMMAND_SUPERVISOR_SOURCE.includes(fragment),
      true,
      fragment,
    );
  }
  assert.match(
    engine.COMMAND_SUPERVISOR_SOURCE,
    /\(payload\.identity\.uid === 0 \|\| payload\.identity\.gid === 0\)/,
  );

  const root = temporaryDirectory();
  const payload = (identity) =>
    JSON.stringify({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      timeoutMs: 5000,
      maxOutputBytes: 4096,
      inputFiles: [],
      protectedRoots: [],
      watchRoot: null,
      captureStdout: false,
      identity,
      identityReportPath: null,
      childEnvironment: {},
    });
  const rejected = spawnSync(
    process.execPath,
    ["-e", engine.COMMAND_SUPERVISOR_SOURCE, payload({ uid: 0, gid: 0, umask: 0o077 })],
    { cwd: root, encoding: "utf8", shell: false, timeout: 10_000 },
  );
  assert.equal(rejected.status, 127);
  assert.match(rejected.stderr, /supervisor received invalid input/);

  if (process.platform !== "linux" || process.getuid() !== 0) {
    return;
  }
  // Worker-owned output location; controller storage must stay unreachable.
  fs.chmodSync(root, 0o755);
  const workerOutput = path.join(root, "worker-output");
  fs.mkdirSync(workerOutput, { mode: 0o700 });
  fs.chownSync(workerOutput, engine.WORKER_UID, engine.WORKER_GID);
  const controllerOnly = path.join(root, "controller-only");
  fs.mkdirSync(controllerOnly, { mode: 0o700 });
  fs.chownSync(controllerOnly, 0, 0);
  const identityFile = path.join(workerOutput, "worker-identity.json");
  const escalationProbe = path.join(workerOutput, "escalation.json");
  const setuidProbe = path.join(root, "setuid-id");
  fs.copyFileSync("/usr/bin/id", setuidProbe);
  fs.chownSync(setuidProbe, 0, 0);
  fs.chmodSync(setuidProbe, 0o4755);
  const records = [];
  engine.executeCommands(
    root,
    [
      {
        role: "worker",
        workingDirectory: ".",
        argv: [
          process.execPath,
          "-e",
          [
            'const fs = require("node:fs");',
            'const { spawnSync } = require("node:child_process");',
            `const setuidResult = spawnSync(${JSON.stringify(setuidProbe)}, ["-u"], { encoding: "utf8" });`,
            "let controllerWrite = null;",
            "try {",
            `  fs.writeFileSync(${JSON.stringify(path.join(controllerOnly, "breach"))}, "x");`,
            '  controllerWrite = "written";',
            "} catch (error) {",
            "  controllerWrite = error.code;",
            "}",
            `fs.writeFileSync(${JSON.stringify(identityFile)}, JSON.stringify({ uid: process.getuid(), gid: process.getgid(), groups: process.getgroups() }));`,
            `fs.writeFileSync(${JSON.stringify(escalationProbe)}, JSON.stringify({ setuidUid: setuidResult.stdout.trim(), controllerWrite }));`,
          ].join("\n"),
        ],
        timeoutMs: 20_000,
      },
    ],
    { id: "fixture", profile: "jest-typescript" },
    records,
    { dropPrivileges: true },
  );
  const identity = JSON.parse(fs.readFileSync(identityFile, "utf8"));
  assert.equal(identity.uid, engine.WORKER_UID);
  assert.equal(identity.gid, engine.WORKER_GID);
  assert.deepEqual(
    identity.groups.filter((group) => group !== engine.WORKER_GID),
    [],
  );
  const escalation = JSON.parse(fs.readFileSync(escalationProbe, "utf8"));
  assert.equal(escalation.setuidUid, String(engine.WORKER_UID));
  assert.equal(escalation.controllerWrite, "EACCES");
  assert.equal(fs.existsSync(path.join(controllerOnly, "breach")), false);
  assert.equal(records[0].identity.uid, engine.WORKER_UID);
  assert.equal(records[0].identity.noNewPrivs, 1);
  assert.equal(/[^0]/.test(records[0].identity.capEff), false);
  assert.equal(/[^0]/.test(records[0].identity.capPrm), false);
  assert.equal(/[^0]/.test(records[0].identity.capAmb), false);
});

test("verifies staged workspace integrity against the read-only candidate", () => {
  const fixture = createFixture();
  const prepared = engine.prepareEntry(
    fixture.root,
    fixture.root,
    fixture.context,
    "common",
  );
  const workerHome = temporaryDirectory();
  const layout = supplementalLayout(fixture.root, workerHome);
  const staged = engine.stageWorkerPackage(
    fixture.root,
    prepared.entry,
    prepared.packageInputSnapshot,
    layout,
  );
  assert.deepEqual(
    staged.map((record) => record.path).sort(),
    [...prepared.packageInputs].sort(),
  );
  assert.equal(
    fs.existsSync(path.join(layout.pkg, "package.json")),
    true,
  );
  engine.verifyStagedWorkspace(
    prepared.entry,
    prepared.packageInputSnapshot,
    layout,
    staged,
  );

  fs.chmodSync(path.join(layout.pkg, "package.json"), 0o600);
  fs.writeFileSync(
    path.join(layout.pkg, "package.json"),
    '{"name":"@betstan/common","version":"9.9.9"}\n',
  );
  expectFailure(
    () =>
      engine.verifyStagedWorkspace(
        prepared.entry,
        prepared.packageInputSnapshot,
        layout,
        staged,
      ),
    /staged copy differs from the verified candidate input/,
  );

  const cleanStaged = engine.stageWorkerPackage(
    fixture.root,
    prepared.entry,
    prepared.packageInputSnapshot,
    layout,
  );
  writeFile(layout.pkg, "src/injected.ts", "export const injected = 1;\n");
  expectFailure(
    () =>
      engine.verifyStagedWorkspace(
        prepared.entry,
        prepared.packageInputSnapshot,
        layout,
        cleanStaged,
      ),
    /contains untracked or ignored command input common\/src\/injected.ts/,
  );
});

test("rejects preseeded, forged, and hostile raw coverage inputs", () => {
  const validRaw = '{"result":[{"url":"file:///betstan/home/common/build/index.js"}]}\n';
  const rawName = "coverage-1024-1700000000000-0.json";
  const scenarios = [
    [
      "preseeded before the worker starts",
      (layout) => {
        writeFile(layout.raw, rawName, validRaw);
        writeFile(layout.raw, "preseeded.json", validRaw);
      },
      /raw coverage file name is unexpected: preseeded.json/,
    ],
    [
      "empty sink",
      () => {},
      /raw coverage root contains no V8 coverage data/,
    ],
    [
      "unexpected name",
      (layout) => writeFile(layout.raw, "coverage-final.json", validRaw),
      /raw coverage file name is unexpected/,
    ],
    [
      "symlinked entry",
      (layout) => {
        const outside = writeFile(layout.temporaryRoot, "outside.json", validRaw);
        fs.symlinkSync(outside, path.join(layout.raw, rawName));
      },
      /raw coverage file must be a regular file/,
    ],
    [
      "hardlinked entry",
      (layout) => {
        const original = writeFile(layout.temporaryRoot, "origin.json", validRaw);
        fs.linkSync(original, path.join(layout.raw, rawName));
      },
      /raw coverage file must not be hardlinked/,
    ],
    [
      "oversized entry",
      (layout) => {
        writeFile(layout.raw, rawName, validRaw);
        fs.truncateSync(
          path.join(layout.raw, rawName),
          engine.LIMITS.rawCoverageFileBytes + 1,
        );
      },
      /raw coverage file exceeds/,
    ],
    [
      "malformed JSON",
      (layout) => writeFile(layout.raw, rawName, "not json"),
      /is not valid JSON/,
    ],
    [
      "missing result array",
      (layout) => writeFile(layout.raw, rawName, '{"result":{}}\n'),
      /must contain a V8 result array/,
    ],
    [
      "unsupported field",
      (layout) =>
        writeFile(layout.raw, rawName, '{"result":[],"scriptSource":"evil"}\n'),
      /contains unsupported field scriptSource/,
    ],
    [
      "malformed script record",
      (layout) => writeFile(layout.raw, rawName, '{"result":[{"nope":1}]}\n'),
      /contains a malformed V8 script coverage record/,
    ],
  ];
  for (const [label, seed, pattern] of scenarios) {
    const root = temporaryDirectory();
    const layout = preparedLayout(root);
    seed(layout);
    expectFailure(() => engine.freezeRawCoverage(layout), pattern, label);
  }

  const ownershipRoot = temporaryDirectory();
  const ownershipLayout = preparedLayout(ownershipRoot);
  writeFile(ownershipLayout.raw, rawName, validRaw);
  expectFailure(
    () =>
      engine.freezeRawCoverage({ ...ownershipLayout, authoritative: true }),
    /raw coverage file must be owned by the unprivileged worker/,
  );

  const root = temporaryDirectory();
  const layout = preparedLayout(root);
  writeFile(layout.raw, rawName, validRaw);
  const inventory = engine.freezeRawCoverage(layout);
  assert.equal(inventory.length, 1);
  assert.equal(inventory[0].name, rawName);
  assert.equal(inventory[0].bytes, Buffer.byteLength(validRaw));
  assert.equal(
    fs.readFileSync(path.join(layout.frozen, rawName), "utf8"),
    validRaw,
  );
  assert.equal(fs.lstatSync(layout.raw).mode & 0o222, 0);

  const frozenDigest = engine.hashFrozenCoverage(layout);
  fs.chmodSync(layout.raw, 0o700);
  writeFile(layout.raw, "coverage-4096-1700000000009-0.json", validRaw);
  assert.equal(engine.hashFrozenCoverage(layout), frozenDigest);
  assert.deepEqual(fs.readdirSync(layout.frozen), [rawName]);
});

test("rejects frozen coverage mutation around report generation", () => {
  const root = temporaryDirectory();
  const layout = preparedLayout(root);
  const rawName = "coverage-2048-1700000000001-0.json";
  writeFile(layout.raw, rawName, '{"result":[]}\n');
  engine.freezeRawCoverage(layout);
  const before = engine.hashFrozenCoverage(layout);
  assert.match(before, new RegExp(`^${rawName}:[0-9a-f]{64}$`));

  fs.chmodSync(path.join(layout.frozen, rawName), 0o600);
  fs.writeFileSync(
    path.join(layout.frozen, rawName),
    '{"result":[{"url":"file:///forged.js"}]}\n',
  );
  assert.notEqual(engine.hashFrozenCoverage(layout), before);

  writeFile(layout.frozen, "coverage-2048-1700000000002-0.json", '{"result":[]}\n');
  assert.notEqual(engine.hashFrozenCoverage(layout), before);

  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  assert.match(source, /frozen coverage data changed before report generation/);
  assert.match(source, /frozen coverage data changed during report generation/);
});

test("requires an empty controller-owned report root before c8 report", () => {
  const root = temporaryDirectory();
  const layout = preparedLayout(root);
  assert.deepEqual(fs.readdirSync(layout.report), []);
  assert.equal(fs.lstatSync(layout.report).mode & 0o777, 0o700);
  assert.equal(fs.lstatSync(layout.frozen).mode & 0o777, 0o700);

  writeFile(layout.report, "coverage-final.json", '{"forged":true}\n');
  expectFailure(
    () => engine.assertEmptyDirectory(layout.report, "coverage report root"),
    /coverage report root must be empty before the run: found coverage-final.json/,
  );
  engine.prepareControlledRoots(layout);
  assert.deepEqual(fs.readdirSync(layout.report), []);

  writeFile(layout.raw, "coverage-1-1-0.json", '{"result":[]}\n');
  expectFailure(
    () => engine.prepareControlledRoots(layout),
    /raw coverage root must be empty before the run: found coverage-1-1-0.json/,
  );

  for (const mode of [0o750, 0o770, 0o777, 0o600]) {
    fs.chmodSync(layout.report, mode);
    expectFailure(
      () =>
        engine.assertControlledDirectory(layout.report, "coverage report root", {
          uid: process.getuid(),
        }),
      /coverage report root must use mode 0700/,
    );
  }
  fs.chmodSync(layout.report, 0o700);
  expectFailure(
    () =>
      engine.assertControlledDirectory(layout.report, "coverage report root", {
        uid: process.getuid() + 1,
      }),
    /coverage report root must be owned by uid/,
  );
  expectFailure(
    () =>
      engine.assertControlledDirectory(layout.report, "coverage report root", {
        notUid: process.getuid(),
      }),
    /coverage report root must not be owned by uid/,
  );

  const engineSource = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  assert.match(
    engineSource,
    /assertEmptyDirectory\(layout\.report, "coverage report root"\);/,
  );
});

test("asserts a clean coverage discovery path from the worker package upward", () => {
  const root = temporaryDirectory();
  const layout = preparedLayout(root);
  fs.mkdirSync(layout.pkg, { recursive: true });
  writeJson(layout.pkg, "package.json", { name: "@betstan/common" });
  engine.assertNoCoverageDiscovery(
    layout.pkg,
    [layout.pkg, layout.tool],
    "coverage report discovery path",
  );

  const parent = path.dirname(layout.pkg);
  writeJson(parent, "package.json", { c8: { extends: "../evil.json" } });
  expectFailure(
    () =>
      engine.assertNoCoverageDiscovery(
        layout.pkg,
        [layout.pkg, layout.tool],
        "coverage report discovery path",
      ),
    /contains an unexpected manifest/,
  );
  fs.rmSync(path.join(parent, "package.json"));

  writeFile(parent, ".c8rc.json", "{}\n");
  expectFailure(
    () =>
      engine.assertNoCoverageDiscovery(
        layout.pkg,
        [layout.pkg, layout.tool],
        "coverage report discovery path",
      ),
    /contains forbidden coverage configuration/,
  );
  fs.rmSync(path.join(parent, ".c8rc.json"));

  writeFile(layout.pkg, ".npmrc", "registry=http://evil\n");
  expectFailure(
    () =>
      engine.assertNoCoverageDiscovery(
        layout.pkg,
        [layout.pkg, layout.tool],
        "coverage report discovery path",
      ),
    /contains forbidden npm configuration/,
  );
});

test("emits only safe structured stdout and never echoes candidate bytes", () => {
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return true;
  };
  try {
    engine.emitSafeLine({ id: "common", status: "success", tests: 9 });
  } finally {
    process.stdout.write = original;
  }
  assert.deepEqual(written, ['{"id":"common","status":"success","tests":9}\n']);

  for (const [value, pattern] of [
    [{ id: "::set-output name=x::1" }, /must not contain a workflow command/],
    [{ id: "::add-mask::secret" }, /must not contain a workflow command/],
    [{ id: "::stop-commands::abc" }, /must not contain a workflow command/],
    [{ id: "##[group]forged" }, /must not contain a workflow command/],
    [{ id: "line\nbreak" }, /control or non-ASCII characters/],
    [{ id: "carriage\rreturn" }, /control or non-ASCII characters/],
    [{ id: "escape\u001b[0m" }, /control or non-ASCII characters/],
    [{ id: "caf\u00e9" }, /control or non-ASCII characters/],
    [{ forged: "value" }, /field forged is not permitted/],
    [{}, /must contain at least one field/],
  ]) {
    expectFailure(() => engine.emitSafeLine(value), pattern);
  }

  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  assert.equal(source.includes("process.stdout.write(result.stdout)"), false);
  assert.equal(
    (source.match(/process\.stdout\.write\(/g) || []).length,
    2,
  );
});

test("captures worker output into controller-owned files without echoing", () => {
  const root = temporaryDirectory();
  const layout = preparedLayout(root, "fixture");
  fs.mkdirSync(path.join(root, "fixture"), { recursive: true });
  const stdoutPath = path.join(root, "captured-stdout.tap");
  const stderrPath = path.join(root, "captured-stderr.log");
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return true;
  };
  const records = [];
  const output = {};
  try {
    engine.executeCommands(
      root,
      [
        {
          role: "worker",
          workingDirectory: "fixture",
          argv: [
            process.execPath,
            "-e",
            'process.stdout.write("::add-mask::candidate-secret\\n"); process.stderr.write("noisy diagnostics\\n");',
          ],
          captureStdout: true,
          timeoutMs: 10_000,
        },
      ],
      { id: "fixture", profile: "jest-typescript" },
      records,
      {
        layout,
        capture: { stdoutPath, stderrPath },
        output,
      },
    );
  } finally {
    process.stdout.write = original;
  }
  assert.deepEqual(written, []);
  assert.equal(
    fs.readFileSync(stdoutPath, "utf8"),
    "::add-mask::candidate-secret\n",
  );
  assert.equal(fs.readFileSync(stderrPath, "utf8"), "noisy diagnostics\n");
  assert.equal(records[0].role, "worker");
  assert.equal(records[0].uid, process.getuid());
  assert.notEqual(records[0].uid, engine.WORKER_UID);
  assert.equal(records[0].identity.uid, process.getuid());
  assert.equal(
    records[0].identity.source,
    process.platform === "linux" ? "proc" : "supervisor",
  );
  assert.equal(output.stdout.bytes.length, 29);
  assert.match(output.stdout.sha256, /^[0-9a-f]{64}$/);
});

test("rejects unknown placeholders, absolute paths, and session paths in evidence", () => {
  assert.deepEqual(
    [...engine.COMMAND_PLACEHOLDERS],
    [
      "<C8_CONFIG>",
      "<FROZEN>",
      "<NODE>",
      "<OUT>",
      "<PKG>",
      "<PKG_BIN>",
      "<RAW>",
      "<REPO>",
      "<REPORT>",
      "<TOOL>",
      "<TOOL_BIN>",
    ],
  );
  engine.assertCommandToken("<PKG_BIN>/tsc", "argv");
  engine.assertCommandToken("--src=<PKG>", "argv");
  engine.assertCommandToken("--testMatch=<rootDir>/tests/a.test.js", "argv");
  expectFailure(
    () => engine.assertCommandToken("<EVIL>/tool", "argv"),
    /contains unknown placeholder <EVIL>/,
  );
  expectFailure(
    () => engine.assertCommandToken("/betstan/home/common/node_modules/.bin/tsc", "argv"),
    /must not contain an absolute path/,
  );
  expectFailure(
    () => engine.assertCommandToken(`--temp-directory=${os.tmpdir()}/raw`, "argv"),
    /must not contain a session temporary path/,
  );

  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "common");
  const resolved = structuredClone(artifact.evidence.commands);
  resolved[resolved.length - 1].argv[0] = "/betstan/tool/node_modules/.bin/c8";
  expectFailure(
    () => engine.validateCommandRecords(resolved, artifact.prepared.commands),
    /evidence contains a command outside the fixed profile/,
  );
  const forged = structuredClone(artifact.evidence.commands);
  forged[0].role = "worker";
  expectFailure(
    () => engine.validateCommandRecords(forged, artifact.prepared.commands),
    /evidence contains a command outside the fixed profile/,
  );
  const unknown = structuredClone(artifact.evidence.commands);
  unknown[unknown.length - 1].argv.push("--src=<EVIL>");
  expectFailure(
    () => engine.validateCommandRecords(unknown, artifact.prepared.commands),
    /evidence contains a command outside the fixed profile/,
  );
});

test("binds the descriptor to trusted master parity", () => {
  const workingTree = createFixture();
  mutateDescriptor(workingTree.root, (value) => {
    value.entries = value.entries.filter((entry) => entry.id !== "slip");
  });
  expectFailure(
    () =>
      engine.verifyTrustedAssets(
        workingTree.root,
        workingTree.root,
        workingTree.context,
      ),
    /test-coverage-matrix.json Git blob does not match trusted default/,
  );

  const splitRoots = createFixture();
  const trustedRoot = temporaryDirectory();
  fs.cpSync(splitRoots.root, trustedRoot, { recursive: true });
  engine.verifyTrustedAssets(
    splitRoots.root,
    trustedRoot,
    splitRoots.context,
  );
  mutateDescriptor(splitRoots.root, (value) => {
    value.entries.push({ id: "telemetry", profile: "jest-typescript" });
  });
  expectFailure(
    () =>
      engine.verifyTrustedAssets(
        splitRoots.root,
        trustedRoot,
        splitRoots.context,
      ),
    /candidate \.github\/coverage\/test-coverage-matrix\.json differs from the trusted default copy/,
  );

  const committed = createFixture();
  const committedTrusted = temporaryDirectory();
  fs.cpSync(committed.root, committedTrusted, { recursive: true });
  mutateDescriptor(committed.root, (value) => {
    value.entries.push({ id: "telemetry", profile: "jest-typescript" });
  });
  writePackage(committed.root, "telemetry", "jest-typescript");
  commitAll(committed.root, "register telemetry in the candidate only");
  expectFailure(
    () =>
      engine.verifyTrustedAssets(
        committed.root,
        committedTrusted,
        committed.context,
      ),
    /candidate \.github\/coverage\/test-coverage-matrix\.json differs from the trusted default copy/,
  );
});

test("restricts authoritative runs and evidence to the enforced Common package", () => {
  assert.deepEqual([...engine.ENFORCED_PACKAGE_IDS], ["common"]);
  const enginePath = path.join(REPOSITORY_ROOT, engine.ENGINE_PATH);
  const rejected = spawnSync(
    process.execPath,
    [
      enginePath,
      "run",
      "--id",
      "auth",
      "--context",
      "artifacts/context.json",
      "--trusted-root",
      REPOSITORY_ROOT,
      "--output-root",
      "/betstan/out",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false },
  );
  assert.equal(rejected.status, 1);
  assert.match(
    rejected.stderr,
    /authoritative coverage runs are limited to common/,
  );

  const missingOutputRoot = spawnSync(
    process.execPath,
    [
      enginePath,
      "run",
      "--id",
      "common",
      "--context",
      "artifacts/context.json",
      "--trusted-root",
      REPOSITORY_ROOT,
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false },
  );
  assert.equal(missingOutputRoot.status, 1);
  assert.match(missingOutputRoot.stderr, /missing required option --output-root/);

  const wrongOutputRoot = spawnSync(
    process.execPath,
    [
      enginePath,
      "aggregate",
      "--context",
      "artifacts/context.json",
      "--trusted-root",
      REPOSITORY_ROOT,
      "--output-root",
      "/tmp/betstan-out",
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false },
  );
  assert.equal(wrongOutputRoot.status, 1);
  assert.match(
    wrongOutputRoot.stderr,
    /authoritative output root must equal \/betstan\/out/,
  );
});

test("separates descriptor, run context, and evidence schema versions", () => {
  assert.equal(engine.DESCRIPTOR_SCHEMA_VERSION, 1);
  assert.equal(engine.RUN_CONTEXT_SCHEMA_VERSION, 1);
  assert.equal(engine.EVIDENCE_SCHEMA_VERSION, 3);
  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "common");
  assert.equal(artifact.evidence.schemaVersion, 3);
  assert.equal(
    artifact.evidence.execution.limitation,
    engine.EVIDENCE_LIMITATION,
  );
  assert.match(engine.EVIDENCE_LIMITATION, /provenance-bound review evidence/);

  const contextWithContainer = structuredClone(fixture.context);
  contextWithContainer.container = { imageDigest: `sha256:${"a".repeat(64)}` };
  assert.equal(
    engine.validateRunContext(fixture.root, contextWithContainer).container
      .imageDigest,
    `sha256:${"a".repeat(64)}`,
  );
  const malformed = structuredClone(contextWithContainer);
  malformed.container.imageDigest = "latest";
  expectFailure(
    () => engine.validateRunContext(fixture.root, malformed),
    /container.imageDigest must be a sha256 image digest/,
  );
  const wrongVersion = structuredClone(fixture.context);
  wrongVersion.schemaVersion = 2;
  expectFailure(
    () => engine.validateRunContext(fixture.root, wrongVersion),
    /run context schemaVersion must equal 1/,
  );
});

test("neutralizes workflow commands and control bytes in failure text", () => {
  const root = temporaryDirectory();
  const records = [];
  let message = null;
  assert.throws(
    () =>
      engine.executeCommands(
        root,
        [
          {
            role: "worker",
            workingDirectory: ".",
            argv: [
              process.execPath,
              "-e",
              'process.stderr.write("::add-mask::secret\\u0007 caf\\u00e9\\n"); process.exit(3);',
            ],
            timeoutMs: 10_000,
          },
        ],
        { id: "fixture", profile: "jest-typescript" },
        records,
      ),
    (error) => {
      assert.equal(error instanceof engine.CoverageMatrixError, true);
      message = error.message;
      return true;
    },
  );
  assert.equal(records[0].exitCode, 3);
  assert.match(message, /stderr \d+ bytes sha256 [0-9a-f]{64}/);
  assert.equal(/[\x00-\x1f\x7f]/.test(message), false);
  assert.equal(/[^\x20-\x7e]/.test(message), false);
  assert.equal(message.startsWith("::"), false);
  assert.equal(message.includes("##["), false);
});

function supplementalLayout(fixtureRoot, workerHome) {
  fs.mkdirSync(path.join(workerHome, "common"), { recursive: true });
  fs.mkdirSync(path.join(workerHome, ".npm-cache"), { recursive: true });
  fs.writeFileSync(path.join(workerHome, ".npm-user-config"), "");
  fs.writeFileSync(path.join(workerHome, ".npm-global-config"), "");
  return {
    authoritative: false,
    entryId: "common",
    repo: fixtureRoot,
    pkg: path.join(workerHome, "common"),
    workerHome,
    workerHomeEntries: engine.workerHomeInventory("common"),
    supplementalIds: [...engine.SUPPLEMENTAL_PACKAGE_IDS.common],
  };
}

test("stages exactly the fixed Common supplemental manifest set", () => {
  assert.deepEqual([...engine.SUPPLEMENTAL_PACKAGE_IDS.common], [
    "auth",
    "backoffice",
    "bet",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
  ]);
  assert.deepEqual([...engine.SUPPLEMENTAL_MANIFEST_FILES], [
    "package-lock.json",
    "package.json",
  ]);
  assert.equal(engine.supplementalInputPaths("common").length, 16);
  assert.deepEqual(engine.supplementalInputPaths("auth"), []);
  assert.deepEqual(engine.workerHomeInventory("common"), [
    ".npm-cache",
    ".npm-global-config",
    ".npm-user-config",
    "auth",
    "backoffice",
    "bet",
    "common",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
  ]);

  const fixture = createFixture();
  const snapshot = engine.deriveSupplementalSnapshot(
    fixture.root,
    fixture.context.repository.checkoutSha,
    "common",
  );
  assert.deepEqual(snapshot.paths, engine.supplementalInputPaths("common"));
  for (const record of snapshot.records) {
    assert.match(record.gitBlob, /^[0-9a-f]{40}$/);
    assert.match(record.sha256, /^[0-9a-f]{64}$/);
    assert.equal(record.gitMode, "100644");
    assert.equal(record.byteLength > 0, true);
    assert.equal(
      record.sha256,
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(fixture.root, ...record.path.split("/"))))
        .digest("hex"),
    );
  }

  const workerHome = temporaryDirectory();
  const layout = supplementalLayout(fixture.root, workerHome);
  engine.stageSupplementalInputs(fixture.root, snapshot, layout);
  for (const record of snapshot.records) {
    const staged = path.join(workerHome, ...record.path.split("/"));
    assert.equal(fs.lstatSync(staged).isFile(), true);
    assert.equal(
      crypto.createHash("sha256").update(fs.readFileSync(staged)).digest("hex"),
      record.sha256,
    );
  }
  assert.deepEqual(
    fs.readdirSync(path.join(workerHome, "auth")).sort(),
    ["package-lock.json", "package.json"],
  );
  assert.equal(fs.existsSync(path.join(workerHome, "auth", "src")), false);
  assert.equal(fs.existsSync(path.join(workerHome, "client")), false);
});

test("rejects supplemental manifest substitution, loss, and drift", () => {
  const fixture = createFixture();
  const snapshot = engine.deriveSupplementalSnapshot(
    fixture.root,
    fixture.context.repository.checkoutSha,
    "common",
  );

  const missing = createFixture();
  fs.rmSync(path.join(missing.root, "auth", "package-lock.json"));
  expectFailure(
    () =>
      engine.deriveSupplementalSnapshot(
        missing.root,
        missing.context.repository.checkoutSha,
        "common",
      ),
    /auth\/package-lock.json is missing/,
  );

  const drifted = createFixture();
  writeFile(
    drifted.root,
    "bet/package.json",
    '{"name":"bet","version":"9.9.9"}\n',
  );
  expectFailure(
    () =>
      engine.deriveSupplementalSnapshot(
        drifted.root,
        drifted.context.repository.checkoutSha,
        "common",
      ),
    /bet\/package.json differs from (the exact checkout snapshot|its immutable snapshot)/,
  );

  const symlinked = createFixture();
  const target = path.join(symlinked.root, "slip", "package.json");
  fs.rmSync(target);
  fs.symlinkSync(path.join(symlinked.root, "auth", "package.json"), target);
  expectFailure(
    () =>
      engine.deriveSupplementalSnapshot(
        symlinked.root,
        symlinked.context.repository.checkoutSha,
        "common",
      ),
    /slip\/package.json must be a regular file/,
  );

  const workerHome = temporaryDirectory();
  const layout = supplementalLayout(fixture.root, workerHome);
  engine.stageSupplementalInputs(fixture.root, snapshot, layout);
  const authoritativeLayout = layout;

  const stagedManifest = path.join(workerHome, "event", "package.json");
  fs.chmodSync(stagedManifest, 0o600);
  fs.writeFileSync(stagedManifest, '{"name":"event","version":"6.6.6"}\n');
  expectFailure(
    () => engine.verifyWorkerHomeClosure(fixture.root, snapshot, authoritativeLayout),
    /staged supplemental event\/package.json (size differs|differs from the verified candidate manifest)/,
  );
  engine.stageSupplementalInputs(fixture.root, snapshot, layout);

  writeFile(workerHome, "gamemaster/extra.json", "{}\n");
  expectFailure(
    () => engine.verifyWorkerHomeClosure(fixture.root, snapshot, authoritativeLayout),
    /supplemental package gamemaster must contain exactly package-lock.json,package.json/,
  );
  fs.rmSync(path.join(workerHome, "gamemaster", "extra.json"));

  writeFile(workerHome, "intruder/package.json", "{}\n");
  expectFailure(
    () => engine.verifyWorkerHomeClosure(fixture.root, snapshot, authoritativeLayout),
    /worker home must contain exactly/,
  );
  fs.rmSync(path.join(workerHome, "intruder"), { recursive: true });

  const replaced = path.join(workerHome, "resulting");
  fs.rmSync(replaced, { recursive: true });
  fs.symlinkSync(path.join(fixture.root, "resulting"), replaced);
  expectFailure(
    () => engine.verifyWorkerHomeClosure(fixture.root, snapshot, authoritativeLayout),
    /supplemental package root must be a regular directory: resulting/,
  );
});

test("keeps the worker home parent controller-owned and non-writable", () => {
  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  assert.equal(engine.WORKER_HOME_MODE, 0o755);
  assert.match(source, /fs\.chmodSync\(layout\.workerHome, WORKER_HOME_MODE\);/);
  assert.match(source, /worker home root must be owned by the trusted controller/);
  assert.match(source, /supplemental package root must stay read-only for the worker/);

  const workerHome = temporaryDirectory();
  const fixture = createFixture();
  const snapshot = engine.deriveSupplementalSnapshot(
    fixture.root,
    fixture.context.repository.checkoutSha,
    "common",
  );
  const layout = { ...supplementalLayout(fixture.root, workerHome), authoritative: true };
  expectFailure(
    () => engine.verifyWorkerHomeClosure(fixture.root, snapshot, layout),
    process.getuid() === 0
      ? /worker home root must use mode 0755|worker home must contain exactly/
      : /worker home root must be owned by the trusted controller/,
  );
  if (process.getuid() === 0) {
    fs.chmodSync(workerHome, engine.WORKER_HOME_MODE);
    expectFailure(
      () => engine.verifyWorkerHomeClosure(fixture.root, snapshot, layout),
      /worker home must contain exactly/,
    );
  }
  const structural = { ...layout, authoritative: false };
  expectFailure(
    () => engine.verifyWorkerHomeClosure(fixture.root, snapshot, structural),
    /worker home must contain exactly/,
  );
});

test("reconciles execution evidence with captured artifacts", () => {
  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "common");
  const directory = path.dirname(artifact.evidencePath);
  const evidence = artifact.evidence;
  assert.equal(evidence.execution.supplemental.fileCount, 16);
  assert.equal(
    evidence.execution.stdout.sha256,
    evidence.reports.testResultsSha256,
  );

  const mutations = [
    [
      "superseded evidence schema version",
      (value) => {
        value.schemaVersion = 2;
      },
      /evidence must be schema version 3 with success status/,
    ],
    [
      "stdout byte drift",
      (value) => {
        value.execution.stdout.bytes += 1;
      },
      /stdout does not reconcile with the captured TAP artifact/,
    ],
    [
      "stdout digest drift",
      (value) => {
        value.execution.stdout.sha256 = "0".repeat(64);
      },
      /stdout digest does not match the captured test results/,
    ],
    [
      "stderr drift",
      (value) => {
        value.execution.stderr.bytes = 7;
      },
      /stderr does not reconcile with the captured diagnostics artifact/,
    ],
    [
      "supplemental digest drift",
      (value) => {
        value.execution.supplemental.files[0].sha256 = "1".repeat(64);
      },
      /supplemental inventory does not match the current run/,
    ],
    [
      "supplemental removal",
      (value) => {
        value.execution.supplemental.files.pop();
        value.execution.supplemental.fileCount -= 1;
      },
      /supplemental inventory does not match the current run/,
    ],
    [
      "supplemental foreign path",
      (value) => {
        value.execution.supplemental.files[0].path = "client/package.json";
      },
      /(supplemental inventory must be sorted and unique|supplemental inventory does not match the current run)/,
    ],
    [
      "supplemental path outside the fixed manifest set",
      (value) => {
        value.execution.supplemental.files[0].path = "auth/src/index.ts";
      },
      /supplemental path is outside the fixed manifest set/,
    ],
    [
      "raw oversize",
      (value) => {
        value.execution.rawSink.files[0].bytes =
          engine.LIMITS.rawCoverageFileBytes + 1;
      },
      /raw file exceeds/,
    ],
    [
      "worker identity drift",
      (value) => {
        value.execution.worker.uid = 0;
      },
      /worker identity must be uid 10001/,
    ],
    [
      "worker no_new_privs drift",
      (value) => {
        value.execution.worker.noNewPrivs = 0;
      },
      /worker identity must run with no_new_privs enabled/,
    ],
    [
      "worker capability drift",
      (value) => {
        value.execution.worker.capEff = "00000000a80425fb";
      },
      /worker identity must not retain capEff capabilities/,
    ],
    [
      "worker group drift",
      (value) => {
        value.execution.worker.supplementaryGroups = [27];
      },
      /worker identity must not retain supplementary groups/,
    ],
    [
      "unobserved identity",
      (value) => {
        value.execution.worker.source = "supervisor";
      },
      /worker identity must be observed from the container process table/,
    ],
    [
      "command identity drift",
      (value) => {
        value.commands[1].identity.uid = 0;
        value.commands[1].identity.euid = 0;
      },
      /commands\[1\].identity must be uid 10001 and gid 10001/,
    ],
    [
      "command uid and identity disagreement",
      (value) => {
        value.commands[1].uid = 0;
      },
      /evidence contains a command outside the fixed profile/,
    ],
    [
      "controller identity drift",
      (value) => {
        value.execution.controller.uid = 10001;
      },
      /controller identity must be uid 0/,
    ],
    [
      "limitation drift",
      (value) => {
        value.execution.limitation = "trust me";
      },
      /must retain the accepted provenance limitation/,
    ],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const mutated = structuredClone(evidence);
    mutate(mutated);
    expectFailure(
      () =>
        engine.validateEvidenceAgainstPrepared(
          fixture.root,
          fixture.context,
          mutated,
          artifact.prepared,
          { artifactDirectory: directory },
        ),
      pattern,
      label,
    );
  }
  engine.validateEvidenceAgainstPrepared(
    fixture.root,
    fixture.context,
    evidence,
    artifact.prepared,
    { artifactDirectory: directory },
  );
});

test("binds Common TAP counts to the plan and trailing summary block", () => {
  const root = temporaryDirectory();
  const counts = { total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 };
  const good = writeFile(root, "good.tap", tapDocument(counts));
  assert.deepEqual(engine.parseTapTestResults(good, "common"), {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    todo: 0,
  });

  const forged = writeFile(
    root,
    "forged.tap",
    tapDocument({ total: 9, passed: 9, failed: 0, skipped: 0, todo: 0 }, [], {
      plan: 9,
    }).replace(/^ok [1-9] - case [1-9]$/gm, ""),
  );
  expectFailure(
    () => engine.parseTapTestResults(forged, "common"),
    /plan and top-level results disagree: plan=9 top-level=0/,
  );

  const suppressed = writeFile(
    root,
    "suppressed.tap",
    tapDocument(counts, [], { omitSummary: true }),
  );
  expectFailure(
    () => engine.parseTapTestResults(suppressed, "common"),
    /(too short to contain a summary block|must end with one contiguous summary block)/,
  );

  const nonTrailing = writeFile(
    root,
    "non-trailing.tap",
    tapDocument(counts, [], { summaryBeforeResults: true }),
  );
  expectFailure(
    () => engine.parseTapTestResults(nonTrailing, "common"),
    /must end with one contiguous summary block/,
  );

  const duplicated = writeFile(
    root,
    "duplicated.tap",
    tapDocument(counts, [], { duplicateSummary: true }),
  );
  expectFailure(
    () => engine.parseTapTestResults(duplicated, "common"),
    /must contain one final tests count/,
  );

  const noPlan = writeFile(
    root,
    "no-plan.tap",
    tapDocument(counts, [], { omitPlan: true }),
  );
  expectFailure(
    () => engine.parseTapTestResults(noPlan, "common"),
    /must contain exactly one top-level plan line/,
  );

  const wrongPlan = writeFile(
    root,
    "wrong-plan.tap",
    tapDocument(counts, [], { plan: 5 }),
  );
  expectFailure(
    () => engine.parseTapTestResults(wrongPlan, "common"),
    /plan and top-level results disagree: plan=5 top-level=2/,
  );

  const forgedPass = writeFile(
    root,
    "forged-pass.tap",
    tapDocument({ total: 2, passed: 2, failed: 0, skipped: 0, todo: 0 }).replace(
      "ok 2 - case 2",
      "not ok 2 - case 2",
    ),
  );
  expectFailure(
    () => engine.parseTapTestResults(forgedPass, "common"),
    /failure count does not match the reported results/,
  );

  // Node never prints per-file result lines, so the executed file set is bound
  // by the trusted command plan argv instead of by any TAP name.
  const engineSource = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  assert.equal(engineSource.includes("must be exactly the tracked suites"), false);
  assert.equal(engine.parseTapTestResults.length, 2);
  assert.match(
    engine.EVIDENCE_LIMITATION,
    /bound by the trusted command plan argv rather than by any name in the TAP stream/,
  );
});

test("keeps candidate output out of every emitted failure path", () => {
  const root = temporaryDirectory();
  const payloads = [
    "::add-mask::leading-secret",
    "   ::set-output name=x::indented",
    "prefix ::error::embedded suffix",
    "##[group]forged",
    "  ##[error]indented-forged",
    "first\\n::stop-commands::multiline\\nlast",
  ];
  const script = payloads
    .map(
      (payload) =>
        `process.stdout.write(${JSON.stringify(payload + "\\n")}); process.stderr.write(${JSON.stringify(payload + "\\n")});`,
    )
    .join("\n") + "\nprocess.exit(4);";
  const stdoutPath = path.join(root, "hostile-stdout.tap");
  const stderrPath = path.join(root, "hostile-stderr.log");
  const layout = preparedLayout(root, "fixture");
  fs.mkdirSync(path.join(root, "fixture"), { recursive: true });
  const emitted = [];
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = (chunk) => {
    emitted.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    emitted.push(String(chunk));
    return true;
  };
  let message = null;
  try {
    engine.executeCommands(
      root,
      [
        {
          role: "worker",
          workingDirectory: "fixture",
          argv: [process.execPath, "-e", script],
          captureStdout: true,
          timeoutMs: 15_000,
        },
      ],
      { id: "fixture", profile: "jest-typescript" },
      [],
      {
        layout,
        capture: {
          stdoutPath,
          stderrPath,
          diagnosticsPrefix: path.join(root, "failed-command"),
        },
      },
    );
  } catch (error) {
    message = error.message;
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  assert.equal(typeof message, "string");
  assert.equal(message.includes("::"), false);
  assert.equal(message.includes("##["), false);
  assert.equal(message.includes("secret"), false);
  assert.equal(message.includes("forged"), false);
  assert.match(message, /stdout \d+ bytes sha256 [0-9a-f]{64}/);
  assert.match(message, /stderr \d+ bytes sha256 [0-9a-f]{64}/);
  for (const line of emitted) {
    assert.equal(line.includes("::"), false);
    assert.equal(line.includes("##["), false);
  }
  // The candidate bytes survive only in controller-owned artifacts.
  const retained = fs.readFileSync(path.join(root, "failed-command-stdout.log"), "utf8");
  assert.equal(retained.includes("::add-mask::leading-secret"), true);
  assert.equal(retained.includes("##[group]forged"), true);

  for (const hostile of [
    { id: "::add-mask::x" },
    { id: "  ::set-output name=a::b" },
    { id: "safe ::error:: embedded" },
    { id: "##[group]x" },
    { id: "trailing ##[error]" },
    { status: "line\u000a::stop-commands::x" },
  ]) {
    expectFailure(
      () => engine.emitSafeLine(hostile),
      /(workflow command|control or non-ASCII characters)/,
    );
  }
});

test("neutralizes workflow commands in trusted CLI failure output", () => {
  const fixture = createFixture();
  writeFile(
    fixture.root,
    engine.DESCRIPTOR_PATH,
    '{"schemaVersion": ::add-mask::secret ##[group]forged\n',
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
      "validate",
      "--repo-root",
      fixture.root,
    ],
    { cwd: REPOSITORY_ROOT, encoding: "utf8", shell: false },
  );
  assert.equal(result.status, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.match(output, /descriptor is not valid JSON/);
  assert.equal(output.includes("::"), false);
  assert.equal(output.includes("##["), false);
  assert.equal(/^\s*(::|##\[)/m.test(output), false);
});

test("rejects forbidden container paths and startup variables", () => {
  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  for (const forbidden of ["/github/file_commands", "/github/workspace"]) {
    assert.equal(source.includes(`"${forbidden}"`), true, forbidden);
  }
  const enginePath = path.join(REPOSITORY_ROOT, engine.ENGINE_PATH);
  const spawnRoot = temporaryDirectory();
  for (const name of [
    "NODE_V8_COVERAGE",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "EXPERIMENTAL_MONOCART",
  ]) {
    const value =
      name === "NODE_OPTIONS"
        ? "--no-warnings"
        : name === "NODE_V8_COVERAGE"
          ? path.join(spawnRoot, "stray-coverage")
          : "1";
    const result = spawnSync(
      process.execPath,
      [enginePath, "validate", "--repo-root", REPOSITORY_ROOT],
      {
        cwd: spawnRoot,
        encoding: "utf8",
        shell: false,
        env: { ...process.env, [name]: value },
      },
    );
    assert.equal(result.status, 1, name);
    assert.match(
      result.stderr,
      new RegExp(`${name} must be unset before starting the trusted coverage engine`),
    );
  }
  assert.match(
    source,
    /each attempt requires a fresh container because controlled roots are/,
  );
});

test("enforces the exact controller capability mask", () => {
  assert.equal(engine.CONTROLLER_CAPABILITY_MASK, "00000000000000eb");
  assert.deepEqual([...engine.CONTROLLER_CAPABILITY_NAMES], [
    "CAP_CHOWN",
    "CAP_DAC_OVERRIDE",
    "CAP_FOWNER",
    "CAP_KILL",
    "CAP_SETGID",
    "CAP_SETUID",
  ]);
  assert.equal(
    BigInt(`0x${engine.CONTROLLER_CAPABILITY_MASK}`),
    (1n << 0n) | (1n << 1n) | (1n << 3n) | (1n << 5n) | (1n << 6n) | (1n << 7n),
  );

  const controllerExpectation = {
    uid: 0,
    gid: 0,
    requireControllerCapabilities: true,
  };
  const exact = observedIdentity(0, 0);
  engine.assertObservedIdentityRecord(exact, "controller", controllerExpectation);
  assert.equal(
    engine.assertControllerCapabilityContract(exact, "controller"),
    exact,
  );
  // A wider mask expressed with a shorter hex width is still the same value.
  engine.assertControllerCapabilityContract(
    { ...exact, capEff: "eb", capPrm: "eb", capBnd: "eb" },
    "controller",
  );

  const cases = [
    [
      "omitted required CAP_KILL bit",
      { capEff: "00000000000000cb" },
      /capEff must equal exactly 00000000000000eb \(CAP_CHOWN,CAP_DAC_OVERRIDE,CAP_FOWNER,CAP_KILL,CAP_SETGID,CAP_SETUID\)/,
    ],
    [
      "omitted required CAP_CHOWN bit in permitted",
      { capPrm: "00000000000000ea" },
      /capPrm must equal exactly 00000000000000eb/,
    ],
    [
      "added CAP_SETPCAP",
      { capEff: "00000000000001eb", capPrm: "00000000000001eb" },
      /capEff must equal exactly 00000000000000eb/,
    ],
    [
      "added CAP_SETPCAP to the bounding set",
      { capBnd: "00000000000001eb" },
      /capBnd must equal exactly 00000000000000eb/,
    ],
    [
      "added unrelated CAP_SYS_ADMIN",
      { capEff: "00000000002000eb", capPrm: "00000000002000eb", capBnd: "00000000002000eb" },
      /capEff must equal exactly 00000000000000eb/,
    ],
    [
      "container runtime default set",
      {
        capEff: "00000000a80425fb",
        capPrm: "00000000a80425fb",
        capBnd: "00000000a80425fb",
      },
      /capEff must equal exactly 00000000000000eb/,
    ],
    [
      "nonzero ambient set",
      { capAmb: "0000000000000001" },
      /capAmb must be empty; found 0000000000000001/,
    ],
    [
      "nonzero inheritable set",
      { capInh: "0000000000000080" },
      /capInh must be empty; found 0000000000000080/,
    ],
    [
      "malformed mask",
      { capEff: "not-hex" },
      /capEff must be a hexadecimal capability mask/,
    ],
  ];
  for (const [label, overrides, pattern] of cases) {
    const identity = { ...exact, ...overrides };
    expectFailure(
      () => engine.assertControllerCapabilityContract(identity, "controller"),
      pattern,
      label,
    );
    expectFailure(
      () =>
        engine.assertObservedIdentityRecord(
          identity,
          "controller",
          controllerExpectation,
        ),
      pattern,
      label,
    );
  }

  // Worker requirements are unchanged: empty effective/permitted/ambient,
  // no_new_privs, and the retained controller bounding mask.
  const workerExpectation = {
    uid: engine.WORKER_UID,
    gid: engine.WORKER_GID,
    requireEmptyGroups: true,
    requireNoNewPrivs: true,
    requireEmptyCapabilities: true,
  };
  const worker = observedIdentity(engine.WORKER_UID, engine.WORKER_GID);
  assert.equal(worker.capBnd, engine.CONTROLLER_CAPABILITY_MASK);
  engine.assertObservedIdentityRecord(worker, "worker", workerExpectation);
  engine.assertObservedIdentityRecord(
    { ...worker, capBnd: "00000000a80425fb" },
    "worker",
    workerExpectation,
  );
  for (const [field, pattern] of [
    ["capEff", /worker must not retain capEff capabilities/],
    ["capPrm", /worker must not retain capPrm capabilities/],
    ["capAmb", /worker must not retain capAmb capabilities/],
  ]) {
    expectFailure(
      () =>
        engine.assertObservedIdentityRecord(
          { ...worker, [field]: "0000000000000080" },
          "worker",
          workerExpectation,
        ),
      pattern,
      field,
    );
  }
  expectFailure(
    () =>
      engine.assertObservedIdentityRecord(
        { ...worker, noNewPrivs: 0 },
        "worker",
        workerExpectation,
      ),
    /worker must run with no_new_privs enabled/,
  );
});

test("rejects capability drift in recorded execution evidence", () => {
  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "common");
  const directory = path.dirname(artifact.evidencePath);
  const evidence = artifact.evidence;
  assert.equal(
    evidence.execution.controller.capEff,
    engine.CONTROLLER_CAPABILITY_MASK,
  );
  assert.equal(
    evidence.execution.controller.capBnd,
    engine.CONTROLLER_CAPABILITY_MASK,
  );
  assert.equal(evidence.execution.controller.capAmb, engine.ZERO_CAPABILITY_MASK);
  assert.equal(evidence.execution.controller.capInh, engine.ZERO_CAPABILITY_MASK);
  assert.equal(evidence.execution.worker.capEff, engine.ZERO_CAPABILITY_MASK);

  const mutations = [
    [
      "controller effective drift",
      (value) => {
        value.execution.controller.capEff = "00000000a80425fb";
      },
      /controller identity.capEff must equal exactly 00000000000000eb/,
    ],
    [
      "controller SETPCAP in bounding set",
      (value) => {
        value.execution.controller.capBnd = "00000000000001eb";
      },
      /controller identity.capBnd must equal exactly 00000000000000eb/,
    ],
    [
      "controller ambient drift",
      (value) => {
        value.execution.controller.capAmb = "0000000000000001";
      },
      /controller identity.capAmb must be empty/,
    ],
    [
      "controller inheritable drift",
      (value) => {
        value.execution.controller.capInh = "0000000000000008";
      },
      /controller identity.capInh must be empty/,
    ],
    [
      "controller command record drift",
      (value) => {
        value.commands[0].identity.capPrm = "00000000000000ff";
      },
      /commands\[0\].identity.capPrm must equal exactly 00000000000000eb/,
    ],
    [
      "worker effective drift",
      (value) => {
        value.execution.worker.capEff = "0000000000000001";
      },
      /worker identity must not retain capEff capabilities/,
    ],
    [
      "worker command inheritable is not constrained but must stay hexadecimal",
      (value) => {
        value.commands[1].identity.capInh = "zz";
      },
      /commands\[1\].identity.capInh must be a hexadecimal capability mask/,
    ],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const mutated = structuredClone(evidence);
    mutate(mutated);
    expectFailure(
      () =>
        engine.validateEvidenceAgainstPrepared(
          fixture.root,
          fixture.context,
          mutated,
          artifact.prepared,
          { artifactDirectory: directory },
        ),
      pattern,
      label,
    );
  }
  engine.validateEvidenceAgainstPrepared(
    fixture.root,
    fixture.context,
    evidence,
    artifact.prepared,
    { artifactDirectory: directory },
  );

  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  assert.match(
    source,
    /assertControllerCapabilityContract\(\n\s+controllerIdentity,/,
  );
  assert.match(source, /readProcessIdentityFromProc\("self"\)/);
  assert.match(
    engine.EVIDENCE_LIMITATION,
    /asserted-empty effective, permitted, ambient and inheritable/,
  );
  assert.match(
    engine.EVIDENCE_LIMITATION,
    /bounding set asserted equal to the controller's minimal 00000000000000eb mask/,
  );
  assert.match(
    engine.EVIDENCE_LIMITATION,
    /no_new_privs rather than by an empty bounding set/,
  );
  assert.match(
    engine.EVIDENCE_LIMITATION,
    /container image digest is optional here.*shape and cross-match only/s,
  );
});

test("rejects TAP skip and todo directives independently of the summary", () => {
  const root = temporaryDirectory();
  const write = (name, lines, summary) =>
    writeFile(root, name, tapNodeStyleDocument(lines, summary));

  // A lying summary must not launder a real directive.
  const lyingSkip = write(
    "lying-skip.tap",
    ["# Subtest: fixture", "ok 1 - fixture # SKIP", "1..1"],
    { tests: 1, pass: 1, fail: 0, skipped: 0, todo: 0 },
  );
  expectFailure(
    () => engine.parseTapTestResults(lyingSkip, "common"),
    /contain skipped or todo tests: 1 SKIP and 0 TODO directives \(summary skipped=0 todo=0\)/,
  );

  const lyingTodo = write(
    "lying-todo.tap",
    ["# Subtest: fixture", "ok 1 - fixture # TODO", "1..1"],
    { tests: 1, pass: 1, fail: 0, skipped: 0, todo: 0 },
  );
  expectFailure(
    () => engine.parseTapTestResults(lyingTodo, "common"),
    /contain skipped or todo tests: 0 SKIP and 1 TODO directives \(summary skipped=0 todo=0\)/,
  );

  // Case-insensitive directives and directive reasons are still directives.
  for (const [name, description, pattern] of [
    ["lower-skip.tap", "ok 1 - fixture # skip flaky", /1 SKIP and 0 TODO directives/],
    ["mixed-todo.tap", "ok 1 - fixture # ToDo later", /0 SKIP and 1 TODO directives/],
    ["padded-skip.tap", "ok 1 - fixture #   SKIP", /1 SKIP and 0 TODO directives/],
  ]) {
    const document = write(name, ["# Subtest: fixture", description, "1..1"], {
      tests: 1,
      pass: 1,
      fail: 0,
      skipped: 0,
      todo: 0,
    });
    expectFailure(() => engine.parseTapTestResults(document, "common"), pattern, name);
  }

  // A truthful directive with a matching nonzero summary is still rejected.
  const truthful = write(
    "truthful.tap",
    ["# Subtest: a", "ok 1 - a", "# Subtest: b", "ok 2 - b # SKIP", "1..2"],
    { tests: 2, pass: 1, fail: 0, skipped: 1, todo: 0 },
  );
  expectFailure(
    () => engine.parseTapTestResults(truthful, "common"),
    /contain skipped or todo tests: 1 SKIP and 0 TODO directives \(summary skipped=1 todo=0\)/,
  );

  // A summary that claims skips without any directive is a mismatch.
  const phantom = write(
    "phantom.tap",
    ["# Subtest: a", "ok 1 - a", "1..1"],
    { tests: 1, pass: 0, fail: 0, skipped: 1, todo: 0 },
  );
  expectFailure(
    () => engine.parseTapTestResults(phantom, "common"),
    /directive counts disagree with the reported summary: directives skipped=0 todo=0; summary skipped=1 todo=0/,
  );

  // Nested (indented) directives are detected exactly as Node emits them.
  const nestedSkip = write(
    "nested-skip.tap",
    [
      "# Subtest: parent",
      "    # Subtest: nested pass",
      "    ok 1 - nested pass",
      "    # Subtest: nested skip",
      "    ok 2 - nested skip # SKIP",
      "    1..2",
      "ok 1 - parent",
      "1..1",
    ],
    { tests: 3, pass: 2, fail: 0, skipped: 0, todo: 0 },
  );
  expectFailure(
    () => engine.parseTapTestResults(nestedSkip, "common"),
    /contain skipped or todo tests: 1 SKIP and 0 TODO directives \(summary skipped=0 todo=0\)/,
  );

  // Escaped and non-directive comment text stays plain description text.
  const escaped = write(
    "escaped.tap",
    [
      "# Subtest: hash \\# SKIP in description",
      "ok 1 - hash \\# SKIP in description",
      "# Subtest: annotated",
      "ok 2 - annotated # not a directive",
      "1..2",
    ],
    { tests: 2, pass: 2, fail: 0, skipped: 0, todo: 0 },
  );
  assert.deepEqual(engine.parseTapTestResults(escaped, "common"), {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    todo: 0,
  });
  assert.deepEqual(
    engine.parseTapResultDescription("hash \\# SKIP in description"),
    {
      raw: "hash \\# SKIP in description",
      description: "hash # SKIP in description",
      directive: null,
      comment: null,
    },
  );
  assert.deepEqual(engine.parseTapResultDescription("fixture # SKIP why"), {
    raw: "fixture",
    description: "fixture",
    directive: "skip",
    comment: "SKIP why",
  });

  // Node's real nested output shape is accepted and counted across depths.
  const nested = write(
    "nested-clean.tap",
    [
      "# Subtest: plain pass",
      "ok 1 - plain pass",
      "# Subtest: with subtests",
      "    # Subtest: nested one",
      "    ok 1 - nested one",
      "    # Subtest: nested two",
      "    ok 2 - nested two",
      "    1..2",
      "ok 2 - with subtests",
      "1..2",
    ],
    { tests: 4, pass: 4, fail: 0, skipped: 0, todo: 0 },
  );
  assert.deepEqual(engine.parseTapTestResults(nested, "common"), {
    total: 4,
    passed: 4,
    failed: 0,
    skipped: 0,
    todo: 0,
  });

  // Nested results still have to agree with the summary total.
  const nestedDrift = write(
    "nested-drift.tap",
    [
      "# Subtest: plain pass",
      "ok 1 - plain pass",
      "# Subtest: with subtests",
      "    # Subtest: nested one",
      "    ok 1 - nested one",
      "    1..1",
      "ok 2 - with subtests",
      "1..2",
    ],
    { tests: 9, pass: 9, fail: 0, skipped: 0, todo: 0 },
  );
  expectFailure(
    () => engine.parseTapTestResults(nestedDrift, "common"),
    /summary and reported results disagree: summary tests=9 test results=3/,
  );

  // A nested failure is still counted as a failure.
  const nestedFailure = write(
    "nested-failure.tap",
    [
      "# Subtest: parent",
      "    # Subtest: nested fail",
      "    not ok 1 - nested fail",
      "    1..1",
      "not ok 1 - parent",
      "1..1",
    ],
    { tests: 2, pass: 0, fail: 2, skipped: 0, todo: 0 },
  );
  expectFailure(
    () => engine.parseTapTestResults(nestedFailure, "common"),
    /TAP test results are not successful/,
  );
});

test("fails closed when a command records no proc-observed identity", () => {
  const root = temporaryDirectory();
  const entry = { id: "fixture", profile: "jest-typescript" };
  const layout = preparedLayout(root, "fixture");
  fs.mkdirSync(path.join(root, "fixture"), { recursive: true });
  const command = {
    role: "worker",
    workingDirectory: "fixture",
    argv: [process.execPath, "-e", "process.exit(0)"],
    timeoutMs: 15_000,
  };
  // A supervisor that reports no identity is simulated by removing the
  // controller-owned identity sink the supervisor writes into.
  const withoutIdentitySink = { ...layout, identityRoot: null };

  // Advisory mode records the absence honestly and never invents an identity.
  const advisory = [];
  engine.executeCommands(root, [command], entry, advisory, {
    layout: withoutIdentitySink,
  });
  assert.equal(advisory.length, 1);
  assert.equal(advisory[0].identity, null);
  assert.equal(advisory[0].role, "worker");
  // The remaining uid is the declared plan value, not a measurement.
  assert.equal(advisory[0].uid, engine.WORKER_UID);

  // The same result is refused before it can become a record in authoritative mode.
  const authoritative = [];
  expectFailure(
    () =>
      engine.executeCommands(root, [command], entry, authoritative, {
        layout: withoutIdentitySink,
        requireObservedIdentity: true,
      }),
    /fixture command 0 did not record an observed execution identity/,
  );
  assert.deepEqual(authoritative, []);

  // With the sink present an identity is recorded, and the authoritative role
  // check then judges that identity instead of reporting it as missing.
  const observedRecords = [];
  engine.executeCommands(root, [command], entry, observedRecords, { layout });
  assert.equal(observedRecords.length, 1);
  assert.notEqual(observedRecords[0].identity, null);
  assert.equal(observedRecords[0].identity.uid, process.getuid());
  assert.equal(
    observedRecords[0].identity.source,
    process.platform === "linux" ? "proc" : "supervisor",
  );
  expectFailure(
    () =>
      engine.executeCommands(root, [command], entry, [], {
        layout,
        requireObservedIdentity: true,
      }),
    process.platform === "linux"
      ? /identity must be uid 10001 and gid 10001/
      : /identity must be observed from the container process table/,
  );

  // A missing or declared identity can never satisfy evidence validation either.
  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "common");
  const withoutIdentity = structuredClone(artifact.evidence.commands);
  withoutIdentity[1].identity = null;
  expectFailure(
    () =>
      engine.validateCommandRecords(withoutIdentity, artifact.prepared.commands),
    /evidence commands\[1\].identity must be an object/,
  );
  const declaredIdentity = structuredClone(artifact.evidence.commands);
  declaredIdentity[1].identity.source = "supervisor";
  expectFailure(
    () =>
      engine.validateCommandRecords(declaredIdentity, artifact.prepared.commands),
    /evidence commands\[1\].identity must be observed from the container process table/,
  );
});

// Captured verbatim from `node --test --test-reporter=tap` on Node 20.19.5.
const REAL_TAP_ONE_FILE = [
  "TAP version 13",
  "# Subtest: alpha one",
  "ok 1 - alpha one",
  "  ---",
  "  duration_ms: 0.861324",
  "  ...",
  "# Subtest: alpha two",
  "ok 2 - alpha two",
  "  ---",
  "  duration_ms: 0.163248",
  "  ...",
  "1..2",
  "# tests 2",
  "# suites 0",
  "# pass 2",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 95.743202",
  "",
].join("\n");

const REAL_TAP_TWO_FILES = [
  "TAP version 13",
  "# Subtest: alpha one",
  "ok 1 - alpha one",
  "  ---",
  "  duration_ms: 0.861324",
  "  ...",
  "# Subtest: alpha two",
  "ok 2 - alpha two",
  "  ---",
  "  duration_ms: 0.163248",
  "  ...",
  "# Subtest: beta one",
  "ok 3 - beta one",
  "  ---",
  "  duration_ms: 0.599894",
  "  ...",
  "1..3",
  "# tests 3",
  "# suites 0",
  "# pass 3",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 95.743202",
  "",
].join("\n");

const REAL_TAP_SUITE = [
  "TAP version 13",
  "# Subtest: group",
  "    # Subtest: suite case one",
  "    ok 1 - suite case one",
  "      ---",
  "      duration_ms: 0.454841",
  "      ...",
  "    # Subtest: suite case two",
  "    ok 2 - suite case two",
  "      ---",
  "      duration_ms: 0.076457",
  "      ...",
  "    1..2",
  "ok 1 - group",
  "  ---",
  "  duration_ms: 1.110199",
  "  type: 'suite'",
  "  ...",
  "# Subtest: standalone",
  "ok 2 - standalone",
  "  ---",
  "  duration_ms: 0.064",
  "  ...",
  "1..2",
  "# tests 3",
  "# suites 1",
  "# pass 3",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 36.645643",
  "",
].join("\n");

const REAL_TAP_FAILING_SUITE = [
  "TAP version 13",
  "# Subtest: failing group",
  "    # Subtest: bad case",
  "    not ok 1 - bad case",
  "      ---",
  "      duration_ms: 1.2",
  "      ...",
  "    # Subtest: good case",
  "    ok 2 - good case",
  "      ---",
  "      duration_ms: 0.1",
  "      ...",
  "    1..2",
  "not ok 1 - failing group",
  "  ---",
  "  duration_ms: 2.4",
  "  type: 'suite'",
  "  ...",
  "# Subtest: parent with failing child",
  "    # Subtest: child fails",
  "    not ok 1 - child fails",
  "      ---",
  "      duration_ms: 0.3",
  "      ...",
  "    1..1",
  "not ok 2 - parent with failing child",
  "  ---",
  "  duration_ms: 0.9",
  "  ...",
  "1..2",
  "# tests 4",
  "# suites 1",
  "# pass 1",
  "# fail 3",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 36.6",
  "",
].join("\n");

test("accepts real Node 20.19.5 TAP shapes and rejects injected results", () => {
  const root = temporaryDirectory();
  const oneFile = writeFile(root, "real-one-file.tap", REAL_TAP_ONE_FILE);
  assert.deepEqual(engine.parseTapTestResults(oneFile, "common"), {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    todo: 0,
  });

  // Two files are flattened by Node: there are no per-file result lines to bind.
  const twoFiles = writeFile(root, "real-two-files.tap", REAL_TAP_TWO_FILES);
  assert.deepEqual(engine.parseTapTestResults(twoFiles, "common"), {
    total: 3,
    passed: 3,
    failed: 0,
    skipped: 0,
    todo: 0,
  });
  assert.equal(REAL_TAP_TWO_FILES.includes("test.js"), false);

  // A suite aggregate line counts as a suite, never as a test.
  const suite = writeFile(root, "real-suite.tap", REAL_TAP_SUITE);
  assert.deepEqual(engine.parseTapTestResults(suite, "common"), {
    total: 3,
    passed: 3,
    failed: 0,
    skipped: 0,
    todo: 0,
  });

  // A failing suite is not double-counted as a failing test.
  const failing = writeFile(root, "real-failing.tap", REAL_TAP_FAILING_SUITE);
  expectFailure(
    () => engine.parseTapTestResults(failing, "common"),
    /TAP test results are not successful/,
  );

  // Injected unindented results without a subtest header are rejected.
  const injected = writeFile(
    root,
    "injected.tap",
    REAL_TAP_ONE_FILE.replace("1..2", "ok 3 - injected\n1..3").replace(
      "# tests 2",
      "# tests 3",
    ).replace("# pass 2", "# pass 3"),
  );
  expectFailure(
    () => engine.parseTapTestResults(injected, "common"),
    /TAP result has no matching subtest header at its own depth: injected/,
  );

  // A forged suite marker cannot hide a test from the totals.
  const forgedSuite = writeFile(
    root,
    "forged-suite.tap",
    REAL_TAP_ONE_FILE.replace(
      "  duration_ms: 0.163248",
      "  duration_ms: 0.163248\n  type: 'suite'",
    ),
  );
  expectFailure(
    () => engine.parseTapTestResults(forgedSuite, "common"),
    /summary and reported results disagree: summary tests=2 test results=1/,
  );

  // A suite total that does not match the reported suite lines is rejected.
  const suiteDrift = writeFile(
    root,
    "suite-drift.tap",
    REAL_TAP_SUITE.replace("# suites 1", "# suites 0"),
  );
  expectFailure(
    () => engine.parseTapTestResults(suiteDrift, "common"),
    /summary and reported suites disagree: summary suites=0 suite results=1/,
  );

  // Nested directives inside a real suite are still rejected on their own.
  const suiteSkip = writeFile(
    root,
    "real-suite-skip.tap",
    REAL_TAP_SUITE.replace("    ok 2 - suite case two", "    ok 2 - suite case two # SKIP"),
  );
  expectFailure(
    () => engine.parseTapTestResults(suiteSkip, "common"),
    /contain skipped or todo tests: 1 SKIP and 0 TODO directives \(summary skipped=0 todo=0\)/,
  );
});

test("requires the worker bounding and inheritable capability contract", () => {
  const workerExpectation = engine.expectedIdentityForRole("worker");
  assert.equal(workerExpectation.requireEmptyInheritable, true);
  assert.equal(workerExpectation.requireControllerBoundingMask, true);
  assert.equal(workerExpectation.requireNoNewPrivs, true);
  assert.equal(workerExpectation.requireEmptyCapabilities, true);

  const worker = observedIdentity(engine.WORKER_UID, engine.WORKER_GID);
  engine.assertObservedIdentityRecord(worker, "worker", workerExpectation);

  for (const [label, overrides, pattern] of [
    [
      "runtime default bounding set",
      { capBnd: "00000000a80425fb" },
      /worker.capBnd must equal the inherited controller mask 00000000000000eb/,
    ],
    [
      "empty bounding set",
      { capBnd: "0000000000000000" },
      /worker.capBnd must equal the inherited controller mask 00000000000000eb/,
    ],
    [
      "nonzero inheritable set",
      { capInh: "0000000000000080" },
      /worker must not retain inheritable capabilities; found 0000000000000080/,
    ],
  ]) {
    expectFailure(
      () =>
        engine.assertObservedIdentityRecord(
          { ...worker, ...overrides },
          "worker",
          workerExpectation,
        ),
      pattern,
      label,
    );
  }

  const fixture = createFixture();
  const artifact = createEvidenceArtifact(fixture, "common");
  const directory = path.dirname(artifact.evidencePath);
  for (const [label, mutate, pattern] of [
    [
      "worker bounding drift in execution",
      (value) => {
        value.execution.worker.capBnd = "00000000a80425fb";
      },
      /worker identity.capBnd must equal the inherited controller mask/,
    ],
    [
      "worker inheritable drift in execution",
      (value) => {
        value.execution.worker.capInh = "0000000000000001";
      },
      /worker identity must not retain inheritable capabilities/,
    ],
    [
      "worker bounding drift in a command record",
      (value) => {
        value.commands[1].identity.capBnd = "0000000000000000";
      },
      /commands\[1\].identity.capBnd must equal the inherited controller mask/,
    ],
    [
      "worker inheritable drift in a command record",
      (value) => {
        value.commands[1].identity.capInh = "0000000000000008";
      },
      /commands\[1\].identity must not retain inheritable capabilities/,
    ],
  ]) {
    const mutated = structuredClone(artifact.evidence);
    mutate(mutated);
    expectFailure(
      () =>
        engine.validateEvidenceAgainstPrepared(
          fixture.root,
          fixture.context,
          mutated,
          artifact.prepared,
          { artifactDirectory: directory },
        ),
      pattern,
      label,
    );
  }
});

test("aborts the command sequence on the first identity mismatch", () => {
  const root = temporaryDirectory();
  const entry = { id: "fixture", profile: "jest-typescript" };
  const layout = preparedLayout(root, "fixture");
  fs.mkdirSync(path.join(root, "fixture"), { recursive: true });
  const firstMarker = path.join(root, "first-ran");
  const secondMarker = path.join(root, "second-ran");
  const marker = (target) =>
    `require("node:fs").writeFileSync(${JSON.stringify(target)}, "ran")`;
  const commands = [
    {
      role: "worker",
      workingDirectory: "fixture",
      argv: [process.execPath, "-e", marker(firstMarker)],
      timeoutMs: 15_000,
    },
    {
      role: "worker",
      workingDirectory: "fixture",
      argv: [process.execPath, "-e", marker(secondMarker)],
      timeoutMs: 15_000,
    },
  ];

  // Without the privilege drop the observed identity cannot be the worker
  // account, so the first command must abort the whole sequence.
  const records = [];
  expectFailure(
    () =>
      engine.executeCommands(root, commands, entry, records, {
        layout,
        requireObservedIdentity: true,
      }),
    // Off-container the source check fires first; under the container the uid
    // check does. Either way the mismatch aborts before the next command.
    /fixture command 0 \(worker\) identity must be (observed from the container process table|uid 10001 and gid 10001)/,
  );
  assert.equal(fs.existsSync(firstMarker), true);
  assert.equal(fs.existsSync(secondMarker), false);
  assert.deepEqual(records, []);

  // The same sequence completes when identity checking is advisory.
  const advisory = [];
  engine.executeCommands(root, commands, entry, advisory, { layout });
  assert.equal(advisory.length, 2);
  assert.equal(fs.existsSync(secondMarker), true);
  assert.equal(advisory[0].identity.uid, process.getuid());

  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  const executeStart = source.indexOf("function executeCommands(");
  const executeSource = source.slice(executeStart);
  const identityIndex = executeSource.indexOf("expectedIdentityForRole(role),");
  const pushIndex = executeSource.indexOf("records.push(record);");
  assert.ok(identityIndex > 0);
  assert.ok(pushIndex > identityIndex);
});

function candidateStagingFingerprint(fixtureRoot) {
  const paths = ["common"];
  for (const id of engine.SUPPLEMENTAL_PACKAGE_IDS.common) {
    paths.push(id);
  }
  const inventory = {};
  for (const relative of paths) {
    const directory = path.join(fixtureRoot, relative);
    inventory[relative] = fs
      .readdirSync(directory)
      .sort()
      .map((name) => {
        const absolute = path.join(directory, name);
        const stat = fs.lstatSync(absolute);
        return stat.isFile()
          ? `${name}:${crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")}`
          : `${name}/`;
      });
  }
  return inventory;
}

test("refuses destructive staging unless the layout is isolated from the candidate", () => {
  const fixture = createFixture();
  const snapshot = engine.deriveSupplementalSnapshot(
    fixture.root,
    fixture.context.repository.checkoutSha,
    "common",
  );
  const prepared = engine.prepareEntry(
    fixture.root,
    fixture.root,
    fixture.context,
    "common",
  );
  const before = candidateStagingFingerprint(fixture.root);
  assert.equal(Object.keys(before).length, 9);

  // The advisory local layout points the worker home at the candidate itself,
  // so both destructive primitives must refuse before deleting anything.
  const localLayout = engine.resolveExecutionLayout({
    repoRoot: fixture.root,
    entryId: "common",
    authoritative: false,
  });
  temporaryDirectories.add(localLayout.temporaryRoot);
  assert.equal(localLayout.workerHome, fs.realpathSync(fixture.root));
  assert.equal(localLayout.workerHomeEntries, null);
  expectFailure(
    () =>
      engine.stageWorkerPackage(
        fixture.root,
        prepared.entry,
        prepared.packageInputSnapshot,
        localLayout,
      ),
    /staging worker home must not be the candidate checkout/,
  );
  expectFailure(
    () => engine.stageSupplementalInputs(fixture.root, snapshot, localLayout),
    /staging worker home must not be the candidate checkout/,
  );
  assert.deepEqual(candidateStagingFingerprint(fixture.root), before);

  const malformed = (overrides) => ({
    ...supplementalLayout(fixture.root, temporaryDirectory()),
    ...overrides,
  });
  const cases = [
    [
      "worker home inside the candidate checkout",
      () => {
        const inside = path.join(fixture.root, "staging-home");
        fs.mkdirSync(inside, { recursive: true });
        return {
          ...supplementalLayout(fixture.root, inside),
          workerHome: inside,
          pkg: path.join(inside, "common"),
        };
      },
      /staging worker home must not resolve inside the candidate checkout/,
    ],
    [
      "candidate checkout nested under the worker home",
      () => {
        const outerHome = temporaryDirectory();
        const nestedRepo = path.join(outerHome, "candidate");
        fs.cpSync(fixture.root, nestedRepo, { recursive: true });
        return {
          layout: supplementalLayout(nestedRepo, outerHome),
          repoRoot: nestedRepo,
        };
      },
      /candidate checkout must not resolve inside the staging worker home/,
    ],
    [
      "staged package outside the worker home",
      () => malformed({ pkg: path.join(temporaryDirectory(), "common") }),
      /staged package root must resolve to the worker home entry/,
    ],
    [
      "staged package renamed away from the entry id",
      () => {
        const home = temporaryDirectory();
        return {
          ...supplementalLayout(fixture.root, home),
          pkg: path.join(home, "not-common"),
        };
      },
      /staged package root must resolve to the worker home entry/,
    ],
    [
      "null worker home inventory",
      () => malformed({ workerHomeEntries: null }),
      /staging worker home inventory must be exactly/,
    ],
    [
      "forged worker home inventory",
      () => malformed({ workerHomeEntries: ["common", "..", "auth"] }),
      /staging worker home inventory must be exactly/,
    ],
    [
      "forged supplemental id set",
      () => malformed({ supplementalIds: ["auth", "client"] }),
      /staging supplemental package ids must be exactly/,
    ],
    [
      "missing supplemental id set",
      () => malformed({ supplementalIds: null }),
      /staging supplemental package ids must be an array/,
    ],
    [
      "package id mismatch",
      () => ({
        layout: malformed({ entryId: "auth" }),
        entry: { id: "common", profile: "node-typescript-c8" },
      }),
      {
        worker: /staging layout package id does not match the staged entry/,
        // The supplemental primitive derives its id from the layout, so the
        // forged id is caught by the staged package path instead.
        supplemental: /staged package root must resolve to the worker home entry/,
      },
    ],
    [
      "symlinked staging target",
      () => {
        const home = temporaryDirectory();
        const layout = supplementalLayout(fixture.root, home);
        fs.rmSync(path.join(home, "common"), { recursive: true, force: true });
        fs.symlinkSync(path.join(fixture.root, "common"), path.join(home, "common"));
        return layout;
      },
      /staging target must not be a symlink: common/,
    ],
  ];

  for (const [label, build, pattern] of cases) {
    const built = build();
    const layout = built.layout || built;
    const repoRoot = built.repoRoot || fixture.root;
    const entry =
      built.entry || { id: layout.entryId ?? "common", profile: "node-typescript-c8" };
    const workerPattern = pattern instanceof RegExp ? pattern : pattern.worker;
    const supplementalPattern =
      pattern instanceof RegExp ? pattern : pattern.supplemental;
    const stagingSnapshot =
      repoRoot === fixture.root
        ? snapshot
        : engine.deriveSupplementalSnapshot(
          repoRoot,
          engine.resolveCommit(repoRoot, "HEAD", "nested fixture"),
          "common",
        );
    expectFailure(
      () =>
        engine.stageWorkerPackage(
          repoRoot,
          entry,
          prepared.packageInputSnapshot,
          layout,
        ),
      workerPattern,
      `${label} (worker package)`,
    );
    expectFailure(
      () => engine.stageSupplementalInputs(repoRoot, stagingSnapshot, layout),
      supplementalPattern,
      `${label} (supplemental)`,
    );
  }

  // Nothing in the candidate checkout was touched by any refused attempt.
  assert.deepEqual(candidateStagingFingerprint(fixture.root), before);
  for (const id of engine.SUPPLEMENTAL_PACKAGE_IDS.common) {
    assert.equal(
      fs.existsSync(path.join(fixture.root, id, "package.json")),
      true,
      id,
    );
    assert.equal(
      fs.existsSync(path.join(fixture.root, id, "package-lock.json")),
      true,
      id,
    );
  }
  assert.equal(fs.existsSync(path.join(fixture.root, "common", "src")), true);

  // The isolated layout still stages successfully.
  const isolatedHome = temporaryDirectory();
  const isolated = supplementalLayout(fixture.root, isolatedHome);
  engine.stageWorkerPackage(
    fixture.root,
    prepared.entry,
    prepared.packageInputSnapshot,
    isolated,
  );
  engine.stageSupplementalInputs(fixture.root, snapshot, isolated);
  assert.equal(
    fs.existsSync(path.join(isolatedHome, "auth", "package-lock.json")),
    true,
  );
  assert.deepEqual(candidateStagingFingerprint(fixture.root), before);

  // The guard is the first statement of both primitives, before any removal.
  const source = fs.readFileSync(
    path.join(REPOSITORY_ROOT, engine.ENGINE_PATH),
    "utf8",
  );
  for (const name of ["stageWorkerPackage", "stageSupplementalInputs"]) {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start > 0, name);
    const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
    const guardIndex = body.indexOf("assertIsolatedStagingLayout(");
    const removalIndex = body.indexOf("fs.rmSync(");
    assert.ok(guardIndex > 0, `${name} guard`);
    assert.ok(removalIndex > guardIndex, `${name} removal after guard`);
  }
});

// Captured verbatim from Node 20.19.5: a suite whose child test passes while an
// `after()` hook throws. Every counter reports success.
const REAL_TAP_SUITE_HOOK_FAILURE = [
  "TAP version 13",
  "# Subtest: hook group",
  "    # Subtest: child passes",
  "    ok 1 - child passes",
  "      ---",
  "      duration_ms: 0.4",
  "      ...",
  "    1..1",
  "not ok 1 - hook group",
  "  ---",
  "  duration_ms: 1.1",
  "  type: 'suite'",
  "  location: 'hook.test.js:2:1'",
  "  failureType: 'hookFailed'",
  "  error: 'after hook failed'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "1..1",
  "# tests 1",
  "# suites 1",
  "# pass 1",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 43.474624",
  "",
].join("\n");

// Captured verbatim from Node 20.19.5: nested suites where only the inner
// `after()` hook fails; both aggregates report `not ok` with zero test failures.
const REAL_TAP_NESTED_SUITE_HOOK_FAILURE = [
  "TAP version 13",
  "# Subtest: outer",
  "    # Subtest: inner",
  "        # Subtest: inner child passes",
  "        ok 1 - inner child passes",
  "          ---",
  "          duration_ms: 0.3",
  "          ...",
  "        1..1",
  "    not ok 1 - inner",
  "      ---",
  "      duration_ms: 0.9",
  "      type: 'suite'",
  "      failureType: 'hookFailed'",
  "      error: 'nested after hook failed'",
  "      ...",
  "    1..1",
  "not ok 1 - outer",
  "  ---",
  "  duration_ms: 1.4",
  "  type: 'suite'",
  "  failureType: 'hookFailed'",
  "  ...",
  "1..1",
  "# tests 1",
  "# suites 2",
  "# pass 1",
  "# fail 0",
  "# cancelled 0",
  "# skipped 0",
  "# todo 0",
  "# duration_ms 39.109849",
  "",
].join("\n");

test("rejects failing suite aggregates even when every counter reports success", () => {
  const root = temporaryDirectory();

  const hookFailure = writeFile(
    root,
    "real-suite-hook-failure.tap",
    REAL_TAP_SUITE_HOOK_FAILURE,
  );
  expectFailure(
    () => engine.parseTapTestResults(hookFailure, "common"),
    /TAP reports 1 failing suite aggregate\(s\) while the summary reports 0 test failures: hook group/,
  );

  const nestedHookFailure = writeFile(
    root,
    "real-nested-suite-hook-failure.tap",
    REAL_TAP_NESTED_SUITE_HOOK_FAILURE,
  );
  expectFailure(
    () => engine.parseTapTestResults(nestedHookFailure, "common"),
    /TAP reports 2 failing suite aggregate\(s\) while the summary reports 0 test failures: inner,outer/,
  );

  // The rejection does not depend on the counters at all.
  const inflatedCounters = writeFile(
    root,
    "suite-hook-inflated.tap",
    REAL_TAP_SUITE_HOOK_FAILURE.replace("# pass 1", "# pass 1").replace(
      "# duration_ms 43.474624",
      "# duration_ms 1",
    ),
  );
  expectFailure(
    () => engine.parseTapTestResults(inflatedCounters, "common"),
    /failing suite aggregate\(s\)/,
  );

  // Genuine passing shapes stay green, and suites stay out of the test totals.
  for (const [name, document, expected] of [
    ["real-suite.tap", REAL_TAP_SUITE, { total: 3, passed: 3 }],
    ["real-one-file.tap", REAL_TAP_ONE_FILE, { total: 2, passed: 2 }],
    ["real-two-files.tap", REAL_TAP_TWO_FILES, { total: 3, passed: 3 }],
  ]) {
    const document_ = writeFile(root, `green-${name}`, document);
    assert.deepEqual(engine.parseTapTestResults(document_, "common"), {
      total: expected.total,
      passed: expected.passed,
      failed: 0,
      skipped: 0,
      todo: 0,
    });
  }

  // A failing child test is still reported as a test failure, not a suite one.
  const childFailure = writeFile(
    root,
    "real-failing-child.tap",
    REAL_TAP_FAILING_SUITE,
  );
  expectFailure(
    () => engine.parseTapTestResults(childFailure, "common"),
    /TAP test results are not successful/,
  );

  // Directive rejection, plan binding, subtest pairing and suite reconciliation
  // remain in force on the hook-failure shape.
  const skippedChild = writeFile(
    root,
    "suite-hook-skip.tap",
    REAL_TAP_SUITE_HOOK_FAILURE.replace(
      "    ok 1 - child passes",
      "    ok 1 - child passes # SKIP",
    ),
  );
  expectFailure(
    () => engine.parseTapTestResults(skippedChild, "common"),
    /contain skipped or todo tests: 1 SKIP and 0 TODO directives/,
  );
  const unpairedResult = writeFile(
    root,
    "suite-hook-unpaired.tap",
    REAL_TAP_SUITE_HOOK_FAILURE.replace(
      "1..1\n# tests 1",
      "ok 2 - injected\n1..2\n# tests 2",
    ),
  );
  expectFailure(
    () => engine.parseTapTestResults(unpairedResult, "common"),
    /TAP result has no matching subtest header at its own depth: injected/,
  );
  const suiteCountDrift = writeFile(
    root,
    "suite-hook-count-drift.tap",
    REAL_TAP_SUITE_HOOK_FAILURE.replace("# suites 1", "# suites 0"),
  );
  expectFailure(
    () => engine.parseTapTestResults(suiteCountDrift, "common"),
    /summary and reported suites disagree: summary suites=0 suite results=1/,
  );
});
