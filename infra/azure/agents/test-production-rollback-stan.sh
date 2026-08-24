#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT_DIR/infra/azure/agents/rollback-application-stan.sh"
CAPTURE_SCRIPT="$ROOT_DIR/infra/azure/agents/baseline-capture-stan.sh"
REAL_LIVE_READINESS_SCRIPT="$ROOT_DIR/infra/azure/agents/live-betting-readiness-stan.sh"
REAL_ROLLBACK_READINESS_SCRIPT="$ROOT_DIR/infra/azure/agents/rollback-readiness-stan.sh"
WORKFLOW_FILE="$ROOT_DIR/.github/workflows/production-rollback.yml"
DEPLOY_WORKFLOW_FILE="$ROOT_DIR/.github/workflows/production-deploy.yml"
SAFE_PARENT="${BETSTAN_TEST_TMPDIR:-$ROOT_DIR/.test-workdirs}"
WORK_DIR="$SAFE_PARENT/production-rollback-stan-$$"
BIN_DIR="$WORK_DIR/bin"
FIXTURE_DIR="$WORK_DIR/fixtures"
STATE_DIR="$WORK_DIR/state"
TARGET_SHA=1111111111111111111111111111111111111111
CURRENT_MASTER_SHA=2222222222222222222222222222222222222222
SOURCE_RUN_ID=701
DEPLOY_RUN_ID=601
BUILD_RUN_ID=501
ARTIFACT_NAME="production-baseline-${SOURCE_RUN_ID}-1"
SERVICES=(auth bet backoffice client event moderation resulting slip gamemaster)

mkdir -p "$BIN_DIR" "$FIXTURE_DIR" "$STATE_DIR"
trap '[[ "${KEEP_TEST_WORKDIR:-0}" == "1" ]] || rm -rf "$WORK_DIR"' EXIT

fail() {
  printf 'production_rollback_tests=FAIL reason=%s\n' "$*" >&2
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

assert_regex() {
  local file="$1"
  local pattern="$2"
  grep -Eq "$pattern" "$file" || fail "missing regex '$pattern' in $file"
}

assert_route_row() {
  local file="$1"
  local host="$2"
  local path="$3"
  awk -F '\t' -v host="$host" -v path="$path" '$2 == host && $3 == path {found = 1} END {exit(found ? 0 : 1)}' "$file" ||
    fail "missing route evidence for ${host}${path} in $file"
}

assert_capture_route_row() {
  local file="$1"
  local host="$2"
  local path="$3"
  awk -F '\t' -v host="$host" -v path="$path" '$1 == host && $2 == path {found = 1} END {exit(found ? 0 : 1)}' "$file" ||
    fail "missing capture route evidence for ${host}${path} in $file"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
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

current_digest() {
  local base=$((100 + $(service_index "$1")))
  printf 'sha256:%064d\n' "$base"
}

target_image_ref() {
  local service="$1"
  printf 'fixture.invalid/%s:%s@%s\n' "$service" "$TARGET_SHA" "$(service_digest "$service")"
}

current_image_ref() {
  local service="$1"
  printf 'fixture.invalid/%s:%s@%s\n' "$service" "$CURRENT_MASTER_SHA" "$(current_digest "$service")"
}

create_baseline_fixture() {
  local directory="$1"
  local mode="${2:-good}"
  rm -rf "$directory"
  mkdir -p "$directory"
  : >"$directory/images.tsv"
  : >"$directory/deployments.tsv"
  : >"$directory/pod-images.tsv"
  for service in "${SERVICES[@]}"; do
    local digest image_ref
    digest="$(service_digest "$service")"
    image_ref="$(target_image_ref "$service")"
    if [[ "$mode" == "mutable" && "$service" == "event" ]]; then
      image_ref="fixture.invalid/${service}:${TARGET_SHA}"
    fi
    printf '%s\t%s\t%s\t%s\n' "$service" "fixture.invalid/${service}" "$image_ref" "$digest" >>"$directory/images.tsv"
    printf '%s\tgaming-%s-depl\tgaming-%s\tfixture.invalid/%s\t%s\t%s\t5\t1\t1\t1\t1\n' \
      "$service" "$service" "$service" "$service" "$image_ref" "$digest" >>"$directory/deployments.tsv"
    printf '%s\t%s-pod\tgaming-%s\ttrue\tdocker-pullable://fixture.invalid/%s@%s\n' \
      "$service" "$service" "$service" "$service" "$digest" >>"$directory/pod-images.tsv"
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
  cat >"$directory/public-http.tsv" <<'HTTP'
betstan.xyz	/	200	https://betstan.xyz/	text/html	html:fixture
www.betstan.xyz	/	200	https://www.betstan.xyz/	text/html	html:fixture
HTTP
  cat >"$directory/sse.tsv" <<'SSE'
betstan.xyz	200	https://betstan.xyz/api/event/stream	text/event-stream	fixture
www.betstan.xyz	200	https://www.betstan.xyz/api/event/stream	text/event-stream	fixture
SSE
  cat >"$directory/mongo-topology.json" <<'JSON'
{"data":{"mode":"shared","validated":"true","phase":"complete"}}
JSON
  cat >"$directory/mongo-lock.json" <<'JSON'
{"data":{"state":"released"}}
JSON
  cat >"$directory/migration-backup-references.tsv" <<'REFS'
state	shared	complete
REFS
  cat >"$directory/trusted-deploy-provenance.txt" <<EOF2
image_sha=$TARGET_SHA
upstream_run_id=$BUILD_RUN_ID
upstream_event=push
upstream_run_attempt=1
EOF2
  cat >"$directory/baseline-provenance.env" <<EOF2
baseline_source_sha=$TARGET_SHA
baseline_deploy_workflow=production-deploy
baseline_deploy_run_id=$DEPLOY_RUN_ID
baseline_deploy_run_attempt=1
baseline_deploy_status=completed
baseline_deploy_conclusion=success
baseline_deploy_url=https://example.invalid/runs/$DEPLOY_RUN_ID
baseline_build_workflow=production-build
baseline_build_run_id=$BUILD_RUN_ID
baseline_build_run_attempt=1
baseline_capture_run_id=$SOURCE_RUN_ID
baseline_capture_run_attempt=1
namespace=default
hosts=betstan.xyz,www.betstan.xyz
sse_path=/api/event/stream
database_restore=disabled
EOF2
  : >"$directory/SHA256SUMS"
  local file
  for file in \
    baseline-provenance.env images.tsv deployments.tsv pod-images.tsv queues.tsv \
    public-http.tsv sse.tsv mongo-topology.json mongo-lock.json \
    migration-backup-references.tsv trusted-deploy-provenance.txt; do
    printf '%s  %s\n' "$(sha256_file "$directory/$file")" "$file" >>"$directory/SHA256SUMS"
  done
}

create_deploy_provenance_fixture() {
  local directory="$1"
  rm -rf "$directory"
  mkdir -p "$directory"
  cp "$FIXTURE_DIR/baseline-good/images.tsv" "$directory/images.tsv"
  cat >"$directory/provenance.txt" <<EOF2
image_sha=$TARGET_SHA
upstream_run_id=$BUILD_RUN_ID
upstream_event=push
upstream_run_attempt=1
EOF2
}

reset_live_state() {
  rm -rf "$STATE_DIR/current"
  mkdir -p "$STATE_DIR/current"
  for service in "${SERVICES[@]}"; do
    cat >"$STATE_DIR/current/${service}.env" <<EOF2
image=$(current_image_ref "$service")
revision=9
EOF2
  done
}

set_target_state() {
  rm -rf "$STATE_DIR/current"
  mkdir -p "$STATE_DIR/current"
  for service in "${SERVICES[@]}"; do
    cat >"$STATE_DIR/current/${service}.env" <<EOF2
image=$(target_image_ref "$service")
revision=10
EOF2
  done
}

create_baseline_fixture "$FIXTURE_DIR/baseline-good"
create_baseline_fixture "$FIXTURE_DIR/baseline-mutable" mutable
create_deploy_provenance_fixture "$FIXTURE_DIR/deploy-provenance"
reset_live_state

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
  "rev-parse --show-toplevel")
    printf '%s\n' "$STUB_REPO_ROOT"
    ;;
  "rev-parse ${STUB_TARGET_SHA}^{commit}")
    printf '%s\n' "$STUB_TARGET_SHA"
    ;;
  "cat-file -e ${STUB_TARGET_SHA}^{commit}")
    exit 0
    ;;
  "merge-base --is-ancestor ${STUB_TARGET_SHA} ${STUB_CURRENT_MASTER_SHA}")
    exit 0
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
  "api repos/example/repo/actions/workflows/production-deploy.yml")
    printf '301\n'
    ;;
  "api repos/example/repo/actions/workflows/production-build.yml")
    printf '201\n'
    ;;
  "api repos/example/repo/actions/runs/${STUB_SOURCE_RUN_ID}/attempts/1")
    workflow_id=301
    [[ "${STUB_SOURCE_RUN_BAD_WORKFLOW:-0}" != "1" ]] || workflow_id=999
    jq -n --argjson workflow_id "$workflow_id" --arg recent "$recent" --arg head_sha "$STUB_CURRENT_MASTER_SHA" '{
      workflow_id:$workflow_id,
      path:".github/workflows/production-deploy.yml",
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
      workflow_id:301,
      path:".github/workflows/production-deploy.yml",
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
      workflow_id:201,
      path:".github/workflows/production-build.yml",
      event:"push",
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
  *)
    if [[ "${1:-} ${2:-}" == "run download" ]]; then
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
      elif [[ "$run_id" == "$STUB_DEPLOY_RUN_ID" && "$name" == "deploy-provenance-${STUB_DEPLOY_RUN_ID}-1" ]]; then
        cp -R "$STUB_DEPLOY_FIXTURE"/. "$dir"/
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

