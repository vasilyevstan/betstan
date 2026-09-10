#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

MODE="${MODE:-}"
EXPECTED_IMAGE="${EXPECTED_IMAGE:-none}"
EXPECTED_DATABASE_INITIALIZED="${EXPECTED_DATABASE_INITIALIZED:-false}"
OCI_K8S_NAMESPACE="${OCI_K8S_NAMESPACE:-betstan-oci}"
OCI_PUBLIC_URL="${OCI_PUBLIC_URL:-https://betstan.xyz}"
OCI_DIAGNOSTIC_URL="${OCI_DIAGNOSTIC_URL:-}"
OUTPUT_DIR="${OUTPUT_DIR:-$OCI_ROOT_DIR/artifacts/telemetry-recovery}"

[[ "$MODE" == "retained" || "$MODE" == "absent" ]] ||
  oci_die "Telemetry recovery mode must be retained or absent"
[[ "$EXPECTED_DATABASE_INITIALIZED" == "true" ||
   "$EXPECTED_DATABASE_INITIALIZED" == "false" ]] ||
  oci_die "Telemetry database evidence must be true or false"
if [[ "$MODE" == "retained" ]]; then
  [[ "$EXPECTED_IMAGE" =~ ^ghcr\.io/vasilyevstan/betstan-images@sha256:[0-9a-f]{64}$ ]] ||
    oci_die "retained Telemetry image must be an immutable GHCR digest"
else
  [[ "$EXPECTED_IMAGE" == "none" ]] ||
    oci_die "absent Telemetry recovery cannot carry an image"
