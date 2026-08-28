#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"
# shellcheck source=application-registry.sh
source "$SCRIPT_DIR/application-registry.sh"
# shellcheck source=../../azure/agents/live-betting-readiness-lib.sh
source "$OCI_ROOT_DIR/infra/azure/agents/live-betting-readiness-lib.sh"

REPO="${REPO:-${GITHUB_REPOSITORY:-vasilyevstan/betstan}}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/oci-baseline}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-https://betstan.xyz}"
OCI_REDIRECT_URL="${OCI_REDIRECT_URL:-https://www.betstan.xyz}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
REQUEST_TIMEOUT="${REQUEST_TIMEOUT:-20}"
HTTP_ATTEMPTS="${HTTP_ATTEMPTS:-4}"
HTTP_RETRY_SECONDS="${HTTP_RETRY_SECONDS:-5}"
SSE_TIMEOUT="${SSE_TIMEOUT:-5}"
SSE_REQUIREMENT="${SSE_REQUIREMENT:-required}"
SSE_REQUIRED=true
ALIAS_PROBE_MODE=exhaustive
BASELINE_RETENTION_DAYS="${BASELINE_RETENTION_DAYS:-30}"
RABBIT_SELECTOR="${RABBIT_SELECTOR:-app=gaming-rabbitmq}"
MIGRATION_STATE_CONFIGMAP="${MIGRATION_STATE_CONFIGMAP:-betstan-oci-migration-journal}"
MIGRATION_LOCK_CONFIGMAP="${MIGRATION_LOCK_CONFIGMAP:-betstan-oci-migration-lock}"
MIGRATION_EVIDENCE_REFERENCE="${MIGRATION_EVIDENCE_REFERENCE:-}"
RUN_LOOKBACK="${RUN_LOOKBACK:-40}"
BASELINE_RECOVERY_RUN_ID="${BASELINE_RECOVERY_RUN_ID:-0}"
BASELINE_RECOVERY_DIR="${BASELINE_RECOVERY_DIR:-}"
ROLLBACK_SERVICES=(auth bet backoffice client event gamemaster moderation resulting slip)
API_CONTRACTS=(
  "/|html"
  "/api/auth/currentuser|auth"
  "/api/event|prematch"
  "/api/slip|object"
  "/api/bet|object"
  "/api/bet/stats|array"
  "/api/backoffice|backoffice"
)
SSE_PATH="${SSE_PATH:-/api/event/stream}"
REDIRECT_PATH="${REDIRECT_PATH:-/api/auth/currentuser?live-betting-redirect=1}"

prepare_private_dir() {
  local directory="$1"
  oci_prepare_safe_private_dir "$directory"
}

sha256_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

validate_positive_int() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

env_value() {
  local file="$1"
  local key="$2"
  awk -F= -v key="$key" '
    $1 == key {
      if (found++) exit 1
      value = substr($0, length(key) + 2)
    }
    END {
      if (found != 1) exit 1
      print value
    }
  ' "$file"
}

validate_selected_recovery_artifact() {
  local directory="$1"
  python3 - "$directory" "$BASELINE_RECOVERY_RUN_ID" <<'PY'
import hashlib
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
run_id = sys.argv[2]
services = ("auth", "bet", "backoffice", "client", "event", "gamemaster",
            "moderation", "resulting", "slip")
required_files = {
    *(f"{service}.env" for service in services),
    "images.tsv", "recovery-evidence.env", "transition-plan.tsv",
    "transition-plan-evidence.env", "rabbitmq-baseline.txt",
    "rebind-provenance.env",
    "transition-provenance.env", "SHA256SUMS",
}
if not root.is_dir() or root.is_symlink():
    raise SystemExit("recovery artifact directory is invalid")
files = {path.name for path in root.iterdir() if path.is_file() and not path.is_symlink()}
if files != required_files:
    raise SystemExit("recovery artifact has an unexpected file set")
manifest = {}
for raw in (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
    match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._-]+)", raw)
    if not match or match.group(2) in manifest:
        raise SystemExit("recovery checksum manifest is malformed")
    manifest[match.group(2)] = match.group(1)
if set(manifest) != required_files - {"SHA256SUMS"}:
    raise SystemExit("recovery checksum manifest does not bind the exact evidence set")
for name, digest in manifest.items():
    if hashlib.sha256((root / name).read_bytes()).hexdigest() != digest:
        raise SystemExit(f"recovery checksum mismatch for {name}")

def exact_env(name, expected_keys):
    path = root / name
    values = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or "=" not in raw:
            raise SystemExit(f"{name} is malformed")
        key, value = raw.split("=", 1)
        if key in values or key not in expected_keys:
            raise SystemExit(f"{name} has an unexpected key")
        values[key] = value
    if set(values) != expected_keys:
        raise SystemExit(f"{name} key set is incomplete")
    return values

recovery = exact_env("recovery-evidence.env", {
    "schema", "recovery_origin", "registry_provider", "registry_repository",
    "anonymous_pull", "source_sha", "trusted_build_run_id",
    "trusted_upstream_run_id", "recovery_run_id", "recovery_run_attempt",
    "images_sha256",
})
if recovery["schema"] != "betstan.ghcr-cache-recovery.v1":
    raise SystemExit("recovery evidence schema is invalid")
if recovery["recovery_origin"] != "containerd-cache" or recovery["anonymous_pull"] != "pass":
    raise SystemExit("recovery evidence does not prove verified cache promotion")
if recovery["registry_provider"] != "ghcr" or recovery["registry_repository"] != "ghcr.io/vasilyevstan/betstan-images":
    raise SystemExit("recovery evidence registry is invalid")
if recovery["recovery_run_id"] != run_id or recovery["recovery_run_attempt"] != "1":
    raise SystemExit("recovery evidence does not bind the explicitly selected first attempt")
if not re.fullmatch(r"[0-9a-f]{40}", recovery["source_sha"]):
    raise SystemExit("recovery source SHA is invalid")
for key in ("trusted_build_run_id", "trusted_upstream_run_id"):
    if not re.fullmatch(r"[1-9][0-9]*", recovery[key]):
        raise SystemExit("recovery historical build lineage is invalid")
