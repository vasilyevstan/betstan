#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/oci/scripts/rollback-application-stan.sh"
CAPTURE_SCRIPT="$ROOT_DIR/infra/oci/scripts/baseline-capture-stan.sh"
READINESS_SCRIPT="$ROOT_DIR/infra/oci/scripts/rollback-readiness-stan.sh"
REAL_LIVE_READINESS_SCRIPT="$ROOT_DIR/infra/oci/agents/live-betting-readiness-stan.sh"
WORKFLOW_FILE="$ROOT_DIR/.github/workflows/oci-production-rollback.yml"
DEPLOY_WORKFLOW_FILE="$ROOT_DIR/.github/workflows/oci-production-deploy.yml"
WORK_PARENT="$ROOT_DIR/infra/oci/tests/.rollback-contract-workdirs"
create_unique_dir() {
  local parent="$1"
  local prefix="$2"
  python3 - "$parent" "$prefix" <<'PY'
import sys
import uuid
from pathlib import Path

parent = Path(sys.argv[1])
prefix = sys.argv[2]
parent.mkdir(mode=0o700, parents=True, exist_ok=True)
for _ in range(64):
    candidate = parent / f"{prefix}-{uuid.uuid4().hex}"
    try:
        candidate.mkdir(mode=0o700)
    except FileExistsError:
        continue
    print(candidate.resolve())
    raise SystemExit(0)
raise SystemExit("unable to allocate unique contract workdir")
PY
}
WORK_DIR="$(create_unique_dir "$WORK_PARENT" rollback-contract)"
BIN_DIR="$WORK_DIR/bin"
FIXTURE_DIR="$WORK_DIR/fixtures"
STATE_DIR="$WORK_DIR/state"
TARGET_SHA=1111111111111111111111111111111111111111
CURRENT_MASTER_SHA=2222222222222222222222222222222222222222
SOURCE_RUN_ID=1701
DEPLOY_RUN_ID=1601
BUILD_RUN_ID=1501
CAPTURE_RUN_ID=1401
INFRASTRUCTURE_RUN_ID=1801
INFRASTRUCTURE_PROVENANCE_SHA256=""
RUNTIME_FINGERPRINT="cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34"
ARTIFACT_NAME="oci-production-baseline-${SOURCE_RUN_ID}-1"
SERVICES=(auth bet backoffice client event moderation resulting slip gamemaster)

mkdir -p "$BIN_DIR" "$FIXTURE_DIR" "$STATE_DIR"
cleanup() {
  if [[ "${KEEP_TEST_WORKDIR:-0}" != "1" ]]; then
    rm -rf "$WORK_DIR"
    rmdir "$WORK_PARENT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

fail() {
  printf 'oci_rollback_contract=FAIL reason=%s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local file="$1"
  local pattern="$2"
  grep -Fq "$pattern" "$file" || fail "missing pattern '$pattern' in $file"
}

assert_line() {
  local file="$1"
  local line="$2"
  grep -Fxq "$line" "$file" || fail "missing line '$line' in $file"
}

assert_route_row() {
  local file="$1"
  local label="$2"
  local path="$3"
  awk -F '\t' -v label="$label" -v path="$path" '$2 == label && $3 == path {found = 1} END {exit(found ? 0 : 1)}' "$file" ||
    fail "missing route evidence for ${label}${path} in $file"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

DEPLOY_RABBITMQ_BASELINE_FIXTURE="$FIXTURE_DIR/deploy-rabbitmq-baseline.txt"
printf '%s\n' 'fixture-rabbitmq-baseline' >"$DEPLOY_RABBITMQ_BASELINE_FIXTURE"
INFRASTRUCTURE_PROVENANCE_FIXTURE="$FIXTURE_DIR/infrastructure-provenance.env"
cat >"$INFRASTRUCTURE_PROVENANCE_FIXTURE" <<EOF2
source_sha=$CURRENT_MASTER_SHA
infrastructure_run_id=$INFRASTRUCTURE_RUN_ID
infrastructure_run_attempt=1
runtime_mode=k3s
instance_fingerprint=$RUNTIME_FINGERPRINT
namespace=betstan-oci
EOF2
INFRASTRUCTURE_PROVENANCE_SHA256="$(
  sha256_file "$INFRASTRUCTURE_PROVENANCE_FIXTURE"
)"
TAMPERED_INFRASTRUCTURE_PROVENANCE_FIXTURE="$FIXTURE_DIR/infrastructure-provenance-tampered.env"
cp "$INFRASTRUCTURE_PROVENANCE_FIXTURE" \
  "$TAMPERED_INFRASTRUCTURE_PROVENANCE_FIXTURE"
printf '%s\n' 'unexpected_field=tampered' \
  >>"$TAMPERED_INFRASTRUCTURE_PROVENANCE_FIXTURE"

write_deploy_provenance_fixture() {
  local output_file="$1"
  local images_file="$2"
  local schema="$3"
  local source_sha="${4:-$TARGET_SHA}"
  cat >"$output_file" <<EOF2
source_sha=$source_sha
runtime_mode=k3s
runtime_fingerprint=$RUNTIME_FINGERPRINT
image_provenance_sha256=$(sha256_file "$images_file")
rendered_manifest_sha256=ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56
rabbitmq_baseline_sha256=$(sha256_file "$DEPLOY_RABBITMQ_BASELINE_FIXTURE")
public_host=betstan.xyz
canonical_host=betstan.xyz
redirect_host=www.betstan.xyz
diagnostic_host=203.0.113.10.nip.io
deployment_run_id=$DEPLOY_RUN_ID
deployment_run_attempt=1
EOF2
  case "$schema" in
    modern)
      cat >>"$output_file" <<EOF2
infrastructure_run_id=$INFRASTRUCTURE_RUN_ID
infrastructure_run_attempt=1
infrastructure_provenance_sha256=$INFRASTRUCTURE_PROVENANCE_SHA256
EOF2
      ;;
    legacy)
      ;;
    partial)
      printf 'infrastructure_run_id=%s\n' "$INFRASTRUCTURE_RUN_ID" \
        >>"$output_file"
      ;;
    *)
      fail "unsupported deploy provenance fixture schema: $schema"
      ;;
  esac
}

service_index() {
  local service="$1"
  local index=1
  local candidate
  for candidate in "${SERVICES[@]}"; do
    if [[ "$candidate" == "$service" ]]; then
      printf '%s' "$index"
      return 0
    fi
    index=$((index + 1))
  done
  return 1
}

service_digest() {
  printf 'sha256:%064d\n' "$(service_index "$1")"
}

service_platform_digest() {
  local base=$((30 + $(service_index "$1")))
  printf 'sha256:%064d\n' "$base"
}

current_digest() {
  local base=$((200 + $(service_index "$1")))
  printf 'sha256:%064d\n' "$base"
}

target_image_ref() {
  local service="$1"
  printf 'fixture.invalid/namespace/%s@%s\n' "$service" "$(service_digest "$service")"
}

current_image_ref() {
  local service="$1"
  printf 'fixture.invalid/namespace/%s@%s\n' "$service" "$(current_digest "$service")"
}

create_baseline_fixture() {
  local directory="$1"
  local mode="${2:-good}"
  local fixture_sse_required=true
  local provenance_schema=modern
  local include_trusted_provenance=true
  local provenance_source_sha="$TARGET_SHA"
  [[ "$mode" != "legacy-sse" ]] || fixture_sse_required=false
  case "$mode" in
    legacy-missing)
      include_trusted_provenance=false
      provenance_schema=legacy
      ;;
    legacy-embedded)
      provenance_schema=legacy
      ;;
    legacy-source-mismatch)
      provenance_schema=legacy
      provenance_source_sha="$CURRENT_MASTER_SHA"
      ;;
    partial-infrastructure)
      provenance_schema=partial
      ;;
  esac
  rm -rf "$directory"
  mkdir -p "$directory"
  : >"$directory/images.tsv"
  for service in "${SERVICES[@]}"; do
    local digest platform_digest image_ref
    digest="$(service_digest "$service")"
    platform_digest="$(service_platform_digest "$service")"
    image_ref="$(target_image_ref "$service")"
    if [[ "$mode" == "mutable" && "$service" == "event" ]]; then
      image_ref="fixture.invalid/namespace/${service}:latest"
    fi
    printf '%s\t%s\t%s\t%s\t%s\n' \
      "$service" "fixture.invalid/namespace/${service}" "$image_ref" "$digest" "$platform_digest" >>"$directory/images.tsv"
  done
  cat >"$directory/queues.tsv" <<'QUEUES'
event_new_event	0	0	1
gamemaster_new_event	0	0	1
bet_place_bet	0	0	1
event_live_projection	0	0	1
moderation_live_event_update	0	0	1
resulting_live_event_update	0	0	1
event_live_update.fixture-pod	0	0	2
QUEUES
  cat >"$directory/live-images.tsv" <<'LIVE'
auth	fixture.invalid/namespace/auth@sha256:0000000000000000000000000000000000000000000000000000000000000001
LIVE
  cat >"$directory/public-http.tsv" <<'HTTP'
canonical	/	200	https://betstan.xyz/	text/html	html:fixture
HTTP
  cat >"$directory/sse.tsv" <<'SSE'
canonical	200	https://betstan.xyz/api/event/stream	text/event-stream	fixture
SSE
  cat >"$directory/migration-journal.json" <<'JSON'
{"data":{"phase":"stable"}}
JSON
  cat >"$directory/migration-lock.json" <<'JSON'
{"data":{"state":"released"}}
JSON
  cat >"$directory/migration-backup-references.tsv" <<'REFS'
state	database-restore-excluded	application-rollback-only
REFS
  if [[ "$include_trusted_provenance" == "true" ]]; then
    write_deploy_provenance_fixture \
      "$directory/trusted-deploy-provenance.txt" \
      "$directory/images.tsv" \
      "$provenance_schema" \
      "$provenance_source_sha"
  fi
  cat >"$directory/baseline-provenance.env" <<EOF2
baseline_source_sha=$TARGET_SHA
baseline_deploy_workflow=oci-production-deploy
baseline_deploy_run_id=$DEPLOY_RUN_ID
baseline_deploy_run_attempt=1
baseline_build_workflow=oci-production-build
baseline_build_run_id=$BUILD_RUN_ID
baseline_build_run_attempt=1
baseline_capture_run_id=$CAPTURE_RUN_ID
baseline_capture_run_attempt=1
namespace=betstan-oci
public_url=https://betstan.xyz
redirect_url=https://www.betstan.xyz
diagnostic_url=https://203.0.113.10.nip.io
sse_path=/api/event/stream
sse_required=$fixture_sse_required
database_restore=disabled
EOF2
  : >"$directory/SHA256SUMS"
  local file
  local checksum_files=(
    baseline-provenance.env
    images.tsv
    queues.tsv
    public-http.tsv
    sse.tsv
    migration-journal.json
    migration-lock.json
    migration-backup-references.tsv
  )
  if [[ "$include_trusted_provenance" == "true" ]]; then
    checksum_files+=(trusted-deploy-provenance.txt)
  fi
  for file in "${checksum_files[@]}"; do
    printf '%s  %s\n' "$(sha256_file "$directory/$file")" "$file" >>"$directory/SHA256SUMS"
  done
}

write_text_atomic() {
  local target="$1"
  local temp_file="${target}.tmp.$$.$RANDOM"
  cat >"$temp_file"
  mv "$temp_file" "$target"
}

reset_live_state() {
  local state_root="${1:-$STATE_DIR/current}"
  rm -rf "$state_root"
  mkdir -p "$state_root"
  for service in "${SERVICES[@]}"; do
    write_text_atomic "$state_root/${service}.env" <<EOF2
image=$(current_image_ref "$service")
revision=7
EOF2
  done
}

