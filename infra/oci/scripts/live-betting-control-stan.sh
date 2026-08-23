#!/usr/bin/env bash
set -euo pipefail

ACTION="${ACTION:-}"
SOURCE_SHA="${SOURCE_SHA:-}"
CONTROL_RUN_ID="${CONTROL_RUN_ID:-}"
CONFIRMATION="${CONFIRMATION:-}"
NAMESPACE="${NAMESPACE:-betstan-oci}"
DEPLOYMENT="${DEPLOYMENT:-gaming-gamemaster-depl}"
CONTAINER="${CONTAINER:-gaming-gamemaster}"
ROLLOUT_TIMEOUT="${ROLLOUT_TIMEOUT:-10m}"
OUTPUT_DIR="${OUTPUT_DIR:-artifacts/oci-live-control}"
EVIDENCE_FILE="$OUTPUT_DIR/control.env"
LEASE_DURATION_SECONDS="${LEASE_DURATION_SECONDS:-1800}"
NO_LEASE="none"

case "$ACTION" in
  activate)
    expected_confirmation="ACTIVATE OCI LIVE BETTING"
    target_flag="true"
    ;;
  commit)
    expected_confirmation="COMMIT OCI LIVE BETTING"
    target_flag="true"
    ;;
  disable)
    expected_confirmation="DISABLE OCI LIVE BETTING"
    target_flag="false"
    ;;
  *)
    echo "ACTION must be activate, commit, or disable" >&2
    exit 1
    ;;
esac

[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || {
  echo "SOURCE_SHA must be a full lowercase commit SHA" >&2
  exit 1
}
[[ "$CONTROL_RUN_ID" =~ ^[1-9][0-9]*$ ]] || {
  echo "CONTROL_RUN_ID must be a positive integer" >&2
  exit 1
}
[[ "$CONFIRMATION" == "$expected_confirmation" ]] || {
  echo "CONFIRMATION does not match $ACTION" >&2
  exit 1
}
[[ "$NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
  echo "NAMESPACE is invalid" >&2
  exit 1
}
[[ "$DEPLOYMENT" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
  echo "DEPLOYMENT is invalid" >&2
  exit 1
}
[[ "$CONTAINER" =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
  echo "CONTAINER is invalid" >&2
  exit 1
}
[[ "$ROLLOUT_TIMEOUT" =~ ^[1-9][0-9]*[smh]$ ]] || {
  echo "ROLLOUT_TIMEOUT is invalid" >&2
  exit 1
}
if [[ "$ACTION" == "activate" ]]; then
  [[ "$LEASE_DURATION_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
    echo "LEASE_DURATION_SECONDS must be an integer" >&2
    exit 1
  }
  if (( LEASE_DURATION_SECONDS < 900 || LEASE_DURATION_SECONDS > 3600 )); then
    echo "LEASE_DURATION_SECONDS must be between 900 and 3600" >&2
    exit 1
  fi
fi

for command_name in kubectl python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "required command is unavailable: $command_name" >&2
    exit 1
  }
done

mkdir -p "$OUTPUT_DIR"
umask 077

read_state() {
  kubectl get deployment "$DEPLOYMENT" \
    -n "$NAMESPACE" \
    -o json |
    python3 -c '
import json
import sys

deployment = json.load(sys.stdin)
container_name = sys.argv[1]
containers = [
    container
    for container in deployment.get("spec", {})
        .get("template", {})
        .get("spec", {})
        .get("containers", [])
    if container.get("name") == container_name
]
if len(containers) != 1:
    raise SystemExit("expected exactly one gamemaster container")
values = [
    item.get("value")
    for item in containers[0].get("env", [])
    if item.get("name") == "LIVE_KICKOFFS_ENABLED"
]
if len(values) != 1 or values[0] not in ("true", "false"):
    raise SystemExit("LIVE_KICKOFFS_ENABLED must occur exactly once as a boolean")
lease_values = [
    item.get("value")
    for item in containers[0].get("env", [])
    if item.get("name") == "LIVE_KICKOFFS_LEASE_UNTIL_EPOCH"
]
if len(lease_values) > 1:
    raise SystemExit("LIVE_KICKOFFS_LEASE_UNTIL_EPOCH must occur at most once")
lease = lease_values[0] if lease_values else "none"
if lease != "none" and (
    not isinstance(lease, str)
    or not lease.isdigit()
    or lease.startswith("0")
):
    raise SystemExit(
        "LIVE_KICKOFFS_LEASE_UNTIL_EPOCH must be a positive epoch or absent"
    )
annotations = deployment.get("metadata", {}).get("annotations", {})
action = annotations.get("betstan.dev/live-control-action", "none")
run_id = annotations.get("betstan.dev/live-control-run-id", "none")
source_sha = annotations.get("betstan.dev/live-control-source-sha", "none")
print("\t".join((values[0], lease, action, run_id, source_sha)))
' "$CONTAINER"
}

before_flag="unknown"
before_lease_until_epoch="$NO_LEASE"
before_action="none"
before_run_id="none"
before_source_sha="none"
target_lease_until_epoch="$NO_LEASE"
mutation_attempted=0
operation_committed=0

write_evidence() {
  local after_flag="${1:-unknown}"
  local after_lease_until_epoch="${2:-unknown}"
  local rollback_attempted="${3:-false}"
  local rollout_verified="${4:-false}"
  printf '%s\n' \
    "action=$ACTION" \
    "source_sha=$SOURCE_SHA" \
    "control_run_id=$CONTROL_RUN_ID" \
    "namespace=$NAMESPACE" \
    "deployment=$DEPLOYMENT" \
    "before_flag=$before_flag" \
    "before_lease_until_epoch=$before_lease_until_epoch" \
    "before_action=$before_action" \
    "before_run_id=$before_run_id" \
    "before_source_sha=$before_source_sha" \
    "target_flag=$target_flag" \
    "target_lease_until_epoch=$target_lease_until_epoch" \
    "after_flag=$after_flag" \
    "after_lease_until_epoch=$after_lease_until_epoch" \
    "mutation_attempted=$mutation_attempted" \
    "rollback_attempted=$rollback_attempted" \
    "rollout_verified=$rollout_verified" \
    >"$EVIDENCE_FILE"
}

rollback_activation() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$operation_committed" != "1" ]]; then
    set +e
    kubectl set env deployment/"$DEPLOYMENT" \
      -n "$NAMESPACE" \
      LIVE_KICKOFFS_ENABLED=false \
      LIVE_KICKOFFS_LEASE_UNTIL_EPOCH- >/dev/null
    kubectl rollout status deployment/"$DEPLOYMENT" \
      -n "$NAMESPACE" \
      --timeout="$ROLLOUT_TIMEOUT" >/dev/null
    after_rollback_flag="unknown"
    after_rollback_lease="unknown"
    IFS=$'\t' read -r \
      after_rollback_flag \
      after_rollback_lease \
      _ \
      _ \
      _ < <(read_state 2>/dev/null || printf 'unknown\tunknown\tunknown\tunknown\tunknown\n')
    write_evidence \
      "$after_rollback_flag" \
      "$after_rollback_lease" \
      true \
      false
    set -e
  elif [[ "$status" != "0" ]]; then
    write_evidence "$before_flag" "$before_lease_until_epoch" false false
  fi
  exit "$status"
}
trap rollback_activation EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

IFS=$'\t' read -r \
  before_flag \
  before_lease_until_epoch \
  before_action \
  before_run_id \
  before_source_sha < <(read_state)

if [[ "$ACTION" == "activate" && "$before_flag" != "false" ]]; then
  echo "activation requires LIVE_KICKOFFS_ENABLED=false" >&2
  exit 1
fi

if [[ "$ACTION" == "commit" ]]; then
  [[ "$before_flag" == "true" ]] || {
    echo "commit requires LIVE_KICKOFFS_ENABLED=true" >&2
    exit 1
  }
  [[ "$before_lease_until_epoch" =~ ^[1-9][0-9]*$ ]] || {
    echo "commit requires an active activation lease" >&2
    exit 1
  }
  if (( before_lease_until_epoch <= $(date +%s) )); then
    echo "activation lease expired before commit" >&2
    exit 1
  fi
  [[ "$before_action" == "activate" ]] || {
    echo "commit requires activation-owned runtime state" >&2
    exit 1
  }
  [[ "$before_run_id" == "$CONTROL_RUN_ID" ]] || {
    echo "commit run ID does not own the activation lease" >&2
    exit 1
  }
  [[ "$before_source_sha" == "$SOURCE_SHA" ]] || {
    echo "commit source SHA does not own the activation lease" >&2
    exit 1
  }
fi

case "$ACTION" in
  activate)
    target_lease_until_epoch=$(( $(date +%s) + LEASE_DURATION_SECONDS ))
    mutation_attempted=1
    kubectl set env deployment/"$DEPLOYMENT" \
      -n "$NAMESPACE" \
      LIVE_KICKOFFS_ENABLED=true \
      "LIVE_KICKOFFS_LEASE_UNTIL_EPOCH=$target_lease_until_epoch" >/dev/null
    ;;
  commit)
    mutation_attempted=1
    kubectl set env deployment/"$DEPLOYMENT" \
      -n "$NAMESPACE" \
      LIVE_KICKOFFS_LEASE_UNTIL_EPOCH- >/dev/null
    ;;
  disable)
    if [[ "$before_flag" != "false" \
        || "$before_lease_until_epoch" != "$NO_LEASE" ]]; then
      mutation_attempted=1
      kubectl set env deployment/"$DEPLOYMENT" \
        -n "$NAMESPACE" \
        LIVE_KICKOFFS_ENABLED=false \
        LIVE_KICKOFFS_LEASE_UNTIL_EPOCH- >/dev/null
    fi
    ;;
