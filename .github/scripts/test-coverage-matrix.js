#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DESCRIPTOR_SCHEMA_VERSION = 1;
const RUN_CONTEXT_SCHEMA_VERSION = 1;
const EVIDENCE_SCHEMA_VERSION = 3;
const REQUIRED_NODE_VERSION = "20.19.5";
const REQUIRED_THRESHOLDS = Object.freeze({ lines: 80, branches: 80 });
const DESCRIPTOR_PATH = ".github/coverage/test-coverage-matrix.json";
const TOOL_PACKAGE_PATH = ".github/coverage/package.json";
const ENGINE_PATH = ".github/scripts/test-coverage-matrix.js";
const TOOL_LOCK_PATH = ".github/coverage/package-lock.json";
const WORKFLOW_PATH = ".github/workflows/production-build.yml";
const ARTIFACT_ROOT = "artifacts/test-coverage";
const OUTPUT_ARTIFACT_ROOT = "test-coverage";
const CANONICAL_REPOSITORY = "vasilyevstan/betstan";
const ENFORCED_PACKAGE_IDS = Object.freeze(["common"]);
const SUPPLEMENTAL_PACKAGE_IDS = Object.freeze({
  common: Object.freeze([
    "auth",
    "backoffice",
    "bet",
    "event",
    "gamemaster",
    "moderation",
    "resulting",
    "slip",
  ]),
});
const SUPPLEMENTAL_MANIFEST_FILES = Object.freeze([
  "package-lock.json",
  "package.json",
]);
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const SAFE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SAFE_PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const FORBIDDEN_WORKFLOW_FILES = new Set([
  "tests-telemetry.yml",
  "tests-telemetry.yaml",
]);
const PROFILE_NAMES = new Set([
  "jest-typescript",
  "react-scripts",
  "node-typescript-c8",
]);
const CURRENT_PROFILE_REQUIREMENTS = Object.freeze({
  auth: "jest-typescript",
  backoffice: "jest-typescript",
  bet: "jest-typescript",
  client: "react-scripts",
  common: "node-typescript-c8",
  event: "jest-typescript",
  gamemaster: "jest-typescript",
  moderation: "jest-typescript",
  resulting: "jest-typescript",
  slip: "jest-typescript",
});
const FORBIDDEN_COVERAGE_CONFIG_FILES = Object.freeze([
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
]);
const FORBIDDEN_COVERAGE_MANIFEST_KEYS = Object.freeze(["c8", "istanbul", "nyc"]);
const COMMAND_ROLES = Object.freeze(["controller", "worker"]);
const CONTROLLER_UID = 0;
const CONTROLLER_GID = 0;
const WORKER_UID = 10001;
const WORKER_GID = 10001;
const WORKER_UMASK = 0o077;
const CONTAINER_MARKER_VARIABLE = "BETSTAN_COVERAGE_CONTAINER";
const CONTAINER_ROOTS = Object.freeze({
  home: "/betstan/home",
  frozen: "/betstan/frozen",
  output: "/betstan/out",
  raw: "/betstan/raw",
  tool: "/betstan/tool",
});
const FORBIDDEN_CONTAINER_PATHS = Object.freeze([
  "/github/file_commands",
  "/github/home",
  "/github/workflow/event.json",
  "/github/workspace",
  "/home/runner/work",
  "/run/docker.sock",
  "/var/run/docker.sock",
]);
const GITHUB_COMMAND_CHANNEL_VARIABLES = Object.freeze([
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STATE",
  "GITHUB_STEP_SUMMARY",
]);
const FORBIDDEN_ENVIRONMENT_PREFIX = /^(?:ACTIONS_|GH_|GITHUB_|INPUT_|RUNNER_)/;
const FORBIDDEN_ENVIRONMENT_NAMES = Object.freeze([
  "ALL_PROXY",
  "EXPERIMENTAL_MONOCART",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_V8_COVERAGE",
  "NO_PROXY",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);
const COMMAND_PLACEHOLDERS = Object.freeze([
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
]);
const PLACEHOLDER_TOKEN_PATTERN = /<[^<>]*>/g;
const LITERAL_COMMAND_TOKENS = Object.freeze(["<rootDir>"]);
const RAW_COVERAGE_FILE_PATTERN = /^coverage-[0-9]+-[0-9]+-[0-9]+\.json$/;
const RAW_COVERAGE_KEYS = Object.freeze(["result", "source-map-cache", "timestamp"]);
const C8_CONFIG_CONTENT = "{}\n";
const SAFE_STDOUT_KEYS = Object.freeze([
  "branches",
  "commands",
  "coverage",
  "entries",
  "id",
  "include",
  "lines",
  "node",
  "packages",
  "rawFiles",
  "reportSha256",
  "schemaVersion",
  "status",
  "tests",
  "thresholds",
]);
const SAFE_STDOUT_TEXT_PATTERN = /^[\x20-\x7e]*$/;
const CONTROLLER_CAPABILITY_MASK = "00000000000000eb";
const CONTROLLER_CAPABILITY_NAMES = Object.freeze([
  "CAP_CHOWN",
  "CAP_DAC_OVERRIDE",
  "CAP_FOWNER",
  "CAP_KILL",
  "CAP_SETGID",
  "CAP_SETUID",
]);
const ZERO_CAPABILITY_MASK = "0000000000000000";
const WORKER_HOME_MODE = 0o755;
const SUPPLEMENTAL_DIRECTORY_MODE = 0o555;
const SUPPLEMENTAL_FILE_MODE = 0o444;
const EVIDENCE_LIMITATION =
  "provenance-bound review evidence, not tamper-proof execution proof: a " +
  "tracked test or source map can shape its own V8 coverage data; TAP counts " +
  "and test names are self-reported by the measured run and are only " +
  "structurally cross-checked against the plan, the trailing summary block, " +
  "the subtest headers and the suite-aware result lines, while the executed " +
  "test-file set is bound by the trusted command plan argv rather than by any " +
  "name in the TAP stream; raw V8 digests are controller-recorded assertions " +
  "about the frozen run rather than artifacts revalidated later; the worker " +
  "runs with asserted-empty effective, permitted, ambient and inheritable " +
  "capability sets and a bounding set asserted equal to the controller's " +
  "minimal 00000000000000eb mask, so exec privilege gain is closed by " +
  "no_new_privs rather than by an empty bounding set; and the container image " +
  "digest is optional here, recorded from the run context and checked for " +
  "shape and cross-match only, so mandatory external image attestation " +
  "remains an activation obligation outside this engine";
const LIMITS = Object.freeze({
  descriptorBytes: 64 * 1024,
  entries: 32,
  sourceFilesPerEntry: 5000,
  packageInputFilesPerEntry: 10000,
  sourceFileBytes: 2 * 1024 * 1024,
  toolFiles: 100000,
  toolBytes: 1024 * 1024 * 1024,
  pathBytes: 320,
  workflowFiles: 256,
  workflowBytes: 2 * 1024 * 1024,
  reportBytes: 64 * 1024 * 1024,
  evidenceBytes: 8 * 1024 * 1024,
  artifactFiles: 256,
  commands: 16,
  failures: 64,
  outputBytes: 32 * 1024 * 1024,
  rawCoverageFiles: 1024,
  rawCoverageFileBytes: 64 * 1024 * 1024,
  rawCoverageTotalBytes: 512 * 1024 * 1024,
  rawCoverageResults: 200000,
});
const COMMAND_TIMEOUTS = Object.freeze({
  install: 10 * 60 * 1000,
  typecheck: 5 * 60 * 1000,
  test: 20 * 60 * 1000,
  build: 10 * 60 * 1000,
  clean: 2 * 60 * 1000,
});
const GIT_COMMAND_TIMEOUT_MS = 30_000;
const TRUSTED_GIT_EXECUTABLE = "/usr/bin/git";
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "cat-file",
  "diff",
  "ls-tree",
  "rev-list",
  "rev-parse",
]);
const COMMAND_KILL_GRACE_MS = 1000;
const NPM_CI_ARGUMENTS = Object.freeze([
  "ci",
  "--ignore-scripts",
  "--registry=https://registry.npmjs.org/",
  "--replace-registry-host=never",
  "--strict-ssl=true",
]);
function signalIdentityTargets({
  pid,
  expectedStartTime,
  signal,
  readIdentity,
  sendSignal,
  removeTracked,
  markIdentityFailure,
  reportSignalFailure,
}) {
  for (const target of [-pid, pid]) {
    let identity;
    try {
      identity = readIdentity(pid);
    } catch (error) {
      markIdentityFailure();
      break;
    }
    if (
      !identity ||
      identity.state === "Z" ||
      identity.startTime !== expectedStartTime
    ) {
      removeTracked();
      break;
    }
    try {
      sendSignal(target, signal);
    } catch (error) {
      if (error.code !== "ESRCH") {
        reportSignalFailure();
      }
    }
  }
}
const COMMAND_SUBREAPER_BOOTSTRAP = String.raw`
import ctypes
import os
import sys

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(36, 1, 0, 0, 0) != 0:
    error_number = ctypes.get_errno()
    sys.stderr.write(
        "coverage command supervisor could not enable the Linux subreaper: "
        + os.strerror(error_number)
        + "\n"
    )
    raise SystemExit(127)

try:
    os.execv(sys.argv[1], sys.argv[1:])
except OSError:
    raise SystemExit(127)
`;
const COMMAND_SUPERVISOR_SOURCE = String.raw`
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const signalIdentityTargets = ${signalIdentityTargets.toString()};
const stoppedChildBootstrap = [
  "import os",
  "import signal",
  "import sys",
  "target_uid = int(sys.argv[1])",
  "target_gid = int(sys.argv[2])",
  "target_umask = int(sys.argv[3])",
  "if target_uid >= 0:",
  "    if os.getuid() != 0 or os.geteuid() != 0:",
  "        sys.stderr.write('coverage worker identity drop requires a root controller\\n')",
  "        raise SystemExit(127)",
  "    if target_uid == 0 or target_gid == 0:",
  "        sys.stderr.write('coverage worker identity must not be root\\n')",
  "        raise SystemExit(127)",
  "    import ctypes",
  "    libc = ctypes.CDLL(None, use_errno=True)",
  "    if libc.prctl(38, 1, 0, 0, 0) != 0:",
  "        sys.stderr.write('coverage worker could not set no_new_privs\\n')",
  "        raise SystemExit(127)",
  "    os.setgroups([])",
  "    os.setgid(target_gid)",
  "    os.setuid(target_uid)",
  "    os.umask(target_umask)",
  "    if (",
  "        os.getuid() != target_uid",
  "        or os.geteuid() != target_uid",
  "        or os.getgid() != target_gid",
  "        or os.getegid() != target_gid",
  "    ):",
  "        sys.stderr.write('coverage worker identity drop did not take effect\\n')",
  "        raise SystemExit(127)",
  "    if [group for group in os.getgroups() if group != target_gid]:",
  "        sys.stderr.write('coverage worker retained supplementary groups\\n')",
  "        raise SystemExit(127)",
  "    try:",
  "        os.setuid(0)",
  "        regained = True",
  "    except OSError:",
  "        regained = False",
  "    if regained:",
  "        sys.stderr.write('coverage worker regained uid 0\\n')",
  "        raise SystemExit(127)",
  "    try:",
  "        with open('/proc/self/status', 'r') as status_file:",
  "            status = status_file.read()",
  "    except OSError:",
  "        sys.stderr.write('coverage worker could not read /proc/self/status\\n')",
  "        raise SystemExit(127)",
  "    observed = {}",
  "    for line in status.splitlines():",
  "        parts = line.split()",
  "        if parts:",
  "            observed[parts[0].rstrip(':')] = parts[1:]",
  "    for field in ('CapEff', 'CapPrm', 'CapAmb'):",
  "        if field not in observed:",
  "            sys.stderr.write('coverage worker status is incomplete\\n')",
  "            raise SystemExit(127)",
  "        if int(observed[field][0], 16) != 0:",
  "            sys.stderr.write('coverage worker retained capabilities\\n')",
  "            raise SystemExit(127)",
  "    if observed.get('NoNewPrivs', ['0'])[0] != '1':",
  "        sys.stderr.write('coverage worker no_new_privs is not set\\n')",
  "        raise SystemExit(127)",
  "os.kill(os.getpid(), signal.SIGSTOP)",
  "try:",
  "    os.execvp(sys.argv[4], sys.argv[4:])",
  "except OSError:",
  "    raise SystemExit(127)",
].join("\n");
const localChildBootstrap = [
  'const fs = require("node:fs"); const { spawn } = require("node:child_process");',
  "if (fs.readSync(3, Buffer.alloc(1), 0, 1, null) !== 1) process.exit(127);",
  'const child = spawn(process.argv[1], process.argv.slice(2), { shell: false, stdio: ["ignore", "inherit", "inherit"] });',
  'child.once("error", () => process.exit(127));',
  'child.once("exit", (code, signal) => signal ? process.kill(process.pid, signal) : process.exit(Number.isInteger(code) ? code : 1));',
].join("\n");

const payload = JSON.parse(process.argv[1]);
if (
  !payload ||
  typeof payload.executable !== "string" ||
  !Array.isArray(payload.args) ||
  !Number.isSafeInteger(payload.timeoutMs) ||
  payload.timeoutMs < 1 ||
  !Number.isSafeInteger(payload.maxOutputBytes) ||
  payload.maxOutputBytes < 1 ||
  !Array.isArray(payload.inputFiles) ||
  !Array.isArray(payload.protectedRoots) ||
  !payload.protectedRoots.every((item) =>
    item &&
    typeof item === "object" &&
    path.isAbsolute(item.root) &&
    Array.isArray(item.allowedTopLevel) &&
    item.allowedTopLevel.every((value) => typeof value === "string")
  ) ||
  !(payload.watchRoot === null || path.isAbsolute(payload.watchRoot)) ||
  typeof payload.captureStdout !== "boolean" ||
  !(
    payload.identityReportPath === null ||
    (typeof payload.identityReportPath === "string" &&
      path.isAbsolute(payload.identityReportPath))
  ) ||
  !payload.childEnvironment ||
  typeof payload.childEnvironment !== "object" ||
  Array.isArray(payload.childEnvironment) ||
  Object.entries(payload.childEnvironment).some(
    ([name, value]) =>
      typeof name !== "string" ||
      name.length === 0 ||
      typeof value !== "string" ||
      /[\0\n\r]/.test(value)
  ) ||
  !payload.identity ||
  typeof payload.identity !== "object" ||
  !Number.isSafeInteger(payload.identity.uid) ||
  !Number.isSafeInteger(payload.identity.gid) ||
  !Number.isSafeInteger(payload.identity.umask) ||
  payload.identity.uid < -1 ||
  payload.identity.gid < -1 ||
  payload.identity.umask < 0 ||
  payload.identity.umask > 0o777 ||
  (payload.identity.uid >= 0) !== (payload.identity.gid >= 0) ||
  (payload.identity.uid === 0 || payload.identity.gid === 0)
) {
  console.error("coverage command supervisor received invalid input");
  process.exit(127);
}

if (payload.identity.uid >= 0 && process.platform !== "linux") {
  console.error("coverage command supervisor requires Linux to drop privileges");
  process.exit(127);
}

if (process.platform === "linux") {
  try {
    fs.accessSync("/proc/self/task/" + process.pid + "/children", fs.constants.R_OK);
  } catch (error) {
    console.error("coverage command supervisor requires readable Linux procfs");
    process.exit(127);
  }
}

const childOptions = {
  cwd: process.cwd(),
  env: { ...process.env, ...payload.childEnvironment },
  detached: true, shell: false,
  stdio: ["ignore", "pipe", "pipe"],
};
const child = process.platform === "linux"
  ? spawn(
    "/usr/bin/python3",
    [
      "-I", "-S", "-c", stoppedChildBootstrap,
      String(payload.identity.uid),
      String(payload.identity.gid),
      String(payload.identity.umask),
      payload.executable, ...payload.args,
    ],
    childOptions,
  )
  : spawn(process.execPath,
    ["-e", localChildBootstrap, payload.executable, ...payload.args],
    { ...childOptions, stdio: ["ignore", "pipe", "pipe", "pipe"] });
let trackedProcesses = new Map();
let originalChildIdentity = null;
let adoptedDescendantObserved = false;
let integrityFailed = false;
let terminationCode = null;
let forceKillTimer;
let processScan = null;
let childClosed = false;
let childExitRecorded = false;
let childCode = null;
let childSignal = null;
let forceKillComplete = false;
let cleanupStarted = false;
let containmentFailed = false;
const inputWatchers = [];
let outputBytes = 0;

const writeBoundedSupervisorError = (message) => {
  const bytes = Buffer.from(message + "\n", "utf8");
  const remaining = Math.max(payload.maxOutputBytes - outputBytes, 0);
  if (remaining > 0) {
    const emitted = bytes.subarray(0, remaining);
    process.stderr.write(emitted);
    outputBytes += emitted.length;
  }
};

const finalize = () => {
  if (!childClosed || (cleanupStarted && !forceKillComplete)) {
    return;
  }
  if (processScan !== null) {
    clearInterval(processScan);
  }
  clearTimeout(timeout);
  for (const watcher of inputWatchers) {
    watcher.close();
  }
  if (terminationCode !== null) {
    process.exitCode = terminationCode;
  } else if (
    (containmentFailed || integrityFailed || adoptedDescendantObserved) &&
    childCode === 0 &&
    childSignal === null
  ) {
    process.exitCode = 126;
  } else if (Number.isInteger(childCode)) {
    process.exitCode = childCode;
  } else {
    process.exitCode = childSignal ? 128 : 1;
  }
};

const readObservedIdentity = (pid) => {
  if (process.platform !== "linux") {
    return {
      source: "supervisor",
      uid: process.getuid(),
      euid: process.getuid(),
      gid: process.getgid(),
      egid: process.getgid(),
      groups: process.getgroups().sort((left, right) => left - right),
      noNewPrivs: null,
      capEff: null,
      capPrm: null,
      capAmb: null,
      capBnd: null,
      capInh: null,
    };
  }
  const status = fs.readFileSync("/proc/" + pid + "/status", "utf8");
  const fields = new Map();
  for (const line of status.split("\n")) {
    const parts = line.split(/\s+/).filter((value) => value.length > 0);
    if (parts.length > 0) {
      fields.set(parts[0].replace(/:$/, ""), parts.slice(1));
    }
  }
  const numeric = (name, index) => {
    const values = fields.get(name);
    if (!values || values.length <= index) {
      throw new Error("procfs status is missing " + name);
    }
    return Number(values[index]);
  };
  const capability = (name) => {
    const values = fields.get(name);
    if (!values || values.length === 0) {
      throw new Error("procfs status is missing " + name);
    }
    return values[0];
  };
  return {
    source: "proc",
    uid: numeric("Uid", 0),
    euid: numeric("Uid", 1),
    gid: numeric("Gid", 0),
    egid: numeric("Gid", 1),
    groups: (fields.get("Groups") || [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value))
      .sort((left, right) => left - right),
    noNewPrivs: numeric("NoNewPrivs", 0),
    capEff: capability("CapEff"),
    capPrm: capability("CapPrm"),
    capAmb: capability("CapAmb"),
    capBnd: capability("CapBnd"),
    capInh: capability("CapInh"),
  };
};

const reportObservedIdentity = (pid) => {
  if (payload.identityReportPath === null) {
    return true;
  }
  try {
    fs.writeFileSync(
      payload.identityReportPath,
      JSON.stringify(readObservedIdentity(pid)),
      { mode: 0o600 },
    );
    return true;
  } catch (error) {
    writeBoundedSupervisorError(
      "coverage command supervisor could not record the child identity",
    );
    return false;
  }
};

const readLinuxProcessIdentity = (pid) => {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const commandEnd = stat.lastIndexOf(")");
    const fields = commandEnd >= 0
      ? stat.slice(commandEnd + 2).trim().split(/\s+/)
      : [];
    const state = fields[0];
    const startTime = fields[19];
    if (!state || !startTime) {
      throw new Error("procfs returned a malformed process identity");
    }
    return { state, startTime };
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const refreshDescendants = () => {
  try {
    const discovered = new Map();
    const pending = [process.pid];
    const visited = new Set();
    while (pending.length > 0) {
      const parentPid = pending.pop();
      if (visited.has(parentPid)) {
        continue;
      }
      visited.add(parentPid);
      const isSupervisorParent = parentPid === process.pid;
      let children = "";
      try {
        children = fs.readFileSync(
          "/proc/" + parentPid + "/task/" + parentPid + "/children",
          "utf8",
        );
      } catch (error) {
        if (error.code === "ENOENT" && !isSupervisorParent) {
          continue;
        }
        throw error;
      }
      for (const token of children.trim().split(/\s+/)) {
        if (!token) {
          continue;
        }
        const pid = Number(token);
        if (!Number.isSafeInteger(pid) || pid <= 1) {
          if (isSupervisorParent) {
            adoptedDescendantObserved = true;
          }
          throw new Error("procfs returned an invalid child PID");
        }
        let identity;
        try {
          identity = readLinuxProcessIdentity(pid);
        } catch (error) {
          if (isSupervisorParent) {
            adoptedDescendantObserved = true;
          }
          throw error;
        }
        if (!identity) {
          if (isSupervisorParent) {
            adoptedDescendantObserved = true;
          }
          continue;
        }
        const isOriginalChild =
          originalChildIdentity !== null &&
          pid === originalChildIdentity.pid &&
          identity.startTime === originalChildIdentity.startTime;
        if (isSupervisorParent && !isOriginalChild) {
          adoptedDescendantObserved = true;
        }
        if (identity.state !== "Z") {
          discovered.set(pid, identity.startTime);
          pending.push(pid);
        }
      }
    }
    trackedProcesses = discovered;
    return true;
  } catch (error) {
    containmentFailed = true;
    return false;
  }
};

const signalCurrentTracked = (signal) => {
  const pids = [...trackedProcesses.keys()].sort((left, right) => right - left);
  for (const pid of pids) {
    signalIdentityTargets({
      pid,
      expectedStartTime: trackedProcesses.get(pid),
      signal,
      readIdentity: readLinuxProcessIdentity,
      sendSignal: process.kill.bind(process),
      removeTracked: () => {
        trackedProcesses.delete(pid);
      },
      markIdentityFailure: () => {
        containmentFailed = true;
      },
      reportSignalFailure: () => {
        writeBoundedSupervisorError(
          "coverage command supervisor could not terminate a tracked process",
        );
      },
    });
  }
};

const signalDetachedGroup = (signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      writeBoundedSupervisorError("coverage command supervisor could not terminate the detached process group");
    }
  }
};

const signalTracked = (signal) => {
  if (process.platform !== "linux") {
    signalDetachedGroup(signal);
    return;
  }
  refreshDescendants();
  signalCurrentTracked(signal);
};

const beginCleanup = (exitCode) => {
  if (cleanupStarted) {
    if (
      exitCode !== null &&
      terminationCode === null &&
      childExitRecorded &&
      childCode === 0 &&
      childSignal === null
    ) {
      terminationCode = exitCode;
    }
    return;
  }
  cleanupStarted = true;
  if (exitCode !== null) {
    terminationCode = exitCode;
  }
  signalTracked("SIGTERM");
  forceKillTimer = setTimeout(() => {
    if (process.platform !== "linux") {
      signalDetachedGroup("SIGKILL");
      forceKillComplete = true;
      finalize();
      return;
    }
    const drainDeadline = Date.now() + 2000;
    let emptyScans = 0;
    const drain = () => {
      const scanSucceeded = refreshDescendants();
      const liveDescendants = [...trackedProcesses.keys()].filter(
        (pid) => pid !== child.pid,
      );
      signalCurrentTracked("SIGKILL");
      emptyScans =
        scanSucceeded && liveDescendants.length === 0
          ? emptyScans + 1
          : 0;
      if (emptyScans >= 2) {
        forceKillComplete = true;
        finalize();
        return;
      }
      if (Date.now() >= drainDeadline) {
        containmentFailed = true;
        forceKillComplete = true;
        finalize();
        return;
      }
      forceKillTimer = setTimeout(drain, 25);
    };
    drain();
  }, ${COMMAND_KILL_GRACE_MS});
};

let timeout;

const reportInputMutation = () => {
  beginCleanup(126);
};

if (payload.watchRoot !== null) {
  try {
    for (const inputFile of payload.inputFiles) {
      if (!path.isAbsolute(inputFile)) {
        throw new Error("coverage command input path must be absolute");
      }
      const watcher = fs.watch(inputFile, reportInputMutation);
      watcher.on("error", reportInputMutation);
      inputWatchers.push(watcher);
    }
    const rootWatcher = fs.watch(
      payload.watchRoot,
      { recursive: true },
      (_eventType, filename) => {
        if (filename === null) {
          reportInputMutation();
          return;
        }
        const relative = String(filename).split(path.sep).join("/");
        const firstSegment = relative.split("/")[0];
        if (!["node_modules", "coverage", "build"].includes(firstSegment)) {
          reportInputMutation();
        }
      },
    );
    rootWatcher.on("error", reportInputMutation);
    inputWatchers.push(rootWatcher);
  } catch (error) {
    reportInputMutation();
  }
}
for (const protectedRoot of payload.protectedRoots) {
  try {
    const watcher = fs.watch(
      protectedRoot.root,
      { recursive: true },
      (_eventType, filename) => {
        if (filename === null) {
          reportInputMutation();
          return;
        }
        const firstSegment = String(filename)
          .split(path.sep)
          .join("/")
          .split("/")[0];
        if (!protectedRoot.allowedTopLevel.includes(firstSegment)) {
          reportInputMutation();
        }
      },
    );
    watcher.on("error", reportInputMutation);
    inputWatchers.push(watcher);
  } catch (error) {
    reportInputMutation();
  }
}
if (process.platform !== "linux" && !cleanupStarted) {
  child.stdio[3].end(Buffer.from([1]));
}

const forwardBounded = (stream, destination, enabled) => {
  stream.on("data", (chunk) => {
    const remaining = Math.max(payload.maxOutputBytes - outputBytes, 0);
    if (enabled && remaining > 0) {
      destination.write(chunk.subarray(0, remaining));
    }
    outputBytes += chunk.length;
    if (outputBytes > payload.maxOutputBytes) {
      beginCleanup(125);
    }
  });
};

forwardBounded(child.stdout, process.stdout, true);
forwardBounded(child.stderr, process.stderr, true);

child.once("error", (error) => {
  terminationCode = 127;
  clearTimeout(timeout);
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }
  forceKillComplete = true;
  writeBoundedSupervisorError(
    "coverage command supervisor failed to start child: " + error.message,
  );
});

const recordChildExit = (code, signal) => {
  if (childExitRecorded) {
    return;
  }
  childExitRecorded = true;
  childCode = code;
  childSignal = signal;
  const postExitScanSucceeded =
    process.platform !== "linux" || refreshDescendants();
  if (
    code === 0 &&
    signal === null &&
    (
      !postExitScanSucceeded ||
      adoptedDescendantObserved ||
      [...trackedProcesses].some(
        ([pid, startTime]) =>
          originalChildIdentity === null ||
          pid !== originalChildIdentity.pid ||
          startTime !== originalChildIdentity.startTime,
      )
    )
  ) {
    integrityFailed = true;
  }
  if (terminationCode === null) {
    clearTimeout(timeout);
    beginCleanup(null);
  }
};

child.once("exit", recordChildExit);

child.once("close", (code, signal) => {
  childClosed = true;
  recordChildExit(code, signal);
  finalize();
});

if (process.platform === "linux") {
  const stoppedDeadline = Date.now() + 5000;
  const waitArray = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < stoppedDeadline && originalChildIdentity === null) {
    let identity;
    try {
      identity = readLinuxProcessIdentity(child.pid);
    } catch (error) {
      break;
    }
    if (!identity) {
      break;
    }
    if (identity.state === "T") {
      originalChildIdentity = {
        pid: child.pid,
        startTime: identity.startTime,
      };
    } else {
      Atomics.wait(waitArray, 0, 0, 5);
    }
  }
  if (originalChildIdentity === null) {
    beginCleanup(127);
  } else if (!reportObservedIdentity(child.pid)) {
    beginCleanup(127);
  } else if (!cleanupStarted) {
    processScan = setInterval(refreshDescendants, 20);
    timeout = setTimeout(() => {
      beginCleanup(124);
    }, payload.timeoutMs);
    try {
      process.kill(-child.pid, "SIGCONT");
    } catch (error) {
      beginCleanup(127);
    }
  }
} else if (!cleanupStarted) {
  if (!reportObservedIdentity(child.pid)) {
    beginCleanup(127);
  } else {
    timeout = setTimeout(() => {
      beginCleanup(124);
    }, payload.timeoutMs);
  }
}
`;
const EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "status",
  "package",
  "repository",
  "workflow",
  "engine",
  "descriptor",
  "sources",
  "coverage",
  "tests",
  "locks",
  "toolchain",
  "commands",
  "reports",
  "execution",
  "failures",
]);

