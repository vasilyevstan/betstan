#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OPERATOR="$ROOT_DIR/infra/azure/agents/retire-production-stan.sh"
_SAFE_PARENT="${BETSTAN_TEST_TMPDIR:-${ROOT_DIR}/.test-workdirs}"
mkdir -p "$_SAFE_PARENT"
WORK_DIR="$(mktemp -d "$_SAFE_PARENT/retirement-XXXXXX")"
BIN_DIR="$WORK_DIR/bin"
SOURCE_SHA="1111111111111111111111111111111111111111"
CLUSTER_ID="/subscriptions/fixture/resourceGroups/betstan-rg/providers/Microsoft.ContainerService/managedClusters/betstan-aks"

mkdir -p "$BIN_DIR"
trap 'rm -rf "$WORK_DIR"' EXIT

jq -n --arg cluster "$CLUSTER_ID" '
  [{
    id:$cluster,
    name:"betstan-aks",
    resourceGroup:"betstan-rg",
    type:"Microsoft.ContainerService/managedClusters"
  }] +
  [range(0; 8) | {
    id:("/subscriptions/fixture/resourceGroups/betstan-rg/providers/Microsoft.Compute/snapshots/snapshot-" + tostring),
    name:("snapshot-" + tostring),
    resourceGroup:"betstan-rg",
    type:"Microsoft.Compute/snapshots"
  }] +
  [range(0; 3) | {
    id:("/subscriptions/fixture/resourceGroups/betstan-rg/providers/Microsoft.Insights/metricalerts/alert-" + tostring),
    name:("alert-" + tostring),
    resourceGroup:"betstan-rg",
    type:"Microsoft.Insights/metricalerts"
  }] +
  [{
    id:"/subscriptions/fixture/resourceGroups/betstan-rg/providers/microsoft.insights/actiongroups/action-group",
    name:"action-group",
    resourceGroup:"betstan-rg",
    type:"microsoft.insights/actiongroups"
  }]
' > "$WORK_DIR/primary.json"

jq -n '
  [{
    id:"/subscriptions/fixture/resourceGroups/MC_betstan-rg_betstan-aks_eastus/providers/Microsoft.Compute/virtualMachineScaleSets/nodepool",
    name:"nodepool",
    resourceGroup:"MC_betstan-rg_betstan-aks_eastus",
    type:"Microsoft.Compute/virtualMachineScaleSets"
  }] +
  [range(0; 8) | {
    id:("/subscriptions/fixture/resourceGroups/MC_betstan-rg_betstan-aks_eastus/providers/Microsoft.Compute/disks/disk-" + tostring),
    name:("disk-" + tostring),
    resourceGroup:"MC_betstan-rg_betstan-aks_eastus",
    type:"Microsoft.Compute/disks"
  }] +
  [{
    id:"/subscriptions/fixture/resourceGroups/MC_betstan-rg_betstan-aks_eastus/providers/Microsoft.Network/loadBalancers/kubernetes",
    name:"kubernetes",
    resourceGroup:"MC_betstan-rg_betstan-aks_eastus",
    type:"Microsoft.Network/loadBalancers"
  }] +
  [range(0; 2) | {
    id:("/subscriptions/fixture/resourceGroups/MC_betstan-rg_betstan-aks_eastus/providers/Microsoft.Network/publicIPAddresses/ip-" + tostring),
    name:("ip-" + tostring),
    resourceGroup:"MC_betstan-rg_betstan-aks_eastus",
    type:"Microsoft.Network/publicIPAddresses"
  }] +
  [{
    id:"/subscriptions/fixture/resourceGroups/MC_betstan-rg_betstan-aks_eastus/providers/Microsoft.ManagedIdentity/userAssignedIdentities/kubelet",
    name:"kubelet",
    resourceGroup:"MC_betstan-rg_betstan-aks_eastus",
    type:"Microsoft.ManagedIdentity/userAssignedIdentities"
  },{
    id:"/subscriptions/fixture/resourceGroups/MC_betstan-rg_betstan-aks_eastus/providers/Microsoft.Network/networkSecurityGroups/nsg",
    name:"nsg",
    resourceGroup:"MC_betstan-rg_betstan-aks_eastus",
    type:"Microsoft.Network/networkSecurityGroups"
  },{
    id:"/subscriptions/fixture/resourceGroups/MC_betstan-rg_betstan-aks_eastus/providers/Microsoft.Network/virtualNetworks/vnet",
    name:"vnet",
    resourceGroup:"MC_betstan-rg_betstan-aks_eastus",
    type:"Microsoft.Network/virtualNetworks"
  }]
