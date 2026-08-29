#!/usr/bin/env bash
set -euo pipefail

NAMESPACE="${NAMESPACE:-betstan-oci}"
FAILED_ACTIVATION_RUN_ID="${FAILED_ACTIVATION_RUN_ID:-}"
FAILED_ACTIVATION_USER_ID="${FAILED_ACTIVATION_USER_ID:-}"
CONFIRMATION="${CONFIRMATION:-}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
MONGO_POD_SELECTOR="${MONGO_POD_SELECTOR:-app=gaming-auth-mongo}"
EXPECTED_AUTH_USER_COUNT="${EXPECTED_AUTH_USER_COUNT:-0}"
ALLOWED_BET_KINDS="${ALLOWED_BET_KINDS:-LIVE}"
MAX_ACTIVE_SLIPS="${MAX_ACTIVE_SLIPS:-1}"

fail() {
  echo "Live-acceptance slip cleanup: $*" >&2
  exit 1
}

[[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] ||
  fail "NAMESPACE is invalid"
[[ "$FAILED_ACTIVATION_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  fail "FAILED_ACTIVATION_RUN_ID is invalid"
[[ "$FAILED_ACTIVATION_USER_ID" =~ ^[0-9a-f]{24}$ ]] ||
  fail "FAILED_ACTIVATION_USER_ID is invalid"
[[ "$CONFIRMATION" = \
  "DELETE_FAILED_LIVE_DRAFT:${FAILED_ACTIVATION_RUN_ID}:${FAILED_ACTIVATION_USER_ID}" ]] ||
  fail "CONFIRMATION does not bind the exact failed activation and user"
[[ -n "$OUTPUT_FILE" && "$OUTPUT_FILE" != "/" && "$OUTPUT_FILE" != "." ]] ||
  fail "OUTPUT_FILE is unsafe"
[[ "$EXPECTED_AUTH_USER_COUNT" == "0" ||
   "$EXPECTED_AUTH_USER_COUNT" == "1" ]] ||
  fail "EXPECTED_AUTH_USER_COUNT must be 0 or 1"
[[ "$ALLOWED_BET_KINDS" == "LIVE" ||
   "$ALLOWED_BET_KINDS" == "LIVE,PRE_MATCH" ]] ||
  fail "ALLOWED_BET_KINDS is invalid"
[[ "$MAX_ACTIVE_SLIPS" == "1" || "$MAX_ACTIVE_SLIPS" == "2" ]] ||
  fail "MAX_ACTIVE_SLIPS must be 1 or 2"

command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"

pods_json="$(
  kubectl get pods -n "$NAMESPACE" -l "$MONGO_POD_SELECTOR" -o json
)" || fail "unable to list the shared Mongo pod"
mongo_pod="$(
  jq -er '
    [
      .items[] |
      select(
        .metadata.deletionTimestamp == null and
        .status.phase == "Running"
      ) |
      .metadata.name
    ] |
    if length == 1 then .[0] else error("expected one running Mongo pod") end
  ' <<<"$pods_json"
)" || fail "expected exactly one running shared Mongo pod"

mongo_script="$(cat <<'EOF_SCRIPT'
const runId = "__RUN_ID__";
const userId = "__USER_ID__";
const suffix = runId.slice(-10);
const expectedAuthUserCount = Number("__EXPECTED_AUTH_USER_COUNT__");
const allowedBetKinds = new Set("__ALLOWED_BET_KINDS__".split(","));
const maxActiveSlips = Number("__MAX_ACTIVE_SLIPS__");
const users = db.getSiblingDB("gaming_auth").users;
const slips = db.getSiblingDB("gaming_slip").slips;
const authUserCount = users.countDocuments({_id: ObjectId(userId)});
if (authUserCount !== expectedAuthUserCount) {
  throw new Error("synthetic auth user state differs from the expected state");
}
const scope = {userId};
const candidates = slips.find(scope).limit(maxActiveSlips + 1).toArray();
if (candidates.length > maxActiveSlips) {
  throw new Error("too many active slips matched the exact synthetic user");
}
if (candidates.length === 0) {
  print(JSON.stringify({
    verified: true,
    authUserCount,
    matchedActiveSlips: 0,
    deletedActiveSlips: 0,
    remainingActiveSlips: 0
  }));
  quit(0);
}
const expectedEventNames = new Set([
  `E2E-${suffix}-Alpha - E2E-${suffix}-Bravo`,
  `E2E-${suffix}-Charlie - E2E-${suffix}-Delta`,
  `E2E-${suffix}-Future - E2E-${suffix}-Reserve`
]);
for (const slip of candidates) {
  if (
    !allowedBetKinds.has(slip.betKind) ||
    slip.status !== "DRAFT" ||
    !Array.isArray(slip.rows) ||
    slip.rows.length < 1 ||
    slip.rows.length > 10
  ) {
    throw new Error("active slip is outside the draft acceptance cleanup scope");
  }
  for (const row of slip.rows) {
    if (
      row.betKind !== slip.betKind ||
      typeof row.eventId !== "string" ||
      !/^[0-9a-f]{24}$/.test(row.eventId) ||
      !expectedEventNames.has(row.eventName) ||
      (
        slip.betKind === "LIVE" &&
        (
          typeof row.marketId !== "string" ||
          !row.marketId.startsWith(`${row.eventId}:`)
        )
      )
    ) {
      throw new Error("active slip contains a row outside the acceptance scope");
    }
  }
}
const ids = candidates.map((slip) => slip._id);
const deletion = slips.deleteMany({_id: {$in: ids}, ...scope});
if (deletion.deletedCount !== candidates.length) {
  throw new Error("exact synthetic active-slip deletion count changed");
}
const remainingActiveSlips = slips.countDocuments(scope);
if (remainingActiveSlips !== 0) {
  throw new Error("synthetic active slip remains after deletion");
}
print(JSON.stringify({
  verified: true,
  authUserCount,
  matchedActiveSlips: candidates.length,
  deletedActiveSlips: deletion.deletedCount,
  remainingActiveSlips
}));
EOF_SCRIPT
)"
mongo_script="${mongo_script//__RUN_ID__/$FAILED_ACTIVATION_RUN_ID}"
mongo_script="${mongo_script//__USER_ID__/$FAILED_ACTIVATION_USER_ID}"
mongo_script="${mongo_script//__EXPECTED_AUTH_USER_COUNT__/$EXPECTED_AUTH_USER_COUNT}"
mongo_script="${mongo_script//__ALLOWED_BET_KINDS__/$ALLOWED_BET_KINDS}"
mongo_script="${mongo_script//__MAX_ACTIVE_SLIPS__/$MAX_ACTIVE_SLIPS}"