class CoverageMatrixError extends Error {
  constructor(message) {
    super(message);
    this.name = "CoverageMatrixError";
  }
}

function assertEnvironmentAllowlist(environment, expectedKeys, label) {
  const actual = Object.keys(environment).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      `${label} keys must be exactly ${expected.join(",")}; found ${actual.join(",")}`,
    );
  }
  for (const key of actual) {
    if (FORBIDDEN_ENVIRONMENT_PREFIX.test(key)) {
      fail(`${label} must not contain workflow-controlled variable ${key}`);
    }
    if (FORBIDDEN_ENVIRONMENT_NAMES.includes(key)) {
      fail(`${label} must not contain interpreter or proxy variable ${key}`);
    }
    if (key.toLowerCase().startsWith("npm_config_") && !expected.includes(key)) {
      fail(`${label} must not contain unpinned npm setting ${key}`);
    }
    const value = environment[key];
    if (typeof value !== "string" || /[\0\n\r]/.test(value)) {
      fail(`${label} value for ${key} is unsafe`);
    }
  }
  return environment;
}

function baseEnvironment({ home }) {
  const environment = Object.create(null);
  environment.PATH = "/usr/local/bin:/usr/bin:/bin";
  environment.HOME = home;
  environment.LANG = "C.UTF-8";
  environment.LC_ALL = "C.UTF-8";
  environment.TZ = "UTC";
  return environment;
}

function applyNpmEnvironment(environment, { cache, userConfig, globalConfig }) {
  environment.npm_config_ignore_scripts = "true";
  environment.npm_config_registry = "https://registry.npmjs.org/";
  environment.npm_config_replace_registry_host = "never";
  environment.npm_config_strict_ssl = "true";
  environment.npm_config_userconfig = userConfig;
  environment.npm_config_globalconfig = globalConfig;
  environment.npm_config_cache = cache;
  environment.npm_config_fund = "false";
  environment.npm_config_audit = "false";
  environment.npm_config_update_notifier = "false";
  return environment;
}

const NPM_ENVIRONMENT_KEYS = Object.freeze([
  "npm_config_ignore_scripts",
  "npm_config_registry",
  "npm_config_replace_registry_host",
  "npm_config_strict_ssl",
  "npm_config_userconfig",
  "npm_config_globalconfig",
  "npm_config_cache",
  "npm_config_fund",
  "npm_config_audit",
  "npm_config_update_notifier",
]);
const BASE_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
]);
const CONTROLLER_ENVIRONMENT_KEYS = Object.freeze([
  ...BASE_ENVIRONMENT_KEYS,
  ...NPM_ENVIRONMENT_KEYS,
]);

function buildCommandEnvironment(layout, role, options = {}) {
  if (!COMMAND_ROLES.includes(role)) {
    fail("command role must be controller or worker");
  }
  const label = `${role} environment`;
  const environment = applyNpmEnvironment(
    baseEnvironment({
      home: role === "worker" ? layout.workerHome : layout.controllerHome,
    }),
    role === "worker"
      ? {
        cache: layout.workerCache,
        userConfig: layout.workerUserConfig,
        globalConfig: layout.workerGlobalConfig,
      }
      : {
        cache: layout.controllerCache,
        userConfig: layout.controllerUserConfig,
        globalConfig: layout.controllerGlobalConfig,
      },
  );
  const expected = [...CONTROLLER_ENVIRONMENT_KEYS];
  if (options.rawSink === true) {
    environment.NODE_V8_COVERAGE = layout.raw;
    expected.push("NODE_V8_COVERAGE");
  }
  if (options.continuousIntegration === true) {
    environment.CI = "true";
    expected.push("CI");
  }
  if (options.buildPath === true) {
    environment.BUILD_PATH = "build";
    expected.push("BUILD_PATH");
  }
  const actual = Object.keys(environment).sort();
  const permitted = [...expected].sort();
  if (
    actual.length !== permitted.length ||
    actual.some((key, index) => key !== permitted[index])
  ) {
    fail(
      `${label} keys must be exactly ${permitted.join(",")}; found ${actual.join(",")}`,
    );
  }
  for (const key of actual) {
    if (FORBIDDEN_ENVIRONMENT_PREFIX.test(key)) {
      fail(`${label} must not contain workflow-controlled variable ${key}`);
    }
    if (
      FORBIDDEN_ENVIRONMENT_NAMES.includes(key) &&
      !(key === "NODE_V8_COVERAGE" && options.rawSink === true)
    ) {
      fail(`${label} must not contain interpreter or proxy variable ${key}`);
    }
    const value = environment[key];
    if (typeof value !== "string" || /[\0\n\r]/.test(value)) {
      fail(`${label} value for ${key} is unsafe`);
    }
  }
  return environment;
}

function controllerEnvironment(layout, options = {}) {
  return buildCommandEnvironment(layout, "controller", options);
}

function workerEnvironment(layout, options = {}) {
  return buildCommandEnvironment(layout, "worker", options);
}

function sanitizedGitEnvironment(layout) {
  const environment = baseEnvironment({
    home: layout && layout.controllerHome ? layout.controllerHome : os.tmpdir(),
  });
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = os.devNull;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_SYSTEM = os.devNull;
  environment.GIT_EXTERNAL_DIFF = "";
  environment.GIT_LITERAL_PATHSPECS = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_PAGER = "";
  environment.GIT_TERMINAL_PROMPT = "0";
  return assertEnvironmentAllowlist(
    environment,
    [
      ...BASE_ENVIRONMENT_KEYS,
      "GIT_ATTR_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_SYSTEM",
      "GIT_EXTERNAL_DIFF",
      "GIT_LITERAL_PATHSPECS",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OPTIONAL_LOCKS",
      "GIT_PAGER",
      "GIT_TERMINAL_PROMPT",
    ],
    "git environment",
  );
}

function assertSafeNodeStartupEnvironment() {
  for (const name of [
    "EXPERIMENTAL_MONOCART",
    "NODE_EXTRA_CA_CERTS",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NODE_REPL_EXTERNAL_MODULE",
    "NODE_V8_COVERAGE",
  ]) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      fail(`${name} must be unset before starting the trusted coverage engine`);
    }
  }
}

function emitSafeLine(value) {
  assertPlainObject(value, "structured output");
  const keys = Object.keys(value);
  if (keys.length === 0) {
    fail("structured output must contain at least one field");
  }
  for (const key of keys) {
    if (!SAFE_STDOUT_KEYS.includes(key)) {
      fail(`structured output field ${key} is not permitted`);
    }
  }
  const serialized = JSON.stringify(value, (key, item) => {
    if (typeof item === "string") {
      if (!SAFE_STDOUT_TEXT_PATTERN.test(item)) {
        fail("structured output contains control or non-ASCII characters");
      }
      if (item.includes("::") || item.includes("##[")) {
        fail("structured output must not contain a workflow command");
      }
    }
    return item;
  });
  if (typeof serialized !== "string" || !SAFE_STDOUT_TEXT_PATTERN.test(serialized)) {
    fail("structured output is not printable ASCII");
  }
  if (serialized.includes("::") || serialized.includes("##[")) {
    fail("structured output must not contain a workflow command");
  }
  process.stdout.write(`${serialized}\n`);
  return serialized;
}

function fail(message) {
  throw new CoverageMatrixError(message);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) {
    fail(`${label} must be an object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  assertPlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      `${label} fields must be exactly ${expected.join(",")}; found ${actual.join(",")}`,
    );
  }
}

function assertInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
}

function assertSha(value, label) {
  if (typeof value !== "string" || !SHA_PATTERN.test(value)) {
    fail(`${label} must be a complete lowercase 40-character Git SHA`);
  }
}

function assertPositiveIntegerString(value, label) {
  if (typeof value !== "string" || !POSITIVE_INTEGER_PATTERN.test(value)) {
    fail(`${label} must be a positive decimal string`);
  }
}

function readBoundedFile(filePath, maximumBytes, label) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    fail(`${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`${label} must be a regular file`);
  }
  if (stat.size > maximumBytes) {
    fail(`${label} exceeds ${maximumBytes} bytes`);
  }
  return fs.readFileSync(filePath);
}

function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`);
  }
}

function readJsonFile(filePath, maximumBytes, label) {
  return parseJsonBytes(readBoundedFile(filePath, maximumBytes, label), label);
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath, maximumBytes, label) {
  return sha256Bytes(readBoundedFile(filePath, maximumBytes, label));
}

function normalizeRepoPath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty repository-relative path`);
  }
  if (
    Buffer.byteLength(value, "utf8") > LIMITS.pathBytes ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes("\u2028") ||
    value.includes("\u2029") ||
    /[\x00-\x1f\x7f]/.test(value) ||
    /^[A-Za-z]:/.test(value) ||
    path.posix.isAbsolute(value) ||
    !SAFE_PATH_PATTERN.test(value)
  ) {
    fail(`${label} is unsafe`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.includes("/./") ||
    value.split("/").some((part) => part.length === 0)
  ) {
    fail(`${label} is not canonical`);
  }
  return normalized;
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail(`${label} contains non-UTF-8 data`);
  }
}

function assertSortedUniquePaths(values, label, maximum = LIMITS.sourceFilesPerEntry) {
  if (!Array.isArray(values)) {
    fail(`${label} must be an array`);
  }
  if (values.length > maximum) {
    fail(`${label} exceeds ${maximum} entries`);
  }
  const seen = new Set();
  const collisionKeys = new Map();
  let previous = null;
  for (const value of values) {
    const normalized = normalizeRepoPath(value, `${label} entry`);
    if (seen.has(normalized)) {
      fail(`${label} contains duplicate path ${normalized}`);
    }
    if (previous !== null && previous >= normalized) {
      fail(`${label} must be strictly lexicographically sorted`);
    }
    const collisionKey = normalized.normalize("NFC").toLowerCase();
    const prior = collisionKeys.get(collisionKey);
    if (prior !== undefined && prior !== normalized) {
      fail(`${label} contains case or normalization collision: ${prior} and ${normalized}`);
    }
    collisionKeys.set(collisionKey, normalized);
    seen.add(normalized);
    previous = normalized;
  }
  return values;
}

function assertPathSet(values, label, maximum = LIMITS.sourceFilesPerEntry) {
  const sorted = [...values].sort();
  assertSortedUniquePaths(sorted, label, maximum);
  return sorted;
}

let gitAccessSealed = false;

function sealGitAccess() {
  gitAccessSealed = true;
}

function runGit(repoRoot, args, options = {}) {
  if (gitAccessSealed) {
    fail("Git access is sealed after package execution begins");
  }
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    !ALLOWED_GIT_SUBCOMMANDS.has(args[0])
  ) {
    fail("Git command is outside the read-only allowlist");
  }
  const canonicalRoot = fs.realpathSync(repoRoot);
  const result = spawnSync(TRUSTED_GIT_EXECUTABLE, [
    "--no-pager",
    "--no-replace-objects",
    "-c",
    "safe.directory=",
    "-c",
    `safe.directory=${canonicalRoot}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "core.excludesFile=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "diff.external=",
    ...args,
  ], {
    cwd: canonicalRoot,
    env: sanitizedGitEnvironment(),
    encoding: options.binary ? null : "utf8",
    shell: false,
    maxBuffer: options.maxBuffer || LIMITS.outputBytes,
    timeout: GIT_COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  if (result.error) {
    if (result.error.code === "ENOBUFS") {
      fail(`git ${args[0]} output exceeds the configured bound`);
    }
    if (result.error.code === "ETIMEDOUT") {
      fail(`git ${args[0]} timed out`);
    }
    fail(`git ${args[0]} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr || "";
    fail(`git ${args[0]} failed: ${stderr.trim() || `exit ${result.status}`}`);
  }
  return result.stdout;
}

function resolveRepositoryRoot(root) {
  const resolved = fs.realpathSync(path.resolve(root || process.cwd()));
  const gitRoot = fs.realpathSync(
    runGit(resolved, ["rev-parse", "--show-toplevel"]).trim(),
  );
  if (gitRoot !== resolved) {
    fail("repository root must be the Git worktree root");
  }
  return resolved;
}

function gitObjectType(repoRoot, object) {
  return runGit(repoRoot, ["cat-file", "-t", object]).trim();
}

function requireCommit(repoRoot, sha, label) {
  assertSha(sha, label);
  if (gitObjectType(repoRoot, sha) !== "commit") {
    fail(`${label} does not identify a commit`);
  }
}

function resolveCommit(repoRoot, reference, label) {
  if (typeof reference !== "string" || reference.length === 0) {
    fail(`${label} must be a non-empty Git reference`);
  }
  const sha = runGit(repoRoot, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${reference}^{commit}`,
  ]).trim();
  assertSha(sha, label);
  return sha;
}

function gitBlobAt(repoRoot, commitSha, repoPath, label) {
  const safePath = normalizeRepoPath(repoPath, label);
  const object = runGit(repoRoot, ["rev-parse", `${commitSha}:${safePath}`]).trim();
  assertSha(object, `${label} blob`);
  if (gitObjectType(repoRoot, object) !== "blob") {
    fail(`${label} is not a blob at ${commitSha}`);
  }
  return object;
}

function gitBytesAt(repoRoot, commitSha, repoPath, maximumBytes, label) {
  const object = gitBlobAt(repoRoot, commitSha, repoPath, label);
  const bytes = runGit(repoRoot, ["cat-file", "blob", object], {
    binary: true,
    maxBuffer: maximumBytes + 1,
  });
  if (bytes.length > maximumBytes) {
    fail(`${label} exceeds ${maximumBytes} bytes`);
  }
  return { bytes, object };
}

function gitHashFile(repoRoot, filePath, label) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(fs.realpathSync(repoRoot), absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} resolves outside the repository`);
  }
  const bytes = fs.readFileSync(absolute);
  return gitBlobHash(bytes);
}

function gitBlobHash(bytes) {
  const hash = crypto.createHash("sha1");
  hash.update(`blob ${bytes.length}\0`);
  hash.update(bytes);
  return hash.digest("hex");
}

function ensureRegularInRoot(repoRoot, repoPath, label) {
  const safePath = normalizeRepoPath(repoPath, label);
  const canonicalRoot = fs.realpathSync(repoRoot);
  const absolute = path.join(canonicalRoot, ...safePath.split("/"));
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular file`);
  }
  const real = fs.realpathSync(absolute);
  const relative = path.relative(canonicalRoot, real);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} resolves outside the repository`);
  }
  return absolute;
}

function ensureSafeMutationPath(repoRoot, repoPath, label) {
  const safePath = normalizeRepoPath(repoPath, label);
  const canonicalRoot = fs.realpathSync(repoRoot);
  const parts = safePath.split("/");
  let current = canonicalRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === "ENOENT") {
        break;
      }
      fail(`${label} could not be inspected`);
    }
    if (stat.isSymbolicLink()) {
      fail(`${label} contains symlinked path component ${parts[index]}`);
    }
    if (index < parts.length - 1 && !stat.isDirectory()) {
      fail(`${label} contains a non-directory ancestor ${parts[index]}`);
    }
    const real = fs.realpathSync(current);
    const relative = path.relative(canonicalRoot, real);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      fail(`${label} resolves outside the repository`);
    }
  }
  return path.join(canonicalRoot, ...parts);
}

function writeFileSafely(filePath, bytes, label) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    const existing = fs.lstatSync(filePath);
    if (
      existing.isSymbolicLink() ||
      !existing.isFile() ||
      existing.nlink !== 1
    ) {
      fail(`${label} destination must be a non-hardlinked regular file`);
    }
  } catch (error) {
    if (error instanceof CoverageMatrixError) {
      throw error;
    }
    if (error.code !== "ENOENT") {
      fail(`${label} destination could not be inspected`);
    }
  }
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function hashDirectoryTree(repoRoot, repoPath, label, options = {}) {
  const directory = ensureSafeMutationPath(repoRoot, repoPath, label);
  let rootStat;
  try {
    rootStat = fs.lstatSync(directory);
  } catch (error) {
    fail(`${label} is missing`);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`${label} must be a regular directory`);
  }
  const hash = crypto.createHash("sha256");
  const pending = [directory];
  let fileCount = 0;
  let byteCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(directory, absolute).split(path.sep).join("/");
      const firstSegment = relative.split("/")[0];
      if ((options.excludeTopLevel || []).includes(firstSegment)) {
        continue;
      }
      if (entry.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        pending.push(absolute);
        continue;
      }
      fileCount += 1;
      if (fileCount > LIMITS.toolFiles) {
        fail(`${label} exceeds ${LIMITS.toolFiles} files`);
      }
      if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(absolute);
        const real = fs.realpathSync(absolute);
        const realRelative = path.relative(directory, real);
        if (
          realRelative === ".." ||
          realRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(realRelative)
        ) {
          fail(`${label} contains an out-of-root symlink`);
        }
        hash.update(`L\0${relative}\0${link}\0`);
        continue;
      }
      if (!entry.isFile()) {
        fail(`${label} contains unsupported filesystem entry ${relative}`);
      }
      const stat = fs.lstatSync(absolute);
      byteCount += stat.size;
      if (byteCount > LIMITS.toolBytes) {
        fail(`${label} exceeds ${LIMITS.toolBytes} bytes`);
      }
      hash.update(`F\0${relative}\0${stat.mode & 0o111}\0`);
      hash.update(fs.readFileSync(absolute));
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function parseLsTree(bytes, label) {
  const chunks = decodeUtf8(bytes, label).split("\0");
  if (chunks[chunks.length - 1] === "") {
    chunks.pop();
  }
  const entries = [];
  for (const chunk of chunks) {
    const match =
      /^([0-7]{6}) ([a-z]+) ([0-9a-f]{40}) +([0-9-]+)\t(.+)$/.exec(
        chunk,
      );
    if (!match) {
      fail(`${label} returned a malformed Git tree entry`);
    }
    const [, mode, type, object, sizeText, repoPath] = match;
    const size = sizeText === "-" ? null : Number(sizeText);
    if (
      size !== null &&
      (!Number.isSafeInteger(size) || size < 0)
    ) {
      fail(`${label} returned an invalid Git blob size`);
    }
    entries.push({
      mode,
      type,
      object,
      size,
      path: normalizeRepoPath(repoPath, `${label} path`),
    });
  }
  return entries;
}

function listTreeEntries(repoRoot, treeish, repoPath) {
  const args = ["ls-tree", "-r", "-z", "-l", "--full-tree", treeish];
  if (repoPath) {
    args.push("--", normalizeRepoPath(repoPath, "Git tree path"));
  }
  return parseLsTree(
    runGit(repoRoot, args, { binary: true, maxBuffer: LIMITS.outputBytes }),
    "git ls-tree",
  );
}

function validateDescriptorObject(descriptor) {
  assertExactKeys(
    descriptor,
    ["schemaVersion", "runtime", "thresholds", "entries"],
    "descriptor",
  );
  if (descriptor.schemaVersion !== DESCRIPTOR_SCHEMA_VERSION) {
    fail(`descriptor schemaVersion must equal ${DESCRIPTOR_SCHEMA_VERSION}`);
  }
  assertExactKeys(descriptor.runtime, ["node"], "descriptor.runtime");
  if (descriptor.runtime.node !== REQUIRED_NODE_VERSION) {
    fail(`descriptor runtime.node must equal ${REQUIRED_NODE_VERSION}`);
  }
  assertExactKeys(
    descriptor.thresholds,
    ["lines", "branches"],
    "descriptor.thresholds",
  );
  for (const metric of ["lines", "branches"]) {
    assertInteger(descriptor.thresholds[metric], `descriptor.thresholds.${metric}`);
    if (descriptor.thresholds[metric] !== REQUIRED_THRESHOLDS[metric]) {
      fail(
        `descriptor.thresholds.${metric} must equal ${REQUIRED_THRESHOLDS[metric]}`,
      );
    }
  }
  if (!Array.isArray(descriptor.entries) || descriptor.entries.length === 0) {
    fail("descriptor.entries must contain at least one entry");
  }
  if (descriptor.entries.length > LIMITS.entries) {
    fail(`descriptor.entries exceeds ${LIMITS.entries} entries`);
  }
  const ids = [];
  const seen = new Set();
  for (const [index, entry] of descriptor.entries.entries()) {
    assertExactKeys(entry, ["id", "profile"], `descriptor.entries[${index}]`);
    if (typeof entry.id !== "string" || !SAFE_ID_PATTERN.test(entry.id)) {
      fail(`descriptor.entries[${index}].id is unsafe`);
    }
    if (seen.has(entry.id)) {
      fail(`descriptor.entries contains duplicate id ${entry.id}`);
    }
    if (!PROFILE_NAMES.has(entry.profile)) {
      fail(`descriptor.entries[${index}].profile is unknown`);
    }
    const requiredProfile = CURRENT_PROFILE_REQUIREMENTS[entry.id];
    if (requiredProfile && entry.profile !== requiredProfile) {
      fail(`${entry.id} must use profile ${requiredProfile}`);
    }
    if (ids.length > 0 && ids[ids.length - 1] >= entry.id) {
      fail("descriptor.entries must be strictly lexicographically sorted");
    }
    seen.add(entry.id);
    ids.push(entry.id);
  }
  return descriptor;
}

function readDescriptor(repoRoot, descriptorPath = DESCRIPTOR_PATH) {
  const safePath = normalizeRepoPath(descriptorPath, "descriptor path");
  if (safePath !== DESCRIPTOR_PATH) {
    fail(`descriptor path must equal ${DESCRIPTOR_PATH}`);
  }
  const absolute = ensureRegularInRoot(repoRoot, safePath, "descriptor");
  return validateDescriptorObject(
    readJsonFile(absolute, LIMITS.descriptorBytes, "descriptor"),
  );
}

function assertNoCoverageManifestKeys(manifest, label) {
  if (!isPlainObject(manifest)) {
    return manifest;
  }
  for (const key of FORBIDDEN_COVERAGE_MANIFEST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(manifest, key)) {
      fail(`${label} must not declare a ${key} coverage configuration key`);
    }
  }
  return manifest;
}

function assertNoCoverageConfigurationFiles(repoRoot, trackedPaths, directories) {
  for (const directory of directories) {
    for (const name of FORBIDDEN_COVERAGE_CONFIG_FILES) {
      const repoPath = directory === "" ? name : `${directory}/${name}`;
      if (
        trackedPaths.has(repoPath) ||
        fs.existsSync(path.join(repoRoot, ...repoPath.split("/")))
      ) {
        fail(`repository coverage tool configuration is forbidden: ${repoPath}`);
      }
    }
  }
  return true;
}

function validateToolPackage(repoRoot) {
  const packageJson = readJsonFile(
    ensureRegularInRoot(repoRoot, TOOL_PACKAGE_PATH, "coverage tool package"),
    LIMITS.descriptorBytes,
    "coverage tool package",
  );
  assertExactKeys(
    packageJson,
    ["name", "version", "private", "engines", "devDependencies"],
    "coverage tool package",
  );
  assertNoCoverageManifestKeys(packageJson, "coverage tool package");
  assertExactKeys(packageJson.engines, ["node"], "coverage tool package engines");
  assertExactKeys(
    packageJson.devDependencies,
    ["c8"],
    "coverage tool package devDependencies",
  );
  if (
    packageJson.name !== "@betstan/coverage-tooling" ||
    packageJson.version !== "1.0.0" ||
    packageJson.private !== true ||
    packageJson.engines.node !== REQUIRED_NODE_VERSION ||
    packageJson.devDependencies.c8 !== "12.0.0"
  ) {
    fail("coverage tool package contract is invalid");
  }
  const lock = readJsonFile(
    ensureRegularInRoot(repoRoot, TOOL_LOCK_PATH, "coverage tool lock"),
    LIMITS.reportBytes,
    "coverage tool lock",
  );
  if (
    lock.name !== packageJson.name ||
    lock.version !== packageJson.version ||
    lock.lockfileVersion !== 3 ||
    lock.requires !== true ||
    !isPlainObject(lock.packages) ||
    !isPlainObject(lock.packages[""]) ||
    lock.packages[""].name !== packageJson.name ||
    lock.packages[""].version !== packageJson.version ||
    lock.packages[""].engines?.node !== REQUIRED_NODE_VERSION ||
    lock.packages[""].devDependencies?.c8 !== "12.0.0" ||
    lock.packages["node_modules/c8"]?.version !== "12.0.0"
  ) {
    fail("coverage tool lock contract is invalid");
  }
  validateRegistryLock(lock, "coverage tool lock");
  validateCriticalPackage(packageJson, lock, "c8", {
    name: "c8",
    path: "bin/c8.js",
  });
  return { packageJson, lock };
}

function discoverPackageInventory(repoRoot, treeish) {
  requireCommit(repoRoot, treeish, "package inventory treeish");
  const entries = listTreeEntries(repoRoot, treeish);
  const modes = new Map(entries.map((entry) => [entry.path, entry.mode]));
  const topLevel = new Set();
  for (const entry of entries) {
    const [id, ...rest] = entry.path.split("/");
    if (
      rest.length === 1 &&
      (rest[0] === "package.json" || rest[0] === "package-lock.json")
    ) {
      if (!SAFE_ID_PATTERN.test(id)) {
        fail(`top-level package directory id is unsafe: ${id}`);
      }
      topLevel.add(id);
    }
  }
  const inventory = [];
  for (const id of [...topLevel].sort()) {
    const manifest = `${id}/package.json`;
    const lock = `${id}/package-lock.json`;
    const hasManifest = modes.has(manifest);
    const hasLock = modes.has(lock);
    if (hasManifest !== hasLock) {
      fail(`${id} must contain both package.json and package-lock.json`);
    }
    if (hasManifest) {
      if (modes.get(manifest) === "120000" || modes.get(lock) === "120000") {
        fail(`${id} package metadata must not be symlinked`);
      }
      inventory.push(id);
    }
  }
  return inventory;
}

function lockPackageName(lockPath, record) {
  if (typeof record.name === "string") {
    return record.name;
  }
  const tail = lockPath.split("node_modules/").pop();
  const parts = tail.split("/");
  return parts[0].startsWith("@")
    ? parts.slice(0, 2).join("/")
    : parts[0];
}

function validateRegistryLock(lock, label) {
  assertPlainObject(lock.packages, `${label}.packages`);
  for (const [lockPath, record] of Object.entries(lock.packages)) {
    if (lockPath === "") {
      continue;
    }
    assertPlainObject(record, `${label} record ${lockPath}`);
    if (record.link === true) {
      fail(`${label} contains linked package ${lockPath}`);
    }
    if (
      typeof record.version !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.version)
    ) {
      fail(`${label} package ${lockPath} has an invalid version`);
    }
    const packageName = lockPackageName(lockPath, record);
    const basename = packageName.split("/").pop();
    const expectedResolved =
      `https://registry.npmjs.org/${packageName}/-/` +
      `${basename}-${record.version}.tgz`;
    if (record.resolved !== expectedResolved) {
      fail(`${label} package ${lockPath} is not bound to its canonical npm artifact`);
    }
    if (
      typeof record.integrity !== "string" ||
      !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(record.integrity)
    ) {
      fail(`${label} package ${lockPath} lacks SHA-512 integrity`);
    }
  }
}

function validateCriticalPackage(
  manifest,
  lock,
  packageName,
  expectedBin,
  allowedBinProviders = [packageName],
) {
  const specifications = {
    ...(isPlainObject(manifest.dependencies) ? manifest.dependencies : {}),
    ...(isPlainObject(manifest.devDependencies) ? manifest.devDependencies : {}),
  };
  const specification = specifications[packageName];
  if (
    typeof specification !== "string" ||
    !/^[~^]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specification)
  ) {
    fail(`${manifest.name} must use a registry semver specification for ${packageName}`);
  }
  const record = lock.packages[`node_modules/${packageName}`];
  if (
    !isPlainObject(record) ||
    lockPackageName(`node_modules/${packageName}`, record) !== packageName
  ) {
    fail(`${manifest.name} lock does not preserve ${packageName} package identity`);
  }
  if (expectedBin) {
    if (
      !isPlainObject(record.bin) ||
      record.bin[expectedBin.name] !== expectedBin.path
    ) {
      fail(`${manifest.name} lock has an invalid ${expectedBin.name} executable`);
    }
    const allowedProviderPaths = new Set(
      allowedBinProviders.map((provider) => `node_modules/${provider}`),
    );
    for (const [lockPath, candidate] of Object.entries(lock.packages)) {
      if (
        isPlainObject(candidate) &&
        isPlainObject(candidate.bin) &&
        Object.prototype.hasOwnProperty.call(candidate.bin, expectedBin.name)
      ) {
        const providerName = lockPath.startsWith("node_modules/")
          ? lockPath.slice("node_modules/".length)
          : "";
        if (
          !allowedProviderPaths.has(lockPath) ||
          lockPackageName(lockPath, candidate) !== providerName ||
          candidate.bin[expectedBin.name] !== expectedBin.path
        ) {
          fail(
            `${manifest.name} lock contains invalid ${expectedBin.name} provider ${lockPath}`,
          );
        }
      }
    }
  }
}

