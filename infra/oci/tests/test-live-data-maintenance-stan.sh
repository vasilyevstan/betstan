#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/live-data-maintenance-stan.sh"
LOCK_SCRIPT="$ROOT_DIR/infra/oci/scripts/shared-mongo-operation-lock-stan.sh"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.live-data-maintenance-workdirs"

mkdir -p "$WORK_PARENT"
work_dir="$(mktemp -d "$WORK_PARENT/test.XXXXXX")"
stub_bin="$work_dir/bin"
stub_state="$work_dir/state"
state_file="$work_dir/maintenance.tsv"
mkdir -p "$stub_bin" "$stub_state/replicas" "$stub_state/unstable"

cleanup() {
  rm -rf -- "$work_dir"
  rmdir "$WORK_PARENT" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "live data maintenance contract test failed: $*" >&2
  exit 1
}

cat >"$stub_state/server-snippet" <<'EOF'
if ($host = "www.betstan.xyz") {
  return 308 https://betstan.xyz$request_uri;
}
EOF
for service in bet event moderation resulting slip gamemaster; do
  printf '1\n' >"$stub_state/replicas/$service"
done

cat >"$stub_bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

state="${STUB_STATE_DIR:?}"

service_from_deployment() {
  local deployment="${1#deployment/}"
  deployment="${deployment#gaming-}"
  printf '%s' "${deployment%-depl}"
}

ready_pod_json() {
  local name="$1"
  jq -cn --arg name "$name" '{
    metadata:{name:$name,deletionTimestamp:null},
    status:{
      phase:"Running",
      conditions:[{type:"Ready",status:"True"}]
    }
  }'
}

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" ]]; then
  cat "$state/server-snippet"
  exit 0
fi

if [[ "${1:-}" == "patch" && "${2:-}" == "configmap" ]]; then
  patch=""
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "--patch" ]]; then
      patch="$2"
      break
    fi
    shift
  done
  [[ -n "$patch" ]]
  jq -r '.data["server-snippet"]' <<<"$patch" >"$state/server-snippet"
  exit 0
fi

if [[ "${1:-}" == "rollout" && "${2:-}" == "status" ]]; then
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "deployment" ]]; then
  service="$(service_from_deployment "${3:-}")"
  replicas="$(cat "$state/replicas/$service")"
  unstable_file="$state/unstable/$service"
  unstable=0
  if [[ -f "$unstable_file" ]]; then
    remaining="$(cat "$unstable_file")"
    if (( remaining > 0 )); then
      unstable=1
      printf '%s\n' "$((remaining - 1))" >"$unstable_file"
    fi
  fi
  if [[ "$unstable" == "1" ]]; then
    jq -cn --argjson replicas "$replicas" '{
      spec:{replicas:$replicas},
      status:{
        replicas:$replicas,
        updatedReplicas:$replicas,
        readyReplicas:0,
        availableReplicas:0
      }
    }'
    exit 0
  fi
  jq -cn --argjson replicas "$replicas" '{
    spec:{replicas:$replicas},
    status:{
      replicas:$replicas,
      updatedReplicas:$replicas,
      readyReplicas:$replicas,
      availableReplicas:$replicas
    }
  }'
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "pods" ]]; then
  selector=""
  while [[ "$#" -gt 0 ]]; do
    if [[ "$1" == "-l" ]]; then
      selector="$2"
      break
    fi
    shift
  done
  if [[ "$selector" == "app.kubernetes.io/component=controller" ]]; then
    pod="$(ready_pod_json ingress-controller-0)"
    jq -cn --argjson pod "$pod" '{items:[$pod]}'
    exit 0
  fi
  service="${selector#app=gaming-}"
  replicas="$(cat "$state/replicas/$service")"
  if [[ "$replicas" == "0" ]]; then
    printf '{"items":[]}\n'
  else
    pod="$(ready_pod_json "gaming-${service}-0")"
    jq -cn --argjson pod "$pod" '{items:[$pod]}'
  fi
  exit 0
fi

if [[ "${1:-}" == "exec" ]]; then
  cat "$state/server-snippet"
  exit 0
fi

if [[ "${1:-}" == "scale" ]]; then
  service="$(service_from_deployment "${2:-}")"
  replicas=""
  for argument in "$@"; do
    [[ "$argument" != --replicas=* ]] || replicas="${argument#--replicas=}"
  done
  [[ "$replicas" =~ ^[0-9]+$ ]]
  if [[ "${STUB_FAIL_SCALE_SERVICE:-}" == "$service" &&
        ! -e "$state/scale-failed-once" ]]; then
    touch "$state/scale-failed-once"
    exit 1
  fi
  printf '%s\n' "$replicas" >"$state/replicas/$service"
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 1
SH
chmod +x "$stub_bin/kubectl"

run_maintenance() {
  local action="$1"
  PATH="$stub_bin:$PATH" \
  STUB_STATE_DIR="$stub_state" \
  STATE_FILE="$state_file" \
  OCI_K8S_NAMESPACE=betstan-oci \
  WAIT_ATTEMPTS=2 \
  WAIT_SECONDS=1 \
    "$SCRIPT" "$action" >/dev/null
}