set_target_state() {
  local state_root="${1:-$STATE_DIR/current}"
  rm -rf "$state_root"
  mkdir -p "$state_root"
  for service in "${SERVICES[@]}"; do
    write_text_atomic "$state_root/${service}.env" <<EOF2
image=$(target_image_ref "$service")
revision=8
EOF2
  done
}

create_baseline_fixture "$FIXTURE_DIR/baseline-good"
create_baseline_fixture "$FIXTURE_DIR/baseline-mutable" mutable
create_baseline_fixture "$FIXTURE_DIR/baseline-legacy-sse" legacy-sse
create_baseline_fixture "$FIXTURE_DIR/baseline-legacy-missing" legacy-missing
create_baseline_fixture "$FIXTURE_DIR/baseline-legacy-embedded" legacy-embedded
create_baseline_fixture "$FIXTURE_DIR/baseline-legacy-source-mismatch" legacy-source-mismatch
create_baseline_fixture "$FIXTURE_DIR/baseline-partial-infrastructure" partial-infrastructure

cat >"$BIN_DIR/git" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  "fetch --quiet origin master:refs/remotes/origin/master")
    exit 0
    ;;
  "rev-parse HEAD")
    printf '%s\n' "$STUB_CURRENT_MASTER_SHA"
    ;;
  "rev-parse origin/master")
    printf '%s\n' "$STUB_CURRENT_MASTER_SHA"
    ;;
  "rev-parse ${STUB_TARGET_SHA}^{commit}")
    printf '%s\n' "$STUB_TARGET_SHA"
    ;;
  "cat-file -e ${STUB_TARGET_SHA}^{commit}")
    exit 0
    ;;
  "cat-file -e ${STUB_TARGET_SHA}:event/src/route/EventLiveStream.ts")
    [[ "${STUB_DEPLOYED_SOURCE_HAS_SSE:-1}" == "1" ]]
    ;;
  "merge-base --is-ancestor ${STUB_TARGET_SHA} ${STUB_CURRENT_MASTER_SHA}")
    exit 0
    ;;
  "cat-file -e ${STUB_TARGET_SHA}:backoffice/src/middleware/RequireAdmin.ts")
    [[ "${STUB_TARGET_HAS_ADMIN_AUTH:-1}" == "1" ]]
    ;;
  "cat-file -e ${STUB_TARGET_SHA}:backoffice/src/service/VerifyAdminSession.ts")
    [[ "${STUB_TARGET_HAS_ADMIN_AUTH:-1}" == "1" ]]
    ;;
  "show ${STUB_TARGET_SHA}:auth/src/route/LogIn.ts")
    case "${STUB_TARGET_LOGIN_MODE:-current}" in
      current)
        cat <<'EOF_LOGIN'
import { normalizeIdentifier } from '../data/normalizeIdentifier'
const identifierNormalized = normalizeIdentifier(identifier)
await User.findOne({ identifierNormalized })
EOF_LOGIN
        ;;
      legacy)
        cat <<'EOF_LOGIN'
await User.findOne({ username: identifier })
EOF_LOGIN
        ;;
      missing)
        exit 1
        ;;
      *)
        exit 1
        ;;
    esac
    ;;
  *)
    printf 'unexpected git invocation: %s\n' "$*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$BIN_DIR/git"

cat >"$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
recent='2026-08-20T00:00:00Z'
case "${1:-} ${2:-}" in
  "api repos/example/repo/actions/workflows/oci-production-deploy.yml")
    printf '901\n'
    ;;
  "api repos/example/repo/actions/workflows/oci-production-build.yml")
    printf '801\n'
    ;;
  "api repos/example/repo/actions/runs/${STUB_SOURCE_RUN_ID}/attempts/1")
    workflow_id=901
    [[ "${STUB_SOURCE_RUN_BAD_WORKFLOW:-0}" != "1" ]] || workflow_id=999
    jq -n --argjson workflow_id "$workflow_id" --arg recent "$recent" --arg head_sha "$STUB_CURRENT_MASTER_SHA" '{
      workflow_id:$workflow_id,
      path:".github/workflows/oci-production-deploy.yml",
      event:"workflow_dispatch",
      head_sha:$head_sha,
      head_branch:"master",
      head_repository:{full_name:"example/repo"},
      status:"completed",
      conclusion:"failure",
      run_attempt:1,
      created_at:$recent,
      updated_at:$recent
    }'
    ;;
  "api repos/example/repo/actions/runs/${STUB_DEPLOY_RUN_ID}/attempts/1")
    head_sha="$STUB_TARGET_SHA"
    [[ "${STUB_DEPLOY_BAD_HEAD_SHA:-0}" != "1" ]] || head_sha="$STUB_CURRENT_MASTER_SHA"
    jq -n --arg head_sha "$head_sha" --arg recent "$recent" '{
      workflow_id:901,
      path:".github/workflows/oci-production-deploy.yml",
      event:"workflow_dispatch",
      head_sha:$head_sha,
      head_branch:"master",
      head_repository:{full_name:"example/repo"},
      status:"completed",
      conclusion:"success",
      run_attempt:1,
      created_at:$recent,
      updated_at:$recent
    }'
    ;;
  "api repos/example/repo/actions/runs/${STUB_BUILD_RUN_ID}/attempts/1")
    head_sha="$STUB_TARGET_SHA"
    [[ "${STUB_BUILD_BAD_HEAD_SHA:-0}" != "1" ]] || head_sha="$STUB_CURRENT_MASTER_SHA"
    jq -n --arg head_sha "$head_sha" --arg recent "$recent" '{
      workflow_id:801,
      path:".github/workflows/oci-production-build.yml",
      event:"workflow_run",
      head_sha:$head_sha,
      head_branch:"master",
      head_repository:{full_name:"example/repo"},
      status:"completed",
      conclusion:"success",
      run_attempt:1,
      created_at:$recent,
      updated_at:$recent
    }'
    ;;
  "api repos/example/repo/actions/runs/${STUB_SOURCE_RUN_ID}/artifacts")
    expired=false
    [[ "${STUB_ARTIFACT_EXPIRED:-0}" != "1" ]] || expired=true
    jq -n --arg name "$STUB_ARTIFACT_NAME" --arg recent "$recent" --argjson expired "$expired" '{
      artifacts:[{name:$name, expired:$expired, created_at:$recent, updated_at:$recent}]
    }'
    ;;
  "api repos/example/repo/actions/runs/${STUB_DEPLOY_RUN_ID}/artifacts")
    if [[ "${STUB_DEPLOY_ARTIFACT_MISSING:-0}" == "1" ]]; then
      printf '{"artifacts":[]}\n'
    else
      expired=false
      [[ "${STUB_DEPLOY_ARTIFACT_EXPIRED:-0}" != "1" ]] || expired=true
      jq -n \
        --arg name "oci-deploy-provenance-${STUB_DEPLOY_RUN_ID}-1" \
        --arg recent "$recent" \
        --argjson expired "$expired" \
        '{
          artifacts:[{
            name:$name,
            expired:$expired,
            created_at:$recent,
            updated_at:$recent
          }]
        }'
    fi
    ;;
  "api repos/example/repo/actions/runs/${STUB_BUILD_RUN_ID}/artifacts")
    jq -n --arg name "oci-image-provenance-${STUB_TARGET_SHA}-${STUB_BUILD_RUN_ID}-1" --arg recent "$recent" '{
      artifacts:[{name:$name, expired:false, created_at:$recent, updated_at:$recent}]
    }'
    ;;
  *)
    if [[ "${1:-} ${2:-}" == "run list" ]]; then
      workflow=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --workflow) workflow="$2"; shift 2 ;;
          --repo|--limit|--json|--commit) shift 2 ;;
          *) shift ;;
        esac
      done
      case "$workflow" in
        oci-production-deploy.yml)
          jq -n --arg recent "$recent" --argjson run_id "$STUB_DEPLOY_RUN_ID" '[{
            databaseId:$run_id,
            createdAt:$recent,
            status:"completed",
            conclusion:"success"
          }]'
          ;;
        oci-production-build.yml)
          jq -n --arg recent "$recent" --argjson run_id "$STUB_BUILD_RUN_ID" '[{
            databaseId:$run_id,
            createdAt:$recent,
            status:"completed",
            conclusion:"success"
          }]'
          ;;
        *)
          printf 'unexpected gh run list workflow: %s\n' "$workflow" >&2
          exit 1
          ;;
      esac
    elif [[ "${1:-} ${2:-}" == "run download" ]]; then
      dir=""
      name=""
      run_id="${3:-}"
      shift 3
      while [[ $# -gt 0 ]]; do
        case "$1" in
          --name) name="$2"; shift 2 ;;
          --dir) dir="$2"; shift 2 ;;
          --repo) shift 2 ;;
          *) shift ;;
        esac
      done
      mkdir -p "$dir"
      if [[ "$run_id" == "$STUB_SOURCE_RUN_ID" && "$name" == "$STUB_ARTIFACT_NAME" ]]; then
        cp -R "$STUB_BASELINE_FIXTURE"/. "$dir"/
      elif [[ "$run_id" == "$STUB_DEPLOY_RUN_ID" && "$name" == "oci-deploy-provenance-${STUB_DEPLOY_RUN_ID}-1" ]]; then
        deploy_fixture="${STUB_DEPLOY_PROVENANCE_FIXTURE:-$STUB_BASELINE_FIXTURE}"
        cp "$deploy_fixture/images.tsv" "$dir/images.tsv"
        cp "$deploy_fixture/trusted-deploy-provenance.txt" "$dir/provenance.txt"
        cp "$STUB_DEPLOY_RABBITMQ_BASELINE_FIXTURE" "$dir/rabbitmq-baseline.txt"
      else
        printf 'unexpected gh run download: run=%s name=%s\n' "$run_id" "$name" >&2
        exit 1
      fi
      if [[ -n "${STUB_TAMPER_FILE:-}" ]]; then
        printf 'tampered\n' >>"$dir/${STUB_TAMPER_FILE}"
      fi
    else
      printf 'unexpected gh invocation: %s\n' "$*" >&2
      exit 1
    fi
    ;;
esac
STUB
chmod +x "$BIN_DIR/gh"

cat >"$BIN_DIR/kubectl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

services=(auth bet backoffice client event moderation resulting slip gamemaster)

atomic_write() {
  local target="$1"
  local temp_file="${target}.tmp.$$.$RANDOM"
  mkdir -p "$(dirname "$target")"
  cat >"$temp_file"
  mv "$temp_file" "$target"
}

service_from_deployment() {
  printf '%s' "$1" | sed -E 's#^deployment/gaming-(.+)-depl$#\1#; s#^gaming-(.+)-depl$#\1#'
}

state_file() {
  printf '%s/%s.env\n' "$STUB_STATE_DIR" "$1"
}

read_state() {
  local file
  file="$(state_file "$1")"
  # shellcheck disable=SC1090
  source "$file"
}

service_platform_digest_from_image() {
  local image="$1"
  local service="${image#fixture.invalid/namespace/}"
  service="${service%@*}"
  local index=31
  local candidate
  for candidate in auth bet backoffice client event moderation resulting slip gamemaster; do
    if [[ "$candidate" == "$service" ]]; then
      printf 'sha256:%064d\n' "$index"
      return 0
    fi
    index=$((index + 1))
  done
  printf '%s\n' "${image##*@}"
}