esac

if [[ "$mutation_attempted" == "1" ]]; then
  kubectl rollout status deployment/"$DEPLOYMENT" \
    -n "$NAMESPACE" \
    --timeout="$ROLLOUT_TIMEOUT" >/dev/null
fi

kubectl annotate deployment/"$DEPLOYMENT" \
  -n "$NAMESPACE" \
  --overwrite \
  "betstan.dev/live-control-action=$ACTION" \
  "betstan.dev/live-control-run-id=$CONTROL_RUN_ID" \
  "betstan.dev/live-control-source-sha=$SOURCE_SHA" >/dev/null

IFS=$'\t' read -r \
  after_flag \
  after_lease_until_epoch \
  after_action \
  after_run_id \
  after_source_sha < <(read_state)
if [[ "$after_flag" != "$target_flag" ]]; then
  echo "LIVE_KICKOFFS_ENABLED did not reach $target_flag" >&2
  false
fi
if [[ "$after_lease_until_epoch" != "$target_lease_until_epoch" ]]; then
  echo "LIVE_KICKOFFS_LEASE_UNTIL_EPOCH did not reach the target state" >&2
  false
fi
if [[ "$after_action" != "$ACTION" \
    || "$after_run_id" != "$CONTROL_RUN_ID" \
    || "$after_source_sha" != "$SOURCE_SHA" ]]; then
  echo "live control annotations do not match the committed operation" >&2
  false
fi

write_evidence "$after_flag" "$after_lease_until_epoch" false true
operation_committed=1
trap - EXIT INT TERM
echo "live_betting_control=$ACTION"