function criticalBinsForEntry(entry) {
  if (entry.profile === "jest-typescript") {
    return [
      { name: "jest", packageName: "jest", target: "bin/jest.js" },
      { name: "tsc", packageName: "typescript", target: "bin/tsc" },
    ];
  }
  if (entry.profile === "react-scripts") {
    return [
      {
        name: "react-scripts",
        packageName: "react-scripts",
        target: "bin/react-scripts.js",
      },
    ];
  }
  return [
    { name: "tsc", packageName: "typescript", target: "bin/tsc" },
    { name: "del", packageName: "del-cli", target: "cli.js" },
  ];
}

function validateInstalledBins(repoRoot, nodeModulesPath, bins, label) {
  const nodeModules = ensureSafeMutationPath(
    repoRoot,
    nodeModulesPath,
    label,
  );
  for (const bin of bins) {
    const executable = path.join(nodeModules, ".bin", bin.name);
    let stat;
    try {
      stat = fs.lstatSync(executable);
    } catch (error) {
      fail(`${label} is missing ${bin.name}`);
    }
    if (!stat.isSymbolicLink()) {
      fail(`${label} executable ${bin.name} must be a symlink`);
    }
    const expected = path.join(
      nodeModules,
      bin.packageName,
      ...bin.target.split("/"),
    );
    if (fs.realpathSync(executable) !== fs.realpathSync(expected)) {
      fail(`${label} executable ${bin.name} has the wrong owner`);
    }
  }
}

function snapshotInstalledToolchain(repoRoot, nodeModulesPath, bins, label, options) {
  validateInstalledBins(repoRoot, nodeModulesPath, bins, label);
  return hashDirectoryTree(repoRoot, nodeModulesPath, label, options);
}

function validateProfileManifest(repoRoot, treeish, entry) {
  const manifestPath = `${entry.id}/package.json`;
  const lockPath = `${entry.id}/package-lock.json`;
  const manifestResult = gitBytesAt(
    repoRoot,
    treeish,
    manifestPath,
    LIMITS.descriptorBytes,
    `${entry.id} package manifest`,
  );
  const lockResult = gitBytesAt(
    repoRoot,
    treeish,
    lockPath,
    LIMITS.reportBytes,
    `${entry.id} package lock`,
  );
  const manifest = parseJsonBytes(
    manifestResult.bytes,
    `${entry.id} package manifest`,
  );
  const lock = parseJsonBytes(lockResult.bytes, `${entry.id} package lock`);
  assertPlainObject(manifest, `${entry.id} package manifest`);
  assertPlainObject(lock, `${entry.id} package lock`);
  assertNoCoverageManifestKeys(manifest, `${entry.id} package manifest`);
  const scripts = isPlainObject(manifest.scripts) ? manifest.scripts : {};
  for (const hook of [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "preclean",
    "postclean",
    "pretest",
    "posttest",
    "prebuild",
    "postbuild",
  ]) {
    if (Object.prototype.hasOwnProperty.call(scripts, hook)) {
      fail(`${entry.id} package manifest contains forbidden lifecycle hook ${hook}`);
    }
  }
  const packages = lock.packages;
  if (!isPlainObject(packages) || !isPlainObject(packages[""])) {
    fail(`${entry.id} package lock must contain a root package`);
  }
  const rootLock = packages[""];
  if (manifest.name !== rootLock.name || manifest.version !== rootLock.version) {
    fail(`${entry.id} manifest and lock root identity differ`);
  }
  validateRegistryLock(lock, `${entry.id} package lock`);
  const dependencies = {
    ...(isPlainObject(manifest.dependencies) ? manifest.dependencies : {}),
    ...(isPlainObject(manifest.devDependencies) ? manifest.devDependencies : {}),
  };
  const forbiddenJestConfigNames = new Set([
    "jest.config.js",
    "jest.config.cjs",
    "jest.config.mjs",
    "jest.config.ts",
    "jest.config.json",
  ]);
  const packageTree = listTreeEntries(repoRoot, treeish, entry.id);
  for (const item of packageTree) {
    if (forbiddenJestConfigNames.has(path.posix.basename(item.path))) {
      fail(`${entry.id} must not use a standalone Jest configuration file`);
    }
  }
  if (entry.profile === "jest-typescript") {
    if (
      typeof dependencies.jest !== "string" ||
      typeof dependencies["ts-jest"] !== "string" ||
      typeof dependencies.typescript !== "string"
    ) {
      fail(`${entry.id} jest-typescript profile dependencies are incomplete`);
    }
    validateCriticalPackage(manifest, lock, "jest", {
      name: "jest",
      path: "bin/jest.js",
    }, ["jest", "jest-cli"]);
    validateCriticalPackage(manifest, lock, "ts-jest");
    validateCriticalPackage(manifest, lock, "typescript", {
      name: "tsc",
      path: "bin/tsc",
    });
    assertExactKeys(
      manifest.jest,
      ["preset", "testEnvironment", "setupFilesAfterEnv"],
      `${entry.id} Jest configuration`,
    );
    if (
      manifest.jest.preset !== "ts-jest" ||
      manifest.jest.testEnvironment !== "node" ||
      JSON.stringify(manifest.jest.setupFilesAfterEnv) !==
        JSON.stringify(["./src/test/setup.ts"])
    ) {
      fail(`${entry.id} Jest configuration must use the fixed repository profile`);
    }
    gitBlobAt(repoRoot, treeish, `${entry.id}/tsconfig.json`, `${entry.id} tsconfig`);
  } else if (entry.profile === "react-scripts") {
    if (
      typeof dependencies["react-scripts"] !== "string" ||
      !isPlainObject(manifest.scripts) ||
      typeof manifest.scripts.test !== "string" ||
      typeof manifest.scripts.build !== "string"
    ) {
      fail(`${entry.id} react-scripts profile dependencies are incomplete`);
    }
    validateCriticalPackage(manifest, lock, "react-scripts", {
      name: "react-scripts",
      path: "bin/react-scripts.js",
    });
    if (Object.prototype.hasOwnProperty.call(manifest, "jest")) {
      fail(`${entry.id} react-scripts profile must not override Jest configuration`);
    }
  } else if (entry.profile === "node-typescript-c8") {
    if (
      typeof dependencies.typescript !== "string" ||
      typeof dependencies["del-cli"] !== "string" ||
      !isPlainObject(manifest.scripts) ||
      manifest.scripts.clean !== "del ./build/*"
    ) {
      fail(`${entry.id} node-typescript-c8 profile dependencies or clean command are invalid`);
    }
    validateCriticalPackage(manifest, lock, "typescript", {
      name: "tsc",
      path: "bin/tsc",
    });
    validateCriticalPackage(manifest, lock, "del-cli", {
      name: "del",
      path: "cli.js",
    });
    for (const requiredPath of [
      `${entry.id}/tsconfig.json`,
      `${entry.id}/tsconfig.test.json`,
      `${entry.id}/tsconfig.legacy-amqp.json`,
    ]) {
      gitBlobAt(repoRoot, treeish, requiredPath, `${entry.id} c8 profile input`);
    }
    const tests = listTreeEntries(repoRoot, treeish, `${entry.id}/tests`)
      .filter((item) => item.mode !== "120000")
      .map((item) => item.path)
      .filter((item) => item.endsWith(".test.js"));
    if (tests.length === 0) {
      fail(`${entry.id} node-typescript-c8 profile has no tracked Node tests`);
    }
  }
  return { manifest, lock };
}

function sourceExtensionsForProfile(profile) {
  return profile === "react-scripts" ? new Set([".js", ".jsx"]) : new Set([".ts", ".tsx"]);
}

function isTestSourcePath(entry, repoPath) {
  const basename = path.posix.basename(repoPath);
  const extension = path.posix.extname(basename);
  const allowedExtensions =
    entry.profile === "node-typescript-c8" &&
    repoPath.startsWith(`${entry.id}/tests/`)
      ? new Set([".js"])
      : sourceExtensionsForProfile(entry.profile);
  if (!allowedExtensions.has(extension)) {
    return false;
  }
  const stem = basename.slice(0, -extension.length);
  const segments = repoPath.split("/");
  return (
    segments.includes("__tests__") ||
    basename.includes(".test.") ||
    basename.includes(".spec.") ||
    stem === "test" ||
    stem === "spec"
  );
}

function isEligibleSourcePath(entry, repoPath) {
  const prefix = `${entry.id}/src/`;
  if (!repoPath.startsWith(prefix)) {
    return false;
  }
  const relative = repoPath.slice(prefix.length);
  const segments = relative.split("/");
  const excludedSegments = new Set([
    "__test__",
    "__tests__",
    "test",
    "tests",
    "__mocks__",
  ]);
  if (segments.some((segment) => excludedSegments.has(segment))) {
    return false;
  }
  const basename = segments[segments.length - 1];
  if (
    basename.endsWith(".d.ts") ||
    isTestSourcePath(entry, repoPath)
  ) {
    return false;
  }
  return sourceExtensionsForProfile(entry.profile).has(path.posix.extname(basename));
}

function deriveEligibleSources(repoRoot, treeish, entry, options = {}) {
  const sourceRoot = `${entry.id}/src`;
  const rootEntry = parseLsTree(
    runGit(repoRoot, ["ls-tree", "-z", "-l", treeish, "--", sourceRoot], {
      binary: true,
    }),
    `${entry.id} source root`,
  );
  if (rootEntry.length === 0 && options.allowMissing === true) {
    return [];
  }
  if (
    rootEntry.length !== 1 ||
    rootEntry[0].path !== sourceRoot ||
    rootEntry[0].type !== "tree" ||
    rootEntry[0].mode !== "040000"
  ) {
    fail(`${entry.id} source root is missing or not a regular Git tree`);
  }
  const treeEntries = listTreeEntries(repoRoot, treeish, sourceRoot);
  for (const item of treeEntries) {
    if (item.mode === "120000") {
      fail(`${entry.id} source tree contains symlink ${item.path}`);
    }
    if (item.type !== "blob" || !["100644", "100755"].includes(item.mode)) {
      fail(`${entry.id} source tree contains unsupported entry ${item.path}`);
    }
  }
  const eligible = treeEntries
    .map((item) => item.path)
    .filter((item) => isEligibleSourcePath(entry, item))
    .sort();
  assertSortedUniquePaths(eligible, `${entry.id} eligible sources`);
  if (eligible.length === 0) {
    fail(`${entry.id} has zero eligible source files`);
  }
  for (const repoPath of eligible) {
    const { bytes } = gitBytesAt(
      repoRoot,
      treeish,
      repoPath,
      LIMITS.sourceFileBytes,
      `${entry.id} eligible source`,
    );
    if (
      /(?:\/\*+|\/\/)\s*(?:istanbul|c8)\s+ignore\b/i.test(
        decodeUtf8(bytes, `${entry.id} eligible source`),
      )
    ) {
      fail(`${entry.id} eligible source contains a forbidden coverage-ignore directive`);
    }
  }
  return eligible;
}

function derivePackageInputSnapshot(repoRoot, treeish, entry) {
  const entries = listTreeEntries(repoRoot, treeish, entry.id);
  if (entries.length > LIMITS.packageInputFilesPerEntry) {
    fail(
      `${entry.id} package inputs exceed ${LIMITS.packageInputFilesPerEntry} files`,
    );
  }
  const inputs = [];
  const records = new Map();
  let totalBytes = 0;
  for (const item of entries) {
    if (item.mode === "120000") {
      fail(`${entry.id} package input is symlinked: ${item.path}`);
    }
    if (
      item.type !== "blob" ||
      !["100644", "100755"].includes(item.mode) ||
      !Number.isSafeInteger(item.size)
    ) {
      fail(`${entry.id} package input is unsupported: ${item.path}`);
    }
    totalBytes += item.size;
    if (totalBytes > LIMITS.toolBytes) {
      fail(`${entry.id} package inputs exceed ${LIMITS.toolBytes} bytes`);
    }
    inputs.push(item.path);
    records.set(item.path, {
      path: item.path,
      gitBlob: item.object,
      gitMode: item.mode,
      byteLength: item.size,
    });
  }
  const paths = assertPathSet(
    inputs,
    `${entry.id} package inputs`,
    LIMITS.packageInputFilesPerEntry,
  );
  return {
    paths,
    records: paths.map((repoPath) => records.get(repoPath)),
  };
}

function derivePackageInputs(repoRoot, treeish, entry) {
  return derivePackageInputSnapshot(repoRoot, treeish, entry).paths;
}

function deriveTestFiles(repoRoot, treeish, entry) {
  const roots =
    entry.profile === "node-typescript-c8"
      ? [`${entry.id}/tests`]
      : [`${entry.id}/src`];
  const extensions =
    entry.profile === "react-scripts"
      ? new Set([".js", ".jsx"])
      : entry.profile === "node-typescript-c8"
        ? new Set([".js"])
        : new Set([".ts", ".tsx"]);
  const tests = roots.flatMap((root) =>
    listTreeEntries(repoRoot, treeish, root)
      .filter((item) => item.type === "blob" && item.mode !== "120000")
      .map((item) => item.path)
      .filter((repoPath) =>
        extensions.has(path.posix.extname(repoPath)) &&
        isTestSourcePath(entry, repoPath)
      ),
  ).sort();
  assertSortedUniquePaths(tests, `${entry.id} test files`);
  if (tests.length === 0) {
    fail(`${entry.id} has zero tracked test files`);
  }
  return tests;
}

function deriveWorkingTestFiles(repoRoot, entry) {
  const roots =
    entry.profile === "node-typescript-c8"
      ? [`${entry.id}/tests`]
      : [`${entry.id}/src`];
  const extensions =
    entry.profile === "react-scripts"
      ? new Set([".js", ".jsx"])
      : entry.profile === "node-typescript-c8"
        ? new Set([".js"])
        : new Set([".ts", ".tsx"]);
  const tests = [];
  for (const root of roots) {
    const absoluteRoot = path.join(repoRoot, ...root.split("/"));
    const pending = [absoluteRoot];
    while (pending.length > 0) {
      const current = pending.pop();
      for (const entryValue of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, entryValue.name);
        if (entryValue.isSymbolicLink()) {
          fail(`${entry.id} working test tree contains a symlink`);
        }
        if (entryValue.isDirectory()) {
          pending.push(absolute);
          continue;
        }
        if (!entryValue.isFile()) {
          fail(`${entry.id} working test tree contains an unsupported entry`);
        }
        const repoPath = normalizeRepoPath(
          path.relative(repoRoot, absolute).split(path.sep).join("/"),
          `${entry.id} working test path`,
        );
        if (
          extensions.has(path.extname(entryValue.name)) &&
          isTestSourcePath(entry, repoPath)
        ) {
          tests.push(repoPath);
        }
      }
    }
  }
  const sorted = assertPathSet(tests, `${entry.id} working test files`);
  if (sorted.length === 0) {
    fail(`${entry.id} has zero working test files`);
  }
  return sorted;
}

function generatedRootsForEntry(entry) {
  const roots = new Set(["coverage", "node_modules"]);
  if (
    entry.profile === "node-typescript-c8" ||
    entry.profile === "react-scripts"
  ) {
    roots.add("build");
  }
  return roots;
}

function rejectUnexpectedPackageFiles(repoRoot, entry, packageInputs) {
  const expected = new Set(
    assertPathSet(
      packageInputs,
      `${entry.id} expected package inputs`,
      LIMITS.packageInputFilesPerEntry,
    ),
  );
  const generatedRoots = generatedRootsForEntry(entry);
  for (const repoPath of expected) {
    const relative = relativeFromPackage(entry.id, repoPath);
    if (generatedRoots.has(relative.split("/")[0])) {
      fail(`${entry.id} tracked input is inside a generated root: ${repoPath}`);
    }
  }

  const packageRoot = ensureSafeMutationPath(
    repoRoot,
    entry.id,
    `${entry.id} package root`,
  );
  const rootStat = fs.lstatSync(packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail(`${entry.id} package root must be a regular directory`);
  }
  const pending = [{ absolute: packageRoot, depth: 0 }];
  const startedAt = Date.now();
  let entriesSeen = 0;
  while (pending.length > 0) {
    if (Date.now() - startedAt > GIT_COMMAND_TIMEOUT_MS) {
      fail(`${entry.id} package input inventory timed out`);
    }
    const current = pending.pop();
    const entries = fs
      .readdirSync(current.absolute, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const item of entries) {
      entriesSeen += 1;
      if (entriesSeen > LIMITS.packageInputFilesPerEntry) {
        fail(
          `${entry.id} package input inventory exceeds ${LIMITS.packageInputFilesPerEntry} entries`,
        );
      }
      const absolute = path.join(current.absolute, item.name);
      const relative = path
        .relative(packageRoot, absolute)
        .split(path.sep)
        .join("/");
      const repoPath = normalizeRepoPath(
        `${entry.id}/${relative}`,
        `${entry.id} package input path`,
      );
      const firstSegment = relative.split("/")[0];
      if (current.depth === 0 && generatedRoots.has(firstSegment)) {
        if (item.isSymbolicLink() || !item.isDirectory()) {
          fail(
            `${entry.id} generated root must be a regular directory: ${repoPath}`,
          );
        }
        continue;
      }
      if (item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) {
        fail(`${entry.id} contains unsupported command input ${repoPath}`);
      }
      if (item.isDirectory()) {
        if (current.depth >= 64) {
          fail(`${entry.id} package input inventory is too deep`);
        }
        pending.push({ absolute, depth: current.depth + 1 });
        continue;
      }
      if (!expected.has(repoPath)) {
        fail(`${entry.id} contains untracked or ignored command input ${repoPath}`);
      }
    }
  }
}

function validateNoForbiddenTelemetryWorkflow(repoRoot, treeish) {
  const entries = listTreeEntries(repoRoot, treeish, ".github/workflows");
  const workflows = entries.filter((entry) =>
    entry.path.startsWith(".github/workflows/"),
  );
  if (workflows.length > LIMITS.workflowFiles) {
    fail(`workflow inventory exceeds ${LIMITS.workflowFiles} files`);
  }
  for (const entry of workflows) {
    if (entry.mode === "120000") {
      fail(`workflow must not be a symlink: ${entry.path}`);
    }
    const basename = path.posix.basename(entry.path).normalize("NFC").toLowerCase();
    if (FORBIDDEN_WORKFLOW_FILES.has(basename)) {
      fail(`forbidden tests-telemetry workflow file: ${entry.path}`);
    }
    if (!basename.endsWith(".yml") && !basename.endsWith(".yaml")) {
      continue;
    }
    const result = gitBytesAt(
      repoRoot,
      treeish,
      entry.path,
      LIMITS.workflowBytes,
      `workflow ${entry.path}`,
    );
    const text = result.bytes.toString("utf8");
    if (
      /^\s*name\s*:\s*(?:"tests-telemetry"|'tests-telemetry'|tests-telemetry)\s*(?:#.*)?$/imu.test(
        text,
      )
    ) {
      fail(`forbidden tests-telemetry workflow name: ${entry.path}`);
    }
  }
}

function validateRepository(repoRoot, options = {}) {
  if (runGit(repoRoot, ["rev-parse", "--show-object-format"]).trim() !== "sha1") {
    fail("coverage evidence requires a SHA-1 Git object format");
  }
  const treeish = resolveCommit(
    repoRoot,
    options.treeish || "HEAD",
    "validation treeish",
  );
  const descriptor = readDescriptor(repoRoot, options.descriptorPath);
  validateToolPackage(repoRoot);
  const npmConfigurationPaths = [
    ".npmrc",
    ".github/coverage/.npmrc",
    ...descriptor.entries.map((entry) => `${entry.id}/.npmrc`),
  ];
  const trackedPaths = new Set(
    listTreeEntries(repoRoot, treeish).map((item) => item.path),
  );
  for (const npmConfigPath of npmConfigurationPaths) {
    if (
      trackedPaths.has(npmConfigPath) ||
      fs.existsSync(path.join(repoRoot, ...npmConfigPath.split("/")))
    ) {
      fail(`repository npm configuration is forbidden: ${npmConfigPath}`);
    }
  }
  assertNoCoverageConfigurationFiles(repoRoot, trackedPaths, [
    "",
    ".github/coverage",
    ...descriptor.entries.map((entry) => entry.id),
  ]);
  const inventory = discoverPackageInventory(repoRoot, treeish);
  const ids = descriptor.entries.map((entry) => entry.id);
  if (
    ids.length !== inventory.length ||
    ids.some((id, index) => id !== inventory[index])
  ) {
    fail(
      `descriptor/package inventory mismatch: descriptor=${ids.join(",")} inventory=${inventory.join(",")}`,
    );
  }
  const entries = descriptor.entries.map((entry) => {
    validateProfileManifest(repoRoot, treeish, entry);
    return {
      ...entry,
      eligible: deriveEligibleSources(repoRoot, treeish, entry),
      testFiles: deriveTestFiles(repoRoot, treeish, entry),
    };
  });
  validateNoForbiddenTelemetryWorkflow(repoRoot, treeish);
  return { descriptor, inventory, entries };
}

function parseDiffNameStatus(bytes) {
  const chunks = decodeUtf8(bytes, "Git diff").split("\0");
  if (chunks[chunks.length - 1] === "") {
    chunks.pop();
  }
  const changes = [];
  for (let index = 0; index < chunks.length; ) {
    const status = chunks[index++];
    if (!/^(?:A|C[0-9]{1,3}|M|R[0-9]{1,3}|D)$/.test(status)) {
      fail(`Git diff contains unsupported status ${status}`);
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      if (index + 1 >= chunks.length) {
        fail("Git diff rename/copy record is incomplete");
      }
      changes.push({
        status: status[0],
        oldPath: normalizeRepoPath(chunks[index++], "Git diff old path"),
        newPath: normalizeRepoPath(chunks[index++], "Git diff new path"),
      });
    } else {
      if (index >= chunks.length) {
        fail("Git diff record is incomplete");
      }
      const repoPath = normalizeRepoPath(chunks[index++], "Git diff path");
      changes.push({
        status,
        oldPath: status === "D" ? repoPath : null,
        newPath: status === "D" ? null : repoPath,
      });
    }
  }
  return changes;
}

function deriveChangedSources(repoRoot, baseSha, headSha, entry, eligible) {
  requireCommit(repoRoot, baseSha, "base SHA");
  requireCommit(repoRoot, headSha, "head SHA");
  const baseEligible = new Set(
    deriveEligibleSources(repoRoot, baseSha, entry, { allowMissing: true }),
  );
  const headEligible = new Set(eligible);
  const diff = parseDiffNameStatus(
    runGit(
      repoRoot,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "-z",
        "--find-renames",
        "--find-copies",
        baseSha,
        headSha,
        "--",
        `${entry.id}/src`,
      ],
      { binary: true, maxBuffer: LIMITS.outputBytes },
    ),
  );
  const changed = new Set();
  const deleted = new Set();
  for (const item of diff) {
    if (item.newPath && headEligible.has(item.newPath)) {
      changed.add(item.newPath);
    }
    if (
      item.oldPath &&
      (item.status === "D" || item.status === "R") &&
      baseEligible.has(item.oldPath)
    ) {
      deleted.add(item.oldPath);
    }
  }
  return {
    changedEligible: assertPathSet(changed, `${entry.id} changed eligible sources`),
    deletedEligible: assertPathSet(deleted, `${entry.id} deleted eligible sources`),
  };
}

function validateRunContext(repoRoot, context) {
  const contextKeys = ["schemaVersion", "repository", "workflow", "engine"];
  if (isPlainObject(context) && Object.prototype.hasOwnProperty.call(context, "container")) {
    contextKeys.push("container");
  }
  assertExactKeys(context, contextKeys, "run context");
  if (context.schemaVersion !== RUN_CONTEXT_SCHEMA_VERSION) {
    fail(`run context schemaVersion must equal ${RUN_CONTEXT_SCHEMA_VERSION}`);
  }
  if (contextKeys.includes("container")) {
    assertExactKeys(context.container, ["imageDigest"], "run context container");
    if (
      typeof context.container.imageDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(context.container.imageDigest)
    ) {
      fail("run context container.imageDigest must be a sha256 image digest");
    }
  }
  assertExactKeys(
    context.repository,
    [
      "name",
      "event",
      "baseSha",
      "headSha",
      "mergeSnapshotSha",
      "checkoutSha",
      "runId",
      "runAttempt",
    ],
    "run context repository",
  );
  if (context.repository.name !== CANONICAL_REPOSITORY) {
    fail(`run context repository.name must equal ${CANONICAL_REPOSITORY}`);
  }
  if (!["pull_request", "push"].includes(context.repository.event)) {
    fail("run context repository.event must be pull_request or push");
  }
  for (const field of ["baseSha", "headSha", "checkoutSha"]) {
    assertSha(context.repository[field], `run context repository.${field}`);
    requireCommit(
      repoRoot,
      context.repository[field],
      `run context repository.${field}`,
    );
  }
  assertPositiveIntegerString(context.repository.runId, "run context repository.runId");
  assertInteger(
    context.repository.runAttempt,
    "run context repository.runAttempt",
    1,
  );
  assertExactKeys(
    context.workflow,
    ["id", "path", "blob", "runHeadSha"],
    "run context workflow",
  );
  assertPositiveIntegerString(context.workflow.id, "run context workflow.id");
  if (context.workflow.path !== WORKFLOW_PATH) {
    fail(`run context workflow.path must equal ${WORKFLOW_PATH}`);
  }
  assertSha(context.workflow.blob, "run context workflow.blob");
  assertSha(context.workflow.runHeadSha, "run context workflow.runHeadSha");
  assertExactKeys(
    context.engine,
    ["trustedDefaultSha"],
    "run context engine",
  );
  assertSha(context.engine.trustedDefaultSha, "run context engine.trustedDefaultSha");
  requireCommit(
    repoRoot,
    context.engine.trustedDefaultSha,
    "run context engine.trustedDefaultSha",
  );

  if (context.repository.event === "pull_request") {
    assertSha(
      context.repository.mergeSnapshotSha,
      "run context repository.mergeSnapshotSha",
    );
    requireCommit(
      repoRoot,
      context.repository.mergeSnapshotSha,
      "run context repository.mergeSnapshotSha",
    );
    if (
      context.repository.mergeSnapshotSha === context.repository.baseSha ||
      context.repository.mergeSnapshotSha === context.repository.headSha
    ) {
      fail("PR merge snapshot must differ from base and head");
    }
    if (context.repository.checkoutSha !== context.repository.mergeSnapshotSha) {
      fail("PR checkout SHA must equal the merge snapshot SHA");
    }
    const parentLine = runGit(repoRoot, [
      "rev-list",
      "--parents",
      "-n",
      "1",
      context.repository.mergeSnapshotSha,
    ])
      .trim()
      .split(/\s+/);
    if (
      parentLine.length !== 3 ||
      parentLine[1] !== context.repository.baseSha ||
      parentLine[2] !== context.repository.headSha
    ) {
      fail("PR merge snapshot must have exactly base then head as its two parents");
    }
  } else {
    if (context.repository.mergeSnapshotSha !== null) {
      fail("push evidence must set mergeSnapshotSha to null");
    }
    if (context.repository.checkoutSha !== context.repository.headSha) {
      fail("push checkout SHA must equal head SHA");
    }
  }
  if (context.workflow.runHeadSha !== context.repository.checkoutSha) {
    fail("workflow run head SHA must equal checkout SHA");
  }
  const workflowBlob = gitBlobAt(
    repoRoot,
    context.repository.checkoutSha,
    WORKFLOW_PATH,
    "workflow",
  );
  if (workflowBlob !== context.workflow.blob) {
    fail("workflow blob does not match the exact checkout snapshot");
  }
  return context;
}

