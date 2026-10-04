#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/cleanup-live-acceptance-slips-stan.sh"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/betstan-live-cleanup.XXXXXX")"
stub_bin="$work_dir/bin"
mkdir -p "$stub_bin"
trap 'rm -rf "$work_dir"' EXIT

fail() {
  echo "failed live-acceptance cleanup test: $*" >&2
  exit 1
}

cat >"$stub_bin/kubectl" <<'EOF_STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "get" && "${2:-}" == "pods" ]]; then
  printf '%s\n' '{"items":[{"metadata":{"name":"mongo-0"},"status":{"phase":"Running"}}]}'
  exit 0
fi
if [[ "${1:-}" == "exec" ]]; then
  previous=
  for argument in "$@"; do
    if [[ "$previous" == "--eval" ]]; then
      printf '%s' "$argument" >"${STUB_MONGO_SCRIPT:?}"
    fi
    previous="$argument"
  done
  printf '%s\n' "${STUB_MONGO_RESULT:?}"
  exit 0
fi
echo "unexpected kubectl invocation: $*" >&2
exit 1
EOF_STUB
chmod +x "$stub_bin/kubectl"

run_id=33227742451
user_id=6a923e01e72e00d5ddf8b947
output="$work_dir/evidence.json"
capture="$work_dir/query.js"

run_cleanup() {
  PATH="$stub_bin:$PATH" \
  STUB_MONGO_SCRIPT="$capture" \
  STUB_MONGO_RESULT="$1" \
  FAILED_ACTIVATION_RUN_ID="$run_id" \
  FAILED_ACTIVATION_USER_ID="$user_id" \
  CONFIRMATION="DELETE_FAILED_LIVE_DRAFT:${run_id}:${user_id}" \
  OUTPUT_FILE="$output" \
    "$SCRIPT"
}

run_cleanup \
  '{"verified":true,"authUserCount":0,"matchedActiveSlips":1,"deletedActiveSlips":1,"remainingActiveSlips":0}'
jq -e \
  --arg run_id "$run_id" '
    .schemaVersion == "failed-live-acceptance-cleanup.v1" and
    .failedActivationRunId == $run_id and
    .deletedActiveSlips == 1 and
    .remainingActiveSlips == 0
  ' "$output" >/dev/null
# shellcheck disable=SC2016
for contract in \
  'users.countDocuments({_id: ObjectId(userId)})' \
  'const scope = {userId}' \
  'candidates.length > maxActiveSlips' \
  'slip.status !== "DRAFT"' \
  '!Number.isSafeInteger(slip.boardRevision)' \
  '!/^[0-9a-f]{24}$/.test(slip.boardFingerprint)' \
  'slip.rows.length > 10' \
  'expectedEventNames.has(row.eventName)' \
  'row.marketId.startsWith(`${row.eventId}:`)' \
  'const deletionPredicates = candidates.map((slip) => ({' \
  'status: "DRAFT"' \
  'boardRevision: slip.boardRevision' \
  'boardFingerprint: slip.boardFingerprint' \
  'slips.deleteMany({$or: deletionPredicates})'; do
  grep -Fq "$contract" "$capture" ||
    fail "Mongo cleanup query omits safety contract: $contract"
done

cat >"$work_dir/interleaving-test.js" <<'EOF_NODE'
const fs = require("fs");
const vm = require("vm");

const [scriptPath, mode, runId, userId] = process.argv.slice(2);
const suffix = runId.slice(-10);
const eventId = "0123456789abcdef01234567";
const documents = [{
  _id: "slip-1",
  userId,
  betKind: "LIVE",
  status: "DRAFT",
  boardRevision: 1,
  boardFingerprint: "111111111111111111111111",
  rows: [{
    betKind: "LIVE",
    eventId,
    eventName: `E2E-${suffix}-Alpha - E2E-${suffix}-Bravo`,
    marketId: `${eventId}:winner`
  }]
}];

const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const matches = (document, query) => {
  if (query.$or) {
    return query.$or.some((predicate) => matches(document, predicate));
  }
  return Object.entries(query).every(
    ([key, value]) => equal(document[key], value)
  );
};
const slips = {
  find(query) {
    const snapshot = documents
      .filter((document) => matches(document, query))
      .map((document) => JSON.parse(JSON.stringify(document)));
    return {
      limit() {
        return {toArray: () => snapshot};
      }
    };
  },
  deleteMany(query) {
    if (mode === "placement") {
      documents[0].status = "SUBMITTED";
      documents[0].boardRevision = 2;
      documents[0].boardFingerprint = "222222222222222222222222";
    } else if (mode === "row") {
      documents[0].rows[0].marketId = `${eventId}:changed`;
      documents[0].boardRevision = 2;
      documents[0].boardFingerprint = "333333333333333333333333";
    }
    let deletedCount = 0;
    for (let index = documents.length - 1; index >= 0; index -= 1) {
      if (matches(documents[index], query)) {
        documents.splice(index, 1);
        deletedCount += 1;
      }
    }
    return {deletedCount};
  },
  countDocuments(query) {
    return documents.filter((document) => matches(document, query)).length;
  }
};
const users = {countDocuments: () => 0};
let printed = "";
const context = {
  db: {
    getSiblingDB(name) {
      return name === "gaming_auth" ? {users} : {slips};
    }
  },
  ObjectId: (value) => value,
  print: (value) => { printed = value; },
  quit: () => {}
};