print_all_workloads() {
  python3 - "$STUB_STATE_DIR" "${STUB_FLAG_VALUE:-false}" <<'PY'
import json
import sys
from pathlib import Path

state_dir = Path(sys.argv[1])
flag_value = sys.argv[2]
services = ["auth", "bet", "backoffice", "client", "event", "gamemaster", "moderation", "resulting", "slip"]
items = []
for service in services:
    fields = {}
    for line in (state_dir / f"{service}.env").read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            fields[key] = value
    env = []
    if service == "gamemaster":
        env.append({"name": "LIVE_KICKOFFS_ENABLED", "value": flag_value})
    items.append({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": f"gaming-{service}-depl", "annotations": {"deployment.kubernetes.io/revision": fields.get("revision", "0")}},
        "spec": {"replicas": 1, "template": {"spec": {"containers": [{"name": f"gaming-{service}", "image": fields.get("image", ""), "env": env}]}}},
        "status": {"readyReplicas": 1, "availableReplicas": 1, "updatedReplicas": 1},
    })
items.append({
    "apiVersion": "apps/v1",
    "kind": "Deployment",
    "metadata": {"name": "gaming-rabbitmq-depl", "annotations": {"deployment.kubernetes.io/revision": "4"}},
    "spec": {"replicas": 1, "template": {"spec": {"containers": [{"name": "gaming-rabbitmq", "image": "docker.io/library/rabbitmq@sha256:" + ("f" * 64)}]}}},
    "status": {"readyReplicas": 1, "availableReplicas": 1, "updatedReplicas": 1},
})
items.append({
    "apiVersion": "apps/v1",
    "kind": "Deployment",
    "metadata": {"name": "gaming-auth-mongo-depl", "annotations": {"deployment.kubernetes.io/revision": "5"}},
    "spec": {"replicas": 1, "template": {"spec": {"containers": [{"name": "gaming-auth-mongo", "image": "docker.io/library/mongo@sha256:" + ("e" * 64)}]}}},
    "status": {"readyReplicas": 1, "availableReplicas": 1, "updatedReplicas": 1},
})
print(json.dumps({"items": items}))
PY
}

print_all_pods() {
  python3 - "$STUB_STATE_DIR" "${STUB_BAD_DIGEST_SERVICE:-}" "${MODE:-}" <<'PY'
import json
import sys
from pathlib import Path

state_dir = Path(sys.argv[1])
bad_service = sys.argv[2]
mode = sys.argv[3]
services = ["auth", "bet", "backoffice", "client", "event", "gamemaster", "moderation", "resulting", "slip"]
items = []
platform_map = {
    "auth": 31,
    "bet": 32,
    "backoffice": 33,
    "client": 34,
    "event": 35,
    "gamemaster": 36,
    "moderation": 37,
    "resulting": 38,
    "slip": 39,
}
for service in services:
    fields = {}
    for line in (state_dir / f"{service}.env").read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            fields[key] = value
    digest = 'sha256:' + f"{platform_map[service]:064d}"
    if not mode and service == bad_service:
        digest = 'sha256:' + ('9' * 64)
    items.append({
        "metadata": {"name": f"gaming-{service}-pod-0", "labels": {"app": f"gaming-{service}"}},
        "status": {"containerStatuses": [{"name": f"gaming-{service}", "ready": True, "imageID": f"docker-pullable://fixture.invalid/namespace/{service}@{digest}"}]},
    })
items.append({
    "metadata": {"name": "rabbitmq-0", "labels": {"app": "gaming-rabbitmq"}},
    "status": {"containerStatuses": [{"name": "gaming-rabbitmq", "ready": True, "imageID": "docker-pullable://fixture.invalid/namespace/rabbitmq@sha256:" + ("f" * 64)}]},
})
items.append({
    "metadata": {"name": "auth-mongo-0", "labels": {"app": "gaming-auth-mongo"}},
    "status": {"containerStatuses": [{"name": "gaming-auth-mongo", "ready": True, "imageID": "docker-pullable://fixture.invalid/namespace/mongo@sha256:" + ("e" * 64)}]},
})
print(json.dumps({"items": items}))
PY
}

if [[ "${1:-}" == --request-timeout=* ]]; then
  shift
fi

case "${1:-}" in
  get)
    shift
    case "${1:-}" in
      deployment)
        deployment="$2"
        shift 2
        service="$(service_from_deployment "$deployment")"
        read_state "$service"
        output_mode="json"
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        if [[ "$output_mode" == "json" ]]; then
          jq -n --arg container "gaming-${service}" --arg image "$image" --arg revision "$revision" '{
            metadata:{generation:8,annotations:{"deployment.kubernetes.io/revision":$revision}},
            spec:{replicas:1,template:{spec:{containers:[{name:$container,image:$image}]}}},
            status:{observedGeneration:8,readyReplicas:1,availableReplicas:1,updatedReplicas:1}
          }'
        elif [[ "$output_mode" == "jsonpath={.metadata.generation}|{.status.observedGeneration}|{.spec.replicas}|{.status.updatedReplicas}|{.status.readyReplicas}|{.status.availableReplicas}" ]]; then
          printf '8|8|1|1|1|1'
        else
          printf 'unexpected deployment output mode: %s\n' "$output_mode" >&2
          exit 1
        fi
        ;;
      deploy)
        shift
        output_mode=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        case "$output_mode" in
          "json")
            print_all_workloads
            ;;
          "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}")
            for service in "${services[@]}"; do
              printf 'gaming-%s-depl\n' "$service"
            done
            ;;
          "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{.status.readyReplicas}{\"\\t\"}{.status.replicas}{\"\\n\"}{end}")
            for service in "${services[@]}"; do
              printf 'gaming-%s-depl\t1\t1\n' "$service"
            done
            printf 'gaming-rabbitmq-depl\t1\t1\n'
            ;;
          "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{range .spec.template.spec.containers[*]}{.image}{\" \"}{end}{\"\\n\"}{end}")
            for service in "${services[@]}"; do
              read_state "$service"
              printf 'gaming-%s-depl\t%s \n' "$service" "$image"
            done
            printf 'gaming-rabbitmq-depl\tdocker.io/library/rabbitmq@sha256:%064d \n' 15
            ;;
          *)
            printf 'unexpected kubectl get deploy output: %s\n' "$output_mode" >&2
            exit 1
            ;;
        esac
        ;;
      deploy,sts)
        shift
        output_mode=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        if [[ "$output_mode" == "json" ]]; then
          print_all_workloads
        else
          printf 'unexpected kubectl get deploy,sts output: %s\n' "$output_mode" >&2
          exit 1
        fi
        ;;
      sts)
        shift
        output_mode=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        case "$output_mode" in
          "json")
            print_all_workloads
            ;;
          "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{.status.readyReplicas}{\"\\t\"}{.status.replicas}{\"\\n\"}{end}")
            printf 'gaming-auth-mongo-depl\t1\t1\n'
            ;;
          *)
            printf 'unexpected kubectl get sts output: %s\n' "$output_mode" >&2
            exit 1
            ;;
        esac
        ;;
      pods)
        shift
        selector=""
        output_mode="json"
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -l) selector="$2"; shift 2 ;;
            -n|--request-timeout) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        if [[ "$output_mode" == jsonpath=* ]]; then
          if [[ "$selector" == "app=gaming-auth" ]]; then
            printf 'gaming-auth-pod-0|Running|True|%s\n' "$(current_image_ref auth)"
          else
            printf 'unexpected pods jsonpath selector: %s\n' "$selector" >&2
            exit 1
          fi
        elif [[ -n "$selector" ]]; then
          service="${selector#app=gaming-}"
          read_state "$service"
          digest="$(service_platform_digest_from_image "$image")"
          if [[ -z "${MODE:-}" && "${STUB_BAD_DIGEST_SERVICE:-}" == "$service" ]]; then
            digest='sha256:9999999999999999999999999999999999999999999999999999999999999999'
          fi
          jq -n --arg service "$service" --arg digest "$digest" '{
            items:[{metadata:{name:($service + "-pod-0"),labels:{app:("gaming-" + $service)}},status:{containerStatuses:[{name:("gaming-" + $service),ready:true,imageID:("docker-pullable://fixture.invalid/namespace/" + $service + "@" + $digest)}]}}]
          }'
        else
          print_all_pods
        fi
        ;;
      pod)
        shift
        selector=""
        output_mode=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -l) selector="$2"; shift 2 ;;
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        if [[ "$output_mode" == "jsonpath={.items[0].metadata.name}" ]]; then
          case "$selector" in
            app=gaming-rabbitmq) printf 'rabbitmq-0' ;;
            app=gaming-auth-mongo) printf 'auth-mongo-0' ;;
            *) printf 'unexpected pod selector: %s\n' "$selector" >&2; exit 1 ;;
          esac
        else
          printf 'unexpected kubectl get pod output: %s\n' "$output_mode" >&2
          exit 1
        fi
        ;;
      persistentvolumeclaims)
        python3 - \
          "${STUB_MONGO_PVC_NAME:-gaming-auth-mongo-data}" \
          "${STUB_MONGO_PVC_PHASE:-Bound}" \
          "${STUB_EXTRA_MONGO_PVC:-}" <<'PY'
import json
import sys

name, phase, extra_name = sys.argv[1:]
items = [{"metadata": {"name": name}, "status": {"phase": phase}}]
if extra_name:
    items.append({
        "metadata": {"name": extra_name},
        "status": {"phase": "Bound"},
    })
print(json.dumps({"items": items}))
PY
        ;;
      configmap)
        name="$2"
        case "$name" in
          gaming-mongo-topology)
            printf '{"data":{"mode":"shared","validated":"true"}}\n'
            ;;
          gaming-mongo-migration-lock)
            printf '{"data":{"state":"released"}}\n'
            ;;
          *)
            printf 'unexpected configmap: %s\n' "$name" >&2
            exit 1
            ;;
        esac
        ;;
      *)
        printf 'unexpected kubectl get: %s\n' "$*" >&2
        exit 1
        ;;
    esac
    ;;
  exec)
    shift
    if [[ "$*" == *"rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers"* ]]; then
      live_ready="${STUB_LIVE_QUEUE_READY:-0}"
      live_unack="${STUB_LIVE_QUEUE_UNACK:-0}"
      baseline_ready="${STUB_BASELINE_QUEUE_READY:-0}"
      baseline_unack="${STUB_BASELINE_QUEUE_UNACK:-0}"
      dynamic_consumers="${STUB_DYNAMIC_QUEUE_CONSUMERS:-2}"
      dynamic_queue_name="${STUB_DYNAMIC_QUEUE_NAME:-event_live_update.fixture-pod}"
      drop_dynamic_queue="${STUB_DROP_DYNAMIC_QUEUE:-0}"
      if [[ -n "${STUB_KUBECTL_LOG:-}" && -f "${STUB_KUBECTL_LOG:-}" && -s "${STUB_KUBECTL_LOG:-}" ]]; then
        live_ready="${STUB_LIVE_QUEUE_READY_AFTER_ROLLBACK:-$live_ready}"
        live_unack="${STUB_LIVE_QUEUE_UNACK_AFTER_ROLLBACK:-$live_unack}"
        baseline_ready="${STUB_BASELINE_QUEUE_READY_AFTER_ROLLBACK:-$baseline_ready}"
        baseline_unack="${STUB_BASELINE_QUEUE_UNACK_AFTER_ROLLBACK:-$baseline_unack}"
        dynamic_consumers="${STUB_DYNAMIC_QUEUE_CONSUMERS_AFTER_ROLLBACK:-$dynamic_consumers}"
        dynamic_queue_name="${STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK:-$dynamic_queue_name}"
        drop_dynamic_queue="${STUB_DROP_DYNAMIC_QUEUE_AFTER_ROLLBACK:-$drop_dynamic_queue}"
      fi
      cat <<EOF_QUEUES
