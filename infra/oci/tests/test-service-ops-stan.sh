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
    [[ "${PREVIOUS_LOGS_UNAVAILABLE:-false}" != true ]] || exit 71
    if [[ -n "${PREVIOUS_LOG_FIXTURE:-}" ]]; then
      cat "$PREVIOUS_LOG_FIXTURE"
      exit 0
    fi
    printf '%s\n' \
      '2026-09-05T11:20:06Z fatal mongodb://user:fixture-secret@mongo.internal:27017/event'
  else
    [[ "${CURRENT_LOGS_UNAVAILABLE:-false}" != true ]] || exit 72
    if [[ "$4" == event-pod && -n "${CURRENT_LOG_FIXTURE:-}" ]]; then
      cat "$CURRENT_LOG_FIXTURE"
      exit 0
    fi
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

current_log="$WORK_DIR/current.log"
previous_log="$WORK_DIR/previous.log"
case_output="$WORK_DIR/case-output.log"
cases=0

access_line() {
  printf '192.0.2.8 - - [20/Sep/2026:16:44:00 +0000] "%s" %s 123 "%s" "%s" "%s"\n' \
    "$2" "$1" "${3:--}" "${4:--}" "${5:--}"
}

run_case() {
  cases=$((cases + 1))
  : >"$WORK_DIR/kubectl-calls.log"
  : >"$WORK_DIR/classifier-calls"
  PATH="$WORK_DIR/bin:$PATH" \
  KUBECTL_CALL_LOG="$WORK_DIR/kubectl-calls.log" \
  PODS_FIXTURE="$WORK_DIR/pods.json" \
  INFRA_PROVENANCE_FILE="$WORK_DIR/infrastructure.env" \
  CURRENT_LOG_FIXTURE="$current_log" \
  PREVIOUS_LOG_FIXTURE="$previous_log" \
  CLASSIFIER_CALL_LOG="$WORK_DIR/classifier-calls" \
    "$SCRIPT" >"$case_output" 2>&1 || return "$?"
  if grep -Fq 'sensitive-marker' "$case_output"; then
    fail "classified logs leaked synthetic private fields"
  fi
}

assert_no_current_errors() {
  if grep -Eq '^pod=' "$case_output"; then
    fail "successful access traffic produced a current-error sentinel"
  fi
}

both_logs() {
  printf '%s\n' "$1" >"$current_log"
  printf '2026-09-20T16:44:00.123456789Z %s\n' "$1" >"$previous_log"
}

both_logs "$(access_line 200 'GET /room HTTP/1.1')"
run_case
assert_no_current_errors
assert_contains "$case_output" 'previous_logs=no_matching_error_lines'

for keyword in error exception failed panic fatal oom; do
  for field in request referer agent forwarded; do
    request='GET /telemetry HTTP/1.1'
    referer=-
    agent=-
    forwarded=-
    value="sensitive-marker-$keyword"
    case "$field" in
      request) request="GET /$value HTTP/1.1" ;;
      referer) referer="$value" ;;
      agent) agent="$value" ;;
      forwarded) forwarded="$value" ;;
    esac
    both_logs "$(access_line 200 "$request" "$referer" "$agent" "$forwarded")"
    run_case
    assert_no_current_errors
    assert_contains "$case_output" 'previous_logs=no_matching_error_lines'
  done
done

for status in 100 199 200 299 301 399 400 404 499; do
  both_logs "$(access_line "$status" 'GET /room HTTP/1.1')"
  run_case
  assert_no_current_errors
  assert_contains "$case_output" 'previous_logs=no_matching_error_lines'
done

both_logs "$(access_line 400 '-')"
run_case
assert_no_current_errors
assert_contains "$case_output" 'previous_logs=no_matching_error_lines'
named="$(access_line 200 'GET /room HTTP/1.1')"
named="${named/192.0.2.8/2001:db8::8}"
both_logs "${named/ - - / - sensitive-marker }"
run_case
assert_no_current_errors
assert_contains "$case_output" 'previous_logs=no_matching_error_lines'

escaped="$(access_line 200 'GET /room\x22\x5c\x00 HTTP/1.1' \
  'sensitive-marker\x22' 'sensitive-marker\x5c' 'sensitive-marker\x20')"
printf '2026-09-20T16:44:00+00:00 %s\n' "$escaped" >"$current_log"
printf '%s\n' "$escaped" >"$previous_log"
run_case
assert_no_current_errors
assert_contains "$case_output" 'previous_logs=no_matching_error_lines'

for status in 500 503 599; do
  for request in 'GET /telemetry HTTP/1.1' 'GET /sensitive-marker-oom HTTP/1.1'; do
    both_logs "$(access_line "$status" "$request")"
    run_case
    assert_contains "$case_output" 'pod=event-pod'
    [[ "$(grep -Fc "nginx_access status=$status error [REDACTED_DETAIL]" "$case_output")" == 2 ]] ||
      fail "HTTP server error was not classified in both paths"
  done
done

access_line 503 'GET /sensitive-marker HTTP/1.1' >"$previous_log"
printf '2026-09-20T16:44:00Z %s\n' "$(cat "$previous_log")" >"$current_log"
run_case
assert_contains "$case_output" 'pod=event-pod'
[[ "$(grep -Fc 'nginx_access status=503 error [REDACTED_DETAIL]' "$case_output")" == 2 ]] ||
  fail "timestamp handling hid an HTTP server error"