assert_replicas() {
  local expected="$1"
  local service
  for service in bet event moderation resulting slip gamemaster; do
    [[ "$(cat "$stub_state/replicas/$service")" == "$expected" ]] ||
      fail "$service replicas did not equal $expected"
  done
}

printf '2\n' >"$stub_state/unstable/event"
run_maintenance enter
[[ "$(cat "$stub_state/unstable/event")" == "0" ]] ||
  fail "maintenance entry did not wait for transient deployment stability"
grep -Fq 'request_method' "$stub_state/server-snippet" ||
  fail "maintenance entry did not install the HTTP write fence"
assert_replicas 0
run_maintenance verify-held
[[ -s "$state_file" ]] || fail "maintenance entry did not capture restoration state"

run_maintenance restore
if grep -Fq 'request_method' "$stub_state/server-snippet"; then
  fail "maintenance restoration retained the HTTP write fence"
fi
assert_replicas 1
[[ ! -e "$state_file" ]] || fail "maintenance restoration retained stale state"

printf '10\n' >"$stub_state/unstable/event"
if run_maintenance enter >/dev/null 2>&1; then
  fail "persistently unstable deployment was accepted"
fi
rm -f -- "$stub_state/unstable/event"
assert_replicas 1
if grep -Fq 'request_method' "$stub_state/server-snippet"; then
  fail "unstable preflight changed the HTTP write fence"
fi

run_maintenance enter
for service in bet event moderation resulting slip gamemaster; do
  STUB_STATE_DIR="$stub_state" "$stub_bin/kubectl" \
    scale "deployment/gaming-${service}-depl" \
    -n betstan-oci \
    --replicas=1 >/dev/null
done
run_maintenance release
assert_replicas 1
if grep -Fq 'request_method' "$stub_state/server-snippet"; then
  fail "deployment release retained the HTTP write fence"
fi

run_maintenance hold
assert_replicas 0
run_maintenance verify-held

for service in bet event moderation resulting slip gamemaster; do
  printf '1\n' >"$stub_state/replicas/$service"
done
cat >"$stub_state/server-snippet" <<'EOF'
if ($host = "www.betstan.xyz") {
  return 308 https://betstan.xyz$request_uri;
}
EOF
rm -f -- "$state_file" "$stub_state/scale-failed-once"
if PATH="$stub_bin:$PATH" \
    STUB_STATE_DIR="$stub_state" \
    STUB_FAIL_SCALE_SERVICE=slip \
    STATE_FILE="$state_file" \
    OCI_K8S_NAMESPACE=betstan-oci \
    WAIT_ATTEMPTS=2 \
    WAIT_SECONDS=1 \
      "$SCRIPT" enter >/dev/null 2>&1; then
  fail "partial writer quiescence was accepted"
fi
assert_replicas 1
if grep -Fq 'request_method' "$stub_state/server-snippet"; then
  fail "failed maintenance entry did not restore the HTTP write fence"
fi

lock_bin="$work_dir/lock-bin"
mkdir -p "$lock_bin"
cat >"$lock_bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" ]]; then
  IFS='|' read -r state holder operation_id source_sha <<<"${STUB_LOCK_STATE:?}"
  jq -cn \
    --arg state "$state" \
    --arg holder "$holder" \
    --arg operation_id "$operation_id" \
    --arg source_sha "$source_sha" \
    '{
      apiVersion:"v1",
      kind:"ConfigMap",
      metadata:{
        name:"gaming-mongo-migration-lock",
        namespace:"betstan-oci",
        resourceVersion:"1"
      },
      data:{
        state:$state,
        holder:$holder,
        "operation-id":$operation_id,
        "source-sha":$source_sha,
        "acquired-at-epoch":"900",
        "lease-duration-seconds":"200",
        "lease-until-epoch":"1100",
        "released-at-epoch":"0",
        "fencing-generation":"1"
      }
    }'
  exit 0
fi
echo "unexpected lock kubectl invocation: $*" >&2
exit 1
SH
chmod +x "$lock_bin/kubectl"
lock_env=(
  NAMESPACE=betstan-oci
  LOCK_TOKEN=live-data-4003-1
  OPERATION_ID=live-data-apply-slip-index
  SOURCE_SHA=1111111111111111111111111111111111111111
  NOW_EPOCH=1000
)
PATH="$lock_bin:$PATH" \
STUB_LOCK_STATE='active|live-data-4003-1|live-data-apply-slip-index|1111111111111111111111111111111111111111' \
env "${lock_env[@]}" "$LOCK_SCRIPT" verify >/dev/null
PATH="$lock_bin:$PATH" \
STUB_LOCK_STATE='released||live-data-apply-slip-index|1111111111111111111111111111111111111111' \
env "${lock_env[@]}" "$LOCK_SCRIPT" verify-released >/dev/null
if PATH="$lock_bin:$PATH" \
    STUB_LOCK_STATE='active|different-holder|live-data-apply-slip-index|1111111111111111111111111111111111111111' \
    env "${lock_env[@]}" "$LOCK_SCRIPT" verify >/dev/null 2>&1; then
  fail "database lock handoff accepted a different holder"
fi

echo "live_data_maintenance_tests=PASS"