' > "$WORK_DIR/managed.json"

cat > "$BIN_DIR/az" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${STUB_AZ_LOG:?}"
case "${1:-} ${2:-}" in
  "account show")
    if [[ "${STUB_WRONG_SUBSCRIPTION:-0}" == "1" ]]; then
      printf '%s\n' '{"state":"Enabled","id":"wrong-subscription"}'
    else
      printf '%s\n' '{"state":"Enabled","id":"fixture-subscription"}'
    fi
    ;;
  "group exists")
    [[ "${STUB_GROUP_API_FAIL:-0}" != "1" ]] || exit 1
    group=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--name" ]]; then
        group="$2"
        break
      fi
      shift
    done
    phase="$(cat "${STUB_DELETE_PHASE_FILE:-/dev/null}" 2>/dev/null || true)"
    if [[ "$group" == "betstan-rg" && "$phase" == "retired" ]]; then
      printf '%s\n' false
    elif [[ "$group" == "MC_betstan-rg_betstan-aks_eastus" &&
      ("$phase" == "managed-absent" || "$phase" == "retired") ]]; then
      printf '%s\n' false
    else
      printf '%s\n' true
    fi
    ;;
  "group list")
    phase="$(cat "${STUB_DELETE_PHASE_FILE:-/dev/null}" 2>/dev/null || true)"
    if [[ "$phase" == "retired" ]]; then
      printf '%s\n' '[]'
    else
      printf '%s\n' '[{"name":"betstan-rg"},{"name":"MC_betstan-rg_betstan-aks_eastus"}]'
    fi
    ;;
  "group delete")
    group=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--name" ]]; then
        group="$2"
        break
      fi
      shift
    done
    if [[ "$group" == "MC_betstan-rg_betstan-aks_eastus" ]]; then
      printf '%s\n' managed-absent > "$STUB_DELETE_PHASE_FILE"
      [[ "${STUB_CRASH_POINT:-}" != "managed" ]] || exit 99
    elif [[ "$group" == "betstan-rg" ]]; then
      printf '%s\n' retired > "$STUB_DELETE_PHASE_FILE"
      [[ "${STUB_CRASH_POINT:-}" != "primary" ]] || exit 99
    else
      exit 1
    fi
    ;;
  "aks show")
    jq -n \
      --arg id "$STUB_CLUSTER_ID" \
      --arg power "${STUB_AKS_POWER_STATE:-Stopped}" '{
      id:$id,
      eTag:"fixture-etag",
      nodeResourceGroup:"MC_betstan-rg_betstan-aks_eastus",
      powerState:{code:$power},
      provisioningState:"Failed"
    }'
    ;;
  "resource list")
    group=""
    while [[ $# -gt 0 ]]; do
      if [[ "$1" == "--resource-group" ]]; then
        group="$2"
        break
      fi
      shift
    done
    phase="$(cat "${STUB_DELETE_PHASE_FILE:-/dev/null}" 2>/dev/null || true)"
    if [[ -z "$group" ]]; then
      if [[ "$phase" == "retired" ]]; then
        printf '%s\n' '[]'
      else
        jq -s 'add' "$STUB_PRIMARY_JSON" "$STUB_MANAGED_JSON"
      fi
    elif [[ "$group" == "betstan-rg" ]]; then
      if [[ "${STUB_UNKNOWN_RESOURCE:-0}" == "1" ]]; then
        jq '. + [{
          id:"/subscriptions/fixture/resourceGroups/betstan-rg/providers/Microsoft.Storage/storageAccounts/unapproved",
          name:"unapproved",
          resourceGroup:"betstan-rg",
          type:"Microsoft.Storage/storageAccounts"
        }]' "$STUB_PRIMARY_JSON"
      elif [[ "$phase" == "aks-absent" ||
        "$phase" == "managed-absent" || "$phase" == "retired" ]]; then
        jq '[.[] | select(
          (.type | ascii_downcase) !=
            "microsoft.containerservice/managedclusters"
        )]' "$STUB_PRIMARY_JSON"
      else
        cat "$STUB_PRIMARY_JSON"
      fi
    else
      cat "$STUB_MANAGED_JSON"
    fi
    ;;
  "vmss list-instances")
    if [[ "${STUB_RUNNING_VMSS:-0}" == "1" ]]; then
      printf '%s\n' '[{"instanceView":{"statuses":[{"code":"PowerState/running"}]}}]'
    elif [[ "${STUB_EMPTY_VMSS:-0}" == "1" ]]; then
      printf '%s\n' '[]'
    else
      printf '%s\n' '[{"instanceView":{"statuses":[{"code":"PowerState/deallocated"}]}}]'
    fi
    ;;
  "lock list")
    printf '%s\n' '[]'
    ;;
  "group show")
    printf '%s\n' '{"properties":{"provisioningState":"Succeeded"}}'
    ;;
  "aks delete")
    printf '%s\n' aks-absent > "$STUB_DELETE_PHASE_FILE"
    [[ "${STUB_CRASH_POINT:-}" != "aks" ]] || exit 99
    ;;
  "rest --method")
    method=""
    url=""
    header=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --method) method="$2"; shift 2 ;;
        --url) url="$2"; shift 2 ;;
        --headers) header="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ "$method" == "delete" ]]
    [[ "$url" == "${STUB_CLUSTER_ID}?api-version=2025-10-01" ]]
    [[ "$header" == "If-Match=fixture-etag" ]]
    printf '%s\n' aks-absent > "$STUB_DELETE_PHASE_FILE"
    [[ "${STUB_CRASH_POINT:-}" != "aks" ]] || exit 99
    ;;
  *)
    printf 'unexpected az call: %s\n' "$*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$BIN_DIR/az"

