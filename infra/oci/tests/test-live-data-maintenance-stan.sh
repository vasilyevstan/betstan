#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/live-data-maintenance-stan.sh"
CAPACITY_SCRIPT="$ROOT_DIR/infra/oci/scripts/k3s-node-filesystem-capacity-stan.sh"
LOCK_SCRIPT="$ROOT_DIR/infra/oci/scripts/shared-mongo-operation-lock-stan.sh"
WORKFLOW="$ROOT_DIR/.github/workflows/oci-live-data-rollout.yml"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.live-data-maintenance-workdirs"

mkdir -p "$WORK_PARENT"
work_dir="$(mktemp -d "$WORK_PARENT/test.XXXXXX")"
stub_bin="$work_dir/bin"
stub_state="$work_dir/state"
state_file="$work_dir/maintenance.tsv"
INCIDENT_MANIFEST="$(printf '%064d' 7)"
INCIDENT_CONTROL="$(printf '%040d' 8)"
INCIDENT_OWNER=39945618182
INCIDENT_RESTORE=5000
mkdir -p "$stub_bin" "$stub_state/replicas" "$stub_state/images" "$stub_state/unstable"

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
for service in auth bet backoffice client event gamemaster moderation resulting slip telemetry; do
  printf '1\n' >"$stub_state/replicas/$service"
  printf 'ghcr.io/vasilyevstan/betstan-images@sha256:%064d\n' 1 \
    >"$stub_state/images/$service"
done

cat >"$stub_bin/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

state="${STUB_STATE_DIR:?}"
printf '%s\n' "$*" >>"${STUB_KUBECTL_LOG:-/dev/null}"

service_from_deployment() {
  local deployment="${1#deployment/}"
  deployment="${deployment#gaming-}"
  printf '%s' "${deployment%-depl}"
}

ready_pod_json() {
  local name="$1"
  local container="$2"
  local image="$3"
  jq -cn --arg name "$name" --arg container "$container" --arg image "$image" '{
    metadata:{name:$name,deletionTimestamp:null},
    spec:{containers:[{name:$container,image:$image}]},
    status:{
      phase:"Running",
      conditions:[{type:"Ready",status:"True"}]
    }
  }'
}

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" &&
      "${3:-}" == "gaming-mongo-migration-lock" ]]; then
  cat "$state/incident-lock.json"
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "configmap" ]]; then
  cat "$state/server-snippet"
  exit 0
fi

if [[ "$*" == "get nodes -o json" ]]; then
  printf '{"items":[{"metadata":{"name":"betstan-k3s"}}]}\n'
  exit 0
fi

if [[ "$*" == "get --raw /api/v1/nodes/betstan-k3s/proxy/stats/summary" ]]; then
  cat "${STUB_CAPACITY_SUMMARY:?}"
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
  image="$(cat "$state/images/$service")"
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
    jq -cn --argjson replicas "$replicas" --arg service "$service" --arg image "$image" '{
      spec:{
        replicas:$replicas,
        template:{spec:{containers:[{name:("gaming-" + $service),image:$image}]}}
      },
      status:{
        replicas:$replicas,
        updatedReplicas:$replicas,
        readyReplicas:0,
        availableReplicas:0
      }
    }'
    exit 0
  fi
  jq -cn --argjson replicas "$replicas" --arg service "$service" --arg image "$image" '{
    spec:{
      replicas:$replicas,
      template:{spec:{containers:[{name:("gaming-" + $service),image:$image}]}}
    },
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
    pod="$(ready_pod_json ingress-controller-0 ingress-controller ingress:fixture)"
    jq -cn --argjson pod "$pod" '{items:[$pod]}'
    exit 0
  fi
  service="${selector#app=gaming-}"
  replicas="$(cat "$state/replicas/$service")"
  image="$(cat "$state/images/$service")"
  if [[ "$replicas" == "0" ]]; then
    printf '{"items":[]}\n'
  else
    pod="$(ready_pod_json "gaming-${service}-0" "gaming-${service}" "$image")"
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
  if [[ "${STUB_FAIL_SCALE_AFTER_APPLY_SERVICE:-}" == "$service" &&
        ! -e "$state/scale-after-apply-failed-once" ]]; then
    touch "$state/scale-after-apply-failed-once"
    exit 1
  fi
  if [[ "${STUB_KILL_PARENT_AFTER_SCALE_SERVICE:-}" == "$service" &&
        ! -e "$state/scale-killed-parent-once" ]]; then
    touch "$state/scale-killed-parent-once"
    maintenance_pid="$(ps -o ppid= -p "$PPID" | tr -d ' ')"
    [[ "$maintenance_pid" =~ ^[1-9][0-9]*$ ]]
    kill -KILL "$maintenance_pid" "$PPID"
    sleep 1
  fi
  exit 0