valid="$(access_line 200 'GET /sensitive-marker HTTP/1.1')"
bad_escape="$(access_line 200 'GET /sensitive-marker\q HTTP/1.1')"
for malformed in \
  "${valid/ 200 123 / 099 123 }" \
  "${valid/ 200 123 / 600 123 }" \
  "${valid/ 200 123 / invalid 123 }" \
  "${valid/ 200 123 / 200 invalid }" \
  "${valid/ 200 123 / 200 -1 }" \
  "${valid% \"-\"}" \
  "${valid%\"}" \
  "$bad_escape" \
  "${valid/20\/Sep/00\/Sep}" \
  "${valid/ - - [/ - [}" \
  "${valid/\[/}" \
  "2026-13-20T16:44:00Z $valid" \
  "unexpected-prefix $valid" \
  "$valid trailing" \
  "$valid error sensitive-marker"; do
  both_logs "$malformed"
  run_case
  assert_contains "$case_output" 'pod=event-pod'
  [[ "$(grep -Fc 'nginx_access malformed error [REDACTED_DETAIL]' "$case_output")" == 2 ]] ||
    fail "malformed access record was not rejected in both paths"
done

for error in \
  '2026/09/20 16:44:00 [error] 1#1: sensitive-marker' \
  'failed sensitive-marker' \
  'TypeError: sensitive-marker' \
  'UnhandledException sensitive-marker' \
  'payload "GET /room HTTP/1.1" 200' \
  'fatal sensitive-marker' \
  'panic sensitive-marker' \
  'OOMKilled sensitive-marker'; do
  both_logs "$error"
  run_case
  assert_contains "$case_output" 'pod=event-pod'
  [[ "$(grep -Fc '[REDACTED_DETAIL]' "$case_output")" == 2 ]] ||
    fail "non-access error was not retained and redacted in both paths"
done

{
  printf '%s\n' 'first TypeError: sensitive-marker'
  access_line 200 'GET /room HTTP/1.1'
  access_line 503 'GET /telemetry HTTP/1.1'
  printf '%s\n' 'last OOMKilled sensitive-marker'
} >"$current_log"
: >"$previous_log"
run_case
actual_order="$(sed -n '/^pod=event-pod$/,/^=== redacted previous-container error logs ===$/p' \
  "$case_output" | sed '1d;$d')"
expected_order=$'first TypeError [REDACTED_DETAIL]\nnginx_access status=503 error [REDACTED_DETAIL]\nlast OOM [REDACTED_DETAIL]'
[[ "$actual_order" == "$expected_order" ]] || fail "classified error order changed"

: >"$current_log"
for ((index = 1; index <= 50; index++)); do
  printf 'line%02d error sensitive-marker\n' "$index" >>"$current_log"
  access_line 200 'GET /room HTTP/1.1' >>"$current_log"
done
cp "$current_log" "$previous_log"
SINCE=7m run_case
[[ "$(grep -Ec '^line[0-9]{2} error \[REDACTED_DETAIL\]$' "$case_output")" == 80 ]] ||
  fail "last-40 bounds were not retained for both paths"
assert_contains "$case_output" 'line11 error [REDACTED_DETAIL]'
assert_contains "$case_output" 'line50 error [REDACTED_DETAIL]'
if grep -Fq 'line10 error' "$case_output"; then
  fail "classifier retained more than the last 40 matching lines"
fi
assert_contains "$WORK_DIR/kubectl-calls.log" '--all-containers --since=7m --tail=200'
assert_contains "$WORK_DIR/kubectl-calls.log" '--previous --tail=200 --timestamps=true'
[[ "$(grep -Fc -- '--previous' "$WORK_DIR/kubectl-calls.log")" == 1 ]] ||
  fail "previous log restart selection changed"

: >"$current_log"
access_line 503 'GET /sensitive-marker HTTP/1.1' >"$previous_log"
run_case
assert_no_current_errors
assert_contains "$case_output" $'previous\tevent-pod\tgaming-event\t1'
assert_contains "$case_output" 'nginx_access status=503 error [REDACTED_DETAIL]'
PREVIOUS_LOGS_UNAVAILABLE=true run_case
assert_no_current_errors
assert_contains "$case_output" 'previous_logs=unavailable'

: >"$previous_log"
run_case
assert_no_current_errors
assert_contains "$case_output" 'previous_logs=no_matching_error_lines'

real_python="$(command -v python3)"
cat >"$WORK_DIR/bin/python3" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${2:-}" == *nginx_access* && -n "${FAIL_CLASSIFIER_CALL:-}" ]]; then
  count="$(cat "$CLASSIFIER_CALL_LOG")"
  count=$(( ${count:-0} + 1 ))
  printf '%s\n' "$count" >"$CLASSIFIER_CALL_LOG"
  [[ "$count" != "$FAIL_CLASSIFIER_CALL" ]] || exit 73
fi
exec "${REAL_PYTHON:?}" "$@"
EOF
chmod +x "$WORK_DIR/bin/python3"
for call in 1 3; do
  if REAL_PYTHON="$real_python" FAIL_CLASSIFIER_CALL="$call" run_case; then
    fail "classifier execution failure was swallowed"
  fi
  assert_contains "$case_output" 'error log classification failed'
done
if REAL_PYTHON="$real_python" CURRENT_LOGS_UNAVAILABLE=true run_case; then
  fail "current log retrieval failure was accepted as clean"
fi
assert_contains "$case_output" 'current container log retrieval failed'

echo "oci_service_ops_tests=PASS classifier_cases=$cases"