name messages_ready messages_unacknowledged consumers
event_new_event ${baseline_ready} ${baseline_unack} 1
gamemaster_new_event ${baseline_ready} ${baseline_unack} 1
bet_place_bet ${baseline_ready} ${baseline_unack} 1
event_live_projection ${live_ready} ${live_unack} 1
moderation_live_event_update ${live_ready} ${live_unack} 1
resulting_live_event_update ${live_ready} ${live_unack} 1
EOF_QUEUES
      if [[ "$drop_dynamic_queue" != "1" ]]; then
        printf '%s 0 0 %s\n' "$dynamic_queue_name" "$dynamic_consumers"
      fi
    elif [[ "$*" == *"mongosh --quiet --norc --eval"* ]]; then
      printf '{"mongoOk":true,"activeMatches":%s,"overdueUnstartedEvents":%s,"simulationQuarantines":%s,"submittedLiveSlips":%s,"draftLiveSlips":%s}\n' \
        "${STUB_ACTIVE_MATCHES:-0}" "${STUB_OVERDUE_UNSTARTED_EVENTS:-0}" "${STUB_SIMULATION_QUARANTINES:-0}" \
        "${STUB_SUBMITTED_LIVE_SLIPS:-0}" "${STUB_DRAFT_LIVE_SLIPS:-0}"
    elif [[ "$*" == *"mongosh --quiet mongodb://localhost:27017/"* ]]; then
      [[ "${STUB_AUTH_QUERY_FAIL:-0}" != "1" ]] || exit 1
      printf '%s\n' "${STUB_NORMALIZED_IDENTIFIER_COUNT:-0}"
    else
      printf 'unexpected kubectl exec: %s\n' "$*" >&2
      exit 1
    fi
    ;;
  set)
    shift
    [[ "${1:-}" == "image" ]] || exit 1
    deployment="$2"
    shift 2
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -n) shift 2 ;;
        *) assignment="$1"; shift ;;
      esac
    done
    service="$(service_from_deployment "$deployment")"
    image="${assignment#*=}"
    atomic_write "$(state_file "$service")" <<EOF_STATE
image=$image
revision=8
EOF_STATE
    printf '%s\n' "$service" >>"$STUB_KUBECTL_LOG"
    ;;
  rollout)
    shift
    case "${1:-}" in
      status)
        deployment="$2"
        service="$(service_from_deployment "$deployment")"
        if [[ "${STUB_FAIL_SERVICE:-}" == "$service" ]]; then
          exit 1
        fi
        ;;
      history)
        deployment="$2"
        count="${STUB_HISTORY_COUNT:-3}"
        echo 'REVISION  CHANGE-CAUSE'
        i=1
        while [[ "$i" -le "$count" ]]; do
          printf '%s  fixture\n' "$i"
          i=$((i + 1))
        done
        ;;
      *)
        printf 'unexpected kubectl rollout: %s\n' "$*" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    printf 'unexpected kubectl invocation: %s\n' "$*" >&2
    exit 1
    ;;
esac
STUB
chmod +x "$BIN_DIR/kubectl"

cat >"$BIN_DIR/curl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
output=/dev/null
headers=/dev/null
write_out=''
url=''
max_time=''
format_exact_window_integer_duration() {
  python3 - "$1" <<'PY'
import sys
from decimal import Decimal

window = Decimal(sys.argv[1])
print(window.to_integral_value())
PY
}
format_shifted_window_duration() {
  python3 - "$1" "$2" <<'PY'
import sys
from decimal import Decimal

window = Decimal(sys.argv[1])
delta = Decimal(sys.argv[2])
result = window + delta
if result < 0:
    result = Decimal("0")
print(f"{result:.6f}")
PY
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    --write-out) write_out="$2"; shift 2 ;;
    --max-time) max_time="$2"; shift 2 ;;
    --header|--request|--data) shift 2 ;;
    --location|--silent|--show-error) shift ;;
    *) url="$1"; shift ;;
  esac
done
base_url='https://betstan.xyz'
secondary_url='https://www.betstan.xyz'
diagnostic_url='https://203.0.113.10.nip.io'
status='200'
content_type='application/json'
body='{}'
header_block=$'HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
curl_exit=0
time_total='0'
sse_mode=''
after_rollback=0
if [[ -n "${STUB_KUBECTL_LOG:-}" && -f "${STUB_KUBECTL_LOG:-}" && -s "${STUB_KUBECTL_LOG:-}" ]]; then
  after_rollback=1
fi
event_mode="${STUB_EVENT_MODE:-good}"
if [[ -n "${STUB_EVENT_MODE_AFTER_ROLLBACK:-}" && "$after_rollback" == "1" ]]; then
  event_mode="$STUB_EVENT_MODE_AFTER_ROLLBACK"
fi
if [[ "$url" == "$secondary_url"*'/api/auth/currentuser?live-betting-redirect=1' ]]; then
  status='308'
  body=''
  content_type='text/plain'
  header_block=$(printf 'HTTP/1.1 308 Permanent Redirect\r\nLocation: %s/api/auth/currentuser?live-betting-redirect=1\r\n\r\n' "$base_url")
elif [[ "$url" == *'/api/event/stream' ]]; then
  sse_mode="${STUB_SSE_MODE:-good}"
  if [[ -n "$max_time" && "$max_time" =~ ^[0-9]+$ && "$max_time" -lt 10 ]]; then
    sse_mode="${STUB_SHORT_SSE_MODE:-good}"
    if [[ "$after_rollback" == "1" && -n "${STUB_SHORT_SSE_MODE_AFTER_ROLLBACK:-}" ]]; then
      sse_mode="$STUB_SHORT_SSE_MODE_AFTER_ROLLBACK"
    fi
  elif [[ "$after_rollback" == "1" && -n "${STUB_SSE_MODE_AFTER_ROLLBACK:-}" ]]; then
    sse_mode="$STUB_SSE_MODE_AFTER_ROLLBACK"
  fi
  case "$sse_mode" in
    good|heartbeat|heartbeat-timeout)
      content_type='text/event-stream'
      body=': heartbeat\n\n'
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      curl_exit=28
      time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
      ;;
    quiet-timeout)
      content_type='text/event-stream'
      body=''
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      curl_exit=28
      time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
      ;;
    headers-only-eof)
      content_type='text/event-stream'
      body=''
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total='0'
      ;;
    headers-only-exact-window-eof)
      content_type='text/event-stream'
      body=''
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total="$(format_exact_window_integer_duration "${max_time:-1}")"
      ;;
    headers-only-exact-window-decimal-eof)
      content_type='text/event-stream'
      body=''
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
      ;;
    headers-only-plus-window-eof)
      content_type='text/event-stream'
      body=''
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total="$(format_shifted_window_duration "${max_time:-1}" 0.002)"
      ;;
    headers-only-under-window-eof)
      content_type='text/event-stream'
      body=''
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total="$(format_shifted_window_duration "${max_time:-1}" -0.002)"
      ;;
    heartbeat-eof)
      content_type='text/event-stream'
      body=': heartbeat\n\n'
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total='0'
      ;;
    heartbeat-under-window-eof)
      content_type='text/event-stream'
      body=': heartbeat\n\n'
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total="$(format_shifted_window_duration "${max_time:-1}" -0.002)"
      ;;
    bad-headers)
      content_type='application/json'
      body='{}'
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total='0.01'
      ;;
    bad-status)
      status='503'
      content_type='text/event-stream'
      body=''
      header_block=$'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      time_total='0.01'
      ;;
    legacy-absent)
      status='502'
      content_type='text/html'
      body='<html>legacy route unavailable</html>'
      header_block=$'HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\n\r\n'
      time_total='0.01'
      ;;
    connect-timeout)
      status='000'
      content_type=''
      body=''
      header_block=''
      curl_exit=28
      time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
      ;;
    malformed)
      content_type='text/event-stream'
      body='{"unexpected":true}\n'
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      curl_exit=28
      time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
      ;;
    *)
      content_type='text/event-stream'
      body=': heartbeat\n\n'
      header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n'
      curl_exit=28
      time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
      ;;
  esac
elif [[ "$url" == *'/api/auth/currentuser' ]]; then
  body='{"currentUser":null}'
elif [[ "$url" == *'/api/event' ]]; then
  case "$event_mode" in
    good)
      body='[{"eventId":"legacy-event","name":"Legacy Home - Legacy Away","home":"Legacy Home","away":"Legacy Away","time":"2026-01-01T12:00:00.000Z","products":[{"type":"1X2","name":"1X2","odds":[{"id":"home","name":"Legacy Home","value":1.91},{"id":"draw","name":"Draw","value":3.2},{"id":"away","name":"Legacy Away","value":4.1}]},{"type":"CS","name":"Correct Score","odds":[{"id":"1-0","name":"1 - 0","value":7.0},{"id":"1-1","name":"1 - 1","value":6.4},{"id":"2-1","name":"2 - 1","value":8.2}]}]}]'
      ;;
    live-only)
      body='[{"eventId":"live-event","name":"Live Home - Live Away","home":"Live Home","away":"Live Away","time":"2026-01-01T12:00:00.000Z","phase":"LIVE","live":{"sequence":44,"minute":75},"products":[{"type":"1X2","name":"1X2","odds":[{"id":"home","name":"Live Home","value":1.4},{"id":"draw","name":"Draw","value":5.0},{"id":"away","name":"Live Away","value":8.5}]},{"type":"CS","name":"Correct Score","odds":[{"id":"1-0","name":"1 - 0","value":5.5},{"id":"1-1","name":"1 - 1","value":7.2},{"id":"2-1","name":"2 - 1","value":8.4}]}]}]'
      ;;
    malformed)
      body='[{"eventId":"broken-event","name":"Broken Home - Broken Away","time":"not-a-date","products":[{"type":"1X2","name":"1X2","odds":[{"id":"home","name":"Broken Home","value":"oops"}]}]}]'
      ;;
    empty)
      body='[]'
      ;;
    *)
      body='[]'
      ;;
  esac
  if [[ -n "${STUB_HTTP_PERSISTENT_FAILURE_MATCH:-}" &&
      "$url" == *"$STUB_HTTP_PERSISTENT_FAILURE_MATCH"* ]]; then
    status='503'
    content_type='text/html'
    body='<html>temporarily unavailable</html>'
    header_block=$'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html\r\n\r\n'
  elif [[ -n "${STUB_HTTP_TRANSIENT_FAILURE_MATCH:-}" &&
      "$url" == *"$STUB_HTTP_TRANSIENT_FAILURE_MATCH"* &&
      ! -f "$STUB_STATE_DIR/http-transient-seen" ]]; then
    touch "$STUB_STATE_DIR/http-transient-seen"
    status='503'
    content_type='text/html'
    body='<html>temporarily unavailable</html>'
    header_block=$'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/html\r\n\r\n'
  fi
elif [[ "$url" == *'/api/slip' ]]; then
  body='{}'
elif [[ "$url" == *'/api/bet/stats' ]]; then
  body='[]'
elif [[ "$url" == *'/api/bet' ]]; then
  body='{}'
elif [[ "$url" == *'/api/backoffice' ]]; then
  body='[]'
elif [[ "$url" == */ ]]; then
  content_type='text/html'
  body='<html>BetStan</html>'
  header_block=$'HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-cache, no-transform\r\n\r\n'
fi
headers_tmp="${headers}.tmp.$$.$RANDOM"
output_tmp="${output}.tmp.$$.$RANDOM"
mkdir -p "$(dirname "$headers")" "$(dirname "$output")"
if [[ -n "${STUB_CURL_TRACE_FILE:-}" && "$url" == *'/api/event/stream' ]]; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$url" "$max_time" "$sse_mode" "$curl_exit" "$status" "$time_total" \
    >>"$STUB_CURL_TRACE_FILE"
fi
printf '%s' "$header_block" >"$headers_tmp"
printf '%b' "$body" >"$output_tmp"
mv "$headers_tmp" "$headers"
mv "$output_tmp" "$output"
result="$(python3 - "$write_out" "$status" "$url" "$content_type" "$time_total" <<'PY'
import sys
template, status, url, content_type, time_total = sys.argv[1:6]
result = template.replace('%{http_code}', status)
result = result.replace('%{url_effective}', url)
result = result.replace('%{content_type}', content_type)
result = result.replace('%{time_total}', time_total)
sys.stdout.write(result)
PY
)"
printf '%b' "$result"
exit "$curl_exit"
STUB
chmod +x "$BIN_DIR/curl"