let failed = false;
try {
  vm.runInNewContext(fs.readFileSync(scriptPath, "utf8"), context);
} catch (error) {
  failed = true;
}
if (mode === "none") {
  if (failed || documents.length !== 0 || !printed.includes('"deletedActiveSlips":1')) {
    process.exit(1);
  }
} else {
  const expectedStatus = mode === "placement" ? "SUBMITTED" : "DRAFT";
  if (!failed || documents.length !== 1 || documents[0].status !== expectedStatus) {
    process.exit(1);
  }
}
EOF_NODE

for mode in none placement row; do
  node "$work_dir/interleaving-test.js" \
    "$capture" "$mode" "$run_id" "$user_id" ||
    fail "atomic Mongo cleanup failed interleaving case: $mode"
done

run_cleanup \
  '{"verified":true,"authUserCount":0,"matchedActiveSlips":0,"deletedActiveSlips":0,"remainingActiveSlips":0}'
jq -e '.deletedActiveSlips == 0 and .remainingActiveSlips == 0' \
  "$output" >/dev/null

PATH="$stub_bin:$PATH" \
STUB_MONGO_SCRIPT="$capture" \
STUB_MONGO_RESULT='{"verified":true,"authUserCount":0,"matchedActiveSlips":2,"deletedActiveSlips":2,"remainingActiveSlips":0}' \
FAILED_ACTIVATION_RUN_ID="$run_id" \
FAILED_ACTIVATION_USER_ID="$user_id" \
CONFIRMATION="DELETE_FAILED_LIVE_DRAFT:${run_id}:${user_id}" \
OUTPUT_FILE="$output" \
ALLOWED_BET_KINDS=LIVE,PRE_MATCH \
MAX_ACTIVE_SLIPS=2 \
  "$SCRIPT"
jq -e '.deletedActiveSlips == 2 and .remainingActiveSlips == 0' \
  "$output" >/dev/null

PATH="$stub_bin:$PATH" \
STUB_MONGO_SCRIPT="$capture" \
STUB_MONGO_RESULT='{"verified":true,"authUserCount":1,"matchedActiveSlips":2,"deletedActiveSlips":2,"remainingActiveSlips":0}' \
FAILED_ACTIVATION_RUN_ID="$run_id" \
FAILED_ACTIVATION_USER_ID="$user_id" \
CONFIRMATION="DELETE_FAILED_LIVE_DRAFT:${run_id}:${user_id}" \
OUTPUT_FILE="$output" \
EXPECTED_AUTH_USER_COUNT=1 \
ALLOWED_BET_KINDS=LIVE,PRE_MATCH \
MAX_ACTIVE_SLIPS=2 \
  "$SCRIPT"
jq -e '.deletedActiveSlips == 2 and .remainingActiveSlips == 0' \
  "$output" >/dev/null

expect_failure() {
  if "$@" >/dev/null 2>&1; then
    fail "command unexpectedly succeeded: $*"
  fi
}

expect_failure env \
  PATH="$stub_bin:$PATH" \
  STUB_MONGO_SCRIPT="$capture" \
  STUB_MONGO_RESULT='{}' \
  FAILED_ACTIVATION_RUN_ID=invalid \
  FAILED_ACTIVATION_USER_ID="$user_id" \
  CONFIRMATION="DELETE_FAILED_LIVE_DRAFT:${run_id}:${user_id}" \
  OUTPUT_FILE="$output" \
  "$SCRIPT"
expect_failure env \
  PATH="$stub_bin:$PATH" \
  STUB_MONGO_SCRIPT="$capture" \
  STUB_MONGO_RESULT='{}' \
  FAILED_ACTIVATION_RUN_ID="$run_id" \
  FAILED_ACTIVATION_USER_ID="$user_id" \
  CONFIRMATION=wrong \
  OUTPUT_FILE="$output" \
  "$SCRIPT"
expect_failure env \
  PATH="$stub_bin:$PATH" \
  STUB_MONGO_SCRIPT="$capture" \
  STUB_MONGO_RESULT='{"verified":true,"authUserCount":0,"matchedActiveSlips":3,"deletedActiveSlips":3,"remainingActiveSlips":0}' \
  FAILED_ACTIVATION_RUN_ID="$run_id" \
  FAILED_ACTIVATION_USER_ID="$user_id" \
  CONFIRMATION="DELETE_FAILED_LIVE_DRAFT:${run_id}:${user_id}" \
  OUTPUT_FILE="$output" \
  "$SCRIPT"
expect_failure env \
  PATH="$stub_bin:$PATH" \
  STUB_MONGO_SCRIPT="$capture" \
  STUB_MONGO_RESULT='{"verified":true,"authUserCount":0,"matchedActiveSlips":1,"deletedActiveSlips":1,"remainingActiveSlips":0}' \
  FAILED_ACTIVATION_RUN_ID="$run_id" \
  FAILED_ACTIVATION_USER_ID="$user_id" \
  CONFIRMATION="DELETE_FAILED_LIVE_DRAFT:${run_id}:${user_id}" \
  OUTPUT_FILE="$output" \
  EXPECTED_AUTH_USER_COUNT=1 \
  "$SCRIPT"

echo "failed_live_acceptance_cleanup_tests=PASS"