mongo_uri_for_service() {
  case "$1" in
    auth) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_auth' ;;
    bet) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_bet' ;;
    backoffice) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_backoffice' ;;
    client) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_client' ;;
    event) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_event' ;;
    gamemaster) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_gamemaster' ;;
    moderation) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_moderation' ;;
    resulting) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_resulting' ;;
    slip) printf 'mongodb://gaming-shared-mongo-srv:27017/gaming_slip' ;;
    *) printf 'mongodb://gaming-shared-mongo-srv:27017/%s' "$1" ;;
  esac
}

pod_image_id() {
  local service="$1"
  read_state "$service"
  local digest="${image##*@}"
  if [[ -z "${MODE:-}" && "${STUB_BAD_DIGEST_SERVICE:-}" == "$service" ]]; then
    digest='sha256:9999999999999999999999999999999999999999999999999999999999999999'
  fi
  printf 'docker-pullable://fixture.invalid/%s@%s' "$service" "$digest"
}

deployment_json() {
  local service="$1"
  read_state "$service"
  jq -n \
    --arg deployment "gaming-${service}-depl" \
    --arg container "gaming-${service}" \
    --arg image "$image" \
    --arg revision "$revision" \
    --arg mongo_uri "$(mongo_uri_for_service "$service")" \
    --arg flag_value "${STUB_FLAG_VALUE:-false}" '
    {
      metadata:{
        name:$deployment,
        generation:7,
        annotations:{"deployment.kubernetes.io/revision":$revision}
      },
      spec:{
        replicas:1,
        template:{
          spec:{
            containers:[
              {
                name:$container,
                image:$image,
                env:([
                  {name:"MONGO_URI",value:$mongo_uri}
                ] + (if $container == "gaming-gamemaster" then [{name:"LIVE_KICKOFFS_ENABLED",value:$flag_value}] else [] end))
              }
            ]
          }
        }
      },
      status:{
        observedGeneration:7,
        readyReplicas:1,
        availableReplicas:1,
        updatedReplicas:1
      }
    }'
}