cat >"$BIN_DIR/transition-readiness-stub.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$OUTPUT_DIR"
cat >"$OUTPUT_DIR/summary.env" <<'EOF'
rollback_readiness=GO
mode=migration-transition
phase=backing-up
rollback_operator=infra/oci/scripts/reviewed-topology-rollback-stan.sh
EOF
cat "$OUTPUT_DIR/summary.env"
STUB
chmod +x "$BIN_DIR/transition-readiness-stub.sh"

common_env=(
  "PATH=$BIN_DIR:$PATH"
  "REPO=example/repo"
  "GITHUB_REF_NAME=master"
  "STUB_TARGET_SHA=$TARGET_SHA"
  "STUB_CURRENT_MASTER_SHA=$CURRENT_MASTER_SHA"
  "STUB_SOURCE_RUN_ID=$SOURCE_RUN_ID"
  "STUB_DEPLOY_RUN_ID=$DEPLOY_RUN_ID"
  "STUB_BUILD_RUN_ID=$BUILD_RUN_ID"
  "STUB_ARTIFACT_NAME=$ARTIFACT_NAME"
  "INFRASTRUCTURE_RUN_ID=$INFRASTRUCTURE_RUN_ID"
  "OCI_INFRASTRUCTURE_PROVENANCE_SHA256=$INFRASTRUCTURE_PROVENANCE_SHA256"
  "OCI_INFRASTRUCTURE_PROVENANCE_FILE=$INFRASTRUCTURE_PROVENANCE_FIXTURE"
  "OCI_RUNTIME_FINGERPRINT=$RUNTIME_FINGERPRINT"
  "OCI_RUNTIME_MODE=k3s"
  "STUB_DEPLOY_RABBITMQ_BASELINE_FIXTURE=$DEPLOY_RABBITMQ_BASELINE_FIXTURE"
  "LIVE_BETTING_READINESS_SCRIPT=$REAL_LIVE_READINESS_SCRIPT"
  "ROLLBACK_READINESS_SCRIPT=$READINESS_SCRIPT"
)

run_script() {
  local output_dir="$1"
  shift
  local scenario_name scenario_state_dir scenario_kubectl_log
  rm -rf "$output_dir"
  mkdir -p "$output_dir"
  scenario_name="$(basename "$output_dir")"
  scenario_state_dir="$STATE_DIR/$scenario_name/current"
  scenario_kubectl_log="$STATE_DIR/$scenario_name/kubectl.log"
  reset_live_state "$scenario_state_dir"
  rm -f "$scenario_kubectl_log"
  env -i HOME="$HOME" "${common_env[@]}" \
    STUB_STATE_DIR="$scenario_state_dir" \
    STUB_KUBECTL_LOG="$scenario_kubectl_log" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-good" \
    STUB_CURL_TRACE_FILE="$output_dir/curl-trace.tsv" \
    LIVE_BETTING_SSE_PROBE_TRACE_FILE="$output_dir/sse-probe-trace.tsv" \
    LIVE_BETTING_SSE_VALIDATION_TRACE_FILE="$output_dir/sse-validation-trace.tsv" \
    OUTPUT_DIR="$output_dir" TARGET_SHA="$TARGET_SHA" \
    BASELINE_SOURCE_RUN_ID="$SOURCE_RUN_ID" BASELINE_SOURCE_RUN_ATTEMPT=1 \
    BASELINE_ARTIFACT_NAME="$ARTIFACT_NAME" \
    OCI_PUBLIC_URL='https://betstan.xyz' OCI_REDIRECT_URL='https://www.betstan.xyz' \
    OCI_DIAGNOSTIC_URL='https://203.0.113.10.nip.io' OCI_K8S_NAMESPACE='betstan-oci' \
    "$@" "$SCRIPT"
}

run_expect_failure() {
  local label="$1"
  shift
  local output_dir="$WORK_DIR/$label"
  if run_script "$output_dir" "$@" >"$output_dir.out" 2>&1; then
    cat "$output_dir.out" >&2
    fail "expected failure for $label"
  fi
}

run_capture() {
  local output_dir="$1"
  shift
  local scenario_name capture_state_dir capture_kubectl_log
  scenario_name="$(basename "$output_dir")"
  capture_state_dir="$STATE_DIR/$scenario_name/current"
  capture_kubectl_log="$STATE_DIR/$scenario_name/kubectl.log"
  set_target_state "$capture_state_dir"
  rm -f "$capture_kubectl_log"
  env -i HOME="$HOME" "${common_env[@]}" \
    STUB_STATE_DIR="$capture_state_dir" \
    STUB_KUBECTL_LOG="$capture_kubectl_log" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-good" \
    STUB_CURL_TRACE_FILE="$output_dir/curl-trace.tsv" \
    LIVE_BETTING_SSE_PROBE_TRACE_FILE="$output_dir/sse-probe-trace.tsv" \
    LIVE_BETTING_SSE_VALIDATION_TRACE_FILE="$output_dir/sse-validation-trace.tsv" \
    OUTPUT_DIR="$output_dir" \
    REPO=example/repo \
    OCI_PUBLIC_URL='https://betstan.xyz' OCI_REDIRECT_URL='https://www.betstan.xyz' \
    OCI_DIAGNOSTIC_URL='https://203.0.113.10.nip.io' OCI_K8S_NAMESPACE='betstan-oci' \
    "$@" "$CAPTURE_SCRIPT"
}

run_capture_expect_failure() {
  local label="$1"
  shift
  local output_dir="$WORK_DIR/$label"
  if run_capture "$output_dir" "$@" >"$output_dir.out" 2>&1; then
    cat "$output_dir.out" >&2
    fail "expected capture failure for $label"
  fi
}

ruby -ryaml - "$DEPLOY_WORKFLOW_FILE" "$WORKFLOW_FILE" <<'RUBY'
ARGV.each do |file|
  YAML.load_stream(File.read(file))
end
puts 'oci_rollback_yaml=PASS'
RUBY
assert_contains "$WORKFLOW_FILE" \
  'OCI_INFRASTRUCTURE_PROVENANCE_FILE: artifacts/infrastructure/provenance.env'

bash -n "$CAPTURE_SCRIPT" "$READINESS_SCRIPT" "$SCRIPT"

repeat_capture_dir="$WORK_DIR/capture-repeat-safe"
if ! run_capture "$repeat_capture_dir" STUB_SHORT_SSE_MODE=quiet-timeout >"$WORK_DIR/capture-repeat-safe-1.out" 2>&1; then
  cat "$WORK_DIR/capture-repeat-safe-1.out" >&2
  fail 'OCI repeat-safe quiet SSE capture unexpectedly failed on first run'
fi

legacy_capture_dir="$WORK_DIR/capture-legacy-sse-absence"
if ! run_capture "$legacy_capture_dir" \
    SSE_REQUIREMENT=deployed-source \
    STUB_DEPLOYED_SOURCE_HAS_SSE=0 \
    STUB_HTTP_PERSISTENT_FAILURE_MATCH=www.betstan.xyz/api/event \
    STUB_SHORT_SSE_MODE=legacy-absent >"$WORK_DIR/capture-legacy-sse-absence.out" 2>&1; then
  cat "$WORK_DIR/capture-legacy-sse-absence.out" >&2
  fail "trusted pre-SSE deployed source baseline was rejected"
fi
assert_contains "$legacy_capture_dir/baseline-provenance.env" 'sse_requirement=deployed-source'
assert_contains "$legacy_capture_dir/baseline-provenance.env" 'sse_required=false'
assert_contains "$legacy_capture_dir/baseline-provenance.env" 'alias_probe_mode=legacy-safe'
[[ "$(awk -F '\t' '$4 == "legacy-absent" { count++ } END { print count + 0 }' "$legacy_capture_dir/sse.tsv")" == "1" ]] ||
  fail "legacy SSE absence was not recorded for the canonical endpoint"
[[ "$(awk -F '\t' '$1 != "canonical" && $2 == "/api/event" { count++ } END { print count + 0 }' "$legacy_capture_dir/public-http.tsv")" == "0" ]] ||
  fail "legacy baseline repeated the side-effectful event API through an alias"
grep -Fq $'redirect\t/api/auth/currentuser?live-betting-redirect=1\t308\t' \
  "$legacy_capture_dir/public-http.tsv" ||
  fail "legacy baseline did not prove the exact redirect"

run_capture_expect_failure capture-declared-sse-absence \
  SSE_REQUIREMENT=deployed-source \
  STUB_DEPLOYED_SOURCE_HAS_SSE=1 \
  STUB_SHORT_SSE_MODE=legacy-absent
run_capture_expect_failure capture-legacy-sse-unexpected-status \
  SSE_REQUIREMENT=deployed-source \
  STUB_DEPLOYED_SOURCE_HAS_SSE=0 \
  STUB_SHORT_SSE_MODE=bad-status

http_retry_capture_dir="$WORK_DIR/capture-http-transient-retry"
if ! run_capture "$http_retry_capture_dir" \
    HTTP_ATTEMPTS=2 \
    HTTP_RETRY_SECONDS=0 \
    STUB_HTTP_TRANSIENT_FAILURE_MATCH=www.betstan.xyz/api/event \
    STUB_SHORT_SSE_MODE=quiet-timeout >"$WORK_DIR/capture-http-transient-retry.out" 2>&1; then
  cat "$WORK_DIR/capture-http-transient-retry.out" >&2
  fail "bounded HTTP retry did not recover a transient 503"
fi
assert_contains "$http_retry_capture_dir/baseline-provenance.env" 'http_attempts=2'
assert_contains "$http_retry_capture_dir/baseline-provenance.env" 'http_retry_seconds=0'

run_capture_expect_failure capture-http-persistent-failure \
  HTTP_ATTEMPTS=2 \
  HTTP_RETRY_SECONDS=0 \
  STUB_HTTP_PERSISTENT_FAILURE_MATCH=www.betstan.xyz/api/event \
  STUB_SHORT_SSE_MODE=quiet-timeout
if ! run_capture "$repeat_capture_dir" STUB_SHORT_SSE_MODE=quiet-timeout >"$WORK_DIR/capture-repeat-safe-2.out" 2>&1; then
  cat "$WORK_DIR/capture-repeat-safe-2.out" >&2
  fail 'OCI repeat-safe quiet SSE capture unexpectedly failed on second run'
fi
assert_contains "$WORK_DIR/capture-repeat-safe-2.out" 'oci_baseline_capture=PASS'
assert_contains "$repeat_capture_dir/sse.tsv" $'canonical\t200\thttps://betstan.xyz/api/event/stream\ttext/event-stream'
assert_line "$repeat_capture_dir/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\tquiet-timeout\t28\t200\t5.000000'
assert_line "$repeat_capture_dir/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t28\t200\t5.000000\t5'
assert_line "$repeat_capture_dir/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t28\t200\t5.000000\t5000\t5\t5000\t1\t0\ttrue'
[[ ! -d "$repeat_capture_dir/.workdirs" ]] || fail 'OCI repeat-safe capture left workdirs behind'

if ! run_capture "$WORK_DIR/capture-exact-window-eof" STUB_SHORT_SSE_MODE=headers-only-exact-window-eof >"$WORK_DIR/capture-exact-window-eof.out" 2>&1; then
  cat "$WORK_DIR/capture-exact-window-eof.out" >&2
  fail 'OCI exact-window EOF SSE capture unexpectedly failed'
fi
assert_contains "$WORK_DIR/capture-exact-window-eof.out" 'oci_baseline_capture=PASS'
assert_line "$WORK_DIR/capture-exact-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-exact-window-eof\t0\t200\t5'
assert_line "$WORK_DIR/capture-exact-window-eof/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5\t5'
assert_line "$WORK_DIR/capture-exact-window-eof/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5\t5000\t5\t5000\t1\t0\ttrue'