cat > "$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "api" ]]; then
  endpoint="${2:-}"
  if [[ "$endpoint" == */actions/runs/123 ]]; then
    conclusion=success
    [[ "${STUB_BAD_RUN:-0}" != "1" ]] || conclusion=failure
    jq -n --arg sha "$STUB_SOURCE_SHA" --arg conclusion "$conclusion" '{
      path:".github/workflows/oci-migrate.yml",
      event:"workflow_dispatch",
      head_branch:"master",
      head_sha:$sha,
      run_attempt:1,
      status:"completed",
      conclusion:$conclusion
    }'
  elif [[ "$endpoint" == */git/ref/heads/master ]]; then
    printf '%s\n' "$STUB_SOURCE_SHA"
  elif [[ "$endpoint" == */actions/runs/123/artifacts* ]]; then
    printf '%s\n' '{"artifacts":[{
      "name":"oci-migration-success-provenance-123-1",
      "expired":false
    }]}'
  else
    printf 'unexpected gh api call: %s\n' "$*" >&2
    exit 1
  fi
elif [[ "${1:-} ${2:-}" == "run download" ]]; then
  directory=""
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "--dir" ]]; then
      directory="$2"
      break
    fi
    shift
  done
  [[ -n "$directory" ]]
  target_signature="$(printf 'a%.0s' {1..64})"
  [[ "${STUB_BAD_PARITY:-0}" != "1" ]] ||
    target_signature="$(printf 'b%.0s' {1..64})"
  fence_removed=true
  [[ "${STUB_FENCE_RETAINED:-0}" != "1" ]] || fence_removed=false
  runtime_deploy_source_sha="${STUB_RUNTIME_DEPLOY_SOURCE_SHA:-${STUB_SOURCE_SHA}}"
  [[ "${STUB_BAD_RUNTIME_SHA:-0}" != "1" ]] ||
    runtime_deploy_source_sha=invalid
  closed_recovery_retry="${STUB_CLOSED_RECOVERY_RETRY:-false}"
  [[ "${STUB_BAD_CLOSED_RECOVERY:-0}" != "1" ]] ||
    closed_recovery_retry=invalid
  cat > "$directory/migration-summary.env" <<ENV