images = (root / "images.tsv").read_bytes()
if hashlib.sha256(images).hexdigest() != recovery["images_sha256"]:
    raise SystemExit("recovery image hash does not match recovery evidence")

plan = exact_env("transition-plan-evidence.env", {
    "schema", "source_sha", "plan_origin_recovery_run_id",
    "plan_carrier_recovery_run_id", "plan_carrier_recovery_run_attempt",
    "images_sha256", "infrastructure_provenance_sha256",
    "transition_plan_sha256", "rabbitmq_baseline_sha256",
})
if (plan["schema"] != "betstan.ghcr-cache-transition-plan.v1" or
        plan["source_sha"] != recovery["source_sha"] or
        plan["plan_carrier_recovery_run_id"] != run_id or
        plan["plan_carrier_recovery_run_attempt"] != "1" or
        plan["images_sha256"] != recovery["images_sha256"]):
    raise SystemExit("transition plan evidence identity is invalid")
if not re.fullmatch(r"[1-9][0-9]*", plan["plan_origin_recovery_run_id"]):
    raise SystemExit("transition plan origin run is invalid")
for key in ("infrastructure_provenance_sha256", "transition_plan_sha256",
            "rabbitmq_baseline_sha256"):
    if not re.fullmatch(r"[0-9a-f]{64}", plan[key]):
        raise SystemExit("transition plan evidence hash is invalid")
if hashlib.sha256((root / "transition-plan.tsv").read_bytes()).hexdigest() != plan["transition_plan_sha256"]:
    raise SystemExit("immutable transition plan hash differs")
if hashlib.sha256((root / "rabbitmq-baseline.txt").read_bytes()).hexdigest() != plan["rabbitmq_baseline_sha256"]:
    raise SystemExit("immutable RabbitMQ baseline hash differs")

transition = exact_env("transition-provenance.env", {
    "schema", "transition_workflow", "transition_run_id", "transition_run_attempt",
    "source_sha", "images_sha256", "infrastructure_run_id",
    "infrastructure_run_attempt", "infrastructure_provenance_sha256",
    "runtime_mode", "runtime_fingerprint", "registry_provider", "registry_host",
    "registry_repository", "registry_public_anonymous", "public_host",
    "canonical_host", "redirect_host", "diagnostic_host",
    "transition_plan_state_sha256", "rabbitmq_baseline_sha256",
    "credential_retirement", "ocir_repository_retirement", "transition_status",
})
if (transition["schema"] != "betstan.ghcr-cache-recovery-transition.v1" or
        transition["transition_workflow"] != "oci-ghcr-cache-recovery" or
        transition["transition_run_id"] != run_id or
        transition["transition_run_attempt"] != "1" or
        transition["source_sha"] != recovery["source_sha"] or
        transition["images_sha256"] != recovery["images_sha256"] or
        transition["runtime_mode"] != "k3s" or
        transition["registry_provider"] != "ghcr" or
        transition["registry_host"] != "ghcr.io" or
        transition["registry_repository"] != "ghcr.io/vasilyevstan/betstan-images" or
        transition["registry_public_anonymous"] != "true" or
        transition["credential_retirement"] != "pass" or
        transition["ocir_repository_retirement"] != "pass" or
        transition["transition_status"] != "PASS"):
    raise SystemExit("recovery transition provenance is not an exact completed recovery")
if (plan["infrastructure_provenance_sha256"] != transition["infrastructure_provenance_sha256"] or
        plan["transition_plan_sha256"] != transition["transition_plan_state_sha256"] or
        plan["rabbitmq_baseline_sha256"] != transition["rabbitmq_baseline_sha256"]):
    raise SystemExit("terminal transition does not match the immutable pre-rebind plan")
for key in ("infrastructure_run_id",):
    if not re.fullmatch(r"[1-9][0-9]*", transition[key]):
        raise SystemExit("transition infrastructure run is invalid")
if transition["infrastructure_run_attempt"] != "1":
    raise SystemExit("transition infrastructure evidence is not first attempt")
for key in ("infrastructure_provenance_sha256", "runtime_fingerprint",
            "transition_plan_state_sha256", "rabbitmq_baseline_sha256"):
    if not re.fullmatch(r"[0-9a-f]{64}", transition[key]):
        raise SystemExit("transition hash is invalid")
if hashlib.sha256((root / "transition-plan.tsv").read_bytes()).hexdigest() != transition["transition_plan_state_sha256"]:
    raise SystemExit("transition plan hash does not match exact transition state")
if hashlib.sha256((root / "rabbitmq-baseline.txt").read_bytes()).hexdigest() != transition["rabbitmq_baseline_sha256"]:
    raise SystemExit("RabbitMQ baseline hash does not match transition evidence")
PY
}

capture_configmap() {
  local name="$1"
  local output_file="$2"
  if kubectl get configmap "$name" -n "$OCI_K8S_NAMESPACE" -o json >"$output_file" 2>/dev/null; then
    :
  else
    printf '{"present":false,"name":"%s"}\n' "$name" >"$output_file"
  fi
}

capture_http() {
  local base_url="$1"
  local path="$2"
  local expected_kind="$3"
  local label="$4"
  local body_file="$WORK_DIR/http-body"
  local headers_file="$WORK_DIR/http-headers"
  local summary_file="$WORK_DIR/http-summary.json"
  local attempt curl_status expected_status expected_status_label location meta status effective_url content_type shape
  local -a curl_options=(--silent --show-error --max-time "$REQUEST_TIMEOUT")

  expected_status=200
  expected_status_label=200
  if [[ "$expected_kind" == "redirect" ]]; then
    expected_status=308
    expected_status_label=308
  else
    curl_options+=(--location)
    if [[ "$expected_kind" == "backoffice" ]]; then
      expected_status_label="200 or protected 401"
    fi
  fi
  status=""
  for ((attempt = 1; attempt <= HTTP_ATTEMPTS; attempt++)); do
    if meta="$(
      curl "${curl_options[@]}" \
        --output "$body_file" --dump-header "$headers_file" \
        --write-out '%{http_code}\t%{url_effective}\t%{content_type}' \
        "${base_url}${path}"
    )"; then
      curl_status=0
      IFS=$'\t' read -r status effective_url content_type <<<"$meta"
      if [[ "$status" == "$expected_status" ||
          ("$expected_kind" == "backoffice" && "$status" == "401") ]]; then
        break
      fi
    else
      curl_status=$?
      status=""
    fi

    if ((attempt == HTTP_ATTEMPTS)); then
      if [[ "$curl_status" != "0" ]]; then
        oci_die "HTTP probe failed for ${base_url}${path} after ${HTTP_ATTEMPTS} attempts"
      fi
      oci_die "expected HTTP ${expected_status_label} for ${base_url}${path}, got ${status} after ${HTTP_ATTEMPTS} attempts"
    fi
    if [[ "$curl_status" == "0" &&
        ! "$status" =~ ^(429|500|502|503|504)$ ]]; then
      oci_die "expected HTTP ${expected_status_label} for ${base_url}${path}, got ${status}"
    fi
    sleep "$HTTP_RETRY_SECONDS"
  done
  case "$expected_kind" in
    html)
      [[ "$content_type" == text/html* ]] || oci_die "expected HTML for ${base_url}${path}"
      shape="html"
      ;;
    auth)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, dict) or 'currentUser' not in payload:
    raise SystemExit(1)