if ! run_capture "$WORK_DIR/capture-exact-window-decimal-eof" STUB_SHORT_SSE_MODE=headers-only-exact-window-decimal-eof >"$WORK_DIR/capture-exact-window-decimal-eof.out" 2>&1; then
  cat "$WORK_DIR/capture-exact-window-decimal-eof.out" >&2
  fail 'OCI exact-window decimal EOF SSE capture unexpectedly failed'
fi
assert_contains "$WORK_DIR/capture-exact-window-decimal-eof.out" 'oci_baseline_capture=PASS'
assert_line "$WORK_DIR/capture-exact-window-decimal-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-exact-window-decimal-eof\t0\t200\t5.000000'
assert_line "$WORK_DIR/capture-exact-window-decimal-eof/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5.000000\t5'
assert_line "$WORK_DIR/capture-exact-window-decimal-eof/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5.000000\t5000\t5\t5000\t1\t0\ttrue'

if ! run_capture "$WORK_DIR/capture-plus-window-eof" STUB_SHORT_SSE_MODE=headers-only-plus-window-eof >"$WORK_DIR/capture-plus-window-eof.out" 2>&1; then
  cat "$WORK_DIR/capture-plus-window-eof.out" >&2
  fail 'OCI plus-window EOF SSE capture unexpectedly failed'
fi
assert_contains "$WORK_DIR/capture-plus-window-eof.out" 'oci_baseline_capture=PASS'
assert_line "$WORK_DIR/capture-plus-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-plus-window-eof\t0\t200\t5.002000'
assert_line "$WORK_DIR/capture-plus-window-eof/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5.002000\t5'
assert_line "$WORK_DIR/capture-plus-window-eof/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5.002000\t5002\t5\t5000\t1\t0\ttrue'

if ! run_capture "$WORK_DIR/capture-heartbeat-timeout" STUB_SHORT_SSE_MODE=heartbeat-timeout >"$WORK_DIR/capture-heartbeat-timeout.out" 2>&1; then
  cat "$WORK_DIR/capture-heartbeat-timeout.out" >&2
  fail 'OCI heartbeat-timeout SSE capture unexpectedly failed'
fi
assert_contains "$WORK_DIR/capture-heartbeat-timeout.out" 'oci_baseline_capture=PASS'
assert_line "$WORK_DIR/capture-heartbeat-timeout/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theartbeat-timeout\t28\t200\t5.000000'
assert_line "$WORK_DIR/capture-heartbeat-timeout/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t28\t200\t5.000000\t5'
assert_line "$WORK_DIR/capture-heartbeat-timeout/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t28\t200\t5.000000\t5000\t5\t5000\t1\t1\ttrue'

run_capture_expect_failure capture-sse-under-window-eof \
  STUB_SHORT_SSE_MODE=headers-only-under-window-eof
assert_contains "$WORK_DIR/capture-sse-under-window-eof.out" 'SSE connectivity contract failed for https://betstan.xyz/api/event/stream'
assert_line "$WORK_DIR/capture-sse-under-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-under-window-eof\t0\t200\t4.998000'
assert_line "$WORK_DIR/capture-sse-under-window-eof/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t4.998000\t5'
assert_line "$WORK_DIR/capture-sse-under-window-eof/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t4.998000\t4998\t5\t5000\t1\t0\tfalse'

run_capture_expect_failure capture-sse-headers-only-eof \
  STUB_SHORT_SSE_MODE=headers-only-eof
assert_contains "$WORK_DIR/capture-sse-headers-only-eof.out" 'SSE connectivity contract failed for https://betstan.xyz/api/event/stream'
assert_line "$WORK_DIR/capture-sse-headers-only-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-eof\t0\t200\t0'
assert_line "$WORK_DIR/capture-sse-headers-only-eof/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t0\t5'
assert_line "$WORK_DIR/capture-sse-headers-only-eof/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t0\t0\t5\t5000\t1\t0\tfalse'

run_capture_expect_failure capture-sse-heartbeat-under-window-eof \
  STUB_SHORT_SSE_MODE=heartbeat-under-window-eof
assert_contains "$WORK_DIR/capture-sse-heartbeat-under-window-eof.out" 'SSE connectivity contract failed for https://betstan.xyz/api/event/stream'
assert_line "$WORK_DIR/capture-sse-heartbeat-under-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theartbeat-under-window-eof\t0\t200\t4.998000'
assert_line "$WORK_DIR/capture-sse-heartbeat-under-window-eof/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t4.998000\t5'
assert_line "$WORK_DIR/capture-sse-heartbeat-under-window-eof/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t4.998000\t4998\t5\t5000\t1\t1\tfalse'

run_capture_expect_failure capture-sse-heartbeat-eof \
  STUB_SHORT_SSE_MODE=heartbeat-eof
assert_contains "$WORK_DIR/capture-sse-heartbeat-eof.out" 'SSE connectivity contract failed for https://betstan.xyz/api/event/stream'

run_capture_expect_failure capture-sse-bad-status \
  STUB_SHORT_SSE_MODE=bad-status
assert_contains "$WORK_DIR/capture-sse-bad-status.out" 'SSE connectivity contract failed for https://betstan.xyz/api/event/stream'

run_capture_expect_failure capture-sse-malformed \
  STUB_SHORT_SSE_MODE=malformed
assert_contains "$WORK_DIR/capture-sse-malformed.out" 'SSE connectivity contract failed for https://betstan.xyz/api/event/stream'

run_capture_expect_failure capture-sse-timeout \
  STUB_SHORT_SSE_MODE=connect-timeout
assert_contains "$WORK_DIR/capture-sse-timeout.out" 'SSE connectivity contract failed for https://betstan.xyz/api/event/stream'

oci_cleanup_sentinel="$ROOT_DIR/infra/oci/tests/.cleanup-sentinel-$$"
printf 'protected\n' >"$oci_cleanup_sentinel"
oci_cleanup_before="$(sha256_file "$oci_cleanup_sentinel")"
if env -i HOME="$HOME" "${common_env[@]}" \
    OUTPUT_DIR="$WORK_PARENT/.." \
    OCI_PUBLIC_URL='https://betstan.xyz' OCI_REDIRECT_URL='https://www.betstan.xyz' \
    OCI_DIAGNOSTIC_URL='https://203.0.113.10.nip.io' OCI_K8S_NAMESPACE='betstan-oci' \
    "$CAPTURE_SCRIPT" >"$WORK_DIR/capture-cleanup-traversal.out" 2>&1; then
  fail 'OCI cleanup traversal guard unexpectedly passed'
fi
[[ "$(sha256_file "$oci_cleanup_sentinel")" == "$oci_cleanup_before" ]] ||
  fail 'OCI cleanup traversal guard modified the sentinel'
assert_contains "$WORK_DIR/capture-cleanup-traversal.out" 'private directory'
ln -sfn "$ROOT_DIR/infra/oci/tests" "$WORK_PARENT/oci-cleanup-link"
if env -i HOME="$HOME" "${common_env[@]}" \
    OUTPUT_DIR="$WORK_PARENT/oci-cleanup-link" \
    OCI_PUBLIC_URL='https://betstan.xyz' OCI_REDIRECT_URL='https://www.betstan.xyz' \
    OCI_DIAGNOSTIC_URL='https://203.0.113.10.nip.io' OCI_K8S_NAMESPACE='betstan-oci' \
    "$CAPTURE_SCRIPT" >"$WORK_DIR/capture-cleanup-symlink.out" 2>&1; then
  fail 'OCI cleanup symlink guard unexpectedly passed'
fi
[[ "$(sha256_file "$oci_cleanup_sentinel")" == "$oci_cleanup_before" ]] ||
  fail 'OCI cleanup symlink guard modified the sentinel'
assert_contains "$WORK_DIR/capture-cleanup-symlink.out" 'private directory'
unlink "$WORK_PARENT/oci-cleanup-link"
rm -f "$oci_cleanup_sentinel"

run_expect_failure provenance-rejection \
  STUB_SOURCE_RUN_BAD_WORKFLOW=1 ROLLBACK_MODE=dry-run

run_expect_failure checksum-mismatch \
  STUB_TAMPER_FILE=images.tsv ROLLBACK_MODE=dry-run

run_expect_failure mutable-rejection \
  STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-mutable" ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/mutable-rejection.out" 'baseline image for event is mutable'

run_expect_failure expired-artifact \
  STUB_ARTIFACT_EXPIRED=1 ROLLBACK_MODE=dry-run

legacy_missing_output="$WORK_DIR/legacy-missing-provenance"
if ! run_script "$legacy_missing_output" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-legacy-missing" \
    STUB_DEPLOY_PROVENANCE_FIXTURE="$FIXTURE_DIR/baseline-legacy-embedded" \
    ROLLBACK_MODE=dry-run >"$WORK_DIR/legacy-missing-provenance.out" 2>&1; then
  cat "$WORK_DIR/legacy-missing-provenance.out" >&2
  fail "legacy baseline provenance reconstruction unexpectedly failed"
fi
assert_contains "$legacy_missing_output/rollback-summary.env" \
  'deploy_provenance_origin=reconstructed-exact-deploy-artifact'
assert_contains "$legacy_missing_output/rollback-summary.env" \
  'deploy_provenance_binding=legacy-runtime-fingerprint'
assert_contains "$legacy_missing_output/trusted-deploy-provenance.txt" \
  "infrastructure_run_id=$INFRASTRUCTURE_RUN_ID"
assert_contains "$legacy_missing_output/trusted-deploy-provenance.txt" \
  "infrastructure_provenance_sha256=$INFRASTRUCTURE_PROVENANCE_SHA256"
assert_contains "$legacy_missing_output/trusted-deploy-provenance.txt" \
  'infrastructure_binding=legacy-runtime-fingerprint'

legacy_embedded_output="$WORK_DIR/legacy-embedded-provenance"
if ! run_script "$legacy_embedded_output" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-legacy-embedded" \
    ROLLBACK_MODE=dry-run >"$WORK_DIR/legacy-embedded-provenance.out" 2>&1; then
  cat "$WORK_DIR/legacy-embedded-provenance.out" >&2
  fail "embedded legacy deploy provenance unexpectedly failed"
fi
assert_contains "$legacy_embedded_output/rollback-summary.env" \
  'deploy_provenance_origin=baseline-embedded'
assert_contains "$legacy_embedded_output/rollback-summary.env" \
  'deploy_provenance_binding=legacy-runtime-fingerprint'

run_expect_failure legacy-deploy-provenance-artifact-missing \
  STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-legacy-missing" \
  STUB_DEPLOY_ARTIFACT_MISSING=1 \
  ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/legacy-deploy-provenance-artifact-missing.out" \
  'deploy provenance artifact identity does not resolve to exactly one artifact'

run_expect_failure legacy-deploy-provenance-source-mismatch \
  STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-legacy-missing" \
  STUB_DEPLOY_PROVENANCE_FIXTURE="$FIXTURE_DIR/baseline-legacy-source-mismatch" \
  ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/legacy-deploy-provenance-source-mismatch.out" \
  'trusted deploy provenance source SHA does not match TARGET_SHA'

run_expect_failure legacy-deploy-provenance-images-mismatch \
  STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-legacy-missing" \
  STUB_DEPLOY_PROVENANCE_FIXTURE="$FIXTURE_DIR/baseline-mutable" \
  ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/legacy-deploy-provenance-images-mismatch.out" \
  'recovered deploy provenance images do not match the rollback baseline'

run_expect_failure partial-infrastructure-provenance \
  STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-partial-infrastructure" \
  ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/partial-infrastructure-provenance.out" \
  'trusted deploy provenance has incomplete infrastructure binding'