function verifyTrustedAssets(repoRoot, trustedRoot, context) {
  const trusted = resolveRepositoryRoot(trustedRoot);
  const trustedSha = context.engine.trustedDefaultSha;
  const result = { root: trusted };
  for (const [key, repoPath, maximumBytes] of [
    ["validator", ENGINE_PATH, LIMITS.reportBytes],
    ["toolPackage", TOOL_PACKAGE_PATH, LIMITS.descriptorBytes],
    ["toolLock", TOOL_LOCK_PATH, LIMITS.reportBytes],
    ["descriptor", DESCRIPTOR_PATH, LIMITS.descriptorBytes],
  ]) {
    const candidatePath = ensureRegularInRoot(repoRoot, repoPath, `candidate ${repoPath}`);
    const trustedPath = ensureRegularInRoot(trusted, repoPath, `trusted ${repoPath}`);
    const candidateBytes = readBoundedFile(candidatePath, maximumBytes, `candidate ${repoPath}`);
    const trustedBytes = readBoundedFile(trustedPath, maximumBytes, `trusted ${repoPath}`);
    if (!candidateBytes.equals(trustedBytes)) {
      fail(`candidate ${repoPath} differs from the trusted default copy`);
    }
    const expectedBlob = gitBlobAt(trusted, trustedSha, repoPath, `trusted ${repoPath}`);
    const trustedBlob = gitHashFile(trusted, trustedPath, `trusted ${repoPath}`);
    const candidateBlob = gitHashFile(repoRoot, candidatePath, `candidate ${repoPath}`);
    if (trustedBlob !== expectedBlob || candidateBlob !== expectedBlob) {
      fail(`${repoPath} Git blob does not match trusted default`);
    }
    const headBlob = gitBlobAt(
      repoRoot,
      context.repository.headSha,
      repoPath,
      `candidate head ${repoPath}`,
    );
    const checkoutBlob = gitBlobAt(
      repoRoot,
      context.repository.checkoutSha,
      repoPath,
      `candidate checkout ${repoPath}`,
    );
    if (headBlob !== expectedBlob || checkoutBlob !== expectedBlob) {
      fail(`${repoPath} differs across trusted, head, or checkout snapshots`);
    }
    result[key] = {
      gitBlob: expectedBlob,
      sha256: sha256Bytes(trustedBytes),
    };
  }
  return result;
}

function hashStableRegularFile(
  absolute,
  expectedByteLength,
  label,
  algorithm,
  prefix = "",
) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      fail(`${label} must be a non-hardlinked regular file`);
    }
    if (before.size !== BigInt(expectedByteLength)) {
      fail(`${label} differs from its immutable snapshot`);
    }
    const hash = crypto.createHash(algorithm);
    hash.update(prefix);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < expectedByteLength) {
      const read = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, expectedByteLength - position),
        position,
      );
      if (read <= 0) {
        fail(`${label} changed while it was being verified`);
      }
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathStat = fs.lstatSync(absolute, { bigint: true });
    if (
      !pathStat.isFile() ||
      pathStat.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      after.dev !== pathStat.dev ||
      after.ino !== pathStat.ino ||
      after.size !== pathStat.size ||
      after.mtimeNs !== pathStat.mtimeNs ||
      after.ctimeNs !== pathStat.ctimeNs
    ) {
      fail(`${label} changed while it was being verified`);
    }
    return {
      digest: hash.digest("hex"),
      executable: (Number(after.mode) & 0o111) !== 0,
    };
  } catch (error) {
    if (error instanceof CoverageMatrixError) {
      throw error;
    }
    fail(`${label} could not be verified safely`);
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

function hashStablePackageInput(repoRoot, record, entry) {
  assertExactKeys(
    record,
    ["path", "gitBlob", "gitMode", "byteLength"],
    `${entry.id} package input snapshot`,
  );
  const repoPath = normalizeRepoPath(
    record.path,
    `${entry.id} package input snapshot path`,
  );
  relativeFromPackage(entry.id, repoPath);
  assertSha(record.gitBlob, `${repoPath} Git blob`);
  if (!["100644", "100755"].includes(record.gitMode)) {
    fail(`${repoPath} Git mode is unsupported`);
  }
  assertInteger(record.byteLength, `${repoPath} byte length`);
  const absolute = ensureRegularInRoot(repoRoot, repoPath, repoPath);
  const result = hashStableRegularFile(
    absolute,
    record.byteLength,
    repoPath,
    "sha1",
    `blob ${record.byteLength}\0`,
  );
  if ((record.gitMode === "100755") !== result.executable) {
    fail(`${repoPath} executable mode differs from the exact checkout snapshot`);
  }
  return result.digest;
}

function captureProtectedFile(repoRoot, repoPath, maximumBytes, label) {
  const safePath = normalizeRepoPath(repoPath, label);
  const absolute = ensureRegularInRoot(repoRoot, safePath, label);
  const stat = fs.lstatSync(absolute);
  if (stat.size > maximumBytes) {
    fail(`${label} exceeds ${maximumBytes} bytes`);
  }
  const result = hashStableRegularFile(
    absolute,
    stat.size,
    label,
    "sha256",
  );
  return {
    root: fs.realpathSync(repoRoot),
    path: safePath,
    byteLength: stat.size,
    executable: result.executable,
    sha256: result.digest,
  };
}

function verifyProtectedFile(snapshot, label) {
  assertExactKeys(
    snapshot,
    ["root", "path", "byteLength", "executable", "sha256"],
    label,
  );
  if (
    typeof snapshot.root !== "string" ||
    typeof snapshot.executable !== "boolean" ||
    typeof snapshot.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(snapshot.sha256)
  ) {
    fail(`${label} is invalid`);
  }
  assertInteger(snapshot.byteLength, `${label} byte length`);
  const absolute = ensureRegularInRoot(
    snapshot.root,
    snapshot.path,
    label,
  );
  const result = hashStableRegularFile(
    absolute,
    snapshot.byteLength,
    label,
    "sha256",
  );
  if (
    result.digest !== snapshot.sha256 ||
    result.executable !== snapshot.executable
  ) {
    fail(`${label} differs from its immutable snapshot`);
  }
}

function ensurePackageSnapshot(repoRoot, packageInputSnapshot, entry) {
  if (
    !packageInputSnapshot ||
    !Array.isArray(packageInputSnapshot.paths) ||
    !Array.isArray(packageInputSnapshot.records)
  ) {
    fail(`${entry.id} package input snapshot is invalid`);
  }
  assertEvidenceIdentity(
    packageInputSnapshot.paths,
    packageInputSnapshot.records.map((record) => record.path),
    `${entry.id} package input snapshot paths`,
  );
  for (const record of packageInputSnapshot.records) {
    const actual = hashStablePackageInput(repoRoot, record, entry);
    if (actual !== record.gitBlob) {
      fail(`${record.path} differs from the exact checkout snapshot`);
    }
  }
}

function verifyExecutionFilesystemState(
  repoRoot,
  entry,
  packageInputSnapshot,
  protectedFileSnapshots,
) {
  ensurePackageSnapshot(
    repoRoot,
    packageInputSnapshot,
    entry,
  );
  rejectUnexpectedPackageFiles(
    repoRoot,
    entry,
    packageInputSnapshot.paths,
  );
  if (!Array.isArray(protectedFileSnapshots)) {
    fail("prepared protected input snapshots are invalid");
  }
  for (const [index, snapshot] of protectedFileSnapshots.entries()) {
    verifyProtectedFile(snapshot, `protected input ${index}`);
  }
}

function verifyPreparedFilesystemState(repoRoot, prepared) {
  verifyExecutionFilesystemState(
    repoRoot,
    prepared.entry,
    prepared.packageInputSnapshot,
    prepared.protectedFileSnapshots,
  );
}

function relativeFromPackage(entryId, repoPath) {
  const prefix = `${entryId}/`;
  if (!repoPath.startsWith(prefix)) {
    fail(`${repoPath} is not inside package ${entryId}`);
  }
  return repoPath.slice(prefix.length);
}

function mapSourceToBuild(entryId, repoPath) {
  const relative = relativeFromPackage(entryId, repoPath);
  const extension = path.posix.extname(relative);
  if (![".ts", ".tsx"].includes(extension)) {
    fail(`cannot map non-TypeScript source to build output: ${repoPath}`);
  }
  return `build/${relative.slice(4, -extension.length)}.js`;
}

function assertControlledDirectory(absolute, label, expectation) {
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a regular directory`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    fail(`${label} must use mode 0700`);
  }
  if (
    typeof expectation.uid === "number" &&
    stat.uid !== expectation.uid
  ) {
    fail(`${label} must be owned by uid ${expectation.uid}`);
  }
  if (
    typeof expectation.gid === "number" &&
    stat.gid !== expectation.gid
  ) {
    fail(`${label} must be owned by gid ${expectation.gid}`);
  }
  if (expectation.notUid !== undefined && stat.uid === expectation.notUid) {
    fail(`${label} must not be owned by uid ${expectation.notUid}`);
  }
  if (fs.realpathSync(absolute) !== absolute) {
    fail(`${label} must not contain a symlinked path component`);
  }
  return stat;
}

function assertEmptyDirectory(absolute, label) {
  const entries = fs.readdirSync(absolute);
  if (entries.length !== 0) {
    fail(
      `${label} must be empty before the run: found ${entries.sort().join(",")}; ` +
        "each attempt requires a fresh container because controlled roots are " +
        "never reused",
    );
  }
}

function createControlledDirectory(absolute, label, owner) {
  fs.mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (owner && process.getuid && process.getuid() === CONTROLLER_UID) {
    fs.chownSync(absolute, owner.uid, owner.gid);
  }
  fs.chmodSync(absolute, 0o700);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${label} must be a regular directory`);
  }
  return absolute;
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

function releaseExecutionLayout(layout) {
  if (!layout || !layout.temporaryRoot) {
    return;
  }
  try {
    fs.rmSync(layout.temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    restoreWritablePermissions(layout.temporaryRoot);
    fs.rmSync(layout.temporaryRoot, { recursive: true, force: true });
  }
}

function clearDirectoryContents(absolute) {
  let entries;
  try {
    entries = fs.readdirSync(absolute);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  for (const name of entries) {
    fs.rmSync(path.join(absolute, name), { recursive: true, force: true });
  }
}

function resetControlledDirectory(absolute, label, owner) {
  clearDirectoryContents(absolute);
  createControlledDirectory(absolute, label, owner);
  assertEmptyDirectory(absolute, label);
  return absolute;
}

function parseCapabilityMask(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{1,16}$/.test(value)) {
    fail(`${label} must be a hexadecimal capability mask`);
  }
  return BigInt(`0x${value}`);
}

function assertControllerCapabilityContract(identity, label) {
  const expected = parseCapabilityMask(
    CONTROLLER_CAPABILITY_MASK,
    "controller capability contract",
  );
  for (const field of ["capEff", "capPrm", "capBnd"]) {
    const actual = parseCapabilityMask(identity[field], `${label}.${field}`);
    if (actual !== expected) {
      fail(
        `${label}.${field} must equal exactly ${CONTROLLER_CAPABILITY_MASK} ` +
          `(${CONTROLLER_CAPABILITY_NAMES.join(",")}); found ${identity[field]}`,
      );
    }
  }
  for (const field of ["capAmb", "capInh"]) {
    if (parseCapabilityMask(identity[field], `${label}.${field}`) !== 0n) {
      fail(`${label}.${field} must be empty; found ${identity[field]}`);
    }
  }
  return identity;
}

function readProcessIdentityFromProc(pid = "self") {
  let status;
  try {
    status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  } catch (error) {
    fail(`/proc/${pid}/status must be readable to verify execution identity`);
  }
  const fields = new Map();
  for (const line of status.split("\n")) {
    const parts = line.split(/\s+/).filter((value) => value.length > 0);
    if (parts.length > 0) {
      fields.set(parts[0].replace(/:$/, ""), parts.slice(1));
    }
  }
  const numeric = (name, index) => {
    const values = fields.get(name);
    if (!values || values.length <= index) {
      fail(`/proc/${pid}/status is missing ${name}`);
    }
    return Number(values[index]);
  };
  const capability = (name) => {
    const values = fields.get(name);
    if (!values || values.length === 0) {
      fail(`/proc/${pid}/status is missing ${name}`);
    }
    return values[0].toLowerCase();
  };
  return {
    source: "proc",
    uid: numeric("Uid", 0),
    euid: numeric("Uid", 1),
    gid: numeric("Gid", 0),
    egid: numeric("Gid", 1),
    supplementaryGroups: (fields.get("Groups") || [])
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value)),
    noNewPrivs: numeric("NoNewPrivs", 0),
    capEff: capability("CapEff"),
    capPrm: capability("CapPrm"),
    capAmb: capability("CapAmb"),
    capBnd: capability("CapBnd"),
    capInh: capability("CapInh"),
  };
}

function assertAuthoritativeContainer(layout) {
  if (process.platform !== "linux") {
    fail("authoritative coverage execution requires Linux process containment");
  }
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function" ||
    process.getuid() !== CONTROLLER_UID ||
    process.getgid() !== CONTROLLER_GID
  ) {
    fail("authoritative coverage execution requires a root controller identity");
  }
  if (process.env[CONTAINER_MARKER_VARIABLE] !== "1") {
    fail(
      `authoritative coverage execution requires ${CONTAINER_MARKER_VARIABLE}=1`,
    );
  }
  const controllerIdentity = readProcessIdentityFromProc("self");
  if (
    controllerIdentity.uid !== CONTROLLER_UID ||
    controllerIdentity.euid !== CONTROLLER_UID ||
    controllerIdentity.gid !== CONTROLLER_GID ||
    controllerIdentity.egid !== CONTROLLER_GID
  ) {
    fail("authoritative coverage execution requires a root controller identity");
  }
  assertControllerCapabilityContract(
    controllerIdentity,
    "authoritative controller identity",
  );
  for (const forbidden of FORBIDDEN_CONTAINER_PATHS) {
    if (fs.existsSync(forbidden)) {
      fail(`authoritative coverage execution forbids host path ${forbidden}`);
    }
  }
  for (const name of GITHUB_COMMAND_CHANNEL_VARIABLES) {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      fail(`authoritative coverage execution forbids workflow command channel ${name}`);
    }
  }
  for (const name of Object.keys(process.env)) {
    if (name === CONTAINER_MARKER_VARIABLE) {
      continue;
    }
    if (FORBIDDEN_ENVIRONMENT_PREFIX.test(name)) {
      fail(`authoritative coverage execution forbids inherited variable ${name}`);
    }
  }
  assertControlledDirectory(layout.tool, "controller tool root", {
    uid: CONTROLLER_UID,
    gid: CONTROLLER_GID,
  });
  assertControlledDirectory(layout.frozen, "frozen coverage root", {
    uid: CONTROLLER_UID,
    gid: CONTROLLER_GID,
  });
  assertControlledDirectory(layout.raw, "raw coverage root", {
    uid: WORKER_UID,
    gid: WORKER_GID,
  });
  const homeStat = fs.lstatSync(layout.workerHome, { throwIfNoEntry: false });
  if (!homeStat || homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    fail("worker home root must be a regular directory");
  }
  if (homeStat.uid !== CONTROLLER_UID || homeStat.gid !== CONTROLLER_GID) {
    fail("worker home root must be owned by the trusted controller");
  }
  if (fs.realpathSync(layout.workerHome) !== layout.workerHome) {
    fail("worker home root must not contain a symlinked path component");
  }
  const outputStat = fs.lstatSync(layout.out, { throwIfNoEntry: false });
  if (!outputStat || outputStat.isSymbolicLink() || !outputStat.isDirectory()) {
    fail("controlled output root must be a regular directory");
  }
  if (outputStat.uid !== CONTROLLER_UID || outputStat.gid !== CONTROLLER_GID) {
    fail("controlled output root must be owned by the trusted controller");
  }
  fs.chmodSync(layout.out, 0o700);
  assertControlledDirectory(layout.out, "controlled output root", {
    uid: CONTROLLER_UID,
    gid: CONTROLLER_GID,
  });
  return layout;
}

function assertNoCoverageDiscovery(
  startDirectory,
  allowedManifestDirectories,
  label,
  options = {},
) {
  const allowed = new Set(allowedManifestDirectories);
  const boundary = options.stopAt ? path.resolve(options.stopAt) : null;
  let current = path.resolve(startDirectory);
  const seen = new Set();
  while (!seen.has(current)) {
    seen.add(current);
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch (error) {
      fail(`${label} could not be inspected at ${current}`);
    }
    for (const name of entries) {
      if (FORBIDDEN_COVERAGE_CONFIG_FILES.includes(name)) {
        fail(`${label} contains forbidden coverage configuration ${current}/${name}`);
      }
      if (name === ".npmrc") {
        fail(`${label} contains forbidden npm configuration ${current}/${name}`);
      }
      if (name === "package.json" && !allowed.has(current)) {
        fail(`${label} contains an unexpected manifest ${current}/${name}`);
      }
    }
    if (boundary !== null && current === boundary) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return true;
}

function supplementalPackageIds(entryId) {
  const ids = SUPPLEMENTAL_PACKAGE_IDS[entryId];
  return ids ? [...ids] : [];
}

function supplementalInputPaths(entryId) {
  const paths = [];
  for (const id of supplementalPackageIds(entryId)) {
    for (const name of SUPPLEMENTAL_MANIFEST_FILES) {
      paths.push(`${id}/${name}`);
    }
  }
  return paths.sort();
}

function workerHomeInventory(entryId) {
  return [
    entryId,
    ".npm-cache",
    ".npm-global-config",
    ".npm-user-config",
    ...supplementalPackageIds(entryId),
  ].sort();
}

function resolveExecutionLayout(options) {
  const entryId = options.entryId;
  const repo = fs.realpathSync(options.repoRoot);
  if (options.authoritative === true) {
    const outputRoot = options.outputRoot;
    if (outputRoot !== CONTAINER_ROOTS.output) {
      fail(
        `authoritative output root must equal ${CONTAINER_ROOTS.output}`,
      );
    }
    const workerHome = CONTAINER_ROOTS.home;
    const tool = CONTAINER_ROOTS.tool;
    const artifactsRoot = path.join(outputRoot, OUTPUT_ARTIFACT_ROOT);
    return {
      authoritative: true,
      entryId,
      repo,
      pkg: path.join(workerHome, entryId),
      workerHome,
      workerHomeEntries: workerHomeInventory(entryId),
      supplementalIds: supplementalPackageIds(entryId),
      identityRoot: path.join(tool, "identity"),
      workerCache: path.join(workerHome, ".npm-cache"),
      workerUserConfig: path.join(workerHome, ".npm-user-config"),
      workerGlobalConfig: path.join(workerHome, ".npm-global-config"),
      tool,
      controllerHome: path.join(tool, "controller-home"),
      controllerCache: path.join(tool, "controller-cache"),
      controllerUserConfig: path.join(tool, "controller-user-config"),
      controllerGlobalConfig: path.join(tool, "controller-global-config"),
      c8Config: path.join(tool, "c8-config.json"),
      raw: CONTAINER_ROOTS.raw,
      frozen: CONTAINER_ROOTS.frozen,
      out: outputRoot,
      artifactsRoot,
      artifactDirectory: path.join(artifactsRoot, entryId),
      report: path.join(artifactsRoot, entryId, "report"),
      coverageRoot: workerHome,
      temporaryRoot: null,
    };
  }
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "betstan-coverage-local-"),
  );
  const artifactsRoot = path.join(repo, ...ARTIFACT_ROOT.split("/"));
  return {
    authoritative: false,
    entryId,
    repo,
    pkg: path.join(repo, entryId),
    workerHome: repo,
    workerHomeEntries: null,
    supplementalIds: supplementalPackageIds(entryId),
    identityRoot: path.join(temporaryRoot, "identity"),
    workerCache: path.join(temporaryRoot, "worker-cache"),
    workerUserConfig: path.join(temporaryRoot, "worker-user-config"),
    workerGlobalConfig: path.join(temporaryRoot, "worker-global-config"),
    tool: path.join(repo, ".github", "coverage"),
    controllerHome: path.join(temporaryRoot, "controller-home"),
    controllerCache: path.join(temporaryRoot, "controller-cache"),
    controllerUserConfig: path.join(temporaryRoot, "controller-user-config"),
    controllerGlobalConfig: path.join(temporaryRoot, "controller-global-config"),
    c8Config: path.join(temporaryRoot, "c8-config.json"),
    raw: path.join(temporaryRoot, "raw"),
    frozen: path.join(temporaryRoot, "frozen"),
    out: repo,
    artifactsRoot,
    artifactDirectory: path.join(artifactsRoot, entryId),
    report: path.join(temporaryRoot, "report"),
    coverageRoot: repo,
    temporaryRoot,
  };
}

function writeGeneratedC8Configuration(layout) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    fs.rmSync(layout.c8Config, { force: true });
    descriptor = fs.openSync(
      layout.c8Config,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
      0o600,
    );
    fs.writeSync(descriptor, C8_CONFIG_CONTENT);
  } catch (error) {
    fail("generated c8 configuration could not be created exclusively");
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
  const stat = fs.lstatSync(layout.c8Config);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    fail("generated c8 configuration must be a non-hardlinked regular file");
  }
  if (fs.readFileSync(layout.c8Config, "utf8") !== C8_CONFIG_CONTENT) {
    fail("generated c8 configuration must contain exactly an empty object");
  }
  return layout.c8Config;
}

function prepareControlledRoots(layout) {
  const controllerOwner = { uid: CONTROLLER_UID, gid: CONTROLLER_GID };
  const workerOwner = { uid: WORKER_UID, gid: WORKER_GID };
  if (layout.authoritative) {
    assertEmptyDirectory(layout.raw, "raw coverage root");
    resetControlledDirectory(layout.frozen, "frozen coverage root", controllerOwner);
    createControlledDirectory(layout.controllerHome, "controller home", controllerOwner);
    createControlledDirectory(layout.controllerCache, "controller cache", controllerOwner);
    resetControlledDirectory(layout.identityRoot, "command identity root", controllerOwner);
    createControlledDirectory(layout.workerCache, "worker cache", workerOwner);
    fs.chmodSync(layout.workerHome, WORKER_HOME_MODE);
  } else {
    createControlledDirectory(layout.raw, "raw coverage root", null);
    resetControlledDirectory(layout.frozen, "frozen coverage root", null);
    createControlledDirectory(layout.controllerHome, "controller home", null);
    createControlledDirectory(layout.controllerCache, "controller cache", null);
    resetControlledDirectory(layout.identityRoot, "command identity root", null);
    createControlledDirectory(layout.workerCache, "worker cache", null);
    assertEmptyDirectory(layout.raw, "raw coverage root");
  }
  resetControlledDirectory(layout.report, "coverage report root", controllerOwner);
  for (const configPath of [
    layout.controllerUserConfig,
    layout.controllerGlobalConfig,
    layout.workerUserConfig,
    layout.workerGlobalConfig,
  ]) {
    fs.rmSync(configPath, { force: true });
    fs.writeFileSync(configPath, "", { flag: "wx", mode: 0o600 });
    if (layout.authoritative) {
      fs.chownSync(configPath, CONTROLLER_UID, CONTROLLER_GID);
      fs.chmodSync(configPath, SUPPLEMENTAL_FILE_MODE);
    }
  }
  writeGeneratedC8Configuration(layout);
  return layout;
}

function assertSupplementalFile(absolute, record, label, authoritative) {
  let stat;
  try {
    stat = fs.lstatSync(absolute, { bigint: true });
  } catch (error) {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular file`);
  }
  if (stat.nlink !== 1n) {
    fail(`${label} must not be hardlinked`);
  }
  if (Number(stat.size) !== record.byteLength) {
    fail(`${label} size differs from the exact checkout snapshot`);
  }
  if (authoritative) {
    if (
      Number(stat.uid) !== CONTROLLER_UID ||
      Number(stat.gid) !== CONTROLLER_GID
    ) {
      fail(`${label} must be owned by the trusted controller`);
    }
    if ((Number(stat.mode) & 0o777) !== SUPPLEMENTAL_FILE_MODE) {
      fail(`${label} must stay read-only for the worker`);
    }
  }
  const actual = sha256File(absolute, LIMITS.reportBytes, label);
  if (actual !== record.sha256) {
    fail(`${label} differs from the verified candidate manifest`);
  }
  return actual;
}

function deriveSupplementalSnapshot(repoRoot, treeish, entryId) {
  const expected = supplementalInputPaths(entryId);
  if (expected.length === 0) {
    return { paths: [], records: [] };
  }
  const records = new Map();
  for (const id of supplementalPackageIds(entryId)) {
    const entries = listTreeEntries(repoRoot, treeish, id).filter((item) =>
      SUPPLEMENTAL_MANIFEST_FILES.includes(path.posix.basename(item.path)) &&
      item.path.split("/").length === 2,
    );
    for (const item of entries) {
      if (item.mode === "120000" || item.type !== "blob") {
        fail(`supplemental manifest is not a regular tracked file: ${item.path}`);
      }
      if (item.mode !== "100644") {
        fail(`supplemental manifest mode is unsupported: ${item.path}`);
      }
      if (!Number.isSafeInteger(item.size) || item.size > LIMITS.reportBytes) {
        fail(`supplemental manifest size is unsupported: ${item.path}`);
      }
      records.set(item.path, {
        path: item.path,
        gitBlob: item.object,
        gitMode: item.mode,
        byteLength: item.size,
        sha256: null,
      });
    }
  }
  const actual = [...records.keys()].sort();
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    fail(
      `supplemental Common inputs must be exactly ${expected.join(",")}; found ${actual.join(",")}`,
    );
  }
  const ordered = expected.map((repoPath) => records.get(repoPath));
  for (const record of ordered) {
    const serviceId = record.path.split("/")[0];
    const digest = hashStablePackageInput(repoRoot, {
      path: record.path,
      gitBlob: record.gitBlob,
      gitMode: record.gitMode,
      byteLength: record.byteLength,
    }, { id: serviceId });
    if (digest !== record.gitBlob) {
      fail(`${record.path} differs from the exact checkout snapshot`);
    }
    record.sha256 = sha256File(
      ensureRegularInRoot(repoRoot, record.path, record.path),
      LIMITS.reportBytes,
      record.path,
    );
  }
  return { paths: expected, records: ordered };
}

function verifySupplementalOrigin(repoRoot, snapshot) {
  for (const record of snapshot.records) {
    const serviceId = record.path.split("/")[0];
    const digest = hashStablePackageInput(repoRoot, {
      path: record.path,
      gitBlob: record.gitBlob,
      gitMode: record.gitMode,
      byteLength: record.byteLength,
    }, { id: serviceId });
    if (digest !== record.gitBlob) {
      fail(`${record.path} differs from the exact checkout snapshot`);
    }
    const actual = sha256File(
      ensureRegularInRoot(repoRoot, record.path, record.path),
      LIMITS.reportBytes,
      record.path,
    );
    if (actual !== record.sha256) {
      fail(`${record.path} differs from the verified candidate manifest`);
    }
  }
  return snapshot;
}

function isInsideDirectory(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function canonicalStagingDirectory(candidate, label) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    fail(`${label} must be an absolute path`);
  }
  const normalized = path.resolve(candidate);
  let stat;
  try {
    stat = fs.lstatSync(normalized);
  } catch (error) {
    fail(`${label} is missing`);
  }
  if (stat.isSymbolicLink()) {
    fail(`${label} must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    fail(`${label} must be a regular directory`);
  }
  return fs.realpathSync(normalized);
}