fi
if [[ "$MODE" == "retained" ]]; then
  [[ "$OCI_PUBLIC_URL" == https://* && "$OCI_DIAGNOSTIC_URL" == https://* ]] ||
    oci_die "Telemetry recovery URLs must use HTTPS"
fi
for command_name in kubectl python3 awk; do
  oci_require_command "$command_name"
done
[[ "$MODE" == "absent" ]] || oci_require_command curl
[[ "$OUTPUT_DIR" == /* ]] ||
  oci_die "Telemetry recovery output directory must be absolute"
mkdir -p "$OUTPUT_DIR"
[[ -d "$OUTPUT_DIR" && ! -L "$OUTPUT_DIR" ]] ||
  oci_die "Telemetry recovery output directory is invalid"
chmod 700 "$OUTPUT_DIR"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/betstan-telemetry-recovery.XXXXXX")"
chmod 700 "$WORK_DIR"
cleanup_private_work() {
  rm -rf -- "$WORK_DIR"
}
trap cleanup_private_work EXIT

deployment_json="$WORK_DIR/deployment.json"
service_json="$WORK_DIR/service.json"
ingress_json="$WORK_DIR/ingress.json"
kubectl get deployment gaming-telemetry-depl -n "$OCI_K8S_NAMESPACE" \
  --ignore-not-found -o json >"$deployment_json" ||
  oci_die "unable to inspect the Telemetry deployment"
kubectl get service gaming-telemetry-srv -n "$OCI_K8S_NAMESPACE" \
  --ignore-not-found -o json >"$service_json" ||
  oci_die "unable to inspect the Telemetry service"
kubectl get ingress gaming-oci-ingress -n "$OCI_K8S_NAMESPACE" -o json \
  >"$ingress_json" ||
  oci_die "unable to inspect the OCI ingress"

if [[ "$MODE" == "absent" ]]; then
  [[ ! -s "$deployment_json" && ! -s "$service_json" ]] ||
    oci_die "new Telemetry workload resources remain after topology recovery"
  python3 - "$ingress_json" <<'PY' ||
import json
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
paths = [
    path
    for rule in document.get("spec", {}).get("rules", [])
    for path in rule.get("http", {}).get("paths", [])
    if path.get("backend", {}).get("service", {}).get("name")
    == "gaming-telemetry-srv"
]
if paths:
    raise SystemExit(1)
PY
    oci_die "new Telemetry ingress routes remain after topology recovery"
  printf 'telemetry_recovery_state=PASS mode=absent\n'
  exit 0
fi

python3 - "$deployment_json" "$EXPECTED_IMAGE" <<'PY' ||
import json
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
expected = sys.argv[2]
containers = [
    item
    for item in document.get("spec", {}).get("template", {}).get("spec", {}).get("containers", [])
    if item.get("name") == "gaming-telemetry"
]
desired = document.get("spec", {}).get("replicas", 0)
status = document.get("status", {})
if (
    len(containers) != 1
    or containers[0].get("image") != expected
    or desired < 1
    or any(
        status.get(field, 0) != desired
        for field in ("updatedReplicas", "readyReplicas", "availableReplicas")
    )
    or status.get("observedGeneration", 0)
    != document.get("metadata", {}).get("generation", 0)
):
    raise SystemExit(1)
PY
  oci_die "retained Telemetry deployment is not exact and ready"
[[ -s "$service_json" ]] || oci_die "retained Telemetry service is missing"
python3 - "$ingress_json" <<'PY' ||
import json
import sys

document = json.load(open(sys.argv[1], encoding="utf-8"))
matches = [
    path
    for rule in document.get("spec", {}).get("rules", [])
    for path in rule.get("http", {}).get("paths", [])
    if path.get("path") == "/api/telemetry/?(.*)"
    and path.get("backend", {}).get("service", {}).get("name")
    == "gaming-telemetry-srv"
]
if len(matches) != 2:
    raise SystemExit(1)
PY
  oci_die "retained Telemetry ingress routes are incomplete"

queue_output="$(
  kubectl exec -n "$OCI_K8S_NAMESPACE" deployment/gaming-rabbitmq-depl -- \
    rabbitmqctl list_queues --quiet name messages_ready messages_unacknowledged consumers
)" || oci_die "unable to inspect RabbitMQ for retained Telemetry"
queue_rows="$(oci_rabbitmq_queue_rows <<<"$queue_output")" ||
  oci_die "RabbitMQ queue output is malformed"
[[ "$(awk '$1 == "telemetry:events:v1" && $4 > 0 {count++} END {print count+0}' \
  <<<"$queue_rows")" == "1" ]] ||
  oci_die "retained Telemetry queue is missing or has no consumer"

if [[ "$EXPECTED_DATABASE_INITIALIZED" == "true" ]]; then
  mongo_pod="$(
    kubectl get pod -n "$OCI_K8S_NAMESPACE" -l app=gaming-auth-mongo \
      -o jsonpath='{.items[0].metadata.name}'
  )" || oci_die "unable to identify the retained Mongo pod"
  [[ -n "$mongo_pod" ]] || oci_die "retained Mongo pod is missing"
  database_present="$(
    kubectl exec -n "$OCI_K8S_NAMESPACE" "$mongo_pod" -- \
      mongosh --quiet --eval \
      'print(db.adminCommand({listDatabases:1,nameOnly:true}).databases.some(d=>d.name==="gaming_telemetry"))'
  )" || oci_die "unable to inspect the retained Telemetry database"
  [[ "$database_present" == "true" ]] ||
    oci_die "the pre-existing Telemetry database is missing"
fi

validate_summary() {
  local base_url="$1"
  local label="$2"
  local body="$WORK_DIR/${label}-summary.json"
  local headers="$WORK_DIR/${label}-summary.headers"
  local status
  status="$(
    curl --silent --show-error --fail-with-body --max-time 25 \
      --max-filesize 262144 --output "$body" --dump-header "$headers" \
      --write-out '%{http_code}' "${base_url}/api/telemetry/summary"
  )" || oci_die "$label Telemetry summary request failed"
  [[ "$status" == "200" ]] || oci_die "$label Telemetry summary is unavailable"
  grep -Eiq '^content-type:[[:space:]]*application/json' "$headers" ||
    oci_die "$label Telemetry summary is not JSON"
  python3 - "$body" <<'PY' ||
import datetime
import json
import re
import sys

payload = json.load(open(sys.argv[1], encoding="utf-8"))
metrics = [
    "MAIN_PAGE_VISIT", "ADMIN_PAGE_VISIT", "SLIP_CREATED", "BET_PLACED",
    "RESULTING_SETTLED", "GAMECENTER_EVENT_EMITTED", "USER_CREATED",
    "USER_LOGGED_IN",
]
services = [
    "auth", "backoffice", "bet", "client", "event", "gamemaster",
    "moderation", "resulting", "slip", "telemetry",
]
if not isinstance(payload, dict) or set(payload) != {
    "generatedAt", "dates", "metrics", "health"
}:
    raise SystemExit(1)
stamp = payload["generatedAt"]
if not isinstance(stamp, str) or not re.fullmatch(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z",
    stamp,
):
    raise SystemExit(1)
generated = datetime.datetime.strptime(stamp, "%Y-%m-%dT%H:%M:%S.%fZ")
if generated.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z" != stamp:
    raise SystemExit(1)
dates = payload["dates"]
if (
    not isinstance(dates, list)
    or len(dates) != 14
    or any(not isinstance(value, str) for value in dates)
):
    raise SystemExit(1)
parsed = [datetime.date.fromisoformat(value) for value in dates]
if (
    any(value.isoformat() != raw for value, raw in zip(parsed, dates))
    or any(parsed[index] != parsed[index - 1] + datetime.timedelta(days=1)
           for index in range(1, 14))
    or parsed[-1] != generated.date()
):
    raise SystemExit(1)
rows = payload["metrics"]
if not isinstance(rows, list) or len(rows) != len(metrics):
    raise SystemExit(1)
for expected, row in zip(metrics, rows):
    values = row.get("values") if isinstance(row, dict) else None
    if (
        set(row) != {"metric", "values"}
        or row["metric"] != expected
        or not isinstance(values, list)
        or len(values) != 14
        or any(isinstance(value, bool) or not isinstance(value, int)
               or value < 0 or value > 9007199254740991 for value in values)
    ):
        raise SystemExit(1)
health = payload["health"]
if not isinstance(health, list) or len(health) != len(services):
    raise SystemExit(1)
for expected, row in zip(services, health):
    if (
        not isinstance(row, dict)
        or set(row) != {"service", "status"}
        or row != {"service": expected, "status": "green"}
    ):
        raise SystemExit(1)
PY
    oci_die "$label Telemetry summary is not canonical and healthy"
}

validate_summary "$OCI_PUBLIC_URL" canonical
validate_summary "$OCI_DIAGNOSTIC_URL" diagnostic
printf 'telemetry_recovery_state=PASS mode=retained\n'
