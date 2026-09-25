#!/usr/bin/env bash
set -euo pipefail

SOURCE_SHA="${SOURCE_SHA:-}"
BUILD_RUN_ID="${BUILD_RUN_ID:-}"
INFRASTRUCTURE_RUN_ID="${INFRASTRUCTURE_RUN_ID:-}"
DEPLOYMENT_RUN_ID="${DEPLOYMENT_RUN_ID:-}"
REPOSITORY="${REPOSITORY:-${GITHUB_REPOSITORY:-}}"

[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "SOURCE_SHA must be a full lowercase commit SHA" >&2
  exit 1
}
for run_id in "$BUILD_RUN_ID" "$INFRASTRUCTURE_RUN_ID" "$DEPLOYMENT_RUN_ID"; do
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || {
    echo "all provenance run IDs must be positive integers" >&2
    exit 1
  }
done
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || {
  echo "REPOSITORY is invalid" >&2
  exit 1
}
[[ "${GITHUB_REF_NAME:-}" == "master" ]] || {
  echo "activation must run from master" >&2
  exit 1
}
[[ "${GITHUB_RUN_ATTEMPT:-}" == "1" ]] || {
  echo "activation reruns are not permitted" >&2
  exit 1
}

for command_name in gh git; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command is unavailable: $command_name" >&2
    exit 1
  }
done

git fetch --quiet origin master:refs/remotes/origin/master
[[ "$(git rev-parse HEAD)" == "$SOURCE_SHA" ]] || {
  echo "checked out source no longer matches the approved SHA" >&2
  exit 1
}
[[ "$(git rev-parse origin/master)" == "$SOURCE_SHA" ]] || {
  echo "approved SHA is no longer current master" >&2
  exit 1
}

verify_run() {
  local run_id="$1"
  local workflow_file="$2"
  local expected_event="$3"
  local path event head_sha head_branch repository status conclusion attempt

  read -r path event head_sha head_branch repository status conclusion attempt <<<"$(
    gh api "repos/$REPOSITORY/actions/runs/$run_id" \
      --jq '[.path,.event,.head_sha,.head_branch,.head_repository.full_name,.status,.conclusion,.run_attempt] | @tsv'
  )"
  [[ "$path" == ".github/workflows/$workflow_file" ]]
  [[ "$event" == "$expected_event" ]]
  [[ "$head_sha" == "$SOURCE_SHA" ]]
  [[ "$head_branch" == "master" ]]
  [[ "$repository" == "$REPOSITORY" ]]
  [[ "$status" == "completed" ]]
  [[ "$conclusion" == "success" ]]
  [[ "$attempt" == "1" ]]
}

verify_run "$BUILD_RUN_ID" oci-production-build.yml workflow_run
verify_run "$INFRASTRUCTURE_RUN_ID" oci-infrastructure.yml workflow_dispatch
verify_run "$DEPLOYMENT_RUN_ID" oci-production-deploy.yml workflow_dispatch

if [[ -n "${CASH_BACK_ACCEPTANCE_EVIDENCE_FILE:-}" ]]; then
  python3 - "$CASH_BACK_ACCEPTANCE_EVIDENCE_FILE" \
    "${CASH_BACK_ACCEPTANCE_MODE:-}" "$SOURCE_SHA" "${GITHUB_RUN_ID:-}" <<'PY'
import json
from pathlib import Path
import re
import sys

path, mode, source, run = sys.argv[1:]

def require(value, message):
    if not value:
        raise ValueError(message)

def financial(receipt):
    value = receipt["financial"]
    for field in ("originalStakeMinor", "remainingStakeMinor", "cumulativeClosedStakeMinor", "cumulativeReturnMinor", "revision"):
        require(type(value.get(field)) is int and 0 <= value[field] < 2**53,
                "cash-back financial evidence is malformed")
    require(value["originalStakeMinor"] > 0, "cash-back original principal is missing")
    require(value["originalStakeMinor"] == value["remainingStakeMinor"] + value["cumulativeClosedStakeMinor"],
            "cash-back principal is not conserved")
    return value