// Destructive staging primitives are only allowed to delete inside a worker
// home that is provably separate from the candidate checkout. This runs before
// any removal and never relies on the caller's authoritative flag.
function assertIsolatedStagingLayout(repoRoot, entryId, layout) {
  if (!isPlainObject(layout)) {
    fail("staging layout must be an object");
  }
  if (typeof entryId !== "string" || !SAFE_ID_PATTERN.test(entryId)) {
    fail("staging package id is unsafe");
  }
  if (layout.entryId !== entryId) {
    fail("staging layout package id does not match the staged entry");
  }
  const repo = canonicalStagingDirectory(repoRoot, "candidate repository root");
  const workerHome = canonicalStagingDirectory(
    layout.workerHome,
    "staging worker home root",
  );
  if (workerHome === repo) {
    fail("staging worker home must not be the candidate checkout");
  }
  if (isInsideDirectory(repo, workerHome)) {
    fail("staging worker home must not resolve inside the candidate checkout");
  }
  if (isInsideDirectory(workerHome, repo)) {
    fail("candidate checkout must not resolve inside the staging worker home");
  }
  const expectedPkg = path.join(workerHome, entryId);
  if (typeof layout.pkg !== "string" || !path.isAbsolute(layout.pkg)) {
    fail("staged package root must be an absolute path");
  }
  const resolvedPkg = path.resolve(layout.pkg);
  const pkgParent = canonicalStagingDirectory(
    path.dirname(resolvedPkg),
    "staged package parent",
  );
  if (
    path.basename(resolvedPkg) !== entryId ||
    pkgParent !== workerHome ||
    path.join(pkgParent, path.basename(resolvedPkg)) !== expectedPkg
  ) {
    fail(
      `staged package root must resolve to the worker home entry ${expectedPkg}`,
    );
  }
  const expectedInventory = workerHomeInventory(entryId);
  if (
    !Array.isArray(layout.workerHomeEntries) ||
    layout.workerHomeEntries.length !== expectedInventory.length ||
    [...layout.workerHomeEntries]
      .sort()
      .some((name, index) => name !== expectedInventory[index])
  ) {
    fail(
      `staging worker home inventory must be exactly ${expectedInventory.join(",")}`,
    );
  }
  const supplementalIds = Array.isArray(layout.supplementalIds)
    ? layout.supplementalIds
    : null;
  if (supplementalIds === null) {
    fail("staging supplemental package ids must be an array");
  }
  const expectedSupplemental = supplementalPackageIds(entryId);
  if (
    supplementalIds.length !== expectedSupplemental.length ||
    [...supplementalIds]
      .sort()
      .some((id, index) => id !== [...expectedSupplemental].sort()[index])
  ) {
    fail(
      `staging supplemental package ids must be exactly ${expectedSupplemental.join(",")}`,
    );
  }
  for (const id of [entryId, ...supplementalIds]) {
    if (!SAFE_ID_PATTERN.test(id)) {
      fail(`staging target id is unsafe: ${id}`);
    }
    const target = path.join(workerHome, id);
    if (!isInsideDirectory(workerHome, target)) {
      fail(`staging target must resolve inside the worker home: ${id}`);
    }
    if (target === repo || isInsideDirectory(target, repo)) {
      fail(`staging target must not contain the candidate checkout: ${id}`);
    }
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && stat.isSymbolicLink()) {
      fail(`staging target must not be a symlink: ${id}`);
    }
    if (stat && !stat.isDirectory()) {
      fail(`staging target must be a regular directory: ${id}`);
    }
    if (stat && fs.realpathSync(target) !== path.join(workerHome, id)) {
      fail(`staging target must not resolve through a symlink: ${id}`);
    }
  }
  return { repo, workerHome, pkg: expectedPkg };
}

function stageSupplementalInputs(repoRoot, snapshot, layout) {
  assertIsolatedStagingLayout(repoRoot, layout.entryId, layout);
  for (const id of layout.supplementalIds) {
    const directory = path.join(layout.workerHome, id);
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  for (const record of snapshot.records) {
    const [serviceId, name] = record.path.split("/");
    const source = ensureRegularInRoot(repoRoot, record.path, record.path);
    const bytes = readBoundedFile(source, LIMITS.reportBytes, record.path);
    if (bytes.length !== record.byteLength || sha256Bytes(bytes) !== record.sha256) {
      fail(`${record.path} changed while it was staged for the worker`);
    }
    const target = path.join(layout.workerHome, serviceId, name);
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
    if (layout.authoritative) {
      fs.chownSync(target, CONTROLLER_UID, CONTROLLER_GID);
      fs.chmodSync(target, SUPPLEMENTAL_FILE_MODE);
    }
  }
  for (const id of layout.supplementalIds) {
    const directory = path.join(layout.workerHome, id);
    if (layout.authoritative) {
      fs.chownSync(directory, CONTROLLER_UID, CONTROLLER_GID);
      fs.chmodSync(directory, SUPPLEMENTAL_DIRECTORY_MODE);
    }
  }
  return verifyWorkerHomeClosure(repoRoot, snapshot, layout);
}

function verifyWorkerHomeClosure(repoRoot, snapshot, layout) {
  if (
    !snapshot ||
    !Array.isArray(layout.supplementalIds) ||
    layout.supplementalIds.length === 0
  ) {
    return snapshot;
  }
  const enforceOwnership = layout.authoritative === true;
  const homeStat = fs.lstatSync(layout.workerHome, { bigint: true });
  if (homeStat.isSymbolicLink() || !homeStat.isDirectory()) {
    fail("worker home root must be a regular directory");
  }
  if (enforceOwnership) {
    if (
      Number(homeStat.uid) !== CONTROLLER_UID ||
      Number(homeStat.gid) !== CONTROLLER_GID
    ) {
      fail("worker home root must be owned by the trusted controller");
    }
    if ((Number(homeStat.mode) & 0o777) !== WORKER_HOME_MODE) {
      fail(`worker home root must use mode 0${WORKER_HOME_MODE.toString(8)}`);
    }
  }
  if (!Array.isArray(layout.workerHomeEntries)) {
    fail("worker home inventory is not defined for this run");
  }
  const actualEntries = fs.readdirSync(layout.workerHome).sort();
  const expectedEntries = [...layout.workerHomeEntries].sort();
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((name, index) => name !== expectedEntries[index])
  ) {
    fail(
      `worker home must contain exactly ${expectedEntries.join(",")}; found ${actualEntries.join(",")}`,
    );
  }
  for (const id of layout.supplementalIds) {
    const directory = path.join(layout.workerHome, id);
    const stat = fs.lstatSync(directory, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail(`supplemental package root must be a regular directory: ${id}`);
    }
    if (enforceOwnership) {
      if (Number(stat.uid) !== CONTROLLER_UID || Number(stat.gid) !== CONTROLLER_GID) {
        fail(`supplemental package root must be owned by the trusted controller: ${id}`);
      }
      if ((Number(stat.mode) & 0o777) !== SUPPLEMENTAL_DIRECTORY_MODE) {
        fail(`supplemental package root must stay read-only for the worker: ${id}`);
      }
    }
    const names = fs.readdirSync(directory).sort();
    const expectedNames = [...SUPPLEMENTAL_MANIFEST_FILES].sort();
    if (
      names.length !== expectedNames.length ||
      names.some((name, index) => name !== expectedNames[index])
    ) {
      fail(
        `supplemental package ${id} must contain exactly ${expectedNames.join(",")}; found ${names.join(",")}`,
      );
    }
  }
  for (const record of snapshot.records) {
    const [serviceId, name] = record.path.split("/");
    assertSupplementalFile(
      path.join(layout.workerHome, serviceId, name),
      record,
      `staged supplemental ${record.path}`,
      enforceOwnership,
    );
  }
  verifySupplementalOrigin(repoRoot, snapshot);
  return snapshot;
}

function stageControllerToolchain(trustedRoot, layout) {
  const staged = [];
  for (const name of ["package.json", "package-lock.json"]) {
    const repoPath = `.github/coverage/${name}`;
    const source = ensureRegularInRoot(trustedRoot, repoPath, `trusted ${repoPath}`);
    const bytes = readBoundedFile(source, LIMITS.reportBytes, `trusted ${repoPath}`);
    const target = path.join(layout.tool, name);
    writeFileSafely(target, bytes, `controller tool ${name}`);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
      fail(`controller tool ${name} must be a non-hardlinked regular file`);
    }
    if (sha256File(target, LIMITS.reportBytes, `controller tool ${name}`) !==
      sha256Bytes(bytes)) {
      fail(`controller tool ${name} differs from the trusted coverage package`);
    }
    staged.push({ path: repoPath, sha256: sha256Bytes(bytes) });
  }
  return staged;
}

function chownRecursively(absolute, uid, gid) {
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    fail(`staged workspace must not contain symlink ${absolute}`);
  }
  fs.chownSync(absolute, uid, gid);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute)) {
      chownRecursively(path.join(absolute, name), uid, gid);
    }
  }
}

function stageWorkerPackage(repoRoot, entry, packageInputSnapshot, layout) {
  assertIsolatedStagingLayout(repoRoot, entry.id, layout);
  ensurePackageSnapshot(repoRoot, packageInputSnapshot, entry);
  fs.rmSync(layout.pkg, { recursive: true, force: true });
  fs.mkdirSync(layout.pkg, { recursive: true, mode: 0o700 });
  const staged = [];
  for (const record of packageInputSnapshot.records) {
    const relative = relativeFromPackage(entry.id, record.path);
    const source = ensureRegularInRoot(repoRoot, record.path, record.path);
    const target = path.join(layout.pkg, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const bytes = readBoundedFile(source, LIMITS.sourceFileBytes, record.path);
    if (bytes.length !== record.byteLength) {
      fail(`${record.path} changed while it was staged for the worker`);
    }
    fs.writeFileSync(target, bytes, {
      flag: "wx",
      mode: record.gitMode === "100755" ? 0o700 : 0o600,
    });
    staged.push({ path: record.path, sha256: sha256Bytes(bytes) });
  }
  if (layout.authoritative) {
    chownRecursively(layout.pkg, WORKER_UID, WORKER_GID);
  }
  verifyStagedWorkspace(entry, packageInputSnapshot, layout, staged);
  return staged;
}

function verifyStagedWorkspace(entry, packageInputSnapshot, layout, staged) {
  if (!Array.isArray(staged) || staged.length !== packageInputSnapshot.records.length) {
    fail(`${entry.id} staged workspace inventory is invalid`);
  }
  for (const record of staged) {
    const relative = relativeFromPackage(entry.id, record.path);
    const absolute = path.join(layout.pkg, ...relative.split("/"));
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) {
      fail(`${record.path} staged copy must be a non-hardlinked regular file`);
    }
    if (
      layout.authoritative &&
      (Number(stat.uid) !== WORKER_UID || Number(stat.gid) !== WORKER_GID)
    ) {
      fail(`${record.path} staged copy must be owned by the unprivileged worker`);
    }
    const actual = sha256File(absolute, LIMITS.sourceFileBytes, record.path);
    if (actual !== record.sha256) {
      fail(`${record.path} staged copy differs from the verified candidate input`);
    }
  }
  rejectUnexpectedPackageFiles(
    layout.workerHome,
    entry,
    packageInputSnapshot.paths,
  );
  return staged;
}

function freezeStagedWorkspace(layout, options = {}) {
  const skipTopLevel = new Set(options.skipTopLevel || ["node_modules"]);
  const freeze = (absolute) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      fail(`staged workspace must not contain symlink ${absolute}`);
    }
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) {
        freeze(path.join(absolute, name));
      }
      fs.chmodSync(absolute, 0o500);
      return;
    }
    fs.chmodSync(absolute, stat.mode & 0o100 ? 0o500 : 0o400);
  };
  for (const name of fs.readdirSync(layout.pkg)) {
    if (skipTopLevel.has(name)) {
      continue;
    }
    freeze(path.join(layout.pkg, name));
  }
  fs.chmodSync(layout.pkg, 0o500);
  return layout.pkg;
}

function assertRawCoverageShape(bytes, label) {
  const parsed = parseJsonBytes(bytes, label);
  assertPlainObject(parsed, label);
  for (const key of Object.keys(parsed)) {
    if (!RAW_COVERAGE_KEYS.includes(key)) {
      fail(`${label} contains unsupported field ${key}`);
    }
  }
  if (!Array.isArray(parsed.result)) {
    fail(`${label} must contain a V8 result array`);
  }
  if (
    Object.prototype.hasOwnProperty.call(parsed, "timestamp") &&
    typeof parsed.timestamp !== "number"
  ) {
    fail(`${label} contains a malformed V8 timestamp`);
  }
  if (
    Object.prototype.hasOwnProperty.call(parsed, "source-map-cache") &&
    !isPlainObject(parsed["source-map-cache"])
  ) {
    fail(`${label} contains a malformed V8 source map cache`);
  }
  if (parsed.result.length > LIMITS.rawCoverageResults) {
    fail(`${label} exceeds ${LIMITS.rawCoverageResults} V8 result entries`);
  }
  for (const record of parsed.result) {
    if (!isPlainObject(record) || typeof record.url !== "string") {
      fail(`${label} contains a malformed V8 script coverage record`);
    }
  }
  return parsed;
}

function freezeRawCoverage(layout) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const directory = fs.constants.O_DIRECTORY || 0;
  let handle;
  try {
    handle = fs.openSync(layout.raw, fs.constants.O_RDONLY | directory | noFollow);
    const stat = fs.fstatSync(handle);
    if (!stat.isDirectory()) {
      fail("raw coverage root must be a regular directory");
    }
  } catch (error) {
    if (error instanceof CoverageMatrixError) {
      throw error;
    }
    fail("raw coverage root could not be opened safely");
  } finally {
    if (handle !== undefined) {
      fs.closeSync(handle);
    }
  }
  const names = fs.readdirSync(layout.raw).sort();
  if (names.length === 0) {
    fail("raw coverage root contains no V8 coverage data");
  }
  if (names.length > LIMITS.rawCoverageFiles) {
    fail(`raw coverage root exceeds ${LIMITS.rawCoverageFiles} files`);
  }
  const inventory = [];
  let totalBytes = 0;
  for (const name of names) {
    if (!RAW_COVERAGE_FILE_PATTERN.test(name)) {
      fail(`raw coverage file name is unexpected: ${name}`);
    }
    const absolute = path.join(layout.raw, name);
    const stat = fs.lstatSync(absolute, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(`raw coverage file must be a regular file: ${name}`);
    }
    if (stat.nlink !== 1n) {
      fail(`raw coverage file must not be hardlinked: ${name}`);
    }
    if (layout.authoritative && Number(stat.uid) !== WORKER_UID) {
      fail(`raw coverage file must be owned by the unprivileged worker: ${name}`);
    }
    if (Number(stat.size) > LIMITS.rawCoverageFileBytes) {
      fail(
        `raw coverage file exceeds ${LIMITS.rawCoverageFileBytes} bytes: ${name}`,
      );
    }
    totalBytes += Number(stat.size);
    if (totalBytes > LIMITS.rawCoverageTotalBytes) {
      fail(`raw coverage data exceeds ${LIMITS.rawCoverageTotalBytes} bytes`);
    }
    const bytes = readBoundedFile(
      absolute,
      LIMITS.rawCoverageFileBytes,
      `raw coverage file ${name}`,
    );
    assertRawCoverageShape(bytes, `raw coverage file ${name}`);
    writeFileSafely(
      path.join(layout.frozen, name),
      bytes,
      `frozen coverage file ${name}`,
    );
    inventory.push({ name, bytes: bytes.length, sha256: sha256Bytes(bytes) });
  }
  fs.chmodSync(layout.raw, 0o500);
  return inventory;
}

function hashFrozenCoverage(layout) {
  const names = fs.readdirSync(layout.frozen).sort();
  return names
    .map((name) => {
      const absolute = path.join(layout.frozen, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        fail(`frozen coverage entry must be a regular file: ${name}`);
      }
      return `${name}:${sha256File(
        absolute,
        LIMITS.rawCoverageFileBytes,
        `frozen coverage file ${name}`,
      )}`;
    })
    .join("|");
}

function placeholderTargets(layout) {
  return new Map([
    ["<C8_CONFIG>", layout.c8Config],
    ["<FROZEN>", layout.frozen],
    ["<NODE>", process.execPath],
    ["<OUT>", layout.out],
    ["<PKG>", layout.pkg],
    ["<PKG_BIN>", path.join(layout.pkg, "node_modules", ".bin")],
    ["<RAW>", layout.raw],
    ["<REPO>", layout.repo],
    ["<REPORT>", layout.report],
    ["<TOOL>", layout.tool],
    ["<TOOL_BIN>", path.join(layout.tool, "node_modules", ".bin")],
  ]);
}

function assertClosedPlaceholders(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  for (const token of value.match(PLACEHOLDER_TOKEN_PATTERN) || []) {
    if (
      !COMMAND_PLACEHOLDERS.includes(token) &&
      !LITERAL_COMMAND_TOKENS.includes(token)
    ) {
      fail(`${label} contains unknown placeholder ${token}`);
    }
  }
  return value;
}

function assertCommandToken(value, label) {
  assertClosedPlaceholders(value, label);
  if (
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r") ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    fail(`${label} contains an unsafe value`);
  }
  if (value.startsWith("/")) {
    fail(`${label} must not contain an absolute path: ${value}`);
  }
  const temporaryRoot = os.tmpdir();
  if (temporaryRoot && value.includes(temporaryRoot)) {
    fail(`${label} must not contain a session temporary path`);
  }
  return value;
}

function substitutePlaceholders(value, layout, label) {
  assertClosedPlaceholders(value, label);
  let result = value;
  for (const [token, target] of placeholderTargets(layout)) {
    result = result.split(token).join(target);
  }
  return result;
}

function buildCommandPlan(entry, eligible, options = {}) {
  if (!options.repoRoot || !options.treeish) {
    fail("command planning requires a repository and treeish");
  }
  const testFiles = (
    entry.testFiles || deriveTestFiles(options.repoRoot, options.treeish, entry)
  ).map((repoPath) => relativeFromPackage(entry.id, repoPath));
  const testMatchArguments = testFiles.map(
    (testFile) => `--testMatch=<rootDir>/${testFile}`,
  );
  const testResults = "coverage/test-results.json";
  const collectArguments = eligible.map(
    (repoPath) => `--collectCoverageFrom=${relativeFromPackage(entry.id, repoPath)}`,
  );
  let commands;
  if (entry.profile === "jest-typescript") {
    commands = [
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: ["npm", ...NPM_CI_ARGUMENTS],
        timeoutMs: COMMAND_TIMEOUTS.install,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: ["<PKG_BIN>/tsc", "--noEmit"],
        timeoutMs: COMMAND_TIMEOUTS.typecheck,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: [
          "<PKG_BIN>/jest",
          "--runInBand",
          "--coverage",
          "--coverageDirectory=coverage",
          "--coverageReporters=json",
          "--coverageReporters=json-summary",
          "--json",
          `--outputFile=${testResults}`,
          ...collectArguments,
          ...testMatchArguments,
          "--testPathIgnorePatterns=(?!)",
          "--runTestsByPath",
          ...testFiles,
        ],
        timeoutMs: COMMAND_TIMEOUTS.test,
      },
    ];
  } else if (entry.profile === "react-scripts") {
    commands = [
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: ["npm", ...NPM_CI_ARGUMENTS],
        timeoutMs: COMMAND_TIMEOUTS.install,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: [
          "<PKG_BIN>/react-scripts",
          "test",
          "--watchAll=false",
          "--coverage",
          "--coverageDirectory=coverage",
          "--coverageReporters=json",
          "--coverageReporters=json-summary",
          "--json",
          `--outputFile=${testResults}`,
          ...collectArguments,
          ...testMatchArguments,
          "--testPathIgnorePatterns=(?!)",
          "--runTestsByPath",
          ...testFiles,
        ],
        timeoutMs: COMMAND_TIMEOUTS.test,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: ["<PKG_BIN>/react-scripts", "build"],
        timeoutMs: COMMAND_TIMEOUTS.build,
      },
    ];
  } else if (entry.profile === "node-typescript-c8") {
    const includeArguments = eligible.map(
      (repoPath) => `--include=${mapSourceToBuild(entry.id, repoPath)}`,
    );
    commands = [
      {
        role: "controller",
        workingDirectory: "<TOOL>",
        argv: ["npm", ...NPM_CI_ARGUMENTS],
        timeoutMs: COMMAND_TIMEOUTS.install,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: ["npm", ...NPM_CI_ARGUMENTS],
        timeoutMs: COMMAND_TIMEOUTS.install,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: ["npm", "run", "clean"],
        timeoutMs: COMMAND_TIMEOUTS.clean,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: [
          "<PKG_BIN>/tsc",
          "-p",
          "tsconfig.json",
          "--sourceMap",
          "--inlineSources",
        ],
        timeoutMs: COMMAND_TIMEOUTS.typecheck,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: [
          "<PKG_BIN>/tsc",
          "--noEmit",
          "-p",
          "tsconfig.test.json",
        ],
        timeoutMs: COMMAND_TIMEOUTS.typecheck,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: [
          "<PKG_BIN>/tsc",
          "--noEmit",
          "-p",
          "tsconfig.legacy-amqp.json",
        ],
        timeoutMs: COMMAND_TIMEOUTS.typecheck,
      },
      {
        role: "worker",
        workingDirectory: "<PKG>",
        argv: ["<NODE>", "--test", "--test-reporter=tap", ...testFiles],
        captureStdout: true,
        rawSink: true,
        timeoutMs: COMMAND_TIMEOUTS.test,
      },
      {
        role: "controller",
        workingDirectory: "<PKG>",
        argv: [
          "<TOOL_BIN>/c8",
          "report",
          "--config=<C8_CONFIG>",
          "--temp-directory=<FROZEN>",
          "--reports-dir=<REPORT>",
          "--reporter=json",
          "--reporter=json-summary",
          "--all",
          "--src=<PKG>",
          ...includeArguments,
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
        ],
        reportOutput: true,
        timeoutMs: COMMAND_TIMEOUTS.build,
      },
    ];
  } else {
    fail(`unsupported command profile ${entry.profile}`);
  }
  if (commands.length > LIMITS.commands) {
    fail(`command plan exceeds ${LIMITS.commands} commands`);
  }
  for (const command of commands) {
    if (!COMMAND_ROLES.includes(command.role)) {
      fail("command role must be controller or worker");
    }
    command.uid = command.role === "controller" ? CONTROLLER_UID : WORKER_UID;
    assertCommandToken(command.workingDirectory, "command working directory");
    if (!COMMAND_PLACEHOLDERS.includes(command.workingDirectory)) {
      fail("command working directory must be a closed placeholder root");
    }
    if (!Array.isArray(command.argv) || command.argv.length === 0) {
      fail("command argv must be a non-empty array");
    }
    assertInteger(command.timeoutMs, "command timeout", 1);
    for (const argument of command.argv) {
      assertCommandToken(argument, "command argv");
    }
  }
  return commands;
}

function prepareEntry(repoRoot, trustedRoot, context, id) {
  validateRunContext(repoRoot, context);
  const trustedAssets = verifyTrustedAssets(repoRoot, trustedRoot, context);
  const validated = validateRepository(repoRoot, {
    treeish: context.repository.checkoutSha,
  });
  const entry = validated.entries.find((candidate) => candidate.id === id);
  if (!entry) {
    fail(`package id is not registered: ${id}`);
  }
  const changes = deriveChangedSources(
    repoRoot,
    context.repository.baseSha,
    context.repository.headSha,
    entry,
    entry.eligible,
  );
  const packageInputSnapshot = derivePackageInputSnapshot(
    repoRoot,
    context.repository.checkoutSha,
    entry,
  );
  const packageInputs = packageInputSnapshot.paths;
  const protectedFileSnapshots = [
    captureProtectedFile(
      repoRoot,
      ENGINE_PATH,
      LIMITS.reportBytes,
      `candidate ${ENGINE_PATH}`,
    ),
    captureProtectedFile(
      repoRoot,
      TOOL_PACKAGE_PATH,
      LIMITS.descriptorBytes,
      `candidate ${TOOL_PACKAGE_PATH}`,
    ),
    captureProtectedFile(
      repoRoot,
      TOOL_LOCK_PATH,
      LIMITS.reportBytes,
      `candidate ${TOOL_LOCK_PATH}`,
    ),
    captureProtectedFile(
      repoRoot,
      DESCRIPTOR_PATH,
      LIMITS.descriptorBytes,
      `candidate ${DESCRIPTOR_PATH}`,
    ),
  ];
  if (trustedAssets.root !== fs.realpathSync(repoRoot)) {
    for (const [repoPath, maximumBytes] of [
      [ENGINE_PATH, LIMITS.reportBytes],
      [TOOL_PACKAGE_PATH, LIMITS.descriptorBytes],
      [TOOL_LOCK_PATH, LIMITS.reportBytes],
    ]) {
      protectedFileSnapshots.push(
        captureProtectedFile(
          trustedAssets.root,
          repoPath,
          maximumBytes,
          `trusted ${repoPath}`,
        ),
      );
    }
  }
  const supplementalSnapshot = deriveSupplementalSnapshot(
    repoRoot,
    context.repository.checkoutSha,
    entry.id,
  );
  const commands = buildCommandPlan(entry, entry.eligible, {
    repoRoot,
    treeish: context.repository.checkoutSha,
  });
  const prepared = {
    descriptor: validated.descriptor,
    entry,
    supplementalSnapshot,
    eligible: entry.eligible,
    packageInputs,
    packageInputSnapshot,
    protectedFileSnapshots,
    testFiles: entry.testFiles,
    ...changes,
    trustedAssets,
    commands,
  };
  verifyPreparedFilesystemState(repoRoot, prepared);
  return prepared;
}

function coveragePathToRepoPath(repoRoot, coveragePath, label) {
  if (typeof coveragePath !== "string" || coveragePath.length === 0) {
    fail(`${label} must be a non-empty path`);
  }
  let absolute;
  if (path.isAbsolute(coveragePath)) {
    absolute = path.normalize(coveragePath);
  } else {
    const normalized = normalizeRepoPath(coveragePath, label);
    absolute = path.join(repoRoot, ...normalized.split("/"));
  }
  const relative = path.relative(repoRoot, absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    fail(`${label} resolves outside the repository`);
  }
  return normalizeRepoPath(relative.split(path.sep).join("/"), label);
}

function coverageCountsForFile(record, repoPath, repoRoot) {
  assertPlainObject(record, `coverage record for ${repoPath}`);
  const embeddedPath = coveragePathToRepoPath(
    repoRoot,
    record.path,
    `embedded coverage path for ${repoPath}`,
  );
  if (embeddedPath !== repoPath) {
    fail(`embedded coverage path does not match outer key for ${repoPath}`);
  }
  assertPlainObject(record.statementMap, `statement map for ${repoPath}`);
  assertPlainObject(record.s, `statement counts for ${repoPath}`);
  assertPlainObject(record.branchMap, `branch map for ${repoPath}`);
  assertPlainObject(record.b, `branch counts for ${repoPath}`);
  const requireMatchingKeys = (map, counters, label) => {
    const mapKeys = Object.keys(map).sort();
    const counterKeys = Object.keys(counters).sort();
    if (JSON.stringify(mapKeys) !== JSON.stringify(counterKeys)) {
      fail(`${label} map and counters differ for ${repoPath}`);
    }
  };
  requireMatchingKeys(record.statementMap, record.s, "statement");
  requireMatchingKeys(record.branchMap, record.b, "branch");
  const lineHits = new Map();
  for (const [statementId, location] of Object.entries(record.statementMap)) {
    assertPlainObject(location, `statement ${statementId} location for ${repoPath}`);
    assertPlainObject(location.start, `statement ${statementId} start for ${repoPath}`);
    assertInteger(location.start.line, `statement ${statementId} start line for ${repoPath}`, 1);
    const hits = record.s[statementId];
    assertInteger(hits, `statement ${statementId} hits for ${repoPath}`);
    const current = lineHits.get(location.start.line) || 0;
    lineHits.set(location.start.line, Math.max(current, hits));
  }
  let lineCovered = 0;
  for (const hits of lineHits.values()) {
    if (hits > 0) {
      lineCovered += 1;
    }
  }
  let branchTotal = 0;
  let branchCovered = 0;
  for (const [branchId, hits] of Object.entries(record.b)) {
    if (!Array.isArray(hits)) {
      fail(`branch ${branchId} counts for ${repoPath} must be an array`);
    }
    const branch = record.branchMap[branchId];
    assertPlainObject(branch, `branch ${branchId} map for ${repoPath}`);
    if (!Array.isArray(branch.locations) || branch.locations.length !== hits.length) {
      fail(`branch ${branchId} locations and counters differ for ${repoPath}`);
    }
    for (const hit of hits) {
      assertInteger(hit, `branch ${branchId} hit for ${repoPath}`);
      branchTotal += 1;
      if (hit > 0) {
        branchCovered += 1;
      }
    }
  }
  return {
    lines: { covered: lineCovered, total: lineHits.size },
    branches: { covered: branchCovered, total: branchTotal },
  };
}

function sumCoverageRecords(records) {
  const total = {
    lines: { covered: 0, total: 0 },
    branches: { covered: 0, total: 0 },
  };
  for (const record of records) {
    total.lines.covered += record.lines.covered;
    total.lines.total += record.lines.total;
    total.branches.covered += record.branches.covered;
    total.branches.total += record.branches.total;
  }
  return total;
}