fi

if [[ "${1:-}" == "set" && "${2:-}" == "image" ]]; then
  service="$(service_from_deployment "${3:-}")"
  assignment="${6:-}"
  image="${assignment#*=}"
  [[ "$assignment" == "gaming-${service}="* ]]
  [[ "$image" =~ ^ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$ ]]
  printf '%s\n' "$image" >"$state/images/$service"
  exit 0
fi

echo "unexpected kubectl invocation: $*" >&2
exit 1
SH
chmod +x "$stub_bin/kubectl"

jq -n \
  --arg manifest "$INCIDENT_MANIFEST" \
  --arg control "$INCIDENT_CONTROL" \
  --arg owner "$INCIDENT_OWNER" \
  --arg restore "$INCIDENT_RESTORE" \
  '{
    apiVersion:"v1",
    kind:"ConfigMap",
    metadata:{
      name:"gaming-mongo-migration-lock",
      namespace:"betstan-oci",
      uid:"incident-lock-uid",
      resourceVersion:"101"
    },
    data:{
      state:"active",
      holder:("live-data-incident-" + $restore + "-1"),
      "operation-id":"live-data-incident-restore",
      "source-sha":$control,
      "acquired-at-epoch":"900",
      "lease-duration-seconds":"1200",
      "lease-until-epoch":"2100",
      "released-at-epoch":"0",
      "fencing-generation":"520",
      "incident-manifest-sha256":$manifest,
      "incident-owner-run-id":$owner,
      "incident-restore-run-id":$restore,
      "incident-control-sha":$control,
      "incident-current-run-metadata-sha256":
        "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      "incident-request-created-at-epoch":"850",
      "incident-provider-transition-epoch":"900",
      "incident-predecessor-lease-until-epoch":"800",
      "incident-new-lease-until-epoch":"2100"
    }
  }' >"$stub_state/incident-lock.json"

cat >"$stub_state/capacity-over.json" <<'JSON'
{"node":{"fs":{"capacityBytes":50000000000,"usedBytes":35500000000,"availableBytes":14500000000}}}
JSON
: >"$stub_state/kubectl.log"
if PATH="$stub_bin:$PATH" \
    STUB_STATE_DIR="$stub_state" \
    STUB_KUBECTL_LOG="$stub_state/kubectl.log" \
    STUB_CAPACITY_SUMMARY="$stub_state/capacity-over.json" \
    OCI_K3S_NODE_NAME=betstan-k3s \
    OCI_DISK_MAX_PERCENT=70 \
      "$CAPACITY_SCRIPT" require-at-most >/dev/null 2>&1; then
  fail "pre-maintenance capacity guard accepted an already over-limit root filesystem"
fi
if grep -Eq '(^| )(patch|scale)( |$)' "$stub_state/kubectl.log"; then
  fail "over-limit capacity guard mutated the fence or writer replicas"
fi
cat >"$stub_state/capacity-at-limit.json" <<'JSON'
{"node":{"fs":{"capacityBytes":50000000000,"usedBytes":35000000000,"availableBytes":15000000000}}}
JSON
PATH="$stub_bin:$PATH" \
STUB_STATE_DIR="$stub_state" \
STUB_KUBECTL_LOG="$stub_state/kubectl.log" \
STUB_CAPACITY_SUMMARY="$stub_state/capacity-at-limit.json" \
OCI_K3S_NODE_NAME=betstan-k3s \
OCI_DISK_MAX_PERCENT=70 \
  "$CAPACITY_SCRIPT" require-at-most >/dev/null