try:
    payload = json.loads(Path(path).read_text())
    require(str(payload["runId"]) == run, "cash-back evidence belongs to another run")
    cash = payload["cashBack"]
    require(mode in ("compatibility", "active") and cash["mode"] == mode,
            "cash-back mode is not the declared mode")
    if mode == "compatibility":
        proof = cash["compatibility"]
        require(all(proof.get(key) is True for key in (
            "newAdmissionRefused", "historyReadable", "noPendingIdentifier",
        )), "non-generating compatibility admission is unproven")
    else:
        for key in ("liveFull", "preMatchFull"):
            operation = cash[key]["operation"]
            receipt = operation["receipt"]
            require(operation["state"] == receipt["outcome"] == "ACCEPTED" and receipt["mode"] == "FULL",
                    "full cash-back acceptance is missing")
            value = financial(receipt)
            require(value["remainingStakeMinor"] == 0 and value["status"] == "CASH_BACK",
                    "full cash-back exposure remains open")
        require(cash["preMatchFull"].get("confirmedThroughUI") is True,
                "production cash-back UI confirmation is unproven")
        partial = cash["partial"]
        require(len(partial["operations"]) == 2, "repeated partial cash-back is missing")
        for operation in partial["operations"]:
            require(operation["state"] == operation["receipt"]["outcome"] == "ACCEPTED"
                    and operation["receipt"]["mode"] == "PARTIAL",
                    "partial cash-back was not accepted")
            financial(operation["receipt"])
        last = financial(partial["operations"][-1]["receipt"])
        settled = financial({"financial": partial["settlement"]})
        require(settled["status"] in ("WIN", "LOSS", "VOID")
                and settled["remainingStakeMinor"] == last["remainingStakeMinor"]
                and settled["cumulativeClosedStakeMinor"] == last["cumulativeClosedStakeMinor"],
                "remaining-principal settlement is unproven")
        recovery = cash["recovery"]
        interruption = recovery["interruption"]
        require(interruption["sourceSha"] == source and interruption["runId"] == run,
                "cash-back interruption has stale provenance")
        require(interruption["stopped"] is True and interruption["restored"] is True
                and interruption["checkpoint"]["pendingObservedWithZeroWorkers"] is True,
                "pending worker interruption was not observed")
        before, after = interruption["beforePodFingerprints"], interruption["afterPodFingerprints"]
        require(isinstance(before, list) and isinstance(after, list)
                and type(interruption["replicas"]) is int
                and len(before) == len(after) == interruption["replicas"]
                and bool(before) and len(set(before)) == len(before)
                and len(set(after)) == len(after)
                and all(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value)
                        for value in before + after)
                and not set(before).intersection(after),
                "worker replacement is unproven")
        operation = recovery["operation"]
        require(interruption["checkpoint"]["operationId"] == operation["operationId"]
                and operation["state"] in ("ACCEPTED", "REJECTED")
                and operation["receipt"]["outcome"] == operation["state"]
                and recovery["sameIdentityReplay"] is True,
                "same-operation durable recovery is unproven")
        financial(operation["receipt"])
        drained = recovery["drained"]
        expected = {"rootPresent", "slotDrained", "terminalHistory", "outcomePublished",
                    "projectionComplete", "receiptMatches"}
        require(set(drained) == expected and all(value is True for value in drained.values()),
                "cash-back delivery or release obligations remain")
        require(cash.get("fullImmutableAfterResults") is True,
                "full cash-back immutability after results is unproven")
except (OSError, KeyError, TypeError, ValueError) as error:
    raise SystemExit(f"cash-back acceptance evidence rejected: {error}")
print("cash_back_acceptance_evidence=PASS")
PY
fi

echo "live_activation_revalidation=PASS source_sha=$SOURCE_SHA"