function readSummaryMetric(value, label) {
  assertPlainObject(value, label);
  const covered = value.covered;
  const total = value.total;
  assertInteger(covered, `${label}.covered`);
  assertInteger(total, `${label}.total`);
  if (covered > total) {
    fail(`${label}.covered cannot exceed ${label}.total`);
  }
  return { covered, total };
}

function assertThreshold(metric, counts, minimumPercent) {
  assertInteger(counts.covered, `${metric}.covered`);
  assertInteger(counts.total, `${metric}.total`, 1);
  if (counts.covered > counts.total) {
    fail(`${metric}.covered cannot exceed ${metric}.total`);
  }
  if (counts.covered * 100 < counts.total * minimumPercent) {
    fail(
      `${metric} coverage ${counts.covered}/${counts.total} is below ${minimumPercent}%`,
    );
  }
}

function validateCoverageReports(repoRoot, entry, eligible, changedEligible, reportPaths) {
  const coverageFinal = readJsonFile(
    reportPaths.coverageFinal,
    LIMITS.reportBytes,
    `${entry.id} coverage-final report`,
  );
  assertPlainObject(coverageFinal, `${entry.id} coverage-final report`);
  const normalizedRecords = new Map();
  const collisionKeys = new Map();
  for (const [reportedPath, record] of Object.entries(coverageFinal)) {
    const repoPath = coveragePathToRepoPath(
      repoRoot,
      reportedPath,
      `${entry.id} coverage path`,
    );
    const collisionKey = repoPath.normalize("NFC").toLowerCase();
    const prior = collisionKeys.get(collisionKey);
    if (prior !== undefined) {
      fail(`${entry.id} coverage source-map collision: ${prior} and ${reportedPath}`);
    }
    collisionKeys.set(collisionKey, reportedPath);
    if (normalizedRecords.has(repoPath)) {
      fail(`${entry.id} coverage contains duplicate canonical path ${repoPath}`);
    }
    normalizedRecords.set(
      repoPath,
      coverageCountsForFile(record, repoPath, repoRoot),
    );
  }
  const coverageFiles = [...normalizedRecords.keys()].sort();
  assertSortedUniquePaths(coverageFiles, `${entry.id} coverage files`);
  const expected = [...eligible].sort();
  if (
    coverageFiles.length !== expected.length ||
    coverageFiles.some((value, index) => value !== expected[index])
  ) {
    fail(
      `${entry.id} coverage files must equal the complete eligible source set`,
    );
  }
  for (const repoPath of changedEligible) {
    if (!normalizedRecords.has(repoPath)) {
      fail(`${entry.id} changed eligible source is missing from coverage: ${repoPath}`);
    }
  }
  const totals = sumCoverageRecords(normalizedRecords.values());
  assertThreshold("lines", totals.lines, REQUIRED_THRESHOLDS.lines);
  assertThreshold("branches", totals.branches, REQUIRED_THRESHOLDS.branches);

  const summary = readJsonFile(
    reportPaths.coverageSummary,
    LIMITS.reportBytes,
    `${entry.id} coverage-summary report`,
  );
  assertPlainObject(summary, `${entry.id} coverage-summary report`);
  const summaryRecords = new Map();
  for (const [reportedPath, record] of Object.entries(summary)) {
    if (reportedPath === "total") {
      continue;
    }
    assertPlainObject(record, `${entry.id} summary record`);
    const repoPath = coveragePathToRepoPath(
      repoRoot,
      reportedPath,
      `${entry.id} summary coverage path`,
    );
    if (summaryRecords.has(repoPath)) {
      fail(`${entry.id} summary contains duplicate canonical path ${repoPath}`);
    }
    summaryRecords.set(repoPath, {
      lines: readSummaryMetric(record.lines, `${entry.id} summary lines for ${repoPath}`),
      branches: readSummaryMetric(record.branches, `${entry.id} summary branches for ${repoPath}`),
    });
  }
  const summaryFiles = [...summaryRecords.keys()].sort();
  assertSortedUniquePaths(summaryFiles, `${entry.id} summary coverage files`);
  if (
    summaryFiles.length !== coverageFiles.length ||
    summaryFiles.some((value, index) => value !== coverageFiles[index])
  ) {
    fail(`${entry.id} coverage-final and coverage-summary file sets differ`);
  }
  for (const repoPath of coverageFiles) {
    const actual = normalizedRecords.get(repoPath);
    const reported = summaryRecords.get(repoPath);
    if (
      actual.lines.covered !== reported.lines.covered ||
      actual.lines.total !== reported.lines.total ||
      actual.branches.covered !== reported.branches.covered ||
      actual.branches.total !== reported.branches.total
    ) {
      fail(`${entry.id} coverage summary counts differ for ${repoPath}`);
    }
  }
  assertPlainObject(summary.total, `${entry.id} coverage summary total`);
  const summaryTotal = {
    lines: readSummaryMetric(summary.total.lines, `${entry.id} summary total lines`),
    branches: readSummaryMetric(summary.total.branches, `${entry.id} summary total branches`),
  };
  if (
    summaryTotal.lines.covered !== totals.lines.covered ||
    summaryTotal.lines.total !== totals.lines.total ||
    summaryTotal.branches.covered !== totals.branches.covered ||
    summaryTotal.branches.total !== totals.branches.total
  ) {
    fail(`${entry.id} coverage summary totals differ from raw coverage`);
  }
  return { coverageFiles, totals };
}

function parseJestTestResults(
  filePath,
  entryId,
  expectedTestFiles = null,
  repoRoot = null,
) {
  const result = readJsonFile(
    filePath,
    LIMITS.reportBytes,
    `${entryId} Jest test results`,
  );
  assertPlainObject(result, `${entryId} Jest test results`);
  const counts = {
    total: result.numTotalTests,
    passed: result.numPassedTests,
    failed: result.numFailedTests,
    skipped: result.numPendingTests,
    todo: result.numTodoTests,
  };
  for (const [name, value] of Object.entries(counts)) {
    assertInteger(value, `${entryId} tests.${name}`);
  }
  if (
    counts.total === 0 ||
    counts.total !== counts.passed + counts.failed + counts.skipped + counts.todo
  ) {
    fail(`${entryId} test counts are inconsistent`);
  }
  if (counts.failed !== 0 || result.success !== true || result.wasInterrupted === true) {
    fail(`${entryId} test results are not successful`);
  }
  if (counts.skipped !== 0 || counts.todo !== 0) {
    fail(`${entryId} test results contain skipped or todo tests`);
  }
  if (expectedTestFiles !== null) {
    if (!repoRoot || !Array.isArray(result.testResults)) {
      fail(`${entryId} test suite results are incomplete`);
    }
    const expected = [...expectedTestFiles].sort();
    const actual = result.testResults
      .map((suite) => {
        assertPlainObject(suite, `${entryId} test suite`);
        if (
          suite.status !== "passed" ||
          !Array.isArray(suite.assertionResults) ||
          !suite.assertionResults.some((assertion) => assertion.status === "passed")
        ) {
          fail(`${entryId} contains a missing, failed, or wholly skipped test suite`);
        }
        return coveragePathToRepoPath(
          repoRoot,
          suite.name,
          `${entryId} test suite path`,
        );
      })
      .sort();
    assertSortedUniquePaths(actual, `${entryId} executed test suites`);
    if (
      actual.length !== expected.length ||
      actual.some((value, index) => value !== expected[index])
    ) {
      fail(`${entryId} executed test suites do not match tracked test inventory`);
    }
    for (const [field, expectedValue] of [
      ["numTotalTestSuites", expected.length],
      ["numPassedTestSuites", expected.length],
      ["numFailedTestSuites", 0],
      ["numPendingTestSuites", 0],
      ["numRuntimeErrorTestSuites", 0],
    ]) {
      if (result[field] !== expectedValue) {
        fail(`${entryId} test suite count ${field} is inconsistent`);
      }
    }
  }
  return counts;
}

const TAP_SUMMARY_KEYS = Object.freeze([
  "tests",
  "suites",
  "pass",
  "fail",
  "cancelled",
  "skipped",
  "todo",
  "duration_ms",
]);

function parseTapResultDescription(rawDescription) {
  let description = "";
  for (let index = 0; index < rawDescription.length; index += 1) {
    const character = rawDescription[index];
    if (character === "\\" && index + 1 < rawDescription.length) {
      description += rawDescription[index + 1];
      index += 1;
      continue;
    }
    if (character === "#") {
      const remainder = rawDescription.slice(index + 1).trim();
      const directive = /^(skip|todo)\b/i.exec(remainder);
      return {
        raw: rawDescription.slice(0, index).trim(),
        description: description.trim(),
        directive: directive ? directive[1].toLowerCase() : null,
        comment: remainder,
      };
    }
    description += character;
  }
  return {
    raw: rawDescription.trim(),
    description: description.trim(),
    directive: null,
    comment: null,
  };
}

// Node's TAP stream self-reports test names and never emits per-file result
// lines, so the executed test-file set is bound by the trusted command plan
// argv rather than by any name in this document.
function parseTapTestResults(filePath, entryId) {
  const text = readBoundedFile(
    filePath,
    LIMITS.reportBytes,
    `${entryId} TAP test results`,
  ).toString("utf8");
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }
  if (lines.length < TAP_SUMMARY_KEYS.length + 1) {
    fail(`${entryId} TAP results are too short to contain a summary block`);
  }
  const summaryLines = lines.slice(-TAP_SUMMARY_KEYS.length);
  const parsed = {};
  for (const [index, key] of TAP_SUMMARY_KEYS.entries()) {
    const match = /^# ([a-z_]+) ([0-9]+(?:\.[0-9]+)?)$/.exec(summaryLines[index]);
    if (!match || match[1] !== key) {
      fail(
        `${entryId} TAP results must end with one contiguous summary block in the order ${TAP_SUMMARY_KEYS.join(",")}`,
      );
    }
    parsed[key] = Number(match[2]);
  }
  for (const key of TAP_SUMMARY_KEYS) {
    if (key === "duration_ms") {
      continue;
    }
    const occurrences = [
      ...text.matchAll(new RegExp(`^# ${key} [0-9]+$`, "gm")),
    ];
    if (occurrences.length !== 1) {
      fail(`${entryId} TAP results must contain one final ${key} count`);
    }
    assertInteger(parsed[key], `${entryId} TAP ${key}`);
  }
  const body = lines.slice(0, -TAP_SUMMARY_KEYS.length);
  const planMatches = body.filter((line) => /^1\.\.[0-9]+$/.test(line));
  if (planMatches.length !== 1) {
    fail(`${entryId} TAP results must contain exactly one top-level plan line`);
  }
  const planTotal = Number(planMatches[0].slice(3));
  const allResults = [];
  const subtestHeaders = new Map();
  let lastResult = null;
  for (const line of body) {
    const header = /^([ \t]*)# Subtest: (.*)$/.exec(line);
    if (header) {
      const key = `${header[1].length}\u0000${header[2].trim()}`;
      subtestHeaders.set(key, (subtestHeaders.get(key) || 0) + 1);
      continue;
    }
    const match = /^([ \t]*)(not ok|ok) ([0-9]+)(?:[ \t]+-[ \t]*(.*))?$/.exec(line);
    if (match) {
      const parsedResult = parseTapResultDescription(match[4] || "");
      lastResult = {
        depth: match[1].length,
        ok: match[2] === "ok",
        number: Number(match[3]),
        raw: parsedResult.raw,
        description: parsedResult.description,
        directive: parsedResult.directive,
        isSuite: false,
      };
      allResults.push(lastResult);
      continue;
    }
    if (lastResult !== null && /^[ \t]*type:[ \t]*'suite'[ \t]*$/.test(line)) {
      lastResult.isSuite = true;
    }
  }
  for (const result of allResults) {
    const key = `${result.depth}\u0000${result.raw}`;
    const remaining = subtestHeaders.get(key) || 0;
    if (remaining < 1) {
      fail(
        `${entryId} TAP result has no matching subtest header at its own depth: ${result.raw || "(unnamed)"}`,
      );
    }
    subtestHeaders.set(key, remaining - 1);
  }
  const testResults = allResults.filter((result) => !result.isSuite);
  const suiteResults = allResults.filter((result) => result.isSuite);
  const results = allResults.filter((result) => result.depth === 0);
  const directiveCounts = { skip: 0, todo: 0 };
  for (const result of allResults) {
    if (result.directive !== null) {
      directiveCounts[result.directive] += 1;
    }
  }
  if (directiveCounts.skip > 0 || directiveCounts.todo > 0) {
    fail(
      `${entryId} TAP test results contain skipped or todo tests: ` +
        `${directiveCounts.skip} SKIP and ${directiveCounts.todo} TODO directives ` +
        `(summary skipped=${parsed.skipped} todo=${parsed.todo})`,
    );
  }
  if (
    directiveCounts.skip !== parsed.skipped ||
    directiveCounts.todo !== parsed.todo
  ) {
    fail(
      `${entryId} TAP directive counts disagree with the reported summary: ` +
        `directives skipped=${directiveCounts.skip} todo=${directiveCounts.todo}; ` +
        `summary skipped=${parsed.skipped} todo=${parsed.todo}`,
    );
  }
  if (planTotal !== results.length) {
    fail(
      `${entryId} TAP plan and top-level results disagree: plan=${planTotal} top-level=${results.length}`,
    );
  }
  if (parsed.tests !== testResults.length) {
    fail(
      `${entryId} TAP summary and reported results disagree: summary tests=${parsed.tests} test results=${testResults.length}`,
    );
  }
  if (parsed.suites !== suiteResults.length) {
    fail(
      `${entryId} TAP summary and reported suites disagree: summary suites=${parsed.suites} suite results=${suiteResults.length}`,
    );
  }
  for (const [index, result] of results.entries()) {
    if (result.number !== index + 1) {
      fail(`${entryId} TAP top-level results are not sequentially numbered`);
    }
  }
  const failedResults = testResults.filter((result) => !result.ok).length;
  if (failedResults !== parsed.fail + parsed.cancelled) {
    fail(`${entryId} TAP failure count does not match the reported results`);
  }
  if (
    testResults.length - failedResults !==
    parsed.pass + parsed.skipped + parsed.todo
  ) {
    fail(`${entryId} TAP passing results do not match the reported counts`);
  }
  const counts = {
    total: parsed.tests,
    passed: parsed.pass,
    failed: parsed.fail + parsed.cancelled,
    skipped: parsed.skipped,
    todo: parsed.todo,
  };
  if (
    counts.total === 0 ||
    counts.total !== counts.passed + parsed.fail + parsed.cancelled + counts.skipped + counts.todo
  ) {
    fail(`${entryId} TAP test counts are inconsistent`);
  }
  if (counts.failed !== 0) {
    fail(`${entryId} TAP test results are not successful`);
  }
  // A suite aggregate fails when its own hooks fail even though every child
  // test passed and the trailing summary reports zero failures, so failing
  // suites are rejected independently of the counters.
  const failedSuites = suiteResults.filter((result) => !result.ok);
  if (failedSuites.length > 0) {
    fail(
      `${entryId} TAP reports ${failedSuites.length} failing suite aggregate(s) ` +
        `while the summary reports ${parsed.fail + parsed.cancelled} test failures: ` +
        failedSuites.map((result) => result.description).join(","),
    );
  }
  if (counts.skipped !== 0 || counts.todo !== 0) {
    fail(`${entryId} TAP test results contain skipped or todo tests`);
  }
  return counts;
}

function parseTestResults(entry, filePath, expectedTestFiles, repoRoot) {
  return entry.profile === "node-typescript-c8"
    ? parseTapTestResults(filePath, entry.id)
    : parseJestTestResults(
      filePath,
      entry.id,
      expectedTestFiles,
      repoRoot,
    );
}

function lockDependencyVersion(lock, packageName, label) {
  assertPlainObject(lock, label);
  assertPlainObject(lock.packages, `${label}.packages`);
  const record = lock.packages[`node_modules/${packageName}`];
  if (!isPlainObject(record) || typeof record.version !== "string") {
    fail(`${label} does not lock ${packageName}`);
  }
  return record.version;
}

function readToolchain(repoRoot, entry, authoritative, layout = null) {
  const nodeVersion = process.versions.node;
  if (authoritative && nodeVersion !== REQUIRED_NODE_VERSION) {
    fail(`Node ${REQUIRED_NODE_VERSION} is required; found ${nodeVersion}`);
  }
  const npmResult = spawnSync(
    resolveTrustedNpmExecutable(repoRoot, layout),
    ["--version"],
    {
      cwd: repoRoot,
      env: layout
        ? controllerEnvironment(layout)
        : baseEnvironment({ home: os.tmpdir() }),
      encoding: "utf8",
      shell: false,
      maxBuffer: LIMITS.outputBytes,
    },
  );
  if (npmResult.status !== 0) {
    fail("unable to resolve npm version");
  }
  const packageLock = readJsonFile(
    path.join(repoRoot, entry.id, "package-lock.json"),
    LIMITS.reportBytes,
    `${entry.id} package lock`,
  );
  const toolLock = readJsonFile(
    path.join(repoRoot, ...TOOL_LOCK_PATH.split("/")),
    LIMITS.reportBytes,
    "coverage tool lock",
  );
  if (entry.profile === "jest-typescript") {
    const version = lockDependencyVersion(packageLock, "jest", `${entry.id} package lock`);
    return {
      node: nodeVersion,
      npm: npmResult.stdout.trim(),
      testRunner: { name: "jest", version },
      coverageRunner: { name: "jest", version },
    };
  }
  if (entry.profile === "react-scripts") {
    const version = lockDependencyVersion(
      packageLock,
      "react-scripts",
      `${entry.id} package lock`,
    );
    return {
      node: nodeVersion,
      npm: npmResult.stdout.trim(),
      testRunner: { name: "react-scripts", version },
      coverageRunner: { name: "react-scripts", version },
    };
  }
  return {
    node: nodeVersion,
    npm: npmResult.stdout.trim(),
    testRunner: { name: "node", version: nodeVersion },
    coverageRunner: {
      name: "c8",
      version: lockDependencyVersion(toolLock, "c8", "coverage tool lock"),
    },
  };
}

function expectedRunnerIdentity(repoRoot, entry) {
  const packageLock = readJsonFile(
    path.join(repoRoot, entry.id, "package-lock.json"),
    LIMITS.reportBytes,
    `${entry.id} package lock`,
  );
  if (entry.profile === "jest-typescript") {
    const version = lockDependencyVersion(packageLock, "jest", `${entry.id} package lock`);
    return {
      testRunner: { name: "jest", version },
      coverageRunner: { name: "jest", version },
    };
  }
  if (entry.profile === "react-scripts") {
    const version = lockDependencyVersion(
      packageLock,
      "react-scripts",
      `${entry.id} package lock`,
    );
    return {
      testRunner: { name: "react-scripts", version },
      coverageRunner: { name: "react-scripts", version },
    };
  }
  const toolLock = readJsonFile(
    path.join(repoRoot, ...TOOL_LOCK_PATH.split("/")),
    LIMITS.reportBytes,
    "coverage tool lock",
  );
  return {
    testRunner: { name: "node", version: REQUIRED_NODE_VERSION },
    coverageRunner: {
      name: "c8",
      version: lockDependencyVersion(toolLock, "c8", "coverage tool lock"),
    },
  };
}