if OCI_DISK_MAX_PERCENT=71 PATH="$stub_bin:$PATH" \
    STUB_STATE_DIR="$stub_state" \
    STUB_CAPACITY_SUMMARY="$stub_state/capacity-at-limit.json" \
      "$CAPACITY_SCRIPT" require-at-most >/dev/null 2>&1; then
  fail "capacity guard accepted a threshold waiver"
fi
python3 - "$WORKFLOW" <<'PY'
import sys

text = open(sys.argv[1], encoding="utf-8").read()
guard = text.index("- name: Revalidate exact release disk checkpoint before lock mutation")
lock = text.index("- name: Acquire database operation lock")
maintenance = text.index("- name: Enter or re-establish live data maintenance")
if not guard < lock < maintenance:
    raise SystemExit("checkpoint revalidation is not before lock and maintenance mutation")
PY

run_maintenance() {
  local action="$1"
  PATH="$stub_bin:$PATH" \
  STUB_STATE_DIR="$stub_state" \
  STUB_KUBECTL_LOG="$stub_state/kubectl.log" \
  STATE_FILE="$state_file" \
  INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
  INCIDENT_OWNER_RUN_ID="$INCIDENT_OWNER" \
  INCIDENT_RESTORE_RUN_ID="$INCIDENT_RESTORE" \
  INCIDENT_CONTROL_SHA="$INCIDENT_CONTROL" \
  NOW_EPOCH=1000 \
  OCI_K8S_NAMESPACE=betstan-oci \
  WAIT_ATTEMPTS=2 \
  WAIT_SECONDS=1 \
    "$SCRIPT" "$action" >/dev/null
}

run_incident_restore() {
  PATH="$stub_bin:$PATH" \
  STUB_STATE_DIR="$stub_state" \
  STUB_KUBECTL_LOG="$stub_state/kubectl.log" \
  STATE_FILE="$state_file" \
  RESTORE_KEEP_FENCE=true \
  INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
  INCIDENT_OWNER_RUN_ID="$INCIDENT_OWNER" \
  INCIDENT_RESTORE_RUN_ID="$INCIDENT_RESTORE" \
  INCIDENT_CONTROL_SHA="$INCIDENT_CONTROL" \
  NOW_EPOCH=1000 \
  OCI_K8S_NAMESPACE=betstan-oci \
  WAIT_ATTEMPTS=2 \
  WAIT_SECONDS=1 \
    env "$@" "$SCRIPT" restore >/dev/null
}

assert_replicas() {
  local expected="$1"
  local service
  for service in backoffice bet event moderation resulting slip gamemaster; do
    [[ "$(cat "$stub_state/replicas/$service")" == "$expected" ]] ||
      fail "$service replicas did not equal $expected"
  done
}

run_maintenance fence-writes
grep -Fq 'request_method' "$stub_state/server-snippet" ||
  fail "fence-only maintenance did not install the HTTP write fence"
assert_replicas 1
run_maintenance fence-writes
run_maintenance release
if grep -Fq 'request_method' "$stub_state/server-snippet"; then
  fail "fence-only maintenance release retained the HTTP write fence"
fi
assert_replicas 1

printf '2\n' >"$stub_state/unstable/event"
: >"$stub_state/kubectl.log"
run_maintenance enter
[[ "$(cat "$stub_state/unstable/event")" == "0" ]] ||
  fail "maintenance entry did not wait for transient deployment stability"
grep -Fq 'request_method' "$stub_state/server-snippet" ||
  fail "maintenance entry did not install the HTTP write fence"
assert_replicas 0
quiesce_order="$(
  sed -n 's#^scale deployment/gaming-\([a-z]*\)-depl .*--replicas=0$#\1#p' \
    "$stub_state/kubectl.log" | paste -sd' ' -
)"
[[ "$quiesce_order" == "backoffice gamemaster event slip moderation resulting bet" ]] ||
  fail "maintenance quiesce order was not the exact reviewed seven-writer order"
run_maintenance verify-held
[[ -s "$state_file" ]] || fail "maintenance entry did not capture restoration state"

: >"$stub_state/kubectl.log"
run_maintenance restore
if grep -Fq 'request_method' "$stub_state/server-snippet"; then
  fail "maintenance restoration retained the HTTP write fence"