print_all_deployments_json() {
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
    env.append({"name": "MONGO_URI", "value": f"mongodb://gaming-shared-mongo-srv:27017/gaming_{service}" if service != "backoffice" else "mongodb://gaming-shared-mongo-srv:27017/gaming_backoffice"})
    if service == "gamemaster":
        env.append({"name": "LIVE_KICKOFFS_ENABLED", "value": flag_value})
    items.append({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": f"gaming-{service}-depl",
            "generation": 7,
            "annotations": {"deployment.kubernetes.io/revision": fields.get("revision", "0")},
        },
        "spec": {
            "replicas": 1,
            "template": {
                "spec": {
                    "containers": [{"name": f"gaming-{service}", "image": fields.get("image", ""), "env": env}]
                }
            },
        },
        "status": {"observedGeneration": 7, "readyReplicas": 1, "availableReplicas": 1, "updatedReplicas": 1},
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

print_all_statefulsets_json() {
  cat <<'EOF_JSON'
{"items":[{"metadata":{"name":"gaming-auth-mongo-depl"},"spec":{"replicas":1},"status":{"readyReplicas":1,"replicas":1,"currentReplicas":1}}]}
EOF_JSON
}

print_all_pods_json() {
  python3 - "$STUB_STATE_DIR" "${STUB_BAD_DIGEST_SERVICE:-}" "${MODE:-}" <<'PY'
import json
import sys
from pathlib import Path

state_dir = Path(sys.argv[1])
bad_service = sys.argv[2]
mode = sys.argv[3]
services = ["auth", "bet", "backoffice", "client", "event", "gamemaster", "moderation", "resulting", "slip"]
items = []
for service in services:
    fields = {}
    for line in (state_dir / f"{service}.env").read_text(encoding="utf-8").splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            fields[key] = value
    digest = fields.get("image", "").split("@", 1)[1]
    if not mode and service == bad_service:
        digest = "sha256:" + ("9" * 64)
    items.append({
        "metadata": {"name": f"gaming-{service}-pod-0", "labels": {"app": f"gaming-{service}"}},
        "status": {"containerStatuses": [{"name": f"gaming-{service}", "ready": True, "imageID": f"docker-pullable://fixture.invalid/{service}@{digest}"}]},
    })
items.append({
    "metadata": {"name": "rabbitmq-0", "labels": {"app": "gaming-rabbitmq"}},
    "status": {"containerStatuses": [{"name": "gaming-rabbitmq", "ready": True, "imageID": "docker-pullable://fixture.invalid/rabbitmq@sha256:" + ("f" * 64)}]},
})
items.append({
    "metadata": {"name": "auth-mongo-0", "labels": {"app": "gaming-auth-mongo"}},
    "status": {"containerStatuses": [{"name": "gaming-auth-mongo", "ready": True, "imageID": "docker-pullable://fixture.invalid/mongo@sha256:" + ("e" * 64)}]},
})
print(json.dumps({"items": items}))
PY
}

deployment_rows() {
  local row_type="$1"
  local service
  for service in "${services[@]}"; do
    if [[ "$row_type" == ready ]]; then
      printf 'gaming-%s-depl\t1\t1\n' "$service"
    elif [[ "$row_type" == names ]]; then
      printf 'gaming-%s-depl\n' "$service"
    elif [[ "$row_type" == images ]]; then
      read_state "$service"
      printf 'gaming-%s-depl\t%s \n' "$service" "$image"
    fi
  done
  if [[ "$row_type" == ready ]]; then
    printf 'gaming-rabbitmq-depl\t1\t1\n'
  elif [[ "$row_type" == names ]]; then
    printf 'gaming-rabbitmq-depl\n'
  elif [[ "$row_type" == images ]]; then
    printf 'gaming-rabbitmq-depl\tdocker.io/library/rabbitmq@sha256:%064d \n' 15
  fi
}

statefulset_rows() {
  printf 'gaming-auth-mongo-depl\t1\t1\n'
}

pod_selector_json() {
  local selector="$1"
  local service="${selector#app=gaming-}"
  jq -n --arg service "$service" --arg image_id "$(pod_image_id "$service")" '{
    items:[{metadata:{name:($service + "-pod-0")},status:{containerStatuses:[{name:("gaming-" + $service),ready:true,imageID:$image_id}]}}]
  }'
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
        output_mode="json"
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        service="$(service_from_deployment "$deployment")"
        if [[ "$output_mode" == "json" ]]; then
          deployment_json "$service"
        elif [[ "$output_mode" == jsonpath=* ]]; then
          case "$output_mode" in
            "jsonpath={.metadata.generation}|{.status.observedGeneration}|{.spec.replicas}|{.status.updatedReplicas}|{.status.readyReplicas}|{.status.availableReplicas}")
              printf '7|7|1|1|1|1'
              ;;
            *)
              printf 'unexpected deployment jsonpath: %s\n' "$output_mode" >&2
              exit 1
              ;;
          esac
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
            print_all_deployments_json
            ;;
          "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{.status.readyReplicas}{\"\\t\"}{.status.replicas}{\"\\n\"}{end}")
            deployment_rows ready
            ;;
          "jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}")
            deployment_rows names
            ;;
          "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{range .spec.template.spec.containers[*]}{.image}{\" \"}{end}{\"\\n\"}{end}")
            deployment_rows images
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
          print_all_deployments_json
        else
          printf 'unexpected kubectl get deploy,sts output: %s\n' "$output_mode" >&2
          exit 1
        fi
        ;;
      statefulset)
        statefulset_name="$2"
        shift 2
        output_mode=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        case "$statefulset_name:$output_mode" in
          "gaming-auth-mongo-depl:jsonpath={.spec.replicas}|{.status.readyReplicas}|{.status.currentReplicas}")
            printf '1|1|1'
            ;;
          gaming-*-mongo-depl:)
            exit 1
            ;;
          *)
            printf 'unexpected kubectl get statefulset request: %s %s\n' "$statefulset_name" "$output_mode" >&2
            exit 1
            ;;
        esac
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
            print_all_statefulsets_json
            ;;
          "jsonpath={range .items[*]}{.metadata.name}{\"\\t\"}{.status.readyReplicas}{\"\\t\"}{.status.replicas}{\"\\n\"}{end}")
            statefulset_rows
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
          case "$output_mode" in
            *)
              if [[ "$selector" == "app=gaming-auth" ]]; then
                printf 'gaming-auth-pod-0|Running|True|%s\n' "$(current_image_ref auth)"
              else
                printf 'unexpected pods jsonpath selector: %s\n' "$selector" >&2
                exit 1
              fi
              ;;
          esac
        elif [[ -n "$selector" ]]; then
          pod_selector_json "$selector"
        else
          print_all_pods_json
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
      pvc)
        shift
        pvc_name=""
        if [[ $# -gt 0 && "$1" != -* ]]; then
          pvc_name="$1"
          shift
        fi
        output_mode=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        case "$pvc_name:$output_mode" in
          "gaming-auth-mongo-data-gaming-auth-mongo-depl-0:jsonpath={.status.phase}")
            printf 'Bound'
            ;;
          "gaming-auth-mongo-data-gaming-auth-mongo-depl-0:jsonpath={.status.capacity.storage}")
            printf '16Gi'
            ;;
          ":jsonpath={range .items[*]}{.metadata.name}{\"\\n\"}{end}")
            printf 'gaming-auth-mongo-data-gaming-auth-mongo-depl-0\n'
            ;;
          *)
            printf 'unexpected pvc request: %s %s\n' "$pvc_name" "$output_mode" >&2
            exit 1
            ;;
        esac
        ;;
      service)
        service_name="$2"
        shift 2
        output_mode=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        case "$service_name:$output_mode" in
          "gaming-shared-mongo-srv:jsonpath={.spec.selector.app}")
            printf 'gaming-auth-mongo'
            ;;
          *)
            printf 'unexpected service request: %s %s\n' "$service_name" "$output_mode" >&2
            exit 1
            ;;
        esac
        ;;
      configmap)
        name="$2"
        shift 2
        output_mode=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            -n) shift 2 ;;
            -o) output_mode="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        case "$name:$output_mode" in
          "gaming-mongo-topology:json")
            jq -n --arg mode "${STUB_TOPOLOGY_MODE:-legacy}" --arg phase "${STUB_TOPOLOGY_PHASE:-complete}" --arg source_sha "$STUB_TARGET_SHA" '{
              data:{mode:$mode,validated:"true",phase:$phase,"migration-id":"fixture-migration","source-sha":$source_sha}
            }'
            ;;
          "gaming-mongo-topology:jsonpath={.data.mode}|{.data.phase}|{.data.migration-id}|{.data.source-sha}")
            printf '%s|%s|fixture-migration|%s' "${STUB_TOPOLOGY_MODE:-legacy}" "${STUB_TOPOLOGY_PHASE:-complete}" "$STUB_TARGET_SHA"
            ;;
          "gaming-mongo-topology:jsonpath={.data.mode}")
            printf '%s' "${STUB_TOPOLOGY_MODE:-legacy}"
            ;;
          "gaming-mongo-topology:jsonpath={.data.validated}")
            printf 'true'
            ;;
          "gaming-mongo-topology:jsonpath={.data.migration-id}")
            printf 'fixture-migration'
            ;;
          "gaming-mongo-migration-lock:json")
            printf '{"data":{"state":"released"}}\n'
            ;;
          "gaming-mongo-migration-lock:jsonpath={.data.state}")
            printf 'released'
            ;;
          *)
            printf 'unexpected configmap request: %s %s\n' "$name" "$output_mode" >&2
            exit 1
            ;;
        esac
        ;;
      nodes)
        printf 'aks-node-0 Ready agent\n'
        ;;
      *)
        printf 'unexpected kubectl get: %s\n' "$*" >&2
        exit 1
        ;;
    esac
    ;;
  exec)
    shift
    if [[ "$*" == *"rabbitmqctl list_queues"* &&
        "$*" == *"name messages_ready messages_unacknowledged consumers"* ]]; then
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
    printf 'image=%s\nrevision=10\n' "$image" >"$(state_file "$service")"
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
        service="$(service_from_deployment "$deployment")"
        revisions="${STUB_ROLLOUT_REVISIONS:-2}"
        printf 'REVISION  CHANGE-CAUSE\n'
        if [[ "$revisions" -ge 1 ]]; then
          printf '1         deploy\n'
        fi
        if [[ "$revisions" -ge 2 ]]; then
          printf '2         rollback\n'
        fi
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
    --header) shift 2 ;;
    --location|--silent|--show-error) shift ;;
    *) url="$1"; shift ;;
  esac