schema=betstan.oci-migration-success.v1
migration_id=migration-fixture
source_sha=${STUB_SOURCE_SHA}
runtime_deploy_source_sha=${runtime_deploy_source_sha}
closed_recovery_retry=${closed_recovery_retry}
github_run_id=123
github_run_attempt=1
terminal_phase=DEPLOYED_HEALTHY
terminal_status=DEPLOYED_HEALTHY
journal_heartbeat_epoch=1
journal_generation=1
journal_sequence=1
fencing_generation=1
artifact_run_binding=123-1
destructive_boundary_crossed=true
database_count=8
logical_source_target_parity=true
source_signature_aggregate_sha256=$(printf 'a%.0s' {1..64})
target_signature_aggregate_sha256=${target_signature}
oci_reopened_healthy=true
http_mutation_fence_removed=${fence_removed}
azure_writers_frozen=true
azure_cluster_resource_id_sha256=${STUB_CLUSTER_DIGEST}
aks_power_state=${STUB_AKS_POWER_STATE:-Stopped}
vmss_instances_deallocated=true
azure_cluster_stopped_deallocated=true
final_journal_sha256=$(printf 'c%.0s' {1..64})
ENV
else
  printf 'unexpected gh call: %s\n' "$*" >&2
  exit 1
fi
STUB
chmod +x "$BIN_DIR/gh"

cat > "$BIN_DIR/dig" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${2:-}" == "A" ]]; then
  printf '%s\n' 203.0.113.10
fi
STUB
chmod +x "$BIN_DIR/dig"

cat > "$BIN_DIR/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
output=/dev/null
headers=/dev/null
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    --write-out) shift 2 ;;
    --max-time) shift 2 ;;
    --silent|--show-error|--fail) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [[ "$url" == http://betstan.xyz/* ]]; then
  path="${url#http://betstan.xyz}"
  printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://betstan.xyz%s\r\n\r\n' \
    "$path" > "$headers"
  : > "$output"
  printf 308
elif [[ "$url" == http://www.betstan.xyz/* ||
  "$url" == https://www.betstan.xyz/* ]]; then
  path="${url#*://www.betstan.xyz}"
  printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://betstan.xyz%s\r\n\r\n' \
    "$path" > "$headers"
  : > "$output"
  printf 308
elif [[ "$url" == http://203.0.113.10.nip.io/* ]]; then
  path="${url#http://203.0.113.10.nip.io}"
  printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: https://203.0.113.10.nip.io%s\r\n\r\n' \
    "$path" > "$headers"
  : > "$output"
  printf 308
elif [[ "$url" == */api/* ]]; then
  printf 'HTTP/2 200\r\ncontent-type: application/json\r\n\r\n' > "$headers"
  if [[ "$url" == */api/auth/currentuser* ]]; then
    printf '%s\n' '{"currentUser":null}' > "$output"
  else
    printf '%s\n' '[]' > "$output"
  fi
  printf 200
else
  printf 'HTTP/2 200\r\ncontent-type: text/html\r\n\r\n' > "$headers"
  printf '%s\n' 'BetStan.xyz demo app' > "$output"
  printf 200
fi
STUB
chmod +x "$BIN_DIR/curl"

cat > "$BIN_DIR/openssl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
operation="${1:-}"
shift || true
case "$operation" in
  s_client)
    IFS= read -r command
    [[ "$command" == "Q" ]]
    printf '%s\n' fixture-certificate
    ;;
  x509)
    output=""
    mode=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -out) output="$2"; shift 2 ;;
        -issuer|-text|-checkend) mode="$1"; shift ;;
        -in) shift 2 ;;
        -noout) shift ;;
        *) shift ;;
      esac
    done
    case "$mode" in
      -issuer) printf '%s\n' "issuer=O = Let's Encrypt, CN = Fixture" ;;
      -text)
        printf '%s\n' \
          'X509v3 Subject Alternative Name: DNS:betstan.xyz, DNS:www.betstan.xyz, DNS:203.0.113.10.nip.io'
        ;;
      -checkend) exit 0 ;;
      *) cat > "$output" ;;
    esac
    ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$BIN_DIR/openssl"