fi
assert_replicas 1
restore_order="$(
  sed -n 's#^scale deployment/gaming-\([a-z]*\)-depl .*--replicas=1$#\1#p' \
    "$stub_state/kubectl.log" | paste -sd' ' -
)"
[[ "$restore_order" == "bet event moderation resulting slip gamemaster backoffice" ]] ||
  fail "maintenance restore order did not restore Backoffice last"
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
for service in backoffice bet event moderation resulting slip gamemaster; do
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
run_maintenance verify-quiesced

cat >"$stub_state/server-snippet" <<'EOF'
if ($host = "www.betstan.xyz") {
  return 308 https://betstan.xyz$request_uri;
}
EOF
if run_maintenance verify-held >/dev/null 2>&1; then
  fail "quiesced writers without the HTTP fence were treated as fully held"
fi
run_maintenance verify-quiesced
run_maintenance hold
run_maintenance verify-held

for service in backoffice bet event moderation resulting slip gamemaster; do
  printf '1\n' >"$stub_state/replicas/$service"
done
cat >"$stub_state/server-snippet" <<'EOF'
if ($host = "www.betstan.xyz") {
  return 308 https://betstan.xyz$request_uri;
}
EOF
if run_maintenance verify-quiesced >/dev/null 2>&1; then
  fail "running writers were treated as quiesced"
fi
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

baseline_dir="$work_dir/authenticated-baseline"
baseline_deployments="$baseline_dir/deployments.tsv"
baseline_images="$baseline_dir/live-images.tsv"
readiness_file="$work_dir/readiness.tsv"
mkdir -p "$baseline_dir"
python3 - "$baseline_deployments" "$baseline_images" "$stub_state/images" <<'PY'
import sys
from pathlib import Path

deployments, images, state_images = map(Path, sys.argv[1:])
services = (
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
)
deployment_rows = []
image_rows = []
for index, service in enumerate(services, 1):
    image = (
        "ghcr.io/vasilyevstan/betstan-images@sha256:"
        f"{index:064x}"
    )
    deployment_rows.append(f"{service}\t{image}\t{index}\t1\t1\t1\n")
    image_rows.append(f"{service}\t{image}\n")
    (state_images / service).write_text(image + "\n", encoding="utf-8")
deployments.write_text("".join(deployment_rows), encoding="utf-8")
images.write_text("".join(image_rows), encoding="utf-8")
PY
for service in auth bet backoffice client event gamemaster moderation resulting slip telemetry; do
  printf '1\n' >"$stub_state/replicas/$service"
done
cat >"$stub_state/server-snippet" <<'EOF'
if ($host = "www.betstan.xyz") {
  return 308 https://betstan.xyz$request_uri;
}
EOF
rm -f -- "$state_file" "$readiness_file"
: >"$stub_state/kubectl.log"
PATH="$stub_bin:$PATH" \
STUB_STATE_DIR="$stub_state" \
STUB_KUBECTL_LOG="$stub_state/kubectl.log" \
STATE_FILE="$state_file" \
BASELINE_DEPLOYMENTS_FILE="$baseline_deployments" \
BASELINE_LIVE_IMAGES_FILE="$baseline_images" \
OCI_K8S_NAMESPACE=betstan-oci \
WAIT_ATTEMPTS=2 \
WAIT_SECONDS=1 \
  "$SCRIPT" reconstruct-baseline >/dev/null
grep -Fxq $'state_version\t2' "$state_file" ||
  fail "authenticated baseline reconstruction did not create version 2 state"

run_maintenance hold
run_maintenance verify-held
run_maintenance verify-baseline-images
printf 'ghcr.io/vasilyevstan/betstan-images@sha256:%064d\n' 99 \
  >"$stub_state/images/event"
if run_maintenance verify-baseline-images >/dev/null 2>&1; then
  fail "live image drift was accepted against the authenticated baseline"