print('object.currentUser')
PY
)" || oci_die "invalid auth JSON for ${base_url}${path}"
      ;;
    prematch)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      if ! live_betting_write_http_summary "$body_file" "$headers_file" "$summary_file" legacy-prematch-events \
          2>"$WORK_DIR/http-summary.stderr"; then
        oci_die "invalid legacy PRE_MATCH event JSON for ${base_url}${path}"
      fi
      shape="$(python3 - "$summary_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
print(
    "legacy-prematch:"
    f"events={payload.get('legacy_prematch_events', 0)}:"
    f"1x2={payload.get('legacy_prematch_1x2_odds', 0)}:"
    f"cs={payload.get('legacy_prematch_correct_score_odds', 0)}"
)
PY
)" || oci_die "unable to summarize legacy PRE_MATCH contract for ${base_url}${path}"
      ;;
    array)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, list):
    raise SystemExit(1)
print('array')
PY
)" || oci_die "invalid array JSON for ${base_url}${path}"
      ;;
    backoffice)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      shape="$(python3 - "$body_file" "$status" <<'PY'
import json
import sys

payload = json.load(open(sys.argv[1], encoding='utf-8'))
status = sys.argv[2]
if status == '200':
    if not isinstance(payload, list):
        raise SystemExit(1)
    print('array')
else:
    errors = payload.get('errors') if isinstance(payload, dict) else None
    if (
        not isinstance(errors, list)
        or not errors
        or any(
            not isinstance(error, dict)
            or not isinstance(error.get('message'), str)
            or not error['message']
            for error in errors
        )
    ):
        raise SystemExit(1)
    print('unauthorized.errors')
PY
)" || oci_die "invalid Backoffice JSON for ${base_url}${path}"
      ;;
    object)
      [[ "$content_type" == application/json* ]] || oci_die "expected JSON for ${base_url}${path}"
      shape="$(python3 - "$body_file" <<'PY'
import json
import sys
payload = json.load(open(sys.argv[1], encoding='utf-8'))
if not isinstance(payload, dict):
    raise SystemExit(1)
print('object')
PY
)" || oci_die "invalid object JSON for ${base_url}${path}"
      ;;
    redirect)
      [[ "$content_type" == text/html* || "$content_type" == text/plain* ]] ||
        oci_die "expected redirect response for ${base_url}${path}"
      location="$(
        tr -d '\r' <"$headers_file" |
          sed -n 's/^[Ll]ocation:[[:space:]]*//p' |
          tail -1
      )"
      [[ "$location" == "${OCI_PUBLIC_URL}${path}" ]] ||
        oci_die "unexpected redirect target for ${base_url}${path}"
      shape="redirect:${location}"
      ;;
    *)
      oci_die "unsupported HTTP expectation: $expected_kind"
      ;;
  esac
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$path" "$status" "$effective_url" "$content_type" "$shape:$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/public-http.tsv"
}

capture_api_contracts() {
  local base_url="$1"
  local label="$2"
  local contract path expected_kind
  for contract in "${API_CONTRACTS[@]}"; do
    IFS='|' read -r path expected_kind <<<"$contract"
    capture_http "$base_url" "$path" "$expected_kind" "$label"
  done
}

capture_sse() {
  local base_url="$1"
  local label="$2"
  local body_file="$WORK_DIR/sse-body"
  local headers_file="$WORK_DIR/sse-headers"
  local status_file="$WORK_DIR/sse-status"
  local curl_status status effective_url content_type duration_seconds

  if curl --location --silent --show-error --max-time "$SSE_TIMEOUT" \
      --header 'Accept: text/event-stream' \
      --output "$body_file" --dump-header "$headers_file" \
      --write-out '%{http_code}\t%{url_effective}\t%{time_total}' \
      "${base_url}${SSE_PATH}" >"$status_file"; then
    curl_status=0
  else
    curl_status=$?
  fi
  [[ "$curl_status" == "0" || "$curl_status" == "28" ]] ||
    oci_die "SSE probe failed for ${base_url}${SSE_PATH}"
  IFS=$'\t' read -r status effective_url duration_seconds <"$status_file" || true
  live_betting_trace_sse_probe_inputs \
    "${base_url}${SSE_PATH}" \
    "$curl_status" \
    "$status" \
    "$duration_seconds" \
    "$SSE_TIMEOUT"
  if [[ "$SSE_REQUIRED" == "false" && "$curl_status" == "0" &&
      ( "$status" == "404" || "$status" == "502" ) ]]; then
    content_type="legacy-absent"
  else
    content_type="$(
      live_betting_validate_sse_connectivity \
        "$headers_file" \
        "$body_file" \
        "$curl_status" \
        "$status" \
        "$duration_seconds" \
        "$SSE_TIMEOUT" \
        "${base_url}${SSE_PATH}"
    )" || oci_die "SSE connectivity contract failed for ${base_url}${SSE_PATH}"
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$status" "$effective_url" "$content_type" "$(sha256_file "$body_file")" \
    >>"$OUTPUT_DIR/sse.tsv"
}