cluster_digest="$(
  printf '%s' "$CLUSTER_ID" |
    shasum -a 256 |
    awk '{print $1}'
)"
subscription_digest="$(
  printf '%s' fixture-subscription |
    shasum -a 256 |
    awk '{print $1}'
)"

run_plan() {
  local state_dir="$1"
  shift
  local mode=plan
  if [[ "${1:-}" == "--execute" ]]; then
    mode=execute
    shift
  elif [[ "${1:-}" == "--verify" ]]; then
    mode=verify
    shift
  fi
  env \
    PATH="$BIN_DIR:$PATH" \
    STUB_AZ_LOG="$WORK_DIR/az.log" \
    STUB_CLUSTER_ID="$CLUSTER_ID" \
    STUB_AKS_POWER_STATE=Stopped \
    STUB_PRIMARY_JSON="$WORK_DIR/primary.json" \
    STUB_MANAGED_JSON="$WORK_DIR/managed.json" \
    STUB_DELETE_PHASE_FILE="$WORK_DIR/delete-phase" \
    STUB_SOURCE_SHA="$SOURCE_SHA" \
    STUB_CLUSTER_DIGEST="$cluster_digest" \
    MIGRATION_RUN_ID=123 \
    MIGRATION_RUN_ATTEMPT=1 \
    MIGRATION_ID=migration-fixture \
    SOURCE_SHA="$SOURCE_SHA" \
    AZURE_EXPECTED_CLUSTER_RESOURCE_ID_SHA256="$cluster_digest" \
    AZURE_EXPECTED_SUBSCRIPTION_ID_SHA256="$subscription_digest" \
    OCI_DIAGNOSTIC_URL=https://203.0.113.10.nip.io \
    RETIREMENT_STATE_DIR="$state_dir" \
    "$@" \
    "$OPERATOR" "$mode"
}

: > "$WORK_DIR/az.log"
run_plan "$WORK_DIR/good" |
  grep -Eq '^azure_retirement=READY_TO_CONFIRM inventory_sha256=[0-9a-f]{64} resources=28$'
! grep -Eq 'aks delete|rest --method delete|group delete' "$WORK_DIR/az.log" ||
  { echo "plan mode issued a destructive Azure command" >&2; exit 1; }

run_plan "$WORK_DIR/deallocated" STUB_AKS_POWER_STATE=Deallocated |
  grep -Eq '^azure_retirement=READY_TO_CONFIRM inventory_sha256=[0-9a-f]{64} resources=28$'
run_plan "$WORK_DIR/empty-vmss" STUB_EMPTY_VMSS=1 |
  grep -Eq '^azure_retirement=READY_TO_CONFIRM inventory_sha256=[0-9a-f]{64} resources=28$'
run_plan "$WORK_DIR/closed-recovery" \
    STUB_CLOSED_RECOVERY_RETRY=true \
    STUB_RUNTIME_DEPLOY_SOURCE_SHA=2222222222222222222222222222222222222222 |
  grep -Eq '^azure_retirement=READY_TO_CONFIRM inventory_sha256=[0-9a-f]{64} resources=28$'
if run_plan "$WORK_DIR/running-control-plane" STUB_AKS_POWER_STATE=Running \
    >"$WORK_DIR/running-control-plane.out" 2>&1; then
  echo "retirement fixture accepted a running AKS control plane" >&2
  exit 1
fi
grep -Fq 'NO_GO azure_retirement_reason=' "$WORK_DIR/running-control-plane.out"

for failure_mode in \
  STUB_BAD_RUN STUB_BAD_PARITY STUB_UNKNOWN_RESOURCE STUB_RUNNING_VMSS \
  STUB_WRONG_SUBSCRIPTION STUB_GROUP_API_FAIL STUB_FENCE_RETAINED \
  STUB_BAD_RUNTIME_SHA STUB_BAD_CLOSED_RECOVERY; do
  if run_plan "$WORK_DIR/${failure_mode}" "$failure_mode=1" \
      >"$WORK_DIR/${failure_mode}.out" 2>&1; then
    echo "retirement fixture unexpectedly passed: $failure_mode" >&2
    exit 1
  fi
  grep -Fq 'NO_GO azure_retirement_reason=' "$WORK_DIR/${failure_mode}.out"