done
status='200'
content_type='application/json'
body='{}'
header_block=''
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
case "$url" in
  */api/auth/currentuser)
    content_type='application/json'
    body='{"currentUser":null}'
    ;;
  */api/event)
    content_type='application/json'
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
    ;;
  */api/slip)
    content_type='application/json'
    body='{}'
    ;;
  */api/bet)
    content_type='application/json'
    body='{}'
    ;;
  */api/bet/stats)
    content_type='application/json'
    body='[]'
    ;;
  */api/backoffice)
    content_type='application/json'
    body='[]'
    ;;
  */api/event/stream)
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
        curl_exit=28
        time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
        ;;
      quiet-timeout)
        content_type='text/event-stream'
        body=''
        curl_exit=28
        time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
        ;;
      headers-only-eof)
        content_type='text/event-stream'
        body=''
        time_total='0'
        ;;
      headers-only-exact-window-eof)
        content_type='text/event-stream'
        body=''
        time_total="$(format_exact_window_integer_duration "${max_time:-1}")"
        ;;
      headers-only-exact-window-decimal-eof)
        content_type='text/event-stream'
        body=''
        time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
        ;;
      headers-only-plus-window-eof)
        content_type='text/event-stream'
        body=''
        time_total="$(format_shifted_window_duration "${max_time:-1}" 0.002)"
        ;;
      headers-only-under-window-eof)
        content_type='text/event-stream'
        body=''
        time_total="$(format_shifted_window_duration "${max_time:-1}" -0.002)"
        ;;
      heartbeat-eof)
        content_type='text/event-stream'
        body=': heartbeat\n\n'
        time_total='0'
        ;;
      heartbeat-under-window-eof)
        content_type='text/event-stream'
        body=': heartbeat\n\n'
        time_total="$(format_shifted_window_duration "${max_time:-1}" -0.002)"
        ;;
      bad-headers)
        content_type='application/json'
        body='{}'
        time_total='0.01'
        ;;
      bad-status)
        status='503'
        content_type='text/event-stream'
        body=''
        time_total='0.01'
        ;;
      connect-timeout)
        status='000'
        content_type=''
        body=''
        curl_exit=28
        time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
        ;;
      malformed)
        content_type='text/event-stream'
        body='{"unexpected":true}\n'
        curl_exit=28
        time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
        ;;
      *)
        content_type='text/event-stream'
        body=': heartbeat\n\n'
        curl_exit=28
        time_total="$(format_shifted_window_duration "${max_time:-1}" 0)"
        ;;
    esac
    ;;
  */)
    content_type='text/html'
    body='<html>BetStan</html>'
    ;;
  *)
    content_type='application/json'
    body='{}'
    ;;
esac
if [[ -z "$header_block" && "$status" != "000" ]]; then
  header_block="$(printf 'HTTP/1.1 %s OK\r\nContent-Type: %s\r\nCache-Control: no-cache, no-transform\r\nX-Accel-Buffering: no\r\n\r\n' "$status" "$content_type")"
fi
if [[ -n "${STUB_CURL_TRACE_FILE:-}" && "$url" == *'/api/event/stream' ]]; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$url" "$max_time" "$sse_mode" "$curl_exit" "$status" "$time_total" \
    >>"$STUB_CURL_TRACE_FILE"
fi
printf '%s' "$header_block" >"$headers"
printf '%b' "$body" >"$output"
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

cat >"$BIN_DIR/provenance-stub.sh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\tcompleted\tsuccess\thttps://example.invalid/runs/%s\n' "$STUB_DEPLOY_RUN_ID" "$STUB_DEPLOY_RUN_ID"
STUB
chmod +x "$BIN_DIR/provenance-stub.sh"

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
  "STUB_STATE_DIR=$STATE_DIR/current"
  "STUB_KUBECTL_LOG=$WORK_DIR/kubectl.log"
  "STUB_DEPLOY_FIXTURE=$FIXTURE_DIR/deploy-provenance"
  "STUB_REPO_ROOT=$ROOT_DIR"
  "STUB_TOPOLOGY_MODE=shared"
  "LIVE_BETTING_READINESS_SCRIPT=$REAL_LIVE_READINESS_SCRIPT"
  "ROLLBACK_READINESS_SCRIPT=$REAL_ROLLBACK_READINESS_SCRIPT"
  "PROVENANCE_SCRIPT=$BIN_DIR/provenance-stub.sh"
)