fi
printf '2\n' >"$stub_state/replicas/client"
: >"$stub_state/kubectl.log"
PATH="$stub_bin:$PATH" \
STUB_STATE_DIR="$stub_state" \
STUB_KUBECTL_LOG="$stub_state/kubectl.log" \
STATE_FILE="$state_file" \
RESTORE_KEEP_FENCE=true \
INCIDENT_MANIFEST_SHA256="$INCIDENT_MANIFEST" \
INCIDENT_OWNER_RUN_ID="$INCIDENT_OWNER" \
INCIDENT_RESTORE_RUN_ID="$INCIDENT_RESTORE" \
INCIDENT_CONTROL_SHA="$INCIDENT_CONTROL" \
NOW_EPOCH=1000 \
OCI_K8S_NAMESPACE=betstan-oci \
WAIT_ATTEMPTS=2 \
WAIT_SECONDS=1 \
  "$SCRIPT" restore >/dev/null
grep -Fq 'request_method' "$stub_state/server-snippet" ||
  fail "keep-fence restoration released the HTTP write fence"
[[ -f "$state_file" ]] ||
  fail "keep-fence restoration discarded state before readiness capture"
for service in auth bet backoffice client event gamemaster moderation resulting slip telemetry; do
  [[ "$(cat "$stub_state/replicas/$service")" == "1" ]] ||
    fail "$service did not restore its exact baseline replicas"
  expected_image="$(
    awk -F '\t' -v service="$service" '$1 == service {print $2}' "$baseline_images"
  )"
  [[ "$(cat "$stub_state/images/$service")" == "$expected_image" ]] ||
    fail "$service did not restore its exact baseline image"
done
[[ "$(grep -c '^set image deployment/gaming-' "$stub_state/kubectl.log")" == "10" ]] ||
  fail "authenticated baseline restore did not bind all ten deployment images"

for fault_service in auth client telemetry bet event moderation resulting slip gamemaster backoffice; do
  run_maintenance hold
  rm -f -- \
    "$stub_state/scale-after-apply-failed-once" \
    "$stub_state/scale-killed-parent-once"
  if run_incident_restore \
      "STUB_FAIL_SCALE_AFTER_APPLY_SERVICE=$fault_service" \
      >"$work_dir/fault-${fault_service}.out" 2>&1; then
    fail "incident restore accepted a fault after scaling $fault_service"
  fi
  assert_replicas 0
  grep -Fq 'request_method' "$stub_state/server-snippet" ||
    fail "fault after scaling $fault_service released the incident fence"
done

run_maintenance hold
printf '2\n' >"$stub_state/unstable/event"
if run_incident_restore >"$work_dir/wait-fault.out" 2>&1; then
  fail "incident restore accepted a scale-applied but wait-failed writer"
fi
assert_replicas 0
[[ "$(cat "$stub_state/unstable/event")" == "0" ]] ||
  fail "wait-failure fixture did not reach deterministic reconciliation"
grep -Fq 'request_method' "$stub_state/server-snippet" ||
  fail "wait-failed incident restore released the incident fence"

run_maintenance hold
rm -f -- \
  "$stub_state/scale-after-apply-failed-once" \
  "$stub_state/scale-killed-parent-once"
if run_incident_restore \
    STUB_KILL_PARENT_AFTER_SCALE_SERVICE=event \
    >"$work_dir/hard-termination.out" 2>&1; then
  fail "hard-terminated incident restore unexpectedly succeeded"
fi
partial_restore=false
for service in backoffice bet event moderation resulting slip gamemaster; do
  if [[ "$(cat "$stub_state/replicas/$service")" != "0" ]]; then
    partial_restore=true
  fi
done
if [[ "$partial_restore" != "true" ]]; then
  fail "hard-termination fixture did not leave a partial writer restore"
fi
run_maintenance reconcile-incident-writers
assert_replicas 0
grep -Fq 'request_method' "$stub_state/server-snippet" ||
  fail "hard-termination reconciliation released the incident fence"

: >"$stub_state/kubectl.log"
if PATH="$stub_bin:$PATH" \
    STUB_STATE_DIR="$stub_state" \
    STUB_KUBECTL_LOG="$stub_state/kubectl.log" \
    STATE_FILE="$state_file" \
    INCIDENT_MANIFEST_SHA256="$(printf '%064d' 9)" \
    INCIDENT_OWNER_RUN_ID="$INCIDENT_OWNER" \
    INCIDENT_RESTORE_RUN_ID="$INCIDENT_RESTORE" \
    INCIDENT_CONTROL_SHA="$INCIDENT_CONTROL" \
    NOW_EPOCH=1000 \
    OCI_K8S_NAMESPACE=betstan-oci \
    WAIT_ATTEMPTS=2 \
    WAIT_SECONDS=1 \
      "$SCRIPT" reconcile-incident-writers \
        >"$work_dir/reconcile-mismatch.out" 2>&1; then
  fail "writer reconciliation accepted a mismatched incident lock binding"