validate_deploy_metadata() {
  local metadata_file="$1"
  local workflow_id="$2"
  python3 - "$metadata_file" "$workflow_id" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

run = json.load(open(sys.argv[1], encoding='utf-8'))
workflow_id, repository, retention_days = sys.argv[2:5]
created_at = run.get('created_at') or run.get('run_started_at') or run.get('updated_at')
if not created_at:
    raise SystemExit('deploy run metadata is missing a timestamp')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=int(retention_days)):
    raise SystemExit('deploy run is outside the rollback retention window')
valid = (
    str(run.get('workflow_id', '')) == workflow_id and
    run.get('path') == '.github/workflows/oci-production-deploy.yml' and
    run.get('event') == 'workflow_dispatch' and
    run.get('head_branch') == 'master' and
    ((run.get('head_repository') or {}).get('full_name') == repository) and
    run.get('status') == 'completed' and
    run.get('conclusion') == 'success' and
    run.get('run_attempt') == 1
)
if not valid:
    raise SystemExit('deploy run is not trusted OCI production deploy provenance')
PY
}

validate_build_metadata() {
  local metadata_file="$1"
  local workflow_id="$2"
  local source_sha="$3"
  python3 - "$metadata_file" "$workflow_id" "$source_sha" "$REPO" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

run = json.load(open(sys.argv[1], encoding='utf-8'))
workflow_id, source_sha, repository, retention_days = sys.argv[2:6]
created_at = run.get('created_at') or run.get('run_started_at') or run.get('updated_at')
if not created_at:
    raise SystemExit('build run metadata is missing a timestamp')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=int(retention_days)):
    raise SystemExit('build run is outside the rollback retention window')
valid = (
    str(run.get('workflow_id', '')) == workflow_id and
    run.get('path') == '.github/workflows/oci-production-build.yml' and
    run.get('event') == 'workflow_run' and
    run.get('head_sha') == source_sha and
    run.get('head_branch') == 'master' and
    ((run.get('head_repository') or {}).get('full_name') == repository) and
    run.get('status') == 'completed' and
    run.get('conclusion') == 'success' and
    run.get('run_attempt') == 1
)
if not valid:
    raise SystemExit('build run is not trusted OCI build provenance')
PY
}

validate_artifact_listing() {
  local artifacts_file="$1"
  local artifact_name="$2"
  python3 - "$artifacts_file" "$artifact_name" "$BASELINE_RETENTION_DAYS" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

artifacts = json.load(open(sys.argv[1], encoding='utf-8')).get('artifacts', [])
name = sys.argv[2]
retention_days = int(sys.argv[3])
matching = [artifact for artifact in artifacts if artifact.get('name') == name]
if len(matching) != 1:
    raise SystemExit('artifact identity does not resolve to exactly one artifact')
artifact = matching[0]
if artifact.get('expired'):
    raise SystemExit('artifact is expired')
created_at = artifact.get('created_at') or artifact.get('updated_at')
if not created_at:
    raise SystemExit('artifact timestamp is missing')
created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
if datetime.now(timezone.utc) - created > timedelta(days=retention_days):
    raise SystemExit('artifact is outside the rollback retention window')
PY
}

compare_live_images() {
  local candidate_images_file="$1"
  python3 - "$candidate_images_file" "$OUTPUT_DIR/live-images.tsv" <<'PY'
import sys
from pathlib import Path

candidate = {}
for line in Path(sys.argv[1]).read_text(encoding='utf-8').splitlines():
    if not line:
        continue
    service, _repository, image_ref, _digest, _platform_digest = line.split('\t')
    candidate[service] = image_ref
live = {}
for line in Path(sys.argv[2]).read_text(encoding='utf-8').splitlines():
    if not line:
        continue
    service, image_ref = line.split('\t')
    live[service] = image_ref
if candidate != live:
    raise SystemExit(1)
PY
}

validate_ghcr_image_inventory() {
  local image_file="$1"
  python3 - "$image_file" <<'PY'
import re
import sys
from pathlib import Path

expected_services = {
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip",
}
repository = "ghcr.io/vasilyevstan/betstan-images"
digest_pattern = re.compile(r"sha256:[0-9a-f]{64}")
rows = {}
for raw in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if not raw:
        continue
    fields = raw.split("\t")
    if len(fields) != 5:
        raise SystemExit("image provenance must contain exactly five columns")
    service, row_repository, image_ref, manifest_digest, platform_digest = fields
    if service in rows or service not in expected_services:
        raise SystemExit("image provenance service set is invalid")
    if row_repository != repository:
        raise SystemExit("image provenance repository is not the public GHCR repository")
    if not digest_pattern.fullmatch(manifest_digest):
        raise SystemExit("image provenance manifest digest is invalid")
    if not digest_pattern.fullmatch(platform_digest):
        raise SystemExit("image provenance ARM64 platform digest is invalid")
    if image_ref != f"{repository}@{manifest_digest}":
        raise SystemExit("image provenance reference does not match its GHCR manifest digest")
    rows[service] = image_ref
if set(rows) != expected_services:
    raise SystemExit("image provenance does not contain exactly the nine application services")
PY
}

validate_live_ghcr_inventory() {
  local live_file="$1"
  python3 - "$live_file" <<'PY'
import re
import sys
from pathlib import Path

expected_services = {
    "auth", "bet", "backoffice", "client", "event", "gamemaster",
    "moderation", "resulting", "slip",
}
reference_pattern = re.compile(
    r"ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}"
)
rows = {}
for raw in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    if not raw:
        continue
    fields = raw.split("\t")
    if len(fields) != 2:
        raise SystemExit("live image inventory must contain exactly two columns")
    service, image_ref = fields
    if service in rows or service not in expected_services:
        raise SystemExit("live image inventory service set is invalid")
    if not reference_pattern.fullmatch(image_ref):
        raise SystemExit("live image inventory is not an immutable public GHCR generation")
    rows[service] = image_ref
if set(rows) != expected_services:
    raise SystemExit("live image inventory does not contain exactly the nine application services")
PY
}