raw_result="$(
  kubectl exec -n "$NAMESPACE" "$mongo_pod" -- \
    mongosh --quiet --norc --eval "$mongo_script"
)" || fail "exact synthetic draft verification or deletion failed"
result="$(tail -n 1 <<<"$raw_result")"
jq -e \
  --argjson expected_auth_user_count "$EXPECTED_AUTH_USER_COUNT" \
  --argjson max_active_slips "$MAX_ACTIVE_SLIPS" '
  type == "object" and
  .verified == true and
  .authUserCount == $expected_auth_user_count and
  (.matchedActiveSlips | type == "number") and
  .matchedActiveSlips >= 0 and
  .matchedActiveSlips <= $max_active_slips and
  .deletedActiveSlips == .matchedActiveSlips and
  .remainingActiveSlips == 0 and
  (keys | sort) == [
    "authUserCount",
    "deletedActiveSlips",
    "matchedActiveSlips",
    "remainingActiveSlips",
    "verified"
  ]
' <<<"$result" >/dev/null || fail "Mongo cleanup returned malformed evidence"

output_dir="$(dirname "$OUTPUT_FILE")"
mkdir -p "$output_dir"
temporary="$(mktemp "${OUTPUT_FILE}.tmp.XXXXXX")"
cleanup() {
  rm -f "$temporary"
}
trap cleanup EXIT
jq -cS \
  --arg run_id "$FAILED_ACTIVATION_RUN_ID" \
  '{
    schemaVersion: "failed-live-acceptance-cleanup.v1",
    failedActivationRunId: $run_id,
    verified: .verified,
    matchedActiveSlips: .matchedActiveSlips,
    deletedActiveSlips: .deletedActiveSlips,
    remainingActiveSlips: .remainingActiveSlips
  }' <<<"$result" >"$temporary"
chmod 600 "$temporary"
mv "$temporary" "$OUTPUT_FILE"
trap - EXIT

echo "failed_live_acceptance_cleanup=PASS run_id=$FAILED_ACTIVATION_RUN_ID"