fi
if grep -Eq '^scale ' "$stub_state/kubectl.log"; then
  fail "mismatched incident lock reached writer mutation"
fi

run_incident_restore
run_maintenance release
if grep -Fq 'request_method' "$stub_state/server-snippet"; then
  fail "authenticated baseline release retained the HTTP write fence"
fi
PATH="$stub_bin:$PATH" \
STUB_STATE_DIR="$stub_state" \
STUB_KUBECTL_LOG="$stub_state/kubectl.log" \
STATE_FILE="$state_file" \
READINESS_FILE="$readiness_file" \
OCI_K8S_NAMESPACE=betstan-oci \
WAIT_ATTEMPTS=2 \
WAIT_SECONDS=1 \
  "$SCRIPT" capture-readiness >/dev/null
[[ "$(wc -l <"$readiness_file" | tr -d ' ')" == "11" ]] ||
  fail "authenticated readiness capture did not cover all ten services"
[[ ! -e "$state_file" ]] ||
  fail "authenticated readiness capture retained stale restoration state"

python3 - "$baseline_deployments" "$baseline_images" "$work_dir" <<'PY'
import sys
from pathlib import Path

deployments = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
images = Path(sys.argv[2]).read_text(encoding="utf-8").splitlines()
root = Path(sys.argv[3])
(root / "missing-deployments.tsv").write_text(
    "\n".join(deployments[:-1]) + "\n", encoding="utf-8"
)
zero = list(deployments)
fields = zero[0].split("\t")
fields[3] = "0"
zero[0] = "\t".join(fields)
(root / "zero-deployments.tsv").write_text(
    "\n".join(zero) + "\n", encoding="utf-8"
)
mismatch = list(images)
service, _ = mismatch[0].split("\t")
mismatch[0] = (
    f"{service}\tghcr.io/vasilyevstan/betstan-images@sha256:"
    f"{999:064x}"
)
(root / "mismatch-images.tsv").write_text(
    "\n".join(mismatch) + "\n", encoding="utf-8"
)
PY
for invalid_case in missing zero mismatch; do
  rm -f -- "$state_file"
  deployments_file="$baseline_deployments"
  images_file="$baseline_images"
  case "$invalid_case" in
    missing) deployments_file="$work_dir/missing-deployments.tsv" ;;
    zero) deployments_file="$work_dir/zero-deployments.tsv" ;;
    mismatch) images_file="$work_dir/mismatch-images.tsv" ;;
  esac
  if PATH="$stub_bin:$PATH" \
      STUB_STATE_DIR="$stub_state" \
      STATE_FILE="$state_file" \
      BASELINE_DEPLOYMENTS_FILE="$deployments_file" \
      BASELINE_LIVE_IMAGES_FILE="$images_file" \
      OCI_K8S_NAMESPACE=betstan-oci \
      WAIT_ATTEMPTS=2 \
      WAIT_SECONDS=1 \
        "$SCRIPT" reconstruct-baseline >/dev/null 2>&1; then
    fail "authenticated baseline reconstruction accepted $invalid_case evidence"
  fi
  [[ ! -e "$state_file" ]] ||
    fail "rejected $invalid_case baseline created restoration state"
done

python3 - "$WORKFLOW" <<'PY'
import sys

text = open(sys.argv[1], encoding="utf-8").read()
takeover = text.index("- name: Replace exact expired held lock")
restore = text.index("- name: Restore authenticated baseline while retaining fence")
release_lock = text.index("- name: Release incident lock before fence")
release_fence = text.index("- name: Release fence after lock")
readiness = text.index("- name: Capture restored readiness and public availability")
if not takeover < restore < release_lock < release_fence < readiness:
    raise SystemExit("incident restoration mutation and release order changed")
PY

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