validate_trusted_ghcr_deploy_provenance() {
  local provenance_file="$1"
  local image_file="$2"
  local source_sha="$3"
  local deploy_run_id="$4"
  local repository
  repository="$(env_value "$provenance_file" registry_repository)"
  # A historical writer emitted this key empty; the exact GHCR images remain authoritative.
  if [[ -z "$repository" ]] &&
     ! grep -Fxq 'registry_repository=' "$provenance_file"; then
    return 1
  fi
  [[ "$(env_value "$provenance_file" source_sha)" == "$source_sha" &&
     "$(env_value "$provenance_file" deployment_workflow)" == "oci-production-deploy" &&
     "$(env_value "$provenance_file" deployment_run_id)" == "$deploy_run_id" &&
     "$(env_value "$provenance_file" deployment_run_attempt)" == "1" &&
     "$(env_value "$provenance_file" image_provenance_sha256)" == "$(sha256_file "$image_file")" &&
     "$(env_value "$provenance_file" registry_provider)" == "ghcr" &&
     "$(env_value "$provenance_file" registry_host)" == "ghcr.io" &&
     ( -z "$repository" ||
       "$repository" == "ghcr.io/vasilyevstan/betstan-images" ) &&
     "$(env_value "$provenance_file" registry_public_anonymous)" == "true" ]]
}

prepare_private_dir "$OUTPUT_DIR"
WORK_PARENT_DIR="$OUTPUT_DIR/.workdirs"
prepare_private_dir "$WORK_PARENT_DIR"
WORK_DIR="$(live_betting_create_unique_private_dir "$WORK_PARENT_DIR" baseline)"
trap 'rm -rf -- "$WORK_DIR"; rmdir "$WORK_PARENT_DIR" 2>/dev/null || true' EXIT

oci_require_command gh
oci_require_command git
oci_require_command kubectl
oci_require_command curl
oci_require_command python3
oci_require_command jq
application_registry_require_ghcr
validate_positive_int "$BASELINE_RETENTION_DAYS" || oci_die "BASELINE_RETENTION_DAYS must be positive"
validate_positive_int "$RUN_LOOKBACK" || oci_die "RUN_LOOKBACK must be positive"
validate_positive_int "$HTTP_ATTEMPTS" || oci_die "HTTP_ATTEMPTS must be positive"
[[ "$BASELINE_RECOVERY_RUN_ID" == "0" ||
   "$BASELINE_RECOVERY_RUN_ID" =~ ^[1-9][0-9]*$ ]] ||
  oci_die "BASELINE_RECOVERY_RUN_ID must be 0 or an explicit recovery run ID"
if [[ "$BASELINE_RECOVERY_RUN_ID" == "0" ]]; then
  [[ -z "$BASELINE_RECOVERY_DIR" ]] ||
    oci_die "BASELINE_RECOVERY_DIR is forbidden without an explicit recovery run"
else
  [[ -n "$BASELINE_RECOVERY_DIR" ]] ||
    oci_die "baseline recovery requires the explicitly selected recovery artifact directory"
fi
[[ "$HTTP_RETRY_SECONDS" =~ ^[0-9]+$ ]] ||
  oci_die "HTTP_RETRY_SECONDS must be a nonnegative integer"
