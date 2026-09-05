#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/agents/service-ops-stan.sh"
# shellcheck source=../scripts/lib.sh
source "$ROOT_DIR/infra/oci/scripts/lib.sh"

SAFE_PARENT="${BETSTAN_TEST_TMPDIR:-$ROOT_DIR/.test-workdirs}"
mkdir -p "$SAFE_PARENT"
WORK_DIR="$(mktemp -d "$SAFE_PARENT/oci-service-ops-XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT

fail() {
  echo "oci_service_ops_tests=FAIL reason=$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -Fq -- "$pattern" "$file" || fail "missing '$pattern' in $file"
}

instance_ocid="ocid1.instance.oc1.eu-frankfurt-1.fixture"
cat >"$WORK_DIR/infrastructure.env" <<EOF
runtime_mode=k3s
instance_ocid=$instance_ocid
instance_fingerprint=$(oci_fingerprint "$instance_ocid")
namespace=betstan-oci
EOF

cat >"$WORK_DIR/pods.json" <<'EOF'
{
  "items": [
    {
      "metadata": {"name": "event-pod"},
      "status": {
        "phase": "Running",
        "containerStatuses": [
          {
            "name": "gaming-event",
            "ready": true,
            "restartCount": 1,
            "state": {
              "running": {"startedAt": "2026-09-05T11:20:14Z"}
            },
            "lastState": {
              "terminated": {
                "reason": "Error",
                "exitCode": 137,
                "startedAt": "2026-09-05T10:00:00Z",
                "finishedAt": "2026-09-05T11:20:06Z"
              }
            }
          }
        ]
      }
    },
    {
      "metadata": {"name": "stable-pod"},
      "status": {
        "phase": "Running",
        "containerStatuses": [
          {
            "name": "stable",
            "ready": true,
            "restartCount": 0,
            "state": {
              "running": {"startedAt": "2026-09-05T09:00:00Z"}
            },
            "lastState": {}
          }
        ]
      }
    }
  ]
}
EOF

mkdir -p "$WORK_DIR/bin"
cat >"$WORK_DIR/bin/kubectl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${KUBECTL_CALL_LOG:?}"

if [[ "$1" == "config" && "$2" == "view" ]]; then
  printf '%s\n' \
    '{"clusters":[{"cluster":{"server":"https://127.0.0.1:6443"}}],"users":[]}'
  exit 0
fi

if [[ "$1" == "get" && "$2" == "deployments,statefulsets" ]]; then
  printf '%s\n' \
    '{"items":[{"kind":"Deployment","metadata":{"name":"gaming-event-depl"},"spec":{"replicas":1},"status":{"availableReplicas":1}}]}'
  exit 0
fi

if [[ "$1" == "get" && "$2" == "pods" ]]; then
  cat "${PODS_FIXTURE:?}"
  exit 0
fi

if [[ "$1" == "get" && "$2" == "endpointslices.discovery.k8s.io" ]]; then
  printf '%s\n' \
    '{"items":[{"metadata":{"labels":{"kubernetes.io/service-name":"gaming-event-srv"}},"endpoints":[{"addresses":["10.0.0.1"],"conditions":{"ready":true}}]}]}'
  exit 0
fi

if [[ "$1" == "get" && "$2" == "events" ]]; then
  printf '%s\n' '{"items":[]}'
  exit 0
fi

if [[ "$1" == "logs" ]]; then
  if [[ " $* " == *" --previous "* ]]; then
    [[ " $* " == *" event-pod "* && " $* " == *" -c gaming-event "* ]] ||
      exit 77
    printf '%s\n' \
      '2026-09-05T11:20:06Z fatal mongodb://user:fixture-secret@mongo.internal:27017/event'
  else
    printf '%s\n' 'info healthy'
  fi
  exit 0
fi

echo "unexpected kubectl call: $*" >&2
exit 64
EOF
chmod +x "$WORK_DIR/bin/kubectl"

output="$WORK_DIR/output.log"
PATH="$WORK_DIR/bin:$PATH" \
KUBECTL_CALL_LOG="$WORK_DIR/kubectl-calls.log" \
PODS_FIXTURE="$WORK_DIR/pods.json" \
INFRA_PROVENANCE_FILE="$WORK_DIR/infrastructure.env" \
  "$SCRIPT" >"$output"

assert_contains "$output" "=== per-container status ==="
assert_contains "$output" $'event-pod\tgaming-event\tRunning\ttrue\t1\trunning'
assert_contains "$output" $'terminated\tError\t137\t2026-09-05T10:00:00Z\t2026-09-05T11:20:06Z'
assert_contains "$output" "=== redacted previous-container error logs ==="
assert_contains "$output" $'previous\tevent-pod\tgaming-event\t1'
assert_contains "$output" "fatal [REDACTED_DETAIL]"
if grep -Eq '^pod=' "$output"; then
  fail "previous-container evidence collided with the current-error sentinel"
fi
[[ "$(grep -Fc -- '--previous' "$WORK_DIR/kubectl-calls.log")" == "1" ]] ||
  fail "previous logs were not requested exactly once"
assert_contains "$WORK_DIR/kubectl-calls.log" \
  "logs -n betstan-oci event-pod -c gaming-event --previous --tail=200 --timestamps=true"
if grep -Fq 'stable-pod -c stable --previous' "$WORK_DIR/kubectl-calls.log"; then
  fail "previous logs were requested for a container without restarts"
fi
if grep -Fq 'fixture-secret' "$output"; then
  fail "previous-container diagnostic leaked fixture content"
fi

echo "oci_service_ops_tests=PASS"