run_expect_failure selected-infrastructure-provenance-missing \
  OCI_INFRASTRUCTURE_PROVENANCE_FILE="$FIXTURE_DIR/missing-infrastructure.env" \
  ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/selected-infrastructure-provenance-missing.out" \
  'OCI_INFRASTRUCTURE_PROVENANCE_FILE is missing'

run_expect_failure selected-infrastructure-provenance-tampered \
  STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-legacy-embedded" \
  OCI_INFRASTRUCTURE_PROVENANCE_FILE="$TAMPERED_INFRASTRUCTURE_PROVENANCE_FIXTURE" \
  ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/selected-infrastructure-provenance-tampered.out" \
  'selected infrastructure provenance file hash does not match'

run_expect_failure oci-rollback-readiness-refusal \
  STUB_HISTORY_COUNT=1 ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/oci-rollback-readiness-refusal.out" 'OCI rollback readiness rejected the rollback'

run_expect_failure oci-auth-git-missing \
  STUB_TARGET_LOGIN_MODE=missing ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/oci-auth-git-missing.out" 'OCI rollback readiness rejected the rollback'
assert_contains "$WORK_DIR/oci-auth-git-missing/rollback-readiness/summary.env" 'auth_identifier_rollback_check=missing-git-evidence'

run_expect_failure oci-auth-incompatible \
  STUB_TARGET_LOGIN_MODE=legacy STUB_NORMALIZED_IDENTIFIER_COUNT=2 ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/oci-auth-incompatible.out" 'OCI rollback readiness rejected the rollback'
assert_contains "$WORK_DIR/oci-auth-incompatible/rollback-readiness/summary.env" 'auth_identifier_rollback_check=incompatible'
assert_contains "$WORK_DIR/oci-auth-incompatible/rollback-readiness/summary.env" 'auth_normalized_identifier_count=2'

run_expect_failure oci-auth-query-failed \
  STUB_TARGET_LOGIN_MODE=legacy STUB_AUTH_QUERY_FAIL=1 ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/oci-auth-query-failed.out" 'OCI rollback readiness rejected the rollback'
assert_contains "$WORK_DIR/oci-auth-query-failed/rollback-readiness/summary.env" 'auth_identifier_rollback_check=query-failed'

if ! run_script "$WORK_DIR/oci-auth-compatible" \
    STUB_TARGET_LOGIN_MODE=legacy STUB_NORMALIZED_IDENTIFIER_COUNT=0 ROLLBACK_MODE=dry-run \
    >"$WORK_DIR/oci-auth-compatible.out" 2>&1; then
  cat "$WORK_DIR/oci-auth-compatible.out" >&2
  fail 'OCI auth-compatible dry-run unexpectedly failed'
fi
assert_contains "$WORK_DIR/oci-auth-compatible/rollback-readiness/summary.env" 'auth_identifier_rollback_check=compatible'
assert_contains "$WORK_DIR/oci-auth-compatible/rollback-readiness/summary.env" 'target_supports_normalized_identifiers=false'
assert_contains "$WORK_DIR/oci-auth-compatible/rollback-summary.env" "infrastructure_run_id=$INFRASTRUCTURE_RUN_ID"
assert_contains "$WORK_DIR/oci-auth-compatible/rollback-summary.env" 'admin_auth_rollback_check=persisted-admin-evidence'

run_expect_failure infra-run-id-mismatch \
  ROLLBACK_MODE=dry-run INFRASTRUCTURE_RUN_ID=9999
assert_contains "$WORK_DIR/infra-run-id-mismatch.out" \
  'selected infrastructure run does not match the trusted baseline infrastructure run'

MISMATCHED_HEX_DIGEST="$(printf 'ef56%.0s' {1..16})"
run_expect_failure infra-provenance-hash-mismatch \
  ROLLBACK_MODE=dry-run OCI_INFRASTRUCTURE_PROVENANCE_SHA256="$MISMATCHED_HEX_DIGEST"
assert_contains "$WORK_DIR/infra-provenance-hash-mismatch.out" \
  'selected infrastructure provenance hash does not match the trusted baseline'

run_expect_failure infra-runtime-fingerprint-mismatch \
  ROLLBACK_MODE=dry-run OCI_RUNTIME_FINGERPRINT="$MISMATCHED_HEX_DIGEST"
assert_contains "$WORK_DIR/infra-runtime-fingerprint-mismatch.out" \
  'selected runtime fingerprint does not match the trusted baseline'

run_expect_failure infra-runtime-mode-mismatch \
  ROLLBACK_MODE=dry-run OCI_RUNTIME_MODE=aks
assert_contains "$WORK_DIR/infra-runtime-mode-mismatch.out" \
  'selected runtime mode does not match the trusted baseline'

run_expect_failure oci-public-url-mismatch \
  ROLLBACK_MODE=dry-run OCI_PUBLIC_URL='https://impostor.example.invalid'
assert_contains "$WORK_DIR/oci-public-url-mismatch.out" \
  'OCI_PUBLIC_URL does not match the trusted baseline public URL'

run_expect_failure oci-redirect-url-mismatch \
  ROLLBACK_MODE=dry-run OCI_REDIRECT_URL='https://impostor.example.invalid'
assert_contains "$WORK_DIR/oci-redirect-url-mismatch.out" \
  'OCI_REDIRECT_URL does not match the trusted baseline redirect URL'

run_expect_failure oci-diagnostic-url-mismatch \
  ROLLBACK_MODE=dry-run OCI_DIAGNOSTIC_URL='https://impostor.example.invalid'
assert_contains "$WORK_DIR/oci-diagnostic-url-mismatch.out" \
  'OCI_DIAGNOSTIC_URL does not match the trusted baseline diagnostic URL'

run_expect_failure admin-auth-missing-no-capability \
  STUB_TARGET_HAS_ADMIN_AUTH=0 ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/admin-auth-missing-no-capability.out" \
  'TARGET_SHA is missing persisted-admin Backoffice authorization evidence and no ADMIN_AUTH_CAPABILITY_FILE was supplied'

admin_auth_capability_valid="$WORK_DIR/admin-auth-capability-valid.env"
cat >"$admin_auth_capability_valid" <<EOF
capability=legacy-admin-auth-accepted
source_sha=$TARGET_SHA
reason=pre-admin-auth-release rollback approved by release captain
approved_by=release-captain
EOF

admin_auth_capability_wrong_sha="$WORK_DIR/admin-auth-capability-wrong-sha.env"
cat >"$admin_auth_capability_wrong_sha" <<EOF
capability=legacy-admin-auth-accepted
source_sha=$CURRENT_MASTER_SHA
reason=pre-admin-auth-release rollback approved by release captain
approved_by=release-captain
EOF

admin_auth_capability_wrong_value="$WORK_DIR/admin-auth-capability-wrong-value.env"
cat >"$admin_auth_capability_wrong_value" <<EOF
capability=some-other-capability
source_sha=$TARGET_SHA
reason=pre-admin-auth-release rollback approved by release captain
approved_by=release-captain
EOF

admin_auth_capability_missing_reason="$WORK_DIR/admin-auth-capability-missing-reason.env"
cat >"$admin_auth_capability_missing_reason" <<EOF
capability=legacy-admin-auth-accepted
source_sha=$TARGET_SHA
approved_by=release-captain
EOF

run_expect_failure admin-auth-capability-missing-file \
  STUB_TARGET_HAS_ADMIN_AUTH=0 ROLLBACK_MODE=dry-run \
  ADMIN_AUTH_CAPABILITY_FILE="$WORK_DIR/does-not-exist.env"
assert_contains "$WORK_DIR/admin-auth-capability-missing-file.out" \
  'ADMIN_AUTH_CAPABILITY_FILE does not exist'

run_expect_failure admin-auth-capability-wrong-sha \
  STUB_TARGET_HAS_ADMIN_AUTH=0 ROLLBACK_MODE=dry-run \
  ADMIN_AUTH_CAPABILITY_FILE="$admin_auth_capability_wrong_sha"
assert_contains "$WORK_DIR/admin-auth-capability-wrong-sha.out" \
  'ADMIN_AUTH_CAPABILITY_FILE source_sha does not match TARGET_SHA'

run_expect_failure admin-auth-capability-wrong-value \
  STUB_TARGET_HAS_ADMIN_AUTH=0 ROLLBACK_MODE=dry-run \
  ADMIN_AUTH_CAPABILITY_FILE="$admin_auth_capability_wrong_value"
assert_contains "$WORK_DIR/admin-auth-capability-wrong-value.out" \
  'ADMIN_AUTH_CAPABILITY_FILE capability must be legacy-admin-auth-accepted'

run_expect_failure admin-auth-capability-missing-reason \
  STUB_TARGET_HAS_ADMIN_AUTH=0 ROLLBACK_MODE=dry-run \
  ADMIN_AUTH_CAPABILITY_FILE="$admin_auth_capability_missing_reason"
assert_contains "$WORK_DIR/admin-auth-capability-missing-reason.out" \
  'ADMIN_AUTH_CAPABILITY_FILE reason must be non-empty'

if ! run_script "$WORK_DIR/admin-auth-capability-accepted" \
    STUB_TARGET_HAS_ADMIN_AUTH=0 ROLLBACK_MODE=dry-run \
    ADMIN_AUTH_CAPABILITY_FILE="$admin_auth_capability_valid" \
    >"$WORK_DIR/admin-auth-capability-accepted.out" 2>&1; then
  cat "$WORK_DIR/admin-auth-capability-accepted.out" >&2
  fail 'OCI admin-auth explicit-capability dry-run unexpectedly failed'
fi
assert_contains "$WORK_DIR/admin-auth-capability-accepted/rollback-summary.env" \
  'admin_auth_rollback_check=explicit-capability-override'

run_expect_failure oci-prematch-live-only \
  STUB_EVENT_MODE=live-only ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/oci-prematch-live-only.out" 'OCI rollback readiness rejected the rollback'
assert_contains "$WORK_DIR/oci-prematch-live-only/rollback-readiness/failures.txt" '/api/event'

run_expect_failure migration-transition-block \
  ROLLBACK_MODE=execute ROLLBACK_READINESS_SCRIPT="$BIN_DIR/transition-readiness-stub.sh"
assert_contains "$WORK_DIR/migration-transition-block.out" 'do not roll application images'
assert_contains "$WORK_DIR/migration-transition-block.out" 'infra/oci/scripts/reviewed-topology-rollback-stan.sh'
assert_contains "$WORK_DIR/migration-transition-block/rollback-readiness/summary.env" 'mode=migration-transition'
[[ ! -s "$STATE_DIR/migration-transition-block/kubectl.log" ]] || fail 'OCI migration-transition guard should prevent image mutation'

run_expect_failure active-live-refusal \
  STUB_ACTIVE_MATCHES=1 ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/active-live-refusal.out" 'live-aware rollback drain gate rejected the rollback'

run_expect_failure draft-live-refusal \
  STUB_DRAFT_LIVE_SLIPS=1 ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/draft-live-refusal.out" 'live-aware rollback drain gate rejected the rollback'

run_expect_failure queue-growth-refusal \
  STUB_BASELINE_QUEUE_READY_AFTER_ROLLBACK=1 ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/queue-growth-refusal.out" 'RabbitMQ verification failed after gaming-auth-depl'
assert_contains "$WORK_DIR/queue-growth-refusal/queue-thresholds.env" 'max_post_rollback_queue_ready_growth=0'

run_expect_failure queue-unack-threshold-refusal \
  STUB_BASELINE_QUEUE_UNACK_AFTER_ROLLBACK=6 ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/queue-unack-threshold-refusal.out" 'RabbitMQ verification failed after gaming-auth-depl'
assert_contains "$WORK_DIR/queue-unack-threshold-refusal/queue-thresholds.env" 'max_post_rollback_queue_unack=5'

run_expect_failure dynamic-queue-missing-refusal \
  STUB_DROP_DYNAMIC_QUEUE_AFTER_ROLLBACK=1 ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/dynamic-queue-missing-refusal.out" 'missing dynamic topology'