function sanitizeFailure(error, roots) {
  let message = error instanceof Error ? error.message : String(error);
  for (const [replacement, root] of roots) {
    if (root) {
      message = message.split(root).join(replacement);
    }
  }
  return message
    .replace(/[\x00-\x1f\x7f]+/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .replace(/::/g, ": :")
    .replace(/##\[/g, "# #[")
    .slice(0, 1000);
}

function resolveTrustedNpmExecutable(repoRoot, layout = null) {
  const result = spawnSync("/usr/bin/which", ["npm"], {
    cwd: repoRoot,
    env: layout
      ? controllerEnvironment(layout)
      : baseEnvironment({ home: os.tmpdir() }),
    encoding: "utf8",
    shell: false,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    fail("trusted npm executable could not be resolved");
  }
  const executable = fs.realpathSync(result.stdout.trim());
  const relative = path.relative(fs.realpathSync(repoRoot), executable);
  if (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  ) {
    fail("trusted npm executable must be outside the candidate repository");
  }
  return executable;
}

function resolveCommandDirectory(command, layout, label) {
  if (COMMAND_PLACEHOLDERS.includes(command.workingDirectory)) {
    return substitutePlaceholders(command.workingDirectory, layout, label);
  }
  if (command.workingDirectory === ".") {
    return layout.repo;
  }
  const relative = normalizeRepoPath(command.workingDirectory, label);
  return path.join(layout.repo, ...relative.split("/"));
}

function commandRole(command) {
  const role = command.role || "controller";
  if (!COMMAND_ROLES.includes(role)) {
    fail("command role must be controller or worker");
  }
  return role;
}

function commandIdentity(command, options) {
  const role = commandRole(command);
  if (role === "worker" && options.dropPrivileges === true) {
    return { uid: WORKER_UID, gid: WORKER_GID, umask: WORKER_UMASK };
  }
  return { uid: -1, gid: -1, umask: WORKER_UMASK };
}

function readObservedCommandIdentity(identityReportPath) {
  if (!identityReportPath || !fs.existsSync(identityReportPath)) {
    return null;
  }
  const observed = readJsonFile(
    identityReportPath,
    LIMITS.descriptorBytes,
    "observed command identity",
  );
  assertExactKeys(
    observed,
    [
      "source",
      "uid",
      "euid",
      "gid",
      "egid",
      "groups",
      "noNewPrivs",
      "capEff",
      "capPrm",
      "capAmb",
      "capBnd",
      "capInh",
    ],
    "observed command identity",
  );
  if (!["proc", "supervisor"].includes(observed.source)) {
    fail("observed command identity source is unsupported");
  }
  for (const field of ["uid", "euid", "gid", "egid"]) {
    assertInteger(observed[field], `observed command identity ${field}`);
  }
  if (
    !Array.isArray(observed.groups) ||
    observed.groups.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    fail("observed command identity groups are invalid");
  }
  for (const field of ["capEff", "capPrm", "capAmb", "capBnd", "capInh"]) {
    if (
      observed[field] !== null &&
      (typeof observed[field] !== "string" || !/^[0-9a-f]+$/.test(observed[field]))
    ) {
      fail(`observed command identity ${field} is invalid`);
    }
  }
  if (observed.noNewPrivs !== null && ![0, 1].includes(observed.noNewPrivs)) {
    fail("observed command identity noNewPrivs is invalid");
  }
  return observed;
}

function captureBoundedOutput(value, label) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : "", "utf8");
  if (bytes.length > LIMITS.outputBytes) {
    fail(`${label} exceeded ${LIMITS.outputBytes} bytes`);
  }
  return { bytes, sha256: sha256Bytes(bytes) };
}

function executeCommands(
  repoRoot,
  commands,
  entry,
  records = [],
  options = {},
) {
  if (options.requireLinux === true && process.platform !== "linux") {
    fail("authoritative coverage execution requires Linux process containment");
  }
  const ownedLayout = options.layout
    ? null
    : prepareControlledRoots(
      resolveExecutionLayout({
        repoRoot,
        entryId: entry.id,
        authoritative: false,
      }),
    );
  const layout = options.layout || ownedLayout;
  const inputRoot = options.inputRoot || repoRoot;
  const inputPaths = Array.isArray(options.inputPaths)
    ? options.inputPaths
    : [];
  const watchedInputFiles = inputPaths.map((repoPath) =>
    ensureRegularInRoot(inputRoot, repoPath, `${entry.id} command input`),
  );
  const watchRoot = options.watchRoot
    ? ensureSafeMutationPath(
      inputRoot,
      options.watchRoot,
      `${entry.id} command input root`,
    )
    : null;
  const centralCriticalBins = [{ name: "c8", packageName: "c8", target: "bin/c8.js" }];
  const localCriticalBins = criticalBinsForEntry(entry);
  const snapshotCentralToolchain = () =>
    snapshotInstalledToolchain(
      layout.tool,
      "node_modules",
      centralCriticalBins,
      "central coverage toolchain",
    );
  const snapshotLocalToolchain = () =>
    snapshotInstalledToolchain(
      layout.pkg,
      "node_modules",
      localCriticalBins,
      `${entry.id} installed toolchain`,
      { excludeTopLevel: [".cache"] },
    );
  const trustedNpmExecutable = resolveTrustedNpmExecutable(repoRoot, layout);
  const verifyState = () => {
    if (options.packageInputSnapshot) {
      verifyExecutionFilesystemState(
        repoRoot,
        entry,
        options.packageInputSnapshot,
        options.protectedFileSnapshots || [],
      );
    }
    if (options.stagedInputs) {
      verifyStagedWorkspace(
        entry,
        options.packageInputSnapshot,
        layout,
        options.stagedInputs,
      );
    }
    if (options.supplementalSnapshot) {
      verifyWorkerHomeClosure(repoRoot, options.supplementalSnapshot, layout);
    }
  };
  let centralToolSnapshot = null;
  let localToolSnapshot = null;
  try {
  for (const [index, command] of commands.entries()) {
    verifyState();
    const role = commandRole(command);
    const executable = command.argv[0];
    const isJestCoverage =
      entry.profile === "jest-typescript" &&
      executable.endsWith("/jest") &&
      command.argv.includes("--coverage");
    const isReactTest =
      entry.profile === "react-scripts" &&
      executable.endsWith("/react-scripts") &&
      command.argv[1] === "test";
    const isReactBuild =
      entry.profile === "react-scripts" &&
      executable.endsWith("/react-scripts") &&
      command.argv[1] === "build";
    const isCommonClean =
      entry.profile === "node-typescript-c8" &&
      command.argv[0] === "npm" &&
      command.argv[1] === "run" &&
      command.argv[2] === "clean";
    const isCentralToolInstall =
      role === "controller" &&
      command.workingDirectory === "<TOOL>" &&
      command.argv[0] === "npm" &&
      command.argv[1] === "ci";
    const isLocalToolInstall =
      role === "worker" &&
      command.workingDirectory === "<PKG>" &&
      command.argv[0] === "npm" &&
      command.argv[1] === "ci";
    if (isJestCoverage || isReactTest) {
      fs.rmSync(
        ensureSafeMutationPath(
          layout.workerHome,
          `${entry.id}/coverage`,
          `${entry.id} coverage directory`,
        ),
        { recursive: true, force: true },
      );
    }
    if (isReactBuild || isCommonClean) {
      fs.rmSync(
        ensureSafeMutationPath(
          layout.workerHome,
          `${entry.id}/build`,
          `${entry.id} build directory`,
        ),
        { recursive: true, force: true },
      );
    }
    if (typeof options.beforeCommand === "function") {
      options.beforeCommand(command, index);
    }
    const cwd = resolveCommandDirectory(
      command,
      layout,
      `${entry.id} command working directory`,
    );
    const args = command.argv
      .slice(1)
      .map((argument) =>
        substitutePlaceholders(argument, layout, `${entry.id} command argv`),
      );
    const resolvedExecutable = substitutePlaceholders(
      executable,
      layout,
      `${entry.id} command executable`,
    );
    const actualExecutable =
      executable === "npm" ? trustedNpmExecutable : resolvedExecutable;
    const identityReportPath = layout.identityRoot
      ? path.join(layout.identityRoot, `command-${index}.json`)
      : null;
    if (identityReportPath) {
      fs.rmSync(identityReportPath, { force: true });
    }
    const commandEnvironment = buildCommandEnvironment(layout, role, {
      rawSink: command.rawSink === true,
      continuousIntegration: entry.profile === "react-scripts",
      buildPath: entry.profile === "react-scripts" && isReactBuild,
    });
    const env = { ...commandEnvironment };
    const childEnvironment = {};
    if (Object.prototype.hasOwnProperty.call(env, "NODE_V8_COVERAGE")) {
      childEnvironment.NODE_V8_COVERAGE = env.NODE_V8_COVERAGE;
      delete env.NODE_V8_COVERAGE;
    }
    const protectedRoots = [];
    if (centralToolSnapshot !== null) {
      protectedRoots.push({
        root: ensureSafeMutationPath(
          layout.tool,
          "node_modules",
          "central coverage toolchain",
        ),
        allowedTopLevel: [],
      });
    }
    if (localToolSnapshot !== null) {
      protectedRoots.push({
        root: ensureSafeMutationPath(
          layout.pkg,
          "node_modules",
          `${entry.id} installed toolchain`,
        ),
        allowedTopLevel: [".cache"],
      });
    }
    const supervisorPayload = JSON.stringify({
      executable: actualExecutable,
      args,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: LIMITS.outputBytes,
      inputFiles: watchedInputFiles,
      watchRoot,
      protectedRoots,
      captureStdout: Boolean(command.captureStdout),
      identity: commandIdentity(command, options),
      identityReportPath,
      childEnvironment,
    });
    const linuxSupervisor = process.platform === "linux";
    const supervisorExecutable = linuxSupervisor ? "/usr/bin/python3" : process.execPath;
    const supervisorArgs = linuxSupervisor
      ? [
        "-I", "-S", "-c", COMMAND_SUBREAPER_BOOTSTRAP,
        process.execPath, "-e", COMMAND_SUPERVISOR_SOURCE, supervisorPayload,
      ]
      : ["-e", COMMAND_SUPERVISOR_SOURCE, supervisorPayload];
    const result = spawnSync(
      supervisorExecutable,
      supervisorArgs,
      {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        maxBuffer: LIMITS.outputBytes + 1024 * 1024,
        timeout: command.timeoutMs + COMMAND_KILL_GRACE_MS + 10_000,
        killSignal: "SIGKILL",
      },
    );
    const supervisorTimedOut = result.error?.code === "ETIMEDOUT";
    const exitCode = supervisorTimedOut
      ? 124
      : typeof result.status === "number"
        ? result.status
        : result.error
          ? 127
          : 1;
    const stdout = captureBoundedOutput(
      result.stdout,
      `${entry.id} command output`,
    );
    const stderr = captureBoundedOutput(
      result.stderr,
      `${entry.id} command diagnostics`,
    );
    const observed = readObservedCommandIdentity(identityReportPath);
    if (options.requireObservedIdentity === true) {
      if (observed === null) {
        fail(
          `${entry.id} command ${index} did not record an observed execution identity`,
        );
      }
      assertObservedIdentityRecord(
        observedIdentityRecord(observed),
        `${entry.id} command ${index} (${role}) identity`,
        expectedIdentityForRole(role),
      );
    }
    const record = {
      role,
      uid:
        observed !== null
          ? observed.uid
          : command.uid ?? (role === "controller" ? CONTROLLER_UID : WORKER_UID),
      workingDirectory: command.workingDirectory,
      argv: [...command.argv],
      exitCode,
      identity: observed === null ? null : observedIdentityRecord(observed),
    };
    records.push(record);
    if (options.output) {
      options.output.stdout = stdout;
      options.output.stderr = stderr;
    }
    verifyState();
    if (isCentralToolInstall && exitCode === 0) {
      centralToolSnapshot = snapshotCentralToolchain();
    }
    if (isLocalToolInstall && exitCode === 0) {
      localToolSnapshot = snapshotLocalToolchain();
    }
    if (command.captureStdout && options.capture) {
      writeFileSafely(
        options.capture.stdoutPath,
        stdout.bytes,
        "captured worker output",
      );
      if (options.capture.stderrPath) {
        writeFileSafely(
          options.capture.stderrPath,
          stderr.bytes,
          "captured worker diagnostics",
        );
      }
      verifyState();
    }
    if (exitCode !== 0) {
      if (options.capture && options.capture.diagnosticsPrefix) {
        for (const [stream, captured] of [
          ["stdout", stdout],
          ["stderr", stderr],
        ]) {
          writeFileSafely(
            `${options.capture.diagnosticsPrefix}-${stream}.log`,
            captured.bytes,
            `failed command ${stream}`,
          );
        }
      }
      if (exitCode === 124) {
        fail(`${entry.id} command timed out after ${command.timeoutMs}ms`);
      }
      if (exitCode === 125) {
        fail(`${entry.id} command output exceeded ${LIMITS.outputBytes} bytes`);
      }
      fail(
        `${entry.id} command ${index} (${role}) failed with exit ${exitCode}; ` +
          `stdout ${stdout.bytes.length} bytes sha256 ${stdout.sha256}; ` +
          `stderr ${stderr.bytes.length} bytes sha256 ${stderr.sha256}; ` +
          `spawn ${result.error ? result.error.code || "error" : "ok"}; ` +
          "captured output is retained only in the controller-owned artifact " +
          "directory",
      );
    }
    if (typeof options.afterCommand === "function") {
      options.afterCommand(command, index, record);
    }
  }
  if (centralToolSnapshot !== null) {
    if (snapshotCentralToolchain() !== centralToolSnapshot) {
      fail("central coverage toolchain changed after command execution");
    }
  }
  if (localToolSnapshot !== null) {
    if (snapshotLocalToolchain() !== localToolSnapshot) {
      fail(`${entry.id} installed toolchain changed after command execution`);
    }
  }
  verifyState();
  return records;
  } finally {
    releaseExecutionLayout(ownedLayout);
  }
}

function copyReportFile(sourceAbsolute, targetAbsolute, label) {
  const stat = fs.lstatSync(sourceAbsolute, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular file`);
  }
  const bytes = readBoundedFile(sourceAbsolute, LIMITS.reportBytes, label);
  writeFileSafely(targetAbsolute, bytes, label);
  return targetAbsolute;
}

function buildEvidence({
  repoRoot,
  context,
  prepared,
  commands,
  toolchain,
  reportFiles,
  coverageResult,
  tests,
  status,
  failures,
  execution,
}) {
  const packageLockPath = `${prepared.entry.id}/package-lock.json`;
  const packageLockAbsolute = ensureRegularInRoot(
    repoRoot,
    packageLockPath,
    `${prepared.entry.id} package lock`,
  );
  const reports = {
    coverageFinalSha256: reportFiles.coverageFinal
      ? sha256File(reportFiles.coverageFinal, LIMITS.reportBytes, "coverage-final report")
      : null,
    coverageSummarySha256: reportFiles.coverageSummary
      ? sha256File(reportFiles.coverageSummary, LIMITS.reportBytes, "coverage-summary report")
      : null,
    testResultsSha256: reportFiles.testResults
      ? sha256File(reportFiles.testResults, LIMITS.reportBytes, "test results")
      : null,
  };
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    status,
    package: {
      id: prepared.entry.id,
      profile: prepared.entry.profile,
    },
    repository: {
      event: context.repository.event,
      baseSha: context.repository.baseSha,
      headSha: context.repository.headSha,
      mergeSnapshotSha: context.repository.mergeSnapshotSha,
      checkoutSha: context.repository.checkoutSha,
      runId: context.repository.runId,
      runAttempt: context.repository.runAttempt,
    },
    workflow: { ...context.workflow },
    engine: {
      trustedDefaultSha: context.engine.trustedDefaultSha,
      validatorPath: ENGINE_PATH,
      validatorGitBlob: prepared.trustedAssets.validator.gitBlob,
      validatorSha256: prepared.trustedAssets.validator.sha256,
      toolLockPath: TOOL_LOCK_PATH,
      toolLockSha256: prepared.trustedAssets.toolLock.sha256,
    },
    descriptor: {
      path: DESCRIPTOR_PATH,
      gitBlob: prepared.trustedAssets.descriptor.gitBlob,
      sha256: prepared.trustedAssets.descriptor.sha256,
    },
    sources: {
      eligible: [...prepared.eligible],
      changedEligible: [...prepared.changedEligible],
      deletedEligible: [...prepared.deletedEligible],
      coverageFiles: coverageResult ? [...coverageResult.coverageFiles] : [],
    },
    coverage: {
      lines: {
        covered: coverageResult ? coverageResult.totals.lines.covered : 0,
        total: coverageResult ? coverageResult.totals.lines.total : 0,
        minimumPercent: REQUIRED_THRESHOLDS.lines,
      },
      branches: {
        covered: coverageResult ? coverageResult.totals.branches.covered : 0,
        total: coverageResult ? coverageResult.totals.branches.total : 0,
        minimumPercent: REQUIRED_THRESHOLDS.branches,
      },
    },
    tests: tests || { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    locks: [
      {
        path: packageLockPath,
        sha256: sha256File(
          packageLockAbsolute,
          LIMITS.reportBytes,
          `${prepared.entry.id} package lock`,
        ),
      },
    ],
    toolchain,
    commands,
    reports,
    execution: buildExecutionRecord(context, execution),
    failures,
  };
}

function observedIdentityRecord(identity) {
  if (!identity) {
    return null;
  }
  return {
    source: identity.source,
    uid: identity.uid,
    euid: identity.euid,
    gid: identity.gid,
    egid: identity.egid,
    supplementaryGroups: [
      ...(identity.supplementaryGroups || identity.groups || []),
    ],
    noNewPrivs: identity.noNewPrivs,
    capEff: identity.capEff,
    capPrm: identity.capPrm,
    capAmb: identity.capAmb,
    capBnd: identity.capBnd,
    capInh: identity.capInh,
  };
}

function buildExecutionRecord(context, execution) {
  const source = execution || {};
  return {
    container: {
      imageDigest:
        context && context.container && typeof context.container.imageDigest === "string"
          ? context.container.imageDigest
          : null,
    },
    controller: observedIdentityRecord(source.controllerIdentity),
    worker: observedIdentityRecord(source.workerIdentity),
    supplemental: {
      fileCount: Array.isArray(source.supplemental) ? source.supplemental.length : 0,
      files: Array.isArray(source.supplemental)
        ? source.supplemental.map((file) => ({ ...file }))
        : [],
    },
    rawSink: {
      fileCount: Array.isArray(source.rawFiles) ? source.rawFiles.length : 0,
      files: Array.isArray(source.rawFiles)
        ? source.rawFiles.map((file) => ({ ...file }))
        : [],
    },
    report: {
      root: "<REPORT>",
      outputRoot: "<OUT>",
      sha256: typeof source.reportSha256 === "string" ? source.reportSha256 : null,
    },
    stdout: {
      bytes: source.stdout ? source.stdout.bytes : 0,
      sha256: source.stdout ? source.stdout.sha256 : sha256Bytes(Buffer.alloc(0)),
    },
    stderr: {
      bytes: source.stderr ? source.stderr.bytes : 0,
      sha256: source.stderr ? source.stderr.sha256 : sha256Bytes(Buffer.alloc(0)),
    },
    limitation: EVIDENCE_LIMITATION,
  };
}

function writeJson(filePath, value, maximumBytes = LIMITS.evidenceBytes) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > maximumBytes) {
    fail(`JSON output exceeds ${maximumBytes} bytes`);
  }
  writeFileSafely(filePath, bytes, "JSON output");
}

function runPreparedEntry(options) {
  const {
    repoRoot,
    trustedRoot,
    context,
    prepared,
    layout,
    authoritative,
  } = options;
  const id = prepared.entry.id;
  const commands = [];
  let toolchain = {
    node: process.versions.node,
    npm: "unavailable",
    testRunner: { name: "unavailable", version: "unavailable" },
    coverageRunner: { name: "unavailable", version: "unavailable" },
  };
  let coverageResult = null;
  let tests = null;
  const failures = [];
  const reportFiles = {
    coverageFinal: null,
    coverageSummary: null,
    testResults: null,
  };
  const execution = {
    controllerIdentity: null,
    workerIdentity: null,
    supplemental: prepared.supplementalSnapshot
      ? prepared.supplementalSnapshot.records.map((record) => ({
        path: record.path,
        gitBlob: record.gitBlob,
        bytes: record.byteLength,
        sha256: record.sha256,
      }))
      : [],
    rawFiles: [],
    stdout: null,
    stderr: null,
    reportSha256: null,
  };
  const output = {};
  const isSplitProfile = prepared.entry.profile === "node-typescript-c8";
  const capture = {
    stdoutPath: path.join(layout.artifactDirectory, "test-results.tap"),
    stderrPath: path.join(layout.artifactDirectory, "worker-stderr.log"),
    diagnosticsPrefix: path.join(layout.artifactDirectory, "failed-command"),
  };
  let frozenDigest = null;
  try {
    toolchain = readToolchain(repoRoot, prepared.entry, authoritative, layout);
    if (authoritative) {
      stageControllerToolchain(prepared.trustedAssets.root, layout);
    }
    const staged = authoritative
      ? stageWorkerPackage(
        repoRoot,
        prepared.entry,
        prepared.packageInputSnapshot,
        layout,
      )
      : null;
    if (authoritative) {
      stageSupplementalInputs(repoRoot, prepared.supplementalSnapshot, layout);
    }
    if (authoritative) {
      sealGitAccess();
    }
    executeCommands(
      repoRoot,
      prepared.commands,
      prepared.entry,
      commands,
      {
        layout,
        requireLinux: authoritative,
        dropPrivileges: authoritative,
        inputRoot: authoritative ? layout.workerHome : repoRoot,
        inputPaths: authoritative ? prepared.packageInputs : [],
        watchRoot: authoritative ? prepared.entry.id : null,
        packageInputSnapshot: authoritative
          ? prepared.packageInputSnapshot
          : null,
        protectedFileSnapshots: authoritative
          ? prepared.protectedFileSnapshots
          : [],
        stagedInputs: staged,
        supplementalSnapshot: authoritative ? prepared.supplementalSnapshot : null,
        requireObservedIdentity: authoritative,
        capture,
        output,
        beforeCommand: (command) => {
          if (command.reportOutput !== true) {
            return;
          }
          const discoveryBoundary = authoritative ? null : layout.repo;
          assertNoCoverageDiscovery(
            layout.pkg,
            [layout.pkg, layout.tool],
            "coverage report discovery path",
            { stopAt: discoveryBoundary },
          );
          assertNoCoverageDiscovery(
            layout.tool,
            [layout.pkg, layout.tool],
            "coverage tool discovery path",
            { stopAt: discoveryBoundary },
          );
          assertEmptyDirectory(layout.report, "coverage report root");
          if (authoritative) {
            assertControlledDirectory(layout.report, "coverage report root", {
              uid: CONTROLLER_UID,
              gid: CONTROLLER_GID,
            });
            assertControlledDirectory(layout.frozen, "frozen coverage root", {
              uid: CONTROLLER_UID,
              gid: CONTROLLER_GID,
            });
          }
          if (hashFrozenCoverage(layout) !== frozenDigest) {
            fail("frozen coverage data changed before report generation");
          }
        },
        afterCommand: (command, index, record) => {
          if (record && record.identity !== null && record.identity !== undefined) {
            if (record.role === "worker") {
              execution.workerIdentity = record.identity;
            } else {
              execution.controllerIdentity = record.identity;
            }
          }
          if (command.rawSink === true) {
            execution.stdout = {
              bytes: output.stdout.bytes.length,
              sha256: output.stdout.sha256,
            };
            execution.stderr = {
              bytes: output.stderr.bytes.length,
              sha256: output.stderr.sha256,
            };
            if (authoritative) {
              freezeStagedWorkspace(layout);
              verifyWorkerHomeClosure(
                repoRoot,
                prepared.supplementalSnapshot,
                layout,
              );
            }
            execution.rawFiles = freezeRawCoverage(layout);
            frozenDigest = hashFrozenCoverage(layout);
          }
          if (command.reportOutput === true) {
            if (hashFrozenCoverage(layout) !== frozenDigest) {
              fail("frozen coverage data changed during report generation");
            }
          }
        },
      },
    );
    const reportRoot = isSplitProfile
      ? layout.report
      : path.join(layout.pkg, "coverage");
    reportFiles.coverageFinal = copyReportFile(
      path.join(reportRoot, "coverage-final.json"),
      path.join(layout.artifactDirectory, "coverage-final.json"),
      `${id} coverage-final report`,
    );
    reportFiles.coverageSummary = copyReportFile(
      path.join(reportRoot, "coverage-summary.json"),
      path.join(layout.artifactDirectory, "coverage-summary.json"),
      `${id} coverage-summary report`,
    );
    if (isSplitProfile) {
      reportFiles.testResults = capture.stdoutPath;
    } else {
      reportFiles.testResults = copyReportFile(
        path.join(reportRoot, "test-results.json"),
        path.join(layout.artifactDirectory, "test-results.json"),
        `${id} test results`,
      );
    }
    execution.reportSha256 = sha256File(
      reportFiles.coverageFinal,
      LIMITS.reportBytes,
      `${id} coverage-final report`,
    );
    coverageResult = validateCoverageReports(
      layout.coverageRoot,
      prepared.entry,
      prepared.eligible,
      prepared.changedEligible,
      reportFiles,
    );
    tests = parseTestResults(
      prepared.entry,
      reportFiles.testResults,
      prepared.testFiles,
      layout.coverageRoot,
    );
    if (authoritative) {
      verifyPreparedFilesystemState(repoRoot, prepared);
    }
  } catch (error) {
    failures.push(
      sanitizeFailure(error, [
        ["<repo>", repoRoot],
        ["<trusted>", trustedRoot],
        ["<out>", layout.out],
        ["<home>", layout.workerHome],
        ["<tool>", layout.tool],
      ]),
    );
  }
  return {
    commands,
    toolchain,
    coverageResult,
    tests,
    failures,
    reportFiles,
    execution,
  };
}

function executeEntry(
  repoRoot,
  trustedRoot,
  context,
  id,
  authoritative = true,
  options = {},
) {
  if (authoritative && process.platform !== "linux") {
    fail("authoritative coverage execution requires Linux process containment");
  }
  if (authoritative && !ENFORCED_PACKAGE_IDS.includes(id)) {
    fail(
      `authoritative coverage runs are limited to ${ENFORCED_PACKAGE_IDS.join(",")}`,
    );
  }
  const layout = resolveExecutionLayout({
    repoRoot,
    entryId: id,
    authoritative,
    outputRoot: options.outputRoot,
  });
  if (authoritative) {
    assertAuthoritativeContainer(layout);
  }
  const prepared = prepareEntry(repoRoot, trustedRoot, context, id);
  fs.rmSync(layout.artifactDirectory, { recursive: true, force: true });
  fs.mkdirSync(layout.artifactDirectory, { recursive: true, mode: 0o700 });
  prepareControlledRoots(layout);
  const result = runPreparedEntry({
    repoRoot,
    trustedRoot,
    context,
    prepared,
    layout,
    authoritative,
  });
  const evidence = buildEvidence({
    repoRoot,
    context,
    prepared,
    commands: result.commands,
    toolchain: result.toolchain,
    reportFiles: result.reportFiles,
    coverageResult: result.coverageResult,
    tests: result.tests,
    status: result.failures.length === 0 ? "success" : "failure",
    failures: result.failures,
    execution: result.execution,
  });
  const evidencePath = path.join(layout.artifactDirectory, "evidence.json");
  writeJson(evidencePath, evidence);
  if (authoritative) {
    verifyPreparedFilesystemState(repoRoot, prepared);
  }
  if (result.failures.length > 0) {
    releaseExecutionLayout(layout);
    fail(`${id} coverage run failed: ${result.failures.join("; ")}`);
  }
  validateEvidenceAgainstPrepared(repoRoot, context, evidence, prepared, {
    artifactDirectory: layout.artifactDirectory,
  });
  if (authoritative) {
    verifyPreparedFilesystemState(repoRoot, prepared);
  }
  releaseExecutionLayout(layout);
  return evidence;
}

function assertCoverageMetric(metric, value, expectedMinimum) {
  assertExactKeys(
    value,
    ["covered", "total", "minimumPercent"],
    `evidence coverage.${metric}`,
  );
  assertInteger(value.covered, `evidence coverage.${metric}.covered`);
  assertInteger(value.total, `evidence coverage.${metric}.total`, 1);
  if (value.minimumPercent !== expectedMinimum) {
    fail(`evidence coverage.${metric}.minimumPercent is invalid`);
  }
  assertThreshold(metric, value, expectedMinimum);
}

function assertEvidenceIdentity(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} does not match the current run`);
  }
}

function validateCommandRecords(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    fail("evidence commands do not match the fixed profile");
  }
  for (let index = 0; index < expected.length; index += 1) {
    assertExactKeys(
      actual[index],
      ["role", "uid", "workingDirectory", "argv", "exitCode", "identity"],
      `evidence commands[${index}]`,
    );
    if (!COMMAND_ROLES.includes(actual[index].role)) {
      fail(`evidence commands[${index}].role is not a supported execution role`);
    }
    if (
      actual[index].role !== expected[index].role ||
      actual[index].uid !== expected[index].uid ||
      actual[index].workingDirectory !== expected[index].workingDirectory ||
      JSON.stringify(actual[index].argv) !== JSON.stringify(expected[index].argv)
    ) {
      fail("evidence contains a command outside the fixed profile");
    }
    const expectedIdentity = expectedIdentityForRole(expected[index].role);
    assertObservedIdentityRecord(
      actual[index].identity,
      `evidence commands[${index}].identity`,
      expectedIdentity,
    );
    if (actual[index].identity.uid !== actual[index].uid) {
      fail(`evidence commands[${index}].uid does not match the observed identity`);
    }
    assertCommandToken(
      actual[index].workingDirectory,
      `evidence commands[${index}].workingDirectory`,
    );
    if (!Array.isArray(actual[index].argv) || actual[index].argv.length === 0) {
      fail(`evidence commands[${index}].argv must be a non-empty array`);
    }
    for (const argument of actual[index].argv) {
      assertCommandToken(argument, `evidence commands[${index}].argv`);
    }
    assertInteger(actual[index].exitCode, `evidence commands[${index}].exitCode`);
    if (actual[index].exitCode !== 0) {
      fail("successful evidence contains a failed command");
    }
  }
}

function assertObservedIdentityRecord(value, label, expectedIdentity) {
  assertExactKeys(
    value,
    [
      "source",
      "uid",
      "euid",
      "gid",
      "egid",
      "supplementaryGroups",
      "noNewPrivs",
      "capEff",
      "capPrm",
      "capAmb",
      "capBnd",
      "capInh",
    ],
    label,
  );
  if (value.source !== "proc") {
    fail(`${label} must be observed from the container process table`);
  }
  for (const field of ["uid", "euid", "gid", "egid"]) {
    assertInteger(value[field], `${label}.${field}`);
  }
  if (
    value.uid !== expectedIdentity.uid ||
    value.euid !== expectedIdentity.uid ||
    value.gid !== expectedIdentity.gid ||
    value.egid !== expectedIdentity.gid
  ) {
    fail(
      `${label} must be uid ${expectedIdentity.uid} and gid ${expectedIdentity.gid}`,
    );
  }
  if (!Array.isArray(value.supplementaryGroups)) {
    fail(`${label}.supplementaryGroups must be an array`);
  }
  const extraGroups = value.supplementaryGroups.filter(
    (group) => group !== expectedIdentity.gid,
  );
  if (expectedIdentity.requireEmptyGroups === true && extraGroups.length !== 0) {
    fail(`${label} must not retain supplementary groups`);
  }
  if (expectedIdentity.requireNoNewPrivs === true && value.noNewPrivs !== 1) {
    fail(`${label} must run with no_new_privs enabled`);
  }
  for (const field of ["capEff", "capPrm", "capAmb"]) {
    if (typeof value[field] !== "string" || !/^[0-9a-f]+$/.test(value[field])) {
      fail(`${label}.${field} must be a hexadecimal capability mask`);
    }
    if (
      expectedIdentity.requireEmptyCapabilities === true &&
      /[^0]/.test(value[field])
    ) {
      fail(`${label} must not retain ${field} capabilities`);
    }
  }
  for (const field of ["capBnd", "capInh"]) {
    if (typeof value[field] !== "string" || !/^[0-9a-f]+$/.test(value[field])) {
      fail(`${label}.${field} must be a hexadecimal capability mask`);
    }
  }
  if (expectedIdentity.requireControllerCapabilities === true) {
    assertControllerCapabilityContract(value, label);
  }
  if (expectedIdentity.requireEmptyInheritable === true) {
    if (parseCapabilityMask(value.capInh, `${label}.capInh`) !== 0n) {
      fail(`${label} must not retain inheritable capabilities; found ${value.capInh}`);
    }
  }
  if (expectedIdentity.requireControllerBoundingMask === true) {
    const expectedBounding = parseCapabilityMask(
      CONTROLLER_CAPABILITY_MASK,
      "controller capability contract",
    );
    if (parseCapabilityMask(value.capBnd, `${label}.capBnd`) !== expectedBounding) {
      fail(
        `${label}.capBnd must equal the inherited controller mask ${CONTROLLER_CAPABILITY_MASK}; found ${value.capBnd}`,
      );
    }
  }
  return value;
}

function expectedIdentityForRole(role) {
  if (role === "worker") {
    return {
      uid: WORKER_UID,
      gid: WORKER_GID,
      requireEmptyGroups: true,
      requireNoNewPrivs: true,
      requireEmptyCapabilities: true,
      requireEmptyInheritable: true,
      requireControllerBoundingMask: true,
    };
  }
  return {
    uid: CONTROLLER_UID,
    gid: CONTROLLER_GID,
    requireControllerCapabilities: true,
  };
}

function validateExecutionRecord(evidence, context, expected) {
  assertExactKeys(
    evidence.execution,
    [
      "container",
      "controller",
      "worker",
      "supplemental",
      "rawSink",
      "report",
      "stdout",
      "stderr",
      "limitation",
    ],
    "evidence execution",
  );
  const execution = evidence.execution;
  assertExactKeys(execution.container, ["imageDigest"], "evidence execution container");
  const contextDigest =
    context && context.container ? context.container.imageDigest : null;
  if (
    execution.container.imageDigest !== (contextDigest ?? null) ||
    (execution.container.imageDigest !== null &&
      !/^sha256:[0-9a-f]{64}$/.test(execution.container.imageDigest))
  ) {
    fail("evidence execution container digest does not match the run context");
  }
  assertObservedIdentityRecord(
    execution.controller,
    "evidence execution controller identity",
    expectedIdentityForRole("controller"),
  );
  assertObservedIdentityRecord(
    execution.worker,
    "evidence execution worker identity",
    expectedIdentityForRole("worker"),
  );
  assertExactKeys(
    execution.supplemental,
    ["fileCount", "files"],
    "evidence execution supplemental",
  );
  const expectedSupplemental = expected && Array.isArray(expected.supplemental)
    ? expected.supplemental
    : null;
  if (
    !Array.isArray(execution.supplemental.files) ||
    execution.supplemental.files.length !== execution.supplemental.fileCount
  ) {
    fail("evidence execution supplemental inventory is inconsistent");
  }
  let previousSupplemental = null;
  for (const file of execution.supplemental.files) {
    assertExactKeys(
      file,
      ["path", "gitBlob", "bytes", "sha256"],
      "evidence execution supplemental file",
    );
    normalizeRepoPath(file.path, "evidence execution supplemental path");
    if (
      !SUPPLEMENTAL_MANIFEST_FILES.includes(path.posix.basename(file.path)) ||
      file.path.split("/").length !== 2
    ) {
      fail("evidence execution supplemental path is outside the fixed manifest set");
    }
    if (previousSupplemental !== null && previousSupplemental >= file.path) {
      fail("evidence execution supplemental inventory must be sorted and unique");
    }
    previousSupplemental = file.path;
    assertSha(file.gitBlob, "evidence execution supplemental gitBlob");
    assertInteger(file.bytes, "evidence execution supplemental bytes", 1);
    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail("evidence execution supplemental digest must be a SHA-256 value");
    }
  }
  if (expectedSupplemental !== null) {
    assertEvidenceIdentity(
      execution.supplemental.files,
      expectedSupplemental.map((record) => ({
        path: record.path,
        gitBlob: record.gitBlob,
        bytes: record.byteLength,
        sha256: record.sha256,
      })),
      "evidence execution supplemental inventory",
    );
    if (execution.supplemental.fileCount !== expectedSupplemental.length) {
      fail("evidence execution supplemental count does not match the exact checkout");
    }
  }
  assertExactKeys(execution.rawSink, ["fileCount", "files"], "evidence execution rawSink");
  assertInteger(
    execution.rawSink.fileCount,
    "evidence execution rawSink.fileCount",
    expected && expected.profile === "node-typescript-c8" ? 1 : 0,
  );
  if (
    !Array.isArray(execution.rawSink.files) ||
    execution.rawSink.files.length !== execution.rawSink.fileCount ||
    execution.rawSink.files.length > LIMITS.rawCoverageFiles
  ) {
    fail("evidence execution raw coverage inventory is inconsistent");
  }
  let previousName = null;
  let rawTotalBytes = 0;
  for (const file of execution.rawSink.files) {
    assertExactKeys(file, ["name", "bytes", "sha256"], "evidence execution raw file");
    if (typeof file.name !== "string" || !RAW_COVERAGE_FILE_PATTERN.test(file.name)) {
      fail("evidence execution raw coverage file name is unexpected");
    }
    if (previousName !== null && previousName >= file.name) {
      fail("evidence execution raw coverage inventory must be sorted and unique");
    }
    previousName = file.name;
    assertInteger(file.bytes, "evidence execution raw file bytes", 1);
    if (file.bytes > LIMITS.rawCoverageFileBytes) {
      fail(
        `evidence execution raw file exceeds ${LIMITS.rawCoverageFileBytes} bytes`,
      );
    }
    rawTotalBytes += file.bytes;
    if (rawTotalBytes > LIMITS.rawCoverageTotalBytes) {
      fail(
        `evidence execution raw coverage exceeds ${LIMITS.rawCoverageTotalBytes} bytes`,
      );
    }
    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail("evidence execution raw file digest must be a SHA-256 value");
    }
  }
  assertExactKeys(
    execution.report,
    ["root", "outputRoot", "sha256"],
    "evidence execution report",
  );
  if (execution.report.root !== "<REPORT>" || execution.report.outputRoot !== "<OUT>") {
    fail("evidence execution report identity must use closed placeholders");
  }
  if (
    typeof execution.report.sha256 !== "string" ||
    execution.report.sha256 !== evidence.reports.coverageFinalSha256
  ) {
    fail("evidence execution report digest does not match the copied report");
  }
  for (const stream of ["stdout", "stderr"]) {
    assertExactKeys(execution[stream], ["bytes", "sha256"], `evidence execution ${stream}`);
    assertInteger(execution[stream].bytes, `evidence execution ${stream}.bytes`);
    if (
      typeof execution[stream].sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(execution[stream].sha256)
    ) {
      fail(`evidence execution ${stream} digest must be a SHA-256 value`);
    }
    if (execution[stream].bytes > LIMITS.outputBytes) {
      fail(`evidence execution ${stream} exceeds the captured output bound`);
    }
  }
  if (execution.limitation !== EVIDENCE_LIMITATION) {
    fail("evidence execution must retain the accepted provenance limitation");
  }
  if (expected && expected.profile === "node-typescript-c8") {
    if (execution.stdout.bytes === 0) {
      fail("evidence execution stdout must record captured worker output");
    }
    if (execution.stdout.sha256 !== expected.testResultsSha256) {
      fail("evidence execution stdout digest does not match the captured test results");
    }
    if (expected.artifactDirectory) {
      const tapPath = path.join(expected.artifactDirectory, "test-results.tap");
      const tapBytes = readBoundedFile(
        tapPath,
        LIMITS.reportBytes,
        "captured worker output",
      );
      if (
        tapBytes.length !== execution.stdout.bytes ||
        sha256Bytes(tapBytes) !== execution.stdout.sha256
      ) {
        fail(
          "evidence execution stdout does not reconcile with the captured TAP artifact",
        );
      }
      const stderrPath = path.join(expected.artifactDirectory, "worker-stderr.log");
      const stderrBytes = readBoundedFile(
        stderrPath,
        LIMITS.reportBytes,
        "captured worker diagnostics",
      );
      if (
        stderrBytes.length !== execution.stderr.bytes ||
        sha256Bytes(stderrBytes) !== execution.stderr.sha256
      ) {
        fail(
          "evidence execution stderr does not reconcile with the captured diagnostics artifact",
        );
      }
    }
  }
  return execution;
}