[[ "$OCI_PUBLIC_URL" == https://* ]] || oci_die "OCI_PUBLIC_URL must be https://"
[[ "$OCI_REDIRECT_URL" == https://* ]] || oci_die "OCI_REDIRECT_URL must be https://"
[[ "$OCI_DIAGNOSTIC_URL" == https://* ]] || oci_die "OCI_DIAGNOSTIC_URL must be https://"
[[ "$SSE_REQUIREMENT" == "required" || "$SSE_REQUIREMENT" == "deployed-source" ]] ||
  oci_die "SSE_REQUIREMENT must be required or deployed-source"

: >"$OUTPUT_DIR/live-images.tsv"
: >"$OUTPUT_DIR/deployments.tsv"
for service in "${ROLLBACK_SERVICES[@]}"; do
  deployment="gaming-${service}-depl"
  container="gaming-${service}"
  deployment_json="$WORK_DIR/${service}-deployment.json"
  kubectl get deployment "$deployment" -n "$OCI_K8S_NAMESPACE" -o json >"$deployment_json"
  read -r image revision desired ready updated available < <(
    python3 - "$deployment_json" "$container" <<'PY'
import json
import sys

doc = json.load(open(sys.argv[1], encoding='utf-8'))
container = sys.argv[2]
image = ''
for item in doc.get('spec', {}).get('template', {}).get('spec', {}).get('containers', []):
    if item.get('name') == container:
        image = item.get('image', '')
        break
print(
    image,
    doc.get('metadata', {}).get('annotations', {}).get('deployment.kubernetes.io/revision', '0'),
    doc.get('spec', {}).get('replicas', 0),
    doc.get('status', {}).get('readyReplicas', 0),
    doc.get('status', {}).get('updatedReplicas', 0),
    doc.get('status', {}).get('availableReplicas', 0),
)
PY
  )
  [[ "$image" =~ @sha256:[0-9a-f]{64}$ ]] || oci_die "deployment ${deployment} does not use an immutable digest"
  printf '%s\t%s\n' "$service" "$image" >>"$OUTPUT_DIR/live-images.tsv"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$service" "$image" "$revision" "$desired" "$ready" "$available" >>"$OUTPUT_DIR/deployments.tsv"
done

if ! validate_live_ghcr_inventory "$OUTPUT_DIR/live-images.tsv"; then
  if [[ "$BASELINE_RECOVERY_RUN_ID" == "0" ]]; then
    oci_die "non-GHCR live images require explicit completed cache-recovery authority before baseline capture"
  fi
  oci_die "live images are not the completed immutable GHCR recovery generation"
fi

matched_deploy_run_id=""
matched_source_sha=""
matched_build_run_id=""
baseline_deploy_workflow=oci-production-deploy
baseline_recovery_run_id=0
baseline_recovery_run_attempt=0
baseline_transition_provenance_file=""
trusted_provenance_file=trusted-deploy-provenance.txt
partial_recovery_files=()

if [[ "$BASELINE_RECOVERY_RUN_ID" != "0" ]]; then
  cache_recovery_marker="$BASELINE_RECOVERY_DIR/recovery-evidence.env"
  partial_recovery_marker="$BASELINE_RECOVERY_DIR/partial-recovery-authority.env"
  if [[ -f "$cache_recovery_marker" && -f "$partial_recovery_marker" ]]; then
    oci_die "selected recovery artifact has ambiguous authority"
  elif [[ -f "$partial_recovery_marker" ]]; then
    PARTIAL_RECOVERY_DIR="$BASELINE_RECOVERY_DIR" \
    EXPECTED_RECOVERY_RUN_ID="$BASELINE_RECOVERY_RUN_ID" \
      "$SCRIPT_DIR/validate-partial-recovery-authority-stan.sh" >/dev/null ||
      oci_die "selected partial recovery artifact is not exact completed recovery evidence"
    validate_ghcr_image_inventory "$BASELINE_RECOVERY_DIR/images.tsv" ||
      oci_die "selected partial recovery images are not immutable public GHCR provenance"
    compare_live_images "$BASELINE_RECOVERY_DIR/images.tsv" ||
      oci_die "live deployment GHCR digests do not match the selected partial recovery"
    matched_source_sha="$(
      env_value "$partial_recovery_marker" restored_source_sha
    )"
    matched_deploy_run_id="$BASELINE_RECOVERY_RUN_ID"
    matched_build_run_id="$(
      env_value "$partial_recovery_marker" restored_build_run_id
    )"
    baseline_deploy_workflow=oci-production-rollback
    baseline_recovery_run_id="$BASELINE_RECOVERY_RUN_ID"
    baseline_recovery_run_attempt=1
    baseline_transition_provenance_file=partial-recovery/partial-recovery-authority.env
    trusted_provenance_file="$baseline_transition_provenance_file"
    partial_recovery_files=(
      partial-recovery/partial-recovery-SHA256SUMS
      partial-recovery/partial-recovery-summary.env
      partial-recovery/recovery-plan.tsv
      partial-recovery/recovery-rollout-order.tsv
      partial-recovery/final-state.tsv
      partial-recovery/rollback-readiness/summary.env
      partial-recovery/rollback-readiness/workload-state.tsv
      partial-recovery/rollback-readiness/failures.txt
    )
    mkdir -p "$OUTPUT_DIR/partial-recovery/rollback-readiness"
    cp "$BASELINE_RECOVERY_DIR/images.tsv" "$OUTPUT_DIR/images.tsv"
    cp "$BASELINE_RECOVERY_DIR/partial-recovery-authority.env" \
      "$OUTPUT_DIR/partial-recovery/partial-recovery-authority.env"
    cp "$BASELINE_RECOVERY_DIR/partial-recovery-SHA256SUMS" \
      "$OUTPUT_DIR/partial-recovery/partial-recovery-SHA256SUMS"
    cp "$BASELINE_RECOVERY_DIR/partial-recovery-summary.env" \
      "$OUTPUT_DIR/partial-recovery/partial-recovery-summary.env"
    cp "$BASELINE_RECOVERY_DIR/recovery-plan.tsv" \
      "$OUTPUT_DIR/partial-recovery/recovery-plan.tsv"
    cp "$BASELINE_RECOVERY_DIR/recovery-rollout-order.tsv" \
      "$OUTPUT_DIR/partial-recovery/recovery-rollout-order.tsv"
    cp "$BASELINE_RECOVERY_DIR/final-state.tsv" \
      "$OUTPUT_DIR/partial-recovery/final-state.tsv"
    cp "$BASELINE_RECOVERY_DIR/rollback-readiness/summary.env" \
      "$OUTPUT_DIR/partial-recovery/rollback-readiness/summary.env"
    cp "$BASELINE_RECOVERY_DIR/rollback-readiness/workload-state.tsv" \
      "$OUTPUT_DIR/partial-recovery/rollback-readiness/workload-state.tsv"
    cp "$BASELINE_RECOVERY_DIR/rollback-readiness/failures.txt" \
      "$OUTPUT_DIR/partial-recovery/rollback-readiness/failures.txt"
  else
    validate_selected_recovery_artifact "$BASELINE_RECOVERY_DIR" ||
      oci_die "selected GHCR cache recovery artifact is not exact completed recovery evidence"
    validate_ghcr_image_inventory "$BASELINE_RECOVERY_DIR/images.tsv" ||
      oci_die "selected recovery image provenance is not an immutable public GHCR generation"
    compare_live_images "$BASELINE_RECOVERY_DIR/images.tsv" ||
      oci_die "live deployment GHCR digests do not match the selected recovery artifact"
    matched_source_sha="$(env_value "$BASELINE_RECOVERY_DIR/recovery-evidence.env" source_sha)"
    matched_deploy_run_id="$BASELINE_RECOVERY_RUN_ID"
    matched_build_run_id="$(env_value "$BASELINE_RECOVERY_DIR/recovery-evidence.env" trusted_build_run_id)"
    baseline_deploy_workflow=oci-ghcr-cache-recovery
    baseline_recovery_run_id="$BASELINE_RECOVERY_RUN_ID"
    baseline_recovery_run_attempt=1
    baseline_transition_provenance_file=trusted-recovery-transition-provenance.env
    trusted_provenance_file="$baseline_transition_provenance_file"
    cp "$BASELINE_RECOVERY_DIR/images.tsv" "$OUTPUT_DIR/images.tsv"
    cp "$BASELINE_RECOVERY_DIR/transition-provenance.env" \
      "$OUTPUT_DIR/$baseline_transition_provenance_file"
  fi
else
trusted_deploy_workflow_id="$(gh api "repos/$REPO/actions/workflows/oci-production-deploy.yml" --jq '.id')"
trusted_build_workflow_id="$(gh api "repos/$REPO/actions/workflows/oci-production-build.yml" --jq '.id')"
runs_json="$WORK_DIR/deploy-runs.json"
gh run list --repo "$REPO" --workflow oci-production-deploy.yml \
  --limit "$RUN_LOOKBACK" --json databaseId,createdAt,status,conclusion >"$runs_json"
python3 - "$runs_json" "$BASELINE_RETENTION_DAYS" >"$WORK_DIR/deploy-candidates.txt" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

runs = json.load(open(sys.argv[1], encoding='utf-8'))
retention_days = int(sys.argv[2])
for run in runs:
    if run.get('status') != 'completed' or run.get('conclusion') != 'success':
        continue
    created_at = run.get('createdAt') or run.get('created_at')
    if not created_at:
        continue
    created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
    if datetime.now(timezone.utc) - created <= timedelta(days=retention_days):
        print(run.get('databaseId'))
PY

while IFS= read -r run_id; do
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || continue
  metadata_file="$WORK_DIR/deploy-run-${run_id}.json"
  gh api "repos/$REPO/actions/runs/$run_id/attempts/1" >"$metadata_file"
  if ! validate_deploy_metadata "$metadata_file" "$trusted_deploy_workflow_id"; then
    continue
  fi
  artifact_name="oci-deploy-provenance-${run_id}-1"
  artifacts_file="$WORK_DIR/deploy-run-${run_id}-artifacts.json"
  gh api "repos/$REPO/actions/runs/$run_id/artifacts" >"$artifacts_file"
  if ! validate_artifact_listing "$artifacts_file" "$artifact_name"; then
    continue
  fi
  candidate_dir="$WORK_DIR/candidate-${run_id}"
  prepare_private_dir "$candidate_dir"
  gh run download "$run_id" --repo "$REPO" --name "$artifact_name" --dir "$candidate_dir" >/dev/null
  candidate_images_file="$(find "$candidate_dir" -type f -name images.tsv | head -n 1)"
  candidate_provenance_file="$(find "$candidate_dir" -type f -name provenance.txt | head -n 1)"
  [[ -f "$candidate_images_file" && -f "$candidate_provenance_file" ]] || continue
  if ! validate_ghcr_image_inventory "$candidate_images_file"; then
    continue
  fi
  if ! compare_live_images "$candidate_images_file"; then
    continue
  fi
  matched_source_sha="$(env_value "$candidate_provenance_file" source_sha || true)"
  [[ "$matched_source_sha" =~ ^[0-9a-f]{40}$ ]] || continue
  if ! validate_trusted_ghcr_deploy_provenance \
      "$candidate_provenance_file" \
      "$candidate_images_file" \
      "$matched_source_sha" \
      "$run_id"; then
    continue
  fi
  matched_deploy_run_id="$run_id"
  cp "$candidate_images_file" "$OUTPUT_DIR/images.tsv"
  cp "$candidate_provenance_file" "$OUTPUT_DIR/trusted-deploy-provenance.txt"
  break
done <"$WORK_DIR/deploy-candidates.txt"

[[ -n "$matched_deploy_run_id" ]] || oci_die "unable to find trusted OCI deploy provenance for the live digest set"

build_runs_json="$WORK_DIR/build-runs.json"
gh run list --repo "$REPO" --workflow oci-production-build.yml \
  --commit "$matched_source_sha" --limit 20 \
  --json databaseId,createdAt,status,conclusion >"$build_runs_json"
python3 - "$build_runs_json" "$BASELINE_RETENTION_DAYS" >"$WORK_DIR/build-candidates.txt" <<'PY'
import json
import sys
from datetime import datetime, timedelta, timezone

runs = json.load(open(sys.argv[1], encoding='utf-8'))
retention_days = int(sys.argv[2])
for run in runs:
    if run.get('status') != 'completed' or run.get('conclusion') != 'success':
        continue
    created_at = run.get('createdAt') or run.get('created_at')
    if not created_at:
        continue
    created = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
    if datetime.now(timezone.utc) - created <= timedelta(days=retention_days):
        print(run.get('databaseId'))
PY

while IFS= read -r run_id; do
  [[ "$run_id" =~ ^[1-9][0-9]*$ ]] || continue
  metadata_file="$WORK_DIR/build-run-${run_id}.json"
  gh api "repos/$REPO/actions/runs/$run_id/attempts/1" >"$metadata_file"
  if validate_build_metadata "$metadata_file" "$trusted_build_workflow_id" "$matched_source_sha"; then
    matched_build_run_id="$run_id"
    build_artifact_name="oci-image-provenance-${matched_source_sha}-${run_id}-1"
    artifacts_file="$WORK_DIR/build-run-${run_id}-artifacts.json"
    gh api "repos/$REPO/actions/runs/$run_id/artifacts" >"$artifacts_file"
    validate_artifact_listing "$artifacts_file" "$build_artifact_name"
    break
  fi
done <"$WORK_DIR/build-candidates.txt"

[[ -n "$matched_build_run_id" ]] || oci_die "unable to find trusted OCI build provenance for ${matched_source_sha}"
fi

if [[ "$SSE_REQUIREMENT" == "deployed-source" ]]; then
  git cat-file -e "${matched_source_sha}^{commit}" ||
    oci_die "trusted deployed source commit is unavailable"
  if git cat-file -e \
      "${matched_source_sha}:event/src/route/EventLiveStream.ts"; then
    SSE_REQUIRED=true
  else
    SSE_REQUIRED=false
  fi
fi

: >"$OUTPUT_DIR/pod-images.tsv"
while IFS=$'\t' read -r service _repository _image_ref manifest_digest platform_digest; do
  pods_json="$WORK_DIR/${service}-pods.json"
  kubectl get pods -n "$OCI_K8S_NAMESPACE" -l "app=gaming-${service}" -o json >"$pods_json"
  python3 - "$pods_json" "$service" "$manifest_digest" "$platform_digest" >>"$OUTPUT_DIR/pod-images.tsv" <<'PY'
import json
import sys

doc = json.load(open(sys.argv[1], encoding='utf-8'))
service, manifest_digest, platform_digest = sys.argv[2:5]
ready_pods = 0
for item in doc.get('items', []):
    if item.get('metadata', {}).get('deletionTimestamp') is not None:
        continue
    pod = item.get('metadata', {}).get('name', '')
    for status in item.get('status', {}).get('containerStatuses', []):
        if status.get('name') != f'gaming-{service}':
            continue
        if not status.get('ready'):
            raise SystemExit(f'{service}: pod {pod} is not Ready')
        image_id = status.get('imageID', '')
        if not (
            image_id.endswith('@' + manifest_digest)
            or image_id.endswith('@' + platform_digest)
        ):
            raise SystemExit(
                f'{service}: pod {pod} does not serve the expected manifest/platform digest'
            )
        ready_pods += 1
        print(service, pod, image_id, sep='\t')
if ready_pods == 0:
    raise SystemExit(f'{service}: no ready pods found')
PY
done <"$OUTPUT_DIR/images.tsv"

rabbit_pod="$(kubectl get pod -n "$OCI_K8S_NAMESPACE" -l "$RABBIT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
[[ -n "$rabbit_pod" ]] || oci_die "RabbitMQ pod not found for selector ${RABBIT_SELECTOR}"
queue_raw="$WORK_DIR/queues.raw"
kubectl exec -n "$OCI_K8S_NAMESPACE" "$rabbit_pod" -- \
  rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers >"$queue_raw"
oci_rabbitmq_queue_rows <"$queue_raw" >"$OUTPUT_DIR/queues.tsv" ||
  oci_die "unable to normalize RabbitMQ queue state"
[[ -s "$OUTPUT_DIR/queues.tsv" ]] || oci_die "queue snapshot is empty"

: >"$OUTPUT_DIR/public-http.tsv"
: >"$OUTPUT_DIR/sse.tsv"
if [[ "$SSE_REQUIREMENT" == "deployed-source" && "$SSE_REQUIRED" == "false" ]]; then
  ALIAS_PROBE_MODE=legacy-safe
  capture_api_contracts "$OCI_PUBLIC_URL" canonical
  capture_sse "$OCI_PUBLIC_URL" canonical
  capture_http "$OCI_REDIRECT_URL" "$REDIRECT_PATH" redirect redirect
  capture_http "$OCI_DIAGNOSTIC_URL" / html diagnostic
  capture_http "$OCI_DIAGNOSTIC_URL" /api/auth/currentuser auth diagnostic
else
  for entry in \
    "canonical|$OCI_PUBLIC_URL" \
    "redirect|$OCI_REDIRECT_URL" \
    "diagnostic|$OCI_DIAGNOSTIC_URL"; do
    IFS='|' read -r label base_url <<<"$entry"
    capture_api_contracts "$base_url" "$label"
    capture_sse "$base_url" "$label"
  done
fi
[[ -s "$OUTPUT_DIR/public-http.tsv" ]] || oci_die "public HTTP evidence was not captured"
[[ -s "$OUTPUT_DIR/sse.tsv" ]] || oci_die "SSE evidence was not captured"

capture_configmap "$MIGRATION_STATE_CONFIGMAP" "$OUTPUT_DIR/migration-journal.json"
capture_configmap "$MIGRATION_LOCK_CONFIGMAP" "$OUTPUT_DIR/migration-lock.json"
if [[ -n "$MIGRATION_EVIDENCE_REFERENCE" ]]; then
  printf 'reference\t%s\tconfigured\n' "$MIGRATION_EVIDENCE_REFERENCE" >"$OUTPUT_DIR/migration-backup-references.tsv"
else
  printf 'state\tdatabase-restore-excluded\tapplication-rollback-only\n' >"$OUTPUT_DIR/migration-backup-references.tsv"
fi

cat >"$OUTPUT_DIR/baseline-provenance.env" <<EOF2
baseline_source_sha=$matched_source_sha
baseline_deploy_workflow=$baseline_deploy_workflow
baseline_deploy_run_id=$matched_deploy_run_id
baseline_deploy_run_attempt=1
baseline_build_workflow=oci-production-build
baseline_build_run_id=$matched_build_run_id
baseline_build_run_attempt=1
baseline_recovery_run_id=$baseline_recovery_run_id
baseline_recovery_run_attempt=$baseline_recovery_run_attempt
baseline_transition_provenance_file=${baseline_transition_provenance_file:-none}
baseline_capture_run_id=${GITHUB_RUN_ID:-local}
baseline_capture_run_attempt=${GITHUB_RUN_ATTEMPT:-1}
namespace=$OCI_K8S_NAMESPACE
public_url=$OCI_PUBLIC_URL
redirect_url=$OCI_REDIRECT_URL
diagnostic_url=$OCI_DIAGNOSTIC_URL
http_attempts=$HTTP_ATTEMPTS
http_retry_seconds=$HTTP_RETRY_SECONDS
alias_probe_mode=$ALIAS_PROBE_MODE
sse_path=$SSE_PATH
sse_requirement=$SSE_REQUIREMENT
sse_required=$SSE_REQUIRED
database_restore=disabled
registry_provider=ghcr
registry_host=ghcr.io
registry_repository=ghcr.io/vasilyevstan/betstan-images
registry_public_anonymous=true
EOF2

required_files=(
  baseline-provenance.env
  images.tsv
  live-images.tsv
  deployments.tsv
  pod-images.tsv
  queues.tsv
  public-http.tsv
  sse.tsv
  migration-journal.json
  migration-lock.json
  migration-backup-references.tsv
  "$trusted_provenance_file"
)
if ((${#partial_recovery_files[@]} > 0)); then
  required_files+=("${partial_recovery_files[@]}")
fi
: >"$OUTPUT_DIR/SHA256SUMS"
for file in "${required_files[@]}"; do
  [[ -f "$OUTPUT_DIR/$file" && ! -L "$OUTPUT_DIR/$file" ]] ||
    oci_die "required baseline artifact file is missing: $file"
  if [[ "$file" != "partial-recovery/rollback-readiness/failures.txt" ]]; then
    [[ -s "$OUTPUT_DIR/$file" ]] ||
      oci_die "required baseline artifact file is empty: $file"
  fi
  printf '%s  %s\n' "$(sha256_file "$OUTPUT_DIR/$file")" "$file" >>"$OUTPUT_DIR/SHA256SUMS"
done
find "$OUTPUT_DIR" -type d -exec chmod 700 {} +
find "$OUTPUT_DIR" -type f -exec chmod 600 {} +
allow_local_capture=false
[[ -n "${GITHUB_RUN_ID:-}" ]] || allow_local_capture=true
BASELINE_DIR="$OUTPUT_DIR" \
EXPECTED_SOURCE_SHA="$matched_source_sha" \
EXPECTED_NAMESPACE="$OCI_K8S_NAMESPACE" \
EXPECTED_RECOVERY_RUN_ID="$baseline_recovery_run_id" \
REQUIRE_CURRENT_DEPLOY_PROVENANCE=true \
ALLOW_LOCAL_CAPTURE="$allow_local_capture" \
  "$SCRIPT_DIR/validate-rollback-baseline-stan.sh" >/dev/null

oci_log "oci_baseline_capture=PASS source_sha=${matched_source_sha} deploy_run_id=${matched_deploy_run_id} build_run_id=${matched_build_run_id}"