done
if run_plan "$WORK_DIR/inconsistent-closed-recovery" \
    STUB_CLOSED_RECOVERY_RETRY=true \
    >"$WORK_DIR/inconsistent-closed-recovery.out" 2>&1; then
  echo "retirement fixture accepted inconsistent closed-recovery provenance" >&2
  exit 1
fi
grep -Fq 'NO_GO azure_retirement_reason=' \
  "$WORK_DIR/inconsistent-closed-recovery.out"

printf '%s\n' initial > "$WORK_DIR/delete-phase"
plan_output="$(run_plan "$WORK_DIR/delete-plan")"
inventory_sha256="$(
  sed -n 's/^azure_retirement=READY_TO_CONFIRM inventory_sha256=\([0-9a-f]\{64\}\) resources=28$/\1/p' \
    <<<"$plan_output"
)"
[[ "$inventory_sha256" =~ ^[0-9a-f]{64}$ ]]
confirmation="DELETE AZURE AFTER OCI migration-fixture ${SOURCE_SHA} ${inventory_sha256}"
run_plan "$WORK_DIR/delete-execute" --execute \
  EXPECTED_INVENTORY_SHA256="$inventory_sha256" \
  RETIRE_AZURE_CONFIRMATION="$confirmation" \
  DELETE_WAIT_SECONDS=1 \
  DELETE_MAX_LOOPS=2 \
  MANAGED_GROUP_GRACE_LOOPS=1 \
  ABSENCE_VERIFY_LOOPS=2 \
  ABSENCE_VERIFY_SLEEP_SECONDS=0 |
  grep -qx 'AZURE_RESOURCES_RETIRED cost_verification=pending_delayed_reporting'
grep -Fq 'rest --method delete' "$WORK_DIR/az.log"
grep -Eq 'group delete .*--name MC_betstan-rg_betstan-aks_eastus' "$WORK_DIR/az.log"
grep -Eq 'group delete .*--name betstan-rg' "$WORK_DIR/az.log"
grep -qx 'phase=retired' "$WORK_DIR/delete-execute/retirement-state.env"
run_plan "$WORK_DIR/delete-execute" --verify \
  EXPECTED_INVENTORY_SHA256="$inventory_sha256" \
  ABSENCE_VERIFY_LOOPS=2 \
  ABSENCE_VERIFY_SLEEP_SECONDS=0 |
  grep -qx 'AZURE_RESOURCES_RETIRED cost_verification=pending_delayed_reporting'

for crash_point in aks managed primary; do
  printf '%s\n' initial > "$WORK_DIR/delete-phase"
  state_dir="$WORK_DIR/crash-${crash_point}"
  if run_plan "$state_dir" --execute \
      EXPECTED_INVENTORY_SHA256="$inventory_sha256" \
      RETIRE_AZURE_CONFIRMATION="$confirmation" \
      DELETE_WAIT_SECONDS=1 \
      DELETE_MAX_LOOPS=2 \
      MANAGED_GROUP_GRACE_LOOPS=1 \
      ABSENCE_VERIFY_LOOPS=1 \
      ABSENCE_VERIFY_SLEEP_SECONDS=0 \
      STUB_CRASH_POINT="$crash_point" >/dev/null 2>&1; then
    echo "retirement crash fixture unexpectedly passed: $crash_point" >&2
    exit 1
  fi
  grep -Eq "^phase=${crash_point}-delete-intent$" \
    "$state_dir/retirement-state.env"
  run_plan "$state_dir" --execute \
    EXPECTED_INVENTORY_SHA256="$inventory_sha256" \
    RETIRE_AZURE_CONFIRMATION=ignored-after-intent \
    DELETE_WAIT_SECONDS=1 \
    DELETE_MAX_LOOPS=2 \
    MANAGED_GROUP_GRACE_LOOPS=1 \
    ABSENCE_VERIFY_LOOPS=1 \
    ABSENCE_VERIFY_SLEEP_SECONDS=0 \
    STUB_BAD_RUN=1 |
    grep -qx 'AZURE_RESOURCES_RETIRED cost_verification=pending_delayed_reporting'
done

printf 'azure_retirement_contract=PASS scenarios=20\n'