function validateEvidenceAgainstPrepared(
  repoRoot,
  context,
  evidence,
  prepared,
  options = {},
) {
  assertExactKeys(evidence, EVIDENCE_KEYS, "evidence");
  if (
    evidence.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    evidence.status !== "success"
  ) {
    fail(
      `evidence must be schema version ${EVIDENCE_SCHEMA_VERSION} with success status`,
    );
  }
  assertExactKeys(evidence.package, ["id", "profile"], "evidence package");
  if (
    evidence.package.id !== prepared.entry.id ||
    evidence.package.profile !== prepared.entry.profile
  ) {
    fail("evidence package profile does not match the descriptor");
  }
  const expectedRepository = {
    event: context.repository.event,
    baseSha: context.repository.baseSha,
    headSha: context.repository.headSha,
    mergeSnapshotSha: context.repository.mergeSnapshotSha,
    checkoutSha: context.repository.checkoutSha,
    runId: context.repository.runId,
    runAttempt: context.repository.runAttempt,
  };
  assertEvidenceIdentity(
    evidence.repository,
    expectedRepository,
    "evidence repository identity",
  );
  assertEvidenceIdentity(
    evidence.workflow,
    context.workflow,
    "evidence workflow identity",
  );
  assertExactKeys(
    evidence.engine,
    [
      "trustedDefaultSha",
      "validatorPath",
      "validatorGitBlob",
      "validatorSha256",
      "toolLockPath",
      "toolLockSha256",
    ],
    "evidence engine",
  );
  assertEvidenceIdentity(
    evidence.engine,
    {
      trustedDefaultSha: context.engine.trustedDefaultSha,
      validatorPath: ENGINE_PATH,
      validatorGitBlob: prepared.trustedAssets.validator.gitBlob,
      validatorSha256: prepared.trustedAssets.validator.sha256,
      toolLockPath: TOOL_LOCK_PATH,
      toolLockSha256: prepared.trustedAssets.toolLock.sha256,
    },
    "evidence engine identity",
  );
  assertExactKeys(
    evidence.descriptor,
    ["path", "gitBlob", "sha256"],
    "evidence descriptor",
  );
  assertEvidenceIdentity(
    evidence.descriptor,
    {
      path: DESCRIPTOR_PATH,
      gitBlob: prepared.trustedAssets.descriptor.gitBlob,
      sha256: prepared.trustedAssets.descriptor.sha256,
    },
    "evidence descriptor identity",
  );
  assertExactKeys(
    evidence.sources,
    ["eligible", "changedEligible", "deletedEligible", "coverageFiles"],
    "evidence sources",
  );
  for (const field of [
    "eligible",
    "changedEligible",
    "deletedEligible",
    "coverageFiles",
  ]) {
    assertSortedUniquePaths(
      evidence.sources[field],
      `evidence sources.${field}`,
    );
  }
  assertEvidenceIdentity(
    evidence.sources.eligible,
    prepared.eligible,
    "evidence eligible source set",
  );
  assertEvidenceIdentity(
    evidence.sources.changedEligible,
    prepared.changedEligible,
    "evidence changed source set",
  );
  assertEvidenceIdentity(
    evidence.sources.deletedEligible,
    prepared.deletedEligible,
    "evidence deleted source set",
  );
  assertEvidenceIdentity(
    evidence.sources.coverageFiles,
    prepared.eligible,
    "evidence coverage source set",
  );
  assertExactKeys(evidence.coverage, ["lines", "branches"], "evidence coverage");
  assertCoverageMetric("lines", evidence.coverage.lines, REQUIRED_THRESHOLDS.lines);
  assertCoverageMetric(
    "branches",
    evidence.coverage.branches,
    REQUIRED_THRESHOLDS.branches,
  );
  assertExactKeys(
    evidence.tests,
    ["total", "passed", "failed", "skipped", "todo"],
    "evidence tests",
  );
  for (const [name, value] of Object.entries(evidence.tests)) {
    assertInteger(value, `evidence tests.${name}`);
  }
  if (
    evidence.tests.total === 0 ||
    evidence.tests.failed !== 0 ||
    evidence.tests.total !==
      evidence.tests.passed +
        evidence.tests.failed +
        evidence.tests.skipped +
        evidence.tests.todo
  ) {
    fail("evidence test counts are inconsistent or unsuccessful");
  }
  if (evidence.tests.skipped !== 0 || evidence.tests.todo !== 0) {
    fail("evidence test counts contain skipped or todo tests");
  }
  if (!Array.isArray(evidence.locks) || evidence.locks.length !== 1) {
    fail("evidence must contain exactly one package lock");
  }
  assertExactKeys(evidence.locks[0], ["path", "sha256"], "evidence lock");
  const expectedLockPath = `${prepared.entry.id}/package-lock.json`;
  if (
    evidence.locks[0].path !== expectedLockPath ||
    evidence.locks[0].sha256 !==
      sha256File(
        path.join(repoRoot, prepared.entry.id, "package-lock.json"),
        LIMITS.reportBytes,
        `${prepared.entry.id} package lock`,
      )
  ) {
    fail("evidence package lock identity is invalid");
  }
  assertExactKeys(
    evidence.toolchain,
    ["node", "npm", "testRunner", "coverageRunner"],
    "evidence toolchain",
  );
  if (evidence.toolchain.node !== REQUIRED_NODE_VERSION) {
    fail(`evidence Node version must equal ${REQUIRED_NODE_VERSION}`);
  }
  if (
    typeof evidence.toolchain.npm !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(evidence.toolchain.npm)
  ) {
    fail("evidence npm version is invalid");
  }
  for (const field of ["testRunner", "coverageRunner"]) {
    assertExactKeys(
      evidence.toolchain[field],
      ["name", "version"],
      `evidence toolchain.${field}`,
    );
    if (
      typeof evidence.toolchain[field].name !== "string" ||
      typeof evidence.toolchain[field].version !== "string" ||
      evidence.toolchain[field].name.length === 0 ||
      evidence.toolchain[field].version.length === 0
    ) {
      fail(`evidence toolchain.${field} is incomplete`);
    }
  }
  const expectedRunners = expectedRunnerIdentity(repoRoot, prepared.entry);
  assertEvidenceIdentity(
    evidence.toolchain.testRunner,
    expectedRunners.testRunner,
    "evidence test runner",
  );
  assertEvidenceIdentity(
    evidence.toolchain.coverageRunner,
    expectedRunners.coverageRunner,
    "evidence coverage runner",
  );
  validateCommandRecords(evidence.commands, prepared.commands);
  assertExactKeys(
    evidence.reports,
    [
      "coverageFinalSha256",
      "coverageSummarySha256",
      "testResultsSha256",
    ],
    "evidence reports",
  );
  for (const value of Object.values(evidence.reports)) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      fail("successful evidence report hashes must be SHA-256 values");
    }
  }
  validateExecutionRecord(evidence, context, {
    profile: prepared.entry.profile,
    testResultsSha256: evidence.reports.testResultsSha256,
    supplemental: prepared.supplementalSnapshot
      ? prepared.supplementalSnapshot.records
      : null,
    artifactDirectory: options.artifactDirectory || null,
  });
  if (!Array.isArray(evidence.failures) || evidence.failures.length !== 0) {
    fail("successful evidence must contain no failures");
  }
  return prepared;
}

function validateEvidenceObject(
  repoRoot,
  trustedRoot,
  context,
  evidence,
  options = {},
) {
  if (
    !isPlainObject(evidence) ||
    !isPlainObject(evidence.package) ||
    typeof evidence.package.id !== "string"
  ) {
    fail("evidence package is invalid");
  }
  const prepared = prepareEntry(
    repoRoot,
    trustedRoot,
    context,
    evidence.package.id,
  );
  return validateEvidenceAgainstPrepared(
    repoRoot,
    context,
    evidence,
    prepared,
    options,
  );
}

function validateEvidenceArtifact(
  repoRoot,
  trustedRoot,
  context,
  evidencePath,
  options = {},
) {
  const coverageRoot = options.coverageRoot || repoRoot;
  const evidence = readJsonFile(
    evidencePath,
    LIMITS.evidenceBytes,
    "evidence",
  );
  const directory = path.dirname(evidencePath);
  const prepared = validateEvidenceObject(
    repoRoot,
    trustedRoot,
    context,
    evidence,
    { artifactDirectory: directory },
  );
  const testFileName =
    prepared.entry.profile === "node-typescript-c8"
      ? "test-results.tap"
      : "test-results.json";
  const reports = {
    coverageFinal: path.join(directory, "coverage-final.json"),
    coverageSummary: path.join(directory, "coverage-summary.json"),
    testResults: path.join(directory, testFileName),
  };
  const expectedHashes = {
    coverageFinalSha256: sha256File(
      reports.coverageFinal,
      LIMITS.reportBytes,
      "coverage-final report",
    ),
    coverageSummarySha256: sha256File(
      reports.coverageSummary,
      LIMITS.reportBytes,
      "coverage-summary report",
    ),
    testResultsSha256: sha256File(
      reports.testResults,
      LIMITS.reportBytes,
      "test results",
    ),
  };
  assertEvidenceIdentity(
    evidence.reports,
    expectedHashes,
    "evidence report hashes",
  );
  const coverage = validateCoverageReports(
    coverageRoot,
    prepared.entry,
    prepared.eligible,
    prepared.changedEligible,
    reports,
  );
  assertEvidenceIdentity(
    evidence.sources.coverageFiles,
    coverage.coverageFiles,
    "evidence coverage report source set",
  );
  assertEvidenceIdentity(
    evidence.coverage,
    {
      lines: {
        ...coverage.totals.lines,
        minimumPercent: REQUIRED_THRESHOLDS.lines,
      },
      branches: {
        ...coverage.totals.branches,
        minimumPercent: REQUIRED_THRESHOLDS.branches,
      },
    },
    "evidence raw coverage totals",
  );
  assertEvidenceIdentity(
    evidence.tests,
    parseTestResults(
      prepared.entry,
      reports.testResults,
      prepared.testFiles,
      coverageRoot,
    ),
    "evidence raw test counts",
  );
  return evidence;
}

function readRunContext(repoRoot, contextPath) {
  const safePath = normalizeRepoPath(contextPath, "run context path");
  return validateRunContext(
    repoRoot,
    readJsonFile(
      ensureRegularInRoot(repoRoot, safePath, "run context"),
      LIMITS.evidenceBytes,
      "run context",
    ),
  );
}

function listEvidenceFiles(root) {
  const result = [];
  const pending = [{ absolute: root, depth: 0 }];
  let fileCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = fs.readdirSync(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        fail("artifact directory must not contain symlinks");
      }
      const absolute = path.join(current.absolute, entry.name);
      if (entry.isDirectory()) {
        if (current.depth >= 2) {
          fail("artifact directory nesting is too deep");
        }
        pending.push({ absolute, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        fileCount += 1;
        if (fileCount > LIMITS.artifactFiles) {
          fail(`artifact directory exceeds ${LIMITS.artifactFiles} files`);
        }
        if (entry.name === "evidence.json") {
          result.push(absolute);
        }
      }
    }
  }
  return result.sort();
}

function aggregateEvidence(
  repoRoot,
  trustedRoot,
  context,
  artifactsRoot,
  options = {},
) {
  const authoritative = options.authoritative === true;
  const outputRoot = authoritative
    ? options.outputRoot
    : fs.realpathSync(repoRoot);
  if (authoritative && outputRoot !== CONTAINER_ROOTS.output) {
    fail(`authoritative output root must equal ${CONTAINER_ROOTS.output}`);
  }
  const coverageRoot = authoritative ? CONTAINER_ROOTS.home : repoRoot;
  let canonicalArtifactsRoot;
  try {
    canonicalArtifactsRoot = fs.realpathSync(path.resolve(artifactsRoot));
  } catch (error) {
    fail("aggregate artifact root is missing");
  }
  const expectedArtifactRelative = authoritative
    ? OUTPUT_ARTIFACT_ROOT
    : ARTIFACT_ROOT;
  const artifactRelative = normalizeRepoPath(
    path.relative(fs.realpathSync(outputRoot), canonicalArtifactsRoot)
      .split(path.sep)
      .join("/"),
    "aggregate artifact root",
  );
  if (artifactRelative !== expectedArtifactRelative) {
    fail(`aggregate artifact root must equal ${expectedArtifactRelative}`);
  }
  const safeArtifactsRoot = ensureSafeMutationPath(
    outputRoot,
    artifactRelative,
    "aggregate artifact root",
  );
  let artifactStat;
  try {
    artifactStat = fs.lstatSync(safeArtifactsRoot);
  } catch (error) {
    fail("aggregate artifact root is missing");
  }
  if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) {
    fail("aggregate artifact root must be a regular directory");
  }
  validateRepository(repoRoot, {
    treeish: context.repository.checkoutSha,
  });
  const expectedIds = [...ENFORCED_PACKAGE_IDS].sort();
  const files = listEvidenceFiles(safeArtifactsRoot);
  const byId = new Map();
  for (const filePath of files) {
    const evidence = validateEvidenceArtifact(
      repoRoot,
      trustedRoot,
      context,
      filePath,
      { coverageRoot },
    );
    const id = evidence.package.id;
    if (byId.has(id)) {
      fail(`duplicate aggregate evidence for ${id}`);
    }
    byId.set(id, { evidence, filePath });
  }
  const actualIds = [...byId.keys()].sort();
  if (
    actualIds.length !== expectedIds.length ||
    actualIds.some((id, index) => id !== expectedIds[index])
  ) {
    fail(
      `aggregate evidence package mismatch: expected=${expectedIds.join(",")} actual=${actualIds.join(",")}`,
    );
  }
  const first = byId.get(expectedIds[0]).evidence;
  const tests = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
  const packages = [];
  const coverage = [];
  const locks = [];
  for (const id of expectedIds) {
    const item = byId.get(id);
    const relative = path.relative(safeArtifactsRoot, item.filePath).split(path.sep).join("/");
    normalizeRepoPath(relative, `${id} aggregate evidence path`);
    packages.push({
      id,
      evidencePath: relative,
      evidenceSha256: sha256File(
        item.filePath,
        LIMITS.evidenceBytes,
        `${id} evidence`,
      ),
    });
    coverage.push({
      id,
      lines: { ...item.evidence.coverage.lines },
      branches: { ...item.evidence.coverage.branches },
    });
    for (const key of Object.keys(tests)) {
      tests[key] += item.evidence.tests[key];
    }
    locks.push(...item.evidence.locks.map((lock) => ({ id, ...lock })));
  }
  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    status: "success",
    repository: first.repository,
    workflow: first.workflow,
    engine: first.engine,
    descriptor: first.descriptor,
    expectedPackageIds: expectedIds,
    packages,
    locks,
    tests,
    coverage,
    allPackagesSucceeded: true,
    failures: [],
  };
}

function parseOptions(argv, allowed, required = []) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") || !allowed.has(token)) {
      fail(`unknown option ${token}`);
    }
    if (Object.prototype.hasOwnProperty.call(options, token)) {
      fail(`duplicate option ${token}`);
    }
    if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
      fail(`option ${token} requires a value`);
    }
    options[token] = argv[++index];
  }
  for (const token of required) {
    if (!Object.prototype.hasOwnProperty.call(options, token)) {
      fail(`missing required option ${token}`);
    }
  }
  return options;
}

function helpText() {
  return [
    "Usage: node .github/scripts/test-coverage-matrix.js <command> [options]",
    "",
    "Commands:",
    "  validate [--repo-root DIR] [--treeish SHA]",
    "  matrix [--repo-root DIR] [--treeish SHA]",
    "  run --id ID --context FILE --trusted-root DIR --output-root DIR [--repo-root DIR]",
    "  aggregate --context FILE --trusted-root DIR --output-root DIR [--repo-root DIR]",
    "  dry-run --id ID|all [--repo-root DIR]",
    "",
    `Authoritative run commands require Linux and Node ${REQUIRED_NODE_VERSION}.`,
    "dry-run is local-only and never emits authoritative evidence.",
  ].join("\n");
}

function cli(argv) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    process.stdout.write(`${helpText()}\n`);
    return;
  }
  const commonAllowed = new Set(["--repo-root", "--treeish"]);
  if (command === "validate" || command === "matrix") {
    const options = parseOptions(rest, commonAllowed);
    const repoRoot = resolveRepositoryRoot(options["--repo-root"]);
    const validated = validateRepository(repoRoot, {
      treeish: options["--treeish"] || "HEAD",
    });
    if (command === "matrix") {
      emitSafeLine({
        include: validated.descriptor.entries.map((entry) => ({ id: entry.id })),
      });
    } else {
      emitSafeLine({
        schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
        entries: validated.inventory,
        thresholds: REQUIRED_THRESHOLDS,
      });
    }
    return;
  }
  if (command === "run") {
    const options = parseOptions(
      rest,
      new Set([
        "--repo-root",
        "--id",
        "--context",
        "--trusted-root",
        "--output-root",
      ]),
      ["--id", "--context", "--trusted-root", "--output-root"],
    );
    const repoRoot = resolveRepositoryRoot(options["--repo-root"]);
    const id = options["--id"];
    if (!SAFE_ID_PATTERN.test(id)) {
      fail("package id is unsafe");
    }
    if (!ENFORCED_PACKAGE_IDS.includes(id)) {
      fail(
        `authoritative coverage runs are limited to ${ENFORCED_PACKAGE_IDS.join(",")}`,
      );
    }
    const context = readRunContext(repoRoot, options["--context"]);
    const evidence = executeEntry(
      repoRoot,
      options["--trusted-root"],
      context,
      id,
      true,
      { outputRoot: options["--output-root"] },
    );
    emitSafeLine({
      id,
      status: "success",
      node: evidence.toolchain.node,
      lines: evidence.coverage.lines.covered,
      branches: evidence.coverage.branches.covered,
      tests: evidence.tests.total,
      rawFiles: evidence.execution.rawSink.fileCount,
      reportSha256: evidence.reports.coverageFinalSha256,
    });
    return;
  }
  if (command === "aggregate") {
    const options = parseOptions(
      rest,
      new Set([
        "--repo-root",
        "--context",
        "--trusted-root",
        "--output-root",
      ]),
      ["--context", "--trusted-root", "--output-root"],
    );
    const repoRoot = resolveRepositoryRoot(options["--repo-root"]);
    const outputRoot = options["--output-root"];
    if (outputRoot !== CONTAINER_ROOTS.output) {
      fail(`authoritative output root must equal ${CONTAINER_ROOTS.output}`);
    }
    const context = readRunContext(repoRoot, options["--context"]);
    const artifactsRoot = ensureSafeMutationPath(
      outputRoot,
      OUTPUT_ARTIFACT_ROOT,
      "aggregate artifact root",
    );
    const aggregate = aggregateEvidence(
      repoRoot,
      options["--trusted-root"],
      context,
      artifactsRoot,
      { authoritative: true, outputRoot },
    );
    writeJson(
      ensureSafeMutationPath(
        outputRoot,
        `${OUTPUT_ARTIFACT_ROOT}/aggregate.json`,
        "aggregate evidence path",
      ),
      aggregate,
    );
    emitSafeLine({
      status: "success",
      packages: aggregate.expectedPackageIds,
    });
    return;
  }
  if (command === "dry-run") {
    const options = parseOptions(
      rest,
      new Set(["--repo-root", "--id"]),
      ["--id"],
    );
    const repoRoot = resolveRepositoryRoot(options["--repo-root"]);
    const validated = validateRepository(repoRoot);
    const ids =
      options["--id"] === "all"
        ? validated.inventory
        : [options["--id"]];
    for (const id of ids) {
      if (!validated.inventory.includes(id)) {
        fail(`package id is not registered: ${id}`);
      }
      const validatedEntry = validated.entries.find(
        (candidate) => candidate.id === id,
      );
      const entry = {
        ...validatedEntry,
        testFiles: deriveWorkingTestFiles(repoRoot, validatedEntry),
      };
      const prepared = {
        entry,
        eligible: entry.eligible,
        changedEligible: [],
        deletedEligible: [],
        packageInputs: [],
        packageInputSnapshot: null,
        protectedFileSnapshots: [],
        testFiles: entry.testFiles,
        commands: buildCommandPlan(entry, entry.eligible, {
          repoRoot,
          treeish: resolveCommit(repoRoot, "HEAD", "dry-run treeish"),
        }),
      };
      const layout = resolveExecutionLayout({
        repoRoot,
        entryId: id,
        authoritative: false,
      });
      fs.rmSync(layout.artifactDirectory, { recursive: true, force: true });
      fs.mkdirSync(layout.artifactDirectory, { recursive: true, mode: 0o700 });
      prepareControlledRoots(layout);
      const result = runPreparedEntry({
        repoRoot,
        trustedRoot: repoRoot,
        context: null,
        prepared,
        layout,
        authoritative: false,
      });
      releaseExecutionLayout(layout);
      if (result.failures.length > 0) {
        fail(`${id} dry run failed: ${result.failures.join("; ")}`);
      }
      emitSafeLine({
        id,
        status: "success",
        node: process.versions.node,
        coverage: result.coverageResult.totals,
        tests: result.tests,
        commands: result.commands.length,
      });
    }
    return;
  }
  fail(`unknown command ${command}`);
}

if (require.main === module) {
  try {
    assertSafeNodeStartupEnvironment();
    cli(process.argv.slice(2));
  } catch (error) {
    const message = sanitizeFailure(error, [["<cwd>", process.cwd()]]);
    console.error(`coverage-matrix: ${message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  ARTIFACT_ROOT,
  CANONICAL_REPOSITORY,
  COMMAND_KILL_GRACE_MS,
  COMMAND_PLACEHOLDERS,
  COMMAND_ROLES,
  COMMAND_SUBREAPER_BOOTSTRAP,
  COMMAND_SUPERVISOR_SOURCE,
  COMMAND_TIMEOUTS,
  CONTAINER_MARKER_VARIABLE,
  CONTAINER_ROOTS,
  CONTROLLER_UID,
  CoverageMatrixError,
  DESCRIPTOR_PATH,
  DESCRIPTOR_SCHEMA_VERSION,
  ENFORCED_PACKAGE_IDS,
  ENGINE_PATH,
  EVIDENCE_KEYS,
  EVIDENCE_LIMITATION,
  EVIDENCE_SCHEMA_VERSION,
  FORBIDDEN_COVERAGE_CONFIG_FILES,
  FORBIDDEN_COVERAGE_MANIFEST_KEYS,
  OUTPUT_ARTIFACT_ROOT,
  RUN_CONTEXT_SCHEMA_VERSION,
  WORKER_GID,
  WORKER_UID,
  GIT_COMMAND_TIMEOUT_MS,
  LIMITS,
  NPM_CI_ARGUMENTS,
  REQUIRED_NODE_VERSION,
  REQUIRED_THRESHOLDS,
  TOOL_LOCK_PATH,
  TOOL_PACKAGE_PATH,
  WORKFLOW_PATH,
  aggregateEvidence,
  assertPathSet,
  assertSortedUniquePaths,
  assertThreshold,
  buildCommandPlan,
  buildEvidence,
  coveragePathToRepoPath,
  deriveChangedSources,
  deriveEligibleSources,
  derivePackageInputSnapshot,
  derivePackageInputs,
  deriveTestFiles,
  deriveWorkingTestFiles,
  discoverPackageInventory,
  executeCommands,
  ensurePackageSnapshot,
  ensureSafeMutationPath,
  isEligibleSourcePath,
  isTestSourcePath,
  normalizeRepoPath,
  parseDiffNameStatus,
  parseJestTestResults,
  parseTapTestResults,
  prepareEntry,
  readDescriptor,
  readJsonFile,
  rejectUnexpectedPackageFiles,
  freezeStagedWorkspace,
  parseTapResultDescription,
  runGit,
  sealGitAccess,
  stageControllerToolchain,
  assertAuthoritativeContainer,
  assertCommandToken,
  assertControlledDirectory,
  assertEmptyDirectory,
  assertControllerCapabilityContract,
  assertIsolatedStagingLayout,
  assertObservedIdentityRecord,
  expectedIdentityForRole,
  readProcessIdentityFromProc,
  CONTROLLER_CAPABILITY_MASK,
  CONTROLLER_CAPABILITY_NAMES,
  ZERO_CAPABILITY_MASK,
  deriveSupplementalSnapshot,
  stageSupplementalInputs,
  supplementalInputPaths,
  verifyWorkerHomeClosure,
  workerHomeInventory,
  SUPPLEMENTAL_MANIFEST_FILES,
  SUPPLEMENTAL_PACKAGE_IDS,
  WORKER_HOME_MODE,
  assertNoCoverageDiscovery,
  controllerEnvironment,
  emitSafeLine,
  freezeRawCoverage,
  hashFrozenCoverage,
  prepareControlledRoots,
  resolveExecutionLayout,
  stageWorkerPackage,
  substitutePlaceholders,
  validateCommandRecords,
  validateExecutionRecord,
  verifyStagedWorkspace,
  workerEnvironment,
  writeGeneratedC8Configuration,
  validateCoverageReports,
  validateDescriptorObject,
  validateEvidenceObject,
  validateEvidenceArtifact,
  validateNoForbiddenTelemetryWorkflow,
  validateRepository,
  validateRunContext,
  validateToolPackage,
  verifyPreparedFilesystemState,
  verifyTrustedAssets,
  writeFileSafely,
  resolveCommit,
  signalIdentityTargets,
  sanitizedGitEnvironment,
  validateEvidenceAgainstPrepared,
};