run_script() {
  local output_dir="$1"
  shift
  rm -rf "$output_dir"
  rm -f "$WORK_DIR/kubectl.log"
  env -i HOME="$HOME" "${common_env[@]}" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-good" \
    STUB_CURL_TRACE_FILE="$output_dir/curl-trace.tsv" \
    LIVE_BETTING_SSE_PROBE_TRACE_FILE="$output_dir/sse-probe-trace.tsv" \
    LIVE_BETTING_SSE_VALIDATION_TRACE_FILE="$output_dir/sse-validation-trace.tsv" \
    OUTPUT_DIR="$output_dir" TARGET_SHA="$TARGET_SHA" \
    BASELINE_SOURCE_RUN_ID="$SOURCE_RUN_ID" \
    BASELINE_SOURCE_RUN_ATTEMPT=1 \
    BASELINE_ARTIFACT_NAME="$ARTIFACT_NAME" \
    HOSTS='betstan.xyz,www.betstan.xyz' \
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
  set_target_state
  env -i HOME="$HOME" "${common_env[@]}" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-good" \
    STUB_CURL_TRACE_FILE="$output_dir/curl-trace.tsv" \
    LIVE_BETTING_SSE_PROBE_TRACE_FILE="$output_dir/sse-probe-trace.tsv" \
    LIVE_BETTING_SSE_VALIDATION_TRACE_FILE="$output_dir/sse-validation-trace.tsv" \
    OUTPUT_DIR="$output_dir" \
    HOSTS='betstan.xyz,www.betstan.xyz' \
    REPO=example/repo \
    PROVENANCE_SCRIPT="$BIN_DIR/provenance-stub.sh" \
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
puts 'azure_rollback_yaml=PASS'
RUBY

assert_contains "$WORKFLOW_FILE" 'CONFIRMATION: ${{ inputs.confirmation }}'
assert_contains \
  "$WORKFLOW_FILE" \
  '[ "$CONFIRMATION" = "ROLLBACK PRODUCTION EXACT DIGEST" ]'
if grep -Fq '[ "${{ inputs.confirmation }}"' "$WORKFLOW_FILE"; then
  fail "rollback workflow interpolates the confirmation directly in shell"
fi

bash -n "$CAPTURE_SCRIPT" "$SCRIPT"

action_lines=(
  'uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2'
  'uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2'
  'uses: azure/login@a457da9ea143d694b1b9c7c869ebb04ebe844ef5 # v2.3.0'
  'uses: azure/aks-set-context@c7eb093e5a5d47caa333f64974d5fd1cd4bf069d # v4.0.3'
)
for pattern in "${action_lines[@]}"; do
  assert_contains "$DEPLOY_WORKFLOW_FILE" "$pattern"
  assert_contains "$WORKFLOW_FILE" "$pattern"
done

repeat_capture_dir="$WORK_DIR/capture-repeat-safe"
if ! run_capture "$repeat_capture_dir" STUB_SHORT_SSE_MODE=quiet-timeout >"$WORK_DIR/capture-repeat-safe-1.out" 2>&1; then
  cat "$WORK_DIR/capture-repeat-safe-1.out" >&2
  fail 'repeat-safe quiet SSE capture unexpectedly failed on first run'
fi
if ! run_capture "$repeat_capture_dir" STUB_SHORT_SSE_MODE=quiet-timeout >"$WORK_DIR/capture-repeat-safe-2.out" 2>&1; then
  cat "$WORK_DIR/capture-repeat-safe-2.out" >&2
  fail 'repeat-safe quiet SSE capture unexpectedly failed on second run'
fi
assert_contains "$WORK_DIR/capture-repeat-safe-2.out" 'baseline_capture=PASS'
assert_contains "$repeat_capture_dir/sse.tsv" $'betstan.xyz\t200\thttps://betstan.xyz/api/event/stream\ttext/event-stream'
assert_line "$repeat_capture_dir/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\tquiet-timeout\t28\t200\t5.000000'
assert_line "$repeat_capture_dir/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t28\t200\t5.000000\t5'
assert_line "$repeat_capture_dir/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t28\t200\t5.000000\t5000\t5\t5000\t1\t0\ttrue'
[[ ! -d "$repeat_capture_dir/.workdirs" ]] || fail 'repeat-safe capture left Azure workdirs behind'

if ! run_capture "$WORK_DIR/capture-exact-window-eof" STUB_SHORT_SSE_MODE=headers-only-exact-window-eof >"$WORK_DIR/capture-exact-window-eof.out" 2>&1; then
  cat "$WORK_DIR/capture-exact-window-eof.out" >&2
  fail 'exact-window EOF SSE capture unexpectedly failed'
fi
assert_contains "$WORK_DIR/capture-exact-window-eof.out" 'baseline_capture=PASS'
assert_line "$WORK_DIR/capture-exact-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-exact-window-eof\t0\t200\t5'
assert_line "$WORK_DIR/capture-exact-window-eof/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5\t5'
assert_line "$WORK_DIR/capture-exact-window-eof/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5\t5000\t5\t5000\t1\t0\ttrue'

if ! run_capture "$WORK_DIR/capture-exact-window-decimal-eof" STUB_SHORT_SSE_MODE=headers-only-exact-window-decimal-eof >"$WORK_DIR/capture-exact-window-decimal-eof.out" 2>&1; then
  cat "$WORK_DIR/capture-exact-window-decimal-eof.out" >&2
  fail 'exact-window decimal EOF SSE capture unexpectedly failed'
fi
assert_contains "$WORK_DIR/capture-exact-window-decimal-eof.out" 'baseline_capture=PASS'
assert_line "$WORK_DIR/capture-exact-window-decimal-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-exact-window-decimal-eof\t0\t200\t5.000000'
assert_line "$WORK_DIR/capture-exact-window-decimal-eof/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5.000000\t5'
assert_line "$WORK_DIR/capture-exact-window-decimal-eof/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5.000000\t5000\t5\t5000\t1\t0\ttrue'

if ! run_capture "$WORK_DIR/capture-plus-window-eof" STUB_SHORT_SSE_MODE=headers-only-plus-window-eof >"$WORK_DIR/capture-plus-window-eof.out" 2>&1; then
  cat "$WORK_DIR/capture-plus-window-eof.out" >&2
  fail 'plus-window EOF SSE capture unexpectedly failed'
fi
assert_contains "$WORK_DIR/capture-plus-window-eof.out" 'baseline_capture=PASS'
assert_line "$WORK_DIR/capture-plus-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-plus-window-eof\t0\t200\t5.002000'
assert_line "$WORK_DIR/capture-plus-window-eof/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5.002000\t5'
assert_line "$WORK_DIR/capture-plus-window-eof/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5.002000\t5002\t5\t5000\t1\t0\ttrue'

if ! run_capture "$WORK_DIR/capture-heartbeat-timeout" STUB_SHORT_SSE_MODE=heartbeat-timeout >"$WORK_DIR/capture-heartbeat-timeout.out" 2>&1; then
  cat "$WORK_DIR/capture-heartbeat-timeout.out" >&2
  fail 'heartbeat-timeout SSE capture unexpectedly failed'
fi
assert_contains "$WORK_DIR/capture-heartbeat-timeout.out" 'baseline_capture=PASS'
assert_line "$WORK_DIR/capture-heartbeat-timeout/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theartbeat-timeout\t28\t200\t5.000000'
assert_line "$WORK_DIR/capture-heartbeat-timeout/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t28\t200\t5.000000\t5'
assert_line "$WORK_DIR/capture-heartbeat-timeout/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t28\t200\t5.000000\t5000\t5\t5000\t1\t1\ttrue'

run_capture_expect_failure capture-sse-under-window-eof \
  STUB_SHORT_SSE_MODE=headers-only-under-window-eof
assert_contains "$WORK_DIR/capture-sse-under-window-eof.out" 'SSE connectivity contract failed for betstan.xyz/api/event/stream'
assert_line "$WORK_DIR/capture-sse-under-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-under-window-eof\t0\t200\t4.998000'
assert_line "$WORK_DIR/capture-sse-under-window-eof/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t4.998000\t5'
assert_line "$WORK_DIR/capture-sse-under-window-eof/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t4.998000\t4998\t5\t5000\t1\t0\tfalse'

run_capture_expect_failure capture-sse-headers-only-eof \
  STUB_SHORT_SSE_MODE=headers-only-eof
assert_contains "$WORK_DIR/capture-sse-headers-only-eof.out" 'SSE connectivity contract failed for betstan.xyz/api/event/stream'
assert_line "$WORK_DIR/capture-sse-headers-only-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-eof\t0\t200\t0'
assert_line "$WORK_DIR/capture-sse-headers-only-eof/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t0\t5'
assert_line "$WORK_DIR/capture-sse-headers-only-eof/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t0\t0\t5\t5000\t1\t0\tfalse'

run_capture_expect_failure capture-sse-heartbeat-under-window-eof \
  STUB_SHORT_SSE_MODE=heartbeat-under-window-eof
assert_contains "$WORK_DIR/capture-sse-heartbeat-under-window-eof.out" 'SSE connectivity contract failed for betstan.xyz/api/event/stream'
assert_line "$WORK_DIR/capture-sse-heartbeat-under-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theartbeat-under-window-eof\t0\t200\t4.998000'
assert_line "$WORK_DIR/capture-sse-heartbeat-under-window-eof/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t4.998000\t5'
assert_line "$WORK_DIR/capture-sse-heartbeat-under-window-eof/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t4.998000\t4998\t5\t5000\t1\t1\tfalse'

run_capture_expect_failure capture-sse-heartbeat-eof \
  STUB_SHORT_SSE_MODE=heartbeat-eof
assert_contains "$WORK_DIR/capture-sse-heartbeat-eof.out" 'SSE connectivity contract failed for betstan.xyz/api/event/stream'

run_capture_expect_failure capture-sse-bad-status \
  STUB_SHORT_SSE_MODE=bad-status
assert_contains "$WORK_DIR/capture-sse-bad-status.out" 'SSE connectivity contract failed for betstan.xyz/api/event/stream'

run_capture_expect_failure capture-sse-malformed \
  STUB_SHORT_SSE_MODE=malformed
assert_contains "$WORK_DIR/capture-sse-malformed.out" 'SSE connectivity contract failed for betstan.xyz/api/event/stream'

run_capture_expect_failure capture-sse-timeout \
  STUB_SHORT_SSE_MODE=connect-timeout
assert_contains "$WORK_DIR/capture-sse-timeout.out" 'SSE connectivity contract failed for betstan.xyz/api/event/stream'

azure_cleanup_sentinel="$ROOT_DIR/infra/azure/agents/.cleanup-sentinel-$$"
printf 'protected\n' >"$azure_cleanup_sentinel"
azure_cleanup_before="$(sha256_file "$azure_cleanup_sentinel")"
if env -i HOME="$HOME" "${common_env[@]}" \
    OUTPUT_DIR="$ROOT_DIR/.test-workdirs/../infra/azure/agents" \
    HOSTS='betstan.xyz,www.betstan.xyz' \
    "$CAPTURE_SCRIPT" >"$WORK_DIR/capture-cleanup-traversal.out" 2>&1; then
  fail 'Azure cleanup traversal guard unexpectedly passed'
fi
[[ "$(sha256_file "$azure_cleanup_sentinel")" == "$azure_cleanup_before" ]] ||
  fail 'Azure cleanup traversal guard modified the sentinel'
assert_contains "$WORK_DIR/capture-cleanup-traversal.out" 'unsafe private directory'
ln -sfn "$ROOT_DIR/infra/azure/agents" "$WORK_DIR/azure-cleanup-link"
if env -i HOME="$HOME" "${common_env[@]}" \
    OUTPUT_DIR="$WORK_DIR/azure-cleanup-link" \
    HOSTS='betstan.xyz,www.betstan.xyz' \
    "$CAPTURE_SCRIPT" >"$WORK_DIR/capture-cleanup-symlink.out" 2>&1; then
  fail 'Azure cleanup symlink guard unexpectedly passed'
fi
[[ "$(sha256_file "$azure_cleanup_sentinel")" == "$azure_cleanup_before" ]] ||
  fail 'Azure cleanup symlink guard modified the sentinel'
assert_contains "$WORK_DIR/capture-cleanup-symlink.out" 'unsafe private directory'
rm -f "$azure_cleanup_sentinel"

run_expect_failure provenance-rejection \
  STUB_SOURCE_RUN_BAD_WORKFLOW=1 ROLLBACK_MODE=dry-run

run_expect_failure checksum-mismatch \
  STUB_TAMPER_FILE=images.tsv ROLLBACK_MODE=dry-run

if env -i HOME="$HOME" "${common_env[@]}" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-mutable" \
    OUTPUT_DIR="$WORK_DIR/mutable-rejection" TARGET_SHA="$TARGET_SHA" \
    BASELINE_SOURCE_RUN_ID="$SOURCE_RUN_ID" BASELINE_SOURCE_RUN_ATTEMPT=1 \
    BASELINE_ARTIFACT_NAME="$ARTIFACT_NAME" HOSTS='betstan.xyz,www.betstan.xyz' \
    ROLLBACK_MODE=dry-run "$SCRIPT" >"$WORK_DIR/mutable-rejection.out" 2>&1; then
  fail 'mutable image artifact unexpectedly passed'
fi
assert_contains "$WORK_DIR/mutable-rejection.out" 'repo:<40sha>@sha256:<64>'

run_expect_failure expired-artifact \
  STUB_ARTIFACT_EXPIRED=1 ROLLBACK_MODE=dry-run

run_expect_failure active-live-refusal \
  STUB_ACTIVE_MATCHES=1 ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/active-live-refusal.out" 'live-aware rollback drain gate rejected the rollback'

run_expect_failure draft-live-refusal \
  STUB_DRAFT_LIVE_SLIPS=1 ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/draft-live-refusal.out" 'live-aware rollback drain gate rejected the rollback'

run_expect_failure rollback-readiness-prematch-live-only \
  STUB_EVENT_MODE=live-only ROLLBACK_MODE=dry-run
assert_contains "$WORK_DIR/rollback-readiness-prematch-live-only.out" 'shared-Mongo rollback readiness rejected the rollback'
assert_contains "$WORK_DIR/rollback-readiness-prematch-live-only/rollback-readiness/summary.env" 'rollback_readiness=NO_GO'
assert_contains "$WORK_DIR/rollback-readiness-prematch-live-only/rollback-readiness/failures.txt" 'path=/api/event'

migration_backup_dir="$(cd "$ROOT_DIR/.." && pwd)/.azure-migration-backups-$$"
mkdir -p "$migration_backup_dir"
chmod 700 "$migration_backup_dir"
reset_live_state
run_expect_failure migration-transition-block \
  STUB_TOPOLOGY_MODE=transition STUB_TOPOLOGY_PHASE=backing-up \
  MIGRATION_ID=fixture-migration MIGRATION_BACKUP_DIR="$migration_backup_dir" \
  ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/migration-transition-block.out" 'do not roll application images'
assert_contains "$WORK_DIR/migration-transition-block.out" 'infra/azure/agents/consolidate-production-mongo-stan.sh'
assert_contains "$WORK_DIR/migration-transition-block/rollback-readiness/summary.env" 'mode=migration-transition'
[[ ! -s "$WORK_DIR/kubectl.log" ]] || fail 'Azure migration-transition guard should prevent image mutation'
rm -rf "$migration_backup_dir"

reset_live_state
run_expect_failure queue-growth-refusal \
  STUB_BASELINE_QUEUE_READY_AFTER_ROLLBACK=1 ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/queue-growth-refusal.out" 'RabbitMQ verification failed after gaming-auth-depl'
assert_contains "$WORK_DIR/queue-growth-refusal/queue-thresholds.env" 'max_post_rollback_queue_ready_growth=0'

reset_live_state
run_expect_failure queue-unack-threshold-refusal \
  STUB_BASELINE_QUEUE_UNACK_AFTER_ROLLBACK=6 ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/queue-unack-threshold-refusal.out" 'RabbitMQ verification failed after gaming-auth-depl'
assert_contains "$WORK_DIR/queue-unack-threshold-refusal/queue-thresholds.env" 'max_post_rollback_queue_unack=5'

reset_live_state
run_expect_failure dynamic-queue-missing-refusal \
  STUB_DROP_DYNAMIC_QUEUE_AFTER_ROLLBACK=1 ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/dynamic-queue-missing-refusal.out" 'missing dynamic topology'

reset_live_state
run_expect_failure dynamic-queue-zero-consumers \
  STUB_DYNAMIC_QUEUE_CONSUMERS_AFTER_ROLLBACK=0 ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/dynamic-queue-zero-consumers.out" 'consumers 0 below required'

reset_live_state
run_expect_failure partial-failure \
  STUB_FAIL_SERVICE=event ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/partial-failure.out" 'rollout did not complete for gaming-event-depl'
assert_contains "$WORK_DIR/partial-failure/partial-state.tsv" $'event\t'

reset_live_state
run_expect_failure post-rollback-prematch-refusal \
  STUB_EVENT_MODE_AFTER_ROLLBACK=live-only ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/post-rollback-prematch-refusal.out" 'invalid legacy PRE_MATCH event payload for betstan.xyz'
[[ "$(wc -l <"$WORK_DIR/post-rollback-prematch-refusal/rollout-order.tsv" | tr -d ' ')" == '1' ]] ||
  fail 'post-rollback prematch refusal should stop after the first deployment'

reset_live_state
run_expect_failure sse-under-window-eof-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=headers-only-under-window-eof ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-under-window-eof-refusal.out" 'SSE verification failed for betstan.xyz after gaming-auth-depl'
assert_line "$WORK_DIR/sse-under-window-eof-refusal/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-under-window-eof\t0\t200\t4.998000'
assert_line "$WORK_DIR/sse-under-window-eof-refusal/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t4.998000\t5'
assert_line "$WORK_DIR/sse-under-window-eof-refusal/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t4.998000\t4998\t5\t5000\t1\t0\tfalse'

reset_live_state
run_expect_failure sse-headers-only-eof-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=headers-only-eof ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-headers-only-eof-refusal.out" 'SSE verification failed for betstan.xyz after gaming-auth-depl'
assert_line "$WORK_DIR/sse-headers-only-eof-refusal/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-eof\t0\t200\t0'
assert_line "$WORK_DIR/sse-headers-only-eof-refusal/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t0\t5'
assert_line "$WORK_DIR/sse-headers-only-eof-refusal/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t0\t0\t5\t5000\t1\t0\tfalse'

reset_live_state
run_expect_failure sse-heartbeat-under-window-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=heartbeat-under-window-eof ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-heartbeat-under-window-refusal.out" 'SSE verification failed for betstan.xyz after gaming-auth-depl'
assert_line "$WORK_DIR/sse-heartbeat-under-window-refusal/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theartbeat-under-window-eof\t0\t200\t4.998000'
assert_line "$WORK_DIR/sse-heartbeat-under-window-refusal/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t4.998000\t5'
assert_line "$WORK_DIR/sse-heartbeat-under-window-refusal/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t4.998000\t4998\t5\t5000\t1\t1\tfalse'

reset_live_state
run_expect_failure sse-heartbeat-eof-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=heartbeat-eof ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-heartbeat-eof-refusal.out" 'SSE verification failed for betstan.xyz after gaming-auth-depl'

reset_live_state
run_expect_failure sse-content-type-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=bad-headers ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-content-type-refusal.out" 'SSE verification failed for betstan.xyz after gaming-auth-depl'

reset_live_state
run_expect_failure sse-malformed-refusal \
  STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=malformed ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/sse-malformed-refusal.out" 'SSE verification failed for betstan.xyz after gaming-auth-depl'

reset_live_state
run_expect_failure exact-digest-verification \
  STUB_BAD_DIGEST_SERVICE=event ROLLBACK_MODE=execute
assert_contains "$WORK_DIR/exact-digest-verification.out" 'does not serve the expected digest'

reset_live_state
if ! run_script "$WORK_DIR/success-exact-window-eof" \
    STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK=event_live_update.rolled-pod \
    STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=headers-only-exact-window-eof \
    ROLLBACK_MODE=execute >"$WORK_DIR/success-exact-window-eof.out" 2>&1; then
  cat "$WORK_DIR/success-exact-window-eof.out" >&2
  fail 'exact-window EOF SSE success fixture unexpectedly failed'
fi
assert_contains "$WORK_DIR/success-exact-window-eof.out" 'rollback_status=PASS'
assert_line "$WORK_DIR/success-exact-window-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-exact-window-eof\t0\t200\t5'
assert_line "$WORK_DIR/success-exact-window-eof/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5\t5'
assert_line "$WORK_DIR/success-exact-window-eof/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5\t5000\t5\t5000\t1\t0\ttrue'

reset_live_state
if ! run_script "$WORK_DIR/success-exact-window-decimal-eof" \
    STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK=event_live_update.rolled-pod \
    STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=headers-only-exact-window-decimal-eof \
    ROLLBACK_MODE=execute >"$WORK_DIR/success-exact-window-decimal-eof.out" 2>&1; then
  cat "$WORK_DIR/success-exact-window-decimal-eof.out" >&2
  fail 'exact-window decimal EOF SSE success fixture unexpectedly failed'
fi
assert_contains "$WORK_DIR/success-exact-window-decimal-eof.out" 'rollback_status=PASS'
assert_line "$WORK_DIR/success-exact-window-decimal-eof/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theaders-only-exact-window-decimal-eof\t0\t200\t5.000000'
assert_line "$WORK_DIR/success-exact-window-decimal-eof/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5.000000\t5'
assert_line "$WORK_DIR/success-exact-window-decimal-eof/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t0\t200\t5.000000\t5000\t5\t5000\t1\t0\ttrue'

reset_live_state
if ! run_script "$WORK_DIR/success-quiet-sse" \
    STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK=event_live_update.rolled-pod \
    STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=quiet-timeout \
    ROLLBACK_MODE=execute >"$WORK_DIR/success-quiet-sse.out" 2>&1; then
  cat "$WORK_DIR/success-quiet-sse.out" >&2
  fail 'quiet-timeout SSE success fixture unexpectedly failed'
fi
assert_contains "$WORK_DIR/success-quiet-sse.out" 'rollback_status=PASS'
assert_line "$WORK_DIR/success-quiet-sse/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\tquiet-timeout\t28\t200\t5.000000'
assert_line "$WORK_DIR/success-quiet-sse/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t28\t200\t5.000000\t5'
assert_line "$WORK_DIR/success-quiet-sse/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t28\t200\t5.000000\t5000\t5\t5000\t1\t0\ttrue'

reset_live_state
if ! run_script "$WORK_DIR/success" \
    STUB_DYNAMIC_QUEUE_NAME_AFTER_ROLLBACK=event_live_update.rolled-pod \
    STUB_SHORT_SSE_MODE_AFTER_ROLLBACK=heartbeat-timeout \
    ROLLBACK_MODE=execute >"$WORK_DIR/success.out" 2>&1; then
  cat "$WORK_DIR/success.out" >&2
  fail 'success fixture unexpectedly failed'
fi
assert_contains "$WORK_DIR/success.out" 'rollback_status=PASS'
assert_line "$WORK_DIR/success/curl-trace.tsv" $'https://betstan.xyz/api/event/stream\t5\theartbeat-timeout\t28\t200\t5.000000'
assert_line "$WORK_DIR/success/sse-probe-trace.tsv" $'betstan.xyz/api/event/stream\t28\t200\t5.000000\t5'
assert_line "$WORK_DIR/success/sse-validation-trace.tsv" $'betstan.xyz/api/event/stream\t28\t200\t5.000000\t5000\t5\t5000\t1\t1\ttrue'
[[ "$(wc -l <"$WORK_DIR/success/rollout-order.tsv" | tr -d ' ')" == '9' ]] || fail 'success rollout did not process every service'
[[ "$(tail -n 1 "$WORK_DIR/success/rollout-order.tsv")" == 'gamemaster' ]] || fail 'gamemaster was not rolled back last'
assert_contains "$WORK_DIR/success/rollback-summary.env" 'status=PASS'
assert_contains "$WORK_DIR/success/rollback-readiness/summary.env" 'rollback_readiness=GO'
assert_contains "$WORK_DIR/success/live-readiness/summary.env" 'mode=rollback-drain'
assert_contains "$WORK_DIR/success/live-readiness/summary.env" 'image_provenance_rows=9'
assert_contains "$WORK_DIR/success/preflight-live-readiness/summary.env" 'mode=rollback-drain'
assert_contains "$WORK_DIR/success/queue-thresholds.env" 'max_post_rollback_queue_ready=5'
assert_contains "$WORK_DIR/success/queue-thresholds.env" 'max_post_rollback_queue_unack=5'
assert_contains "$WORK_DIR/success/queue-verification.tsv" 'dynamic:event_live_update.'
assert_route_row "$WORK_DIR/success/public-verification.tsv" betstan.xyz /api/bet
assert_route_row "$WORK_DIR/success/public-verification.tsv" betstan.xyz /api/backoffice
assert_route_row "$WORK_DIR/success/public-verification.tsv" www.betstan.xyz /api/bet
assert_route_row "$WORK_DIR/success/public-verification.tsv" www.betstan.xyz /api/backoffice
for service in "${SERVICES[@]}"; do
  assert_contains "$STATE_DIR/current/${service}.env" "image=$(target_image_ref "$service")"
done

if env -i HOME="$HOME" "${common_env[@]}" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-good" \
    STUB_EVENT_MODE=empty \
    OUTPUT_DIR="$WORK_DIR/capture-prematch-empty" \
    HOSTS='betstan.xyz,www.betstan.xyz' \
    "$CAPTURE_SCRIPT" >"$WORK_DIR/capture-prematch-empty.out" 2>&1; then
  fail 'baseline capture unexpectedly accepted empty prematch payload'
fi
assert_contains "$WORK_DIR/capture-prematch-empty.out" 'legacy PRE_MATCH event JSON shape'

if ! env -i HOME="$HOME" "${common_env[@]}" \
    STUB_BASELINE_FIXTURE="$FIXTURE_DIR/baseline-good" \
    OUTPUT_DIR="$WORK_DIR/next-baseline" \
    REPO=example/repo \
    HOSTS='betstan.xyz,www.betstan.xyz' \
    PROVENANCE_SCRIPT="$BIN_DIR/provenance-stub.sh" \
    "$CAPTURE_SCRIPT" >"$WORK_DIR/next-baseline.out" 2>&1; then
  cat "$WORK_DIR/next-baseline.out" >&2
  fail 'next baseline capture unexpectedly failed after rollback'
fi
assert_contains "$WORK_DIR/next-baseline.out" 'baseline_capture=PASS'
assert_capture_route_row "$WORK_DIR/next-baseline/public-http.tsv" betstan.xyz /api/bet
assert_capture_route_row "$WORK_DIR/next-baseline/public-http.tsv" betstan.xyz /api/backoffice
assert_capture_route_row "$WORK_DIR/next-baseline/public-http.tsv" www.betstan.xyz /api/bet
assert_capture_route_row "$WORK_DIR/next-baseline/public-http.tsv" www.betstan.xyz /api/backoffice
assert_contains "$WORK_DIR/next-baseline/images.tsv" "fixture.invalid/event:${TARGET_SHA}@$(service_digest event)"

echo 'production_rollback_tests=PASS'