run_expect_failure dynamic-queue-zero-consumers \
  STUB_DYNAMIC_QUEUE_CONSUMERS_AFTER_ROLLBACK=0 ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/dynamic-queue-zero-consumers.out" 'consumers 0 below required'

run_expect_failure partial-failure \
  STUB_FAIL_SERVICE=event ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/partial-failure.out" 'rollout did not complete for gaming-event-depl'
assert_contains "$WORK_DIR/partial-failure/failure-state.env" 'failed_service=event'
assert_contains "$WORK_DIR/partial-failure/failure-state.env" 'failed_deployment=gaming-event-depl'
assert_contains "$WORK_DIR/partial-failure/failure-state.env" 'failed_stage=rollout-status'
[[ "$(wc -l <"$WORK_DIR/partial-failure/rollout-order.tsv" | tr -d ' ')" == '5' ]] || fail 'OCI partial failure should stop after event rollout'
! grep -Fxq 'moderation' "$WORK_DIR/partial-failure/rollout-order.tsv" || fail 'OCI partial failure should not continue after event'

run_expect_failure post-rollback-prematch-refusal \
  STUB_EVENT_MODE_AFTER_ROLLBACK=live-only ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/post-rollback-prematch-refusal.out" 'public API verification failed for canonical after gaming-auth-depl'
assert_contains "$WORK_DIR/post-rollback-prematch-refusal/failure-state.env" 'failed_service=auth'
assert_contains "$WORK_DIR/post-rollback-prematch-refusal/failure-state.env" 'failed_stage=public-api'
[[ "$(wc -l <"$WORK_DIR/post-rollback-prematch-refusal/rollout-order.tsv" | tr -d ' ')" == '1' ]] || fail 'OCI prematch refusal should stop after the first deployment'

run_expect_failure sse-under-window-eof-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=headers-only-under-window-eof ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-under-window-eof-refusal.out" 'SSE verification failed for canonical after gaming-auth-depl'
assert_line "$WORK_DIR/sse-under-window-eof-refusal/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-under-window-eof\t0\t200\t4.998000'
assert_line "$WORK_DIR/sse-under-window-eof-refusal/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t4.998000\t5'
assert_line "$WORK_DIR/sse-under-window-eof-refusal/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t4.998000\t4998\t5\t5000\t1\t0\tfalse'

run_expect_failure sse-headers-only-eof-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=headers-only-eof ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-headers-only-eof-refusal.out" 'SSE verification failed for canonical after gaming-auth-depl'
assert_line "$WORK_DIR/sse-headers-only-eof-refusal/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-eof\t0\t200\t0'
assert_line "$WORK_DIR/sse-headers-only-eof-refusal/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t0\t5'
assert_line "$WORK_DIR/sse-headers-only-eof-refusal/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t0\t0\t5\t5000\t1\t0\tfalse'

run_expect_failure sse-heartbeat-under-window-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=heartbeat-under-window-eof ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-heartbeat-under-window-refusal.out" 'SSE verification failed for canonical after gaming-auth-depl'
assert_line "$WORK_DIR/sse-heartbeat-under-window-refusal/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theartbeat-under-window-eof\t0\t200\t4.998000'
assert_line "$WORK_DIR/sse-heartbeat-under-window-refusal/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t4.998000\t5'
assert_line "$WORK_DIR/sse-heartbeat-under-window-refusal/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t4.998000\t4998\t5\t5000\t1\t1\tfalse'

run_expect_failure sse-heartbeat-eof-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=heartbeat-eof ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-heartbeat-eof-refusal.out" 'SSE verification failed for canonical after gaming-auth-depl'

run_expect_failure sse-content-type-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=bad-headers ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-content-type-refusal.out" 'SSE verification failed for canonical after gaming-auth-depl'

run_expect_failure sse-malformed-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=malformed ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-malformed-refusal.out" 'SSE verification failed for canonical after gaming-auth-depl'

run_expect_failure sse-legacy-absent-required-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=legacy-absent ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-legacy-absent-required-refusal.out" 'SSE verification failed for canonical after gaming-auth-depl'

if ! run_script "$WORK_DIR/legacy-sse-rollback-success" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-legacy-sse" \
    STUB_SSE_MODE=legacy-absent \
    STUB_SHORT_SSE_MODE=legacy-absent \
    ROLLBACK_MODE=execute >"$WORK_DIR/legacy-sse-rollback-success.out" 2>&1; then
  cat "$WORK_DIR/legacy-sse-rollback-success.out" >&2
  fail 'OCI rollback to a pre-SSE baseline unexpectedly failed'
fi
assert_contains "$WORK_DIR/legacy-sse-rollback-success.out" 'oci_rollback_status=PASS'
assert_contains "$WORK_DIR/legacy-sse-rollback-success/preflight-live-readiness/summary.env" 'sse_required=false'
assert_contains "$WORK_DIR/legacy-sse-rollback-success/preflight-live-readiness/summary.env" 'sse_primary_status=legacy-absent:502'
assert_contains "$WORK_DIR/legacy-sse-rollback-success/preflight-live-readiness/summary.env" 'sse_diagnostic_status=legacy-absent:502'
assert_contains "$WORK_DIR/legacy-sse-rollback-success/live-readiness/summary.env" 'sse_required=false'
assert_contains "$WORK_DIR/legacy-sse-rollback-success/live-readiness/summary.env" 'sse_primary_status=legacy-absent:502'
assert_contains "$WORK_DIR/legacy-sse-rollback-success/live-readiness/summary.env" 'sse_diagnostic_status=legacy-absent:502'
assert_contains "$WORK_DIR/legacy-sse-rollback-success/sse-verification.tsv" $'\t502\t'
[[ "$(wc -l <"$WORK_DIR/legacy-sse-rollback-success/rollout-order.tsv" | tr -d ' ')" == '9' ]] ||
  fail 'OCI legacy pre-SSE rollback aborted mid-rollout instead of processing every service'

run_expect_failure exact-digest-verification \
  STUB_BAD_DIGEST_SERVICE=event ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/exact-digest-verification.out" 'does not serve the expected platform digest'

if ! run_script "$WORK_DIR/success-exact-window-eof" \
    STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK=event_live_update.rolled-pod \
    STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=headers-only-exact-window-eof \
    ROLLBACK_MODE=execute >"$WORK_DIR/success-exact-window-eof.out" 2>&1; then
  cat "$WORK_DIR/success-exact-window-eof.out" >&2
  fail 'OCI exact-window EOF SSE success fixture unexpectedly failed'
fi
assert_contains "$WORK_DIR/success-exact-window-eof.out" 'oci_rollback_status=PASS'
assert_line "$WORK_DIR/success-exact-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-exact-window-eof\t0\t200\t5'
assert_line "$WORK_DIR/success-exact-window-eof/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5\t5'
assert_line "$WORK_DIR/success-exact-window-eof/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5\t5000\t5\t5000\t1\t0\ttrue'

if ! run_script "$WORK_DIR/success-exact-window-decimal-eof" \
    STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK=event_live_update.rolled-pod \
    STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=headers-only-exact-window-decimal-eof \
    ROLLBACK_MODE=execute >"$WORK_DIR/success-exact-window-decimal-eof.out" 2>&1; then
  cat "$WORK_DIR/success-exact-window-decimal-eof.out" >&2
  fail 'OCI exact-window decimal EOF SSE success fixture unexpectedly failed'
fi
assert_contains "$WORK_DIR/success-exact-window-decimal-eof.out" 'oci_rollback_status=PASS'
assert_line "$WORK_DIR/success-exact-window-decimal-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-exact-window-decimal-eof\t0\t200\t5.000000'
assert_line "$WORK_DIR/success-exact-window-decimal-eof/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5.000000\t5'
assert_line "$WORK_DIR/success-exact-window-decimal-eof/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t0\t200\t5.000000\t5000\t5\t5000\t1\t0\ttrue'

if ! run_script "$WORK_DIR/success-quiet-sse" \
    STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK=event_live_update.rolled-pod \
    STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=quiet-timeout \
    ROLLBACK_MODE=execute >"$WORK_DIR/success-quiet-sse.out" 2>&1; then
  cat "$WORK_DIR/success-quiet-sse.out" >&2
  fail 'OCI quiet-timeout SSE success fixture unexpectedly failed'
fi
assert_contains "$WORK_DIR/success-quiet-sse.out" 'oci_rollback_status=PASS'
assert_line "$WORK_DIR/success-quiet-sse/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\tquiet-timeout\t28\t200\t5.000000'
assert_line "$WORK_DIR/success-quiet-sse/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t28\t200\t5.000000\t5'
assert_line "$WORK_DIR/success-quiet-sse/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t28\t200\t5.000000\t5000\t5\t5000\t1\t0\ttrue'

if ! run_script "$WORK_DIR/success" \
    STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK=event_live_update.rolled-pod \
    STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=heartbeat-timeout \
    ROLLBACK_MODE=execute >"$WORK_DIR/success.out" 2>&1; then
  cat "$WORK_DIR/success.out" >&2
  fail 'OCI success fixture unexpectedly failed'
fi
assert_contains "$WORK_DIR/success.out" 'oci_rollback_status=PASS'
assert_line "$WORK_DIR/success/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theartbeat-timeout\t28\t200\t5.000000'
assert_line "$WORK_DIR/success/sse-probe-trace.tsv" $'https://betstan.xyz/api/event/stream\t28\t200\t5.000000\t5'
assert_line "$WORK_DIR/success/sse-validation-trace.tsv" $'https://betstan.xyz/api/event/stream\t28\t200\t5.000000\t5000\t5\t5000\t1\t1\ttrue'
[[ "$(wc -l <"$WORK_DIR/success/rollout-order.tsv" | tr -d ' ')" == '9' ]] || fail 'OCI success rollout did not process every service'
[[ "$(tail -n 1 "$WORK_DIR/success/rollout-order.tsv")" == 'gamemaster' ]] || fail 'OCI gamemaster was not rolled back last'
assert_contains "$WORK_DIR/success/rollback-summary.env" 'status=PASS'
assert_contains "$WORK_DIR/success/rollback-readiness/summary.env" 'rollback_readiness=GO'
assert_contains "$WORK_DIR/success/rollback-readiness/summary.env" 'auth_identifier_rollback_check=compatible'
assert_contains "$WORK_DIR/success/preflight-live-readiness/summary.env" 'mode=rollback-drain'
assert_contains "$WORK_DIR/success/live-readiness/summary.env" 'mode=rollback-drain'
assert_contains "$WORK_DIR/success/live-readiness/summary.env" 'secondary_redirect_status=308'
assert_contains "$WORK_DIR/success/live-readiness/summary.env" 'diagnostic_event_status=200'
assert_contains "$WORK_DIR/success/live-readiness/summary.env" 'legacy_prematch_events=1'
assert_contains "$WORK_DIR/success/queue-thresholds.env" 'max_post_rollback_queue_ready=5'
assert_contains "$WORK_DIR/success/queue-thresholds.env" 'max_post_rollback_queue_unack=5'
assert_contains "$WORK_DIR/success/queue-verification.tsv" 'dynamic:event_live_update.'
assert_route_row "$WORK_DIR/success/public-verification.tsv" canonical /api/bet
assert_route_row "$WORK_DIR/success/public-verification.tsv" canonical /api/backoffice
assert_route_row "$WORK_DIR/success/public-verification.tsv" redirect /api/bet
assert_route_row "$WORK_DIR/success/public-verification.tsv" redirect /api/backoffice
assert_route_row "$WORK_DIR/success/public-verification.tsv" diagnostic /api/bet
assert_route_row "$WORK_DIR/success/public-verification.tsv" diagnostic /api/backoffice

echo 'oci_rollback_contract=PASS'
